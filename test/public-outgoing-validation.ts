/** Measure outbound operations against an immutable public tracker copy, never the working tracker. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { readLiveBeadsSnapshot, beadsAcknowledgementDigest, acknowledgeBeadsSnapshot, readBeadsAcknowledgement, type BeadsAcknowledgement, type SnapshotRecord } from '../reconcile.ts';
import { generateBeadsOutgoingDelta, replayBeadsOutgoingDelta, BeadsOutgoingRefusal } from '../outgoing.ts';
const root=resolve(import.meta.dirname,'..');
const repository='unbraind/pm-beads';
assert.equal(JSON.parse(execFileSync('gh',['api',`repos/${repository}`],{encoding:'utf8'})).private,false);
const sourceHead=execFileSync('git',['-C',root,'rev-parse','origin/main'],{encoding:'utf8'}).trim();
const trackerTree=execFileSync('git',['-C',root,'rev-parse',`${sourceHead}:.agents/pm`],{encoding:'utf8'}).trim();
const scratch=await mkdtemp(join(tmpdir(),'beads-outgoing-public-')),pmRoot=join(scratch,'.agents','pm');
/** Exact portable acknowledgement of an observed canonical snapshot. */
function ack(records:SnapshotRecord[],previous:string|null,bindings:Record<string,string>):BeadsAcknowledgement {const state={bindings,source:'public-fleet',previous,records};return {schema:1,...state,revision:beadsAcknowledgementDigest(state)};}
/** Fingerprint only the bounded public scratch tree. */
async function fingerprint(dir:string):Promise<string>{const hash=createHash('sha256');for(const entry of(await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){hash.update(entry.name);hash.update(entry.isDirectory()?await fingerprint(join(dir,entry.name)):await readFile(join(dir,entry.name)));}return hash.digest('hex');}
/** Adjust permissions only on the disposable public copy. */
async function permissions(dir:string,readonly:boolean):Promise<void>{if(!readonly)await chmod(dir,0o700);for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.isDirectory())await permissions(join(dir,entry.name),readonly);else await chmod(join(dir,entry.name),readonly?0o400:0o600);}if(readonly)await chmod(dir,0o500);}
try{
  execFileSync('tar',['-x','-C',scratch],{input:execFileSync('git',['-C',root,'archive',sourceHead,'.agents/pm'],{maxBuffer:64*1024*1024})});
  const client=new PmClient({pmRoot,noExtensions:true,author:'public-validation'});
  await client.listAllComplete();const live=await readLiveBeadsSnapshot(pmRoot); // Warm SDK-derived caches before freezing the copy.
  await acknowledgeBeadsSnapshot(pmRoot,'public-fleet',live,'public-validation');
  await permissions(pmRoot,true);const before=await fingerprint(pmRoot);
  const previousPath=process.env.PATH;process.env.PATH='';process.env.GIT_CEILING_DIRECTORIES=tmpdir();
  const started=performance.now();
  const baseline=(await readBeadsAcknowledgement(pmRoot,'public-fleet'))!;
  assert.deepEqual(baseline.records,await readLiveBeadsSnapshot(pmRoot));
  const changed=structuredClone(baseline.records);changed[0].fields.title+=' (synthetic change)';changed.at(-1)!.fields.description+='\r\nSynthetic validation change.\r\n';
  const target=ack(changed,baseline.revision,baseline.bindings!),delta=generateBeadsOutgoingDelta(baseline,target);
  assert.equal(delta.mode,'delta');if(delta.mode!=='delta')throw Error('mode');assert.equal(delta.operations.length,2);
  assert.deepEqual(replayBeadsOutgoingDelta(baseline,delta).acknowledgement,target);
  assert.equal(replayBeadsOutgoingDelta(target,delta).unchanged,true);
  assert.throws(()=>replayBeadsOutgoingDelta(ack([],null,{}),delta),error=>error instanceof BeadsOutgoingRefusal&&error.code==='base_mismatch');
  const full=generateBeadsOutgoingDelta(null,target);assert.deepEqual(replayBeadsOutgoingDelta(null,full).acknowledgement,target);
  assert.equal(await fingerprint(pmRoot),before);
  const elapsedMs=Number((performance.now()-started).toFixed(2));process.env.PATH=previousPath;
  assert.equal(execFileSync('git',['-C',root,'rev-parse',`${sourceHead}:.agents/pm`],{encoding:'utf8'}).trim(),trackerTree);
  console.log(JSON.stringify({repository,sourceHead,trackerTree,records:baseline.records.length,changedFields:2,operations:delta.operations.length,liveMetadataPreserved:baseline.records.every(row=>row.pmId&&row.version&&row.updatedAt),
    deltaJsonBytes:Buffer.byteLength(JSON.stringify(delta)),fullSnapshotJsonBytes:Buffer.byteLength(JSON.stringify(full)),replayUnchanged:true,
    incorrectBaseRefused:true,fullFallbackVerified:true,readOnly:true,nonGit:true,gitAbsentFromPath:true,trackerFingerprint:before,trackerUnchanged:true,sourceUnchanged:true,elapsedMs},null,2));
}finally{await permissions(scratch,false);await rm(scratch,{recursive:true,force:true});}
