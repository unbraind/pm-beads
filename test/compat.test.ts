/** Published schema-1 golden artifacts resume under their original rules, outside git. */
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { validateBeadsTransferPlan, planBeadsTransfer, applyBeadsTransfer, type BeadsTransferPlan } from '../transfer.ts';
import { applyBeadsReconciliation, readLiveBeadsSnapshot, readBeadsAcknowledgement, beadsAcknowledgementDigest,
  reconcileBeadsSnapshots, type BeadsReconcilePlan, type BeadsAcknowledgement, type SnapshotRecord } from '../reconcile.ts';

const originalPath=process.env.PATH,originalCeiling=process.env.GIT_CEILING_DIRECTORIES;
before(()=>{process.env.PATH='';process.env.GIT_CEILING_DIRECTORIES=tmpdir();});
after(()=>{if(originalPath===undefined)delete process.env.PATH;else process.env.PATH=originalPath;if(originalCeiling===undefined)delete process.env.GIT_CEILING_DIRECTORIES;else process.env.GIT_CEILING_DIRECTORIES=originalCeiling;});

interface Golden {
  schema: 1; producer: { version: string }; tracker: Record<string,string>;
  plan: BeadsTransferPlan | BeadsReconcilePlan;
  expected: Array<Pick<SnapshotRecord,'id'|'fields'> & {pmId:string}>;
  baseline?: BeadsAcknowledgement; acknowledgement?: BeadsAcknowledgement;
  result?: {applied:number;baseRevision:string;deletionProposals:number};
}
/** Restore only captured synthetic text into an owned non-git directory. */
async function restore(t:test.TestContext,golden:Golden){
  const dir=await mkdtemp(join(tmpdir(),'beads-compat-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const [name,text] of Object.entries(golden.tracker)){assert(!name.startsWith('/')&&!name.split('/').includes('..'));const file=join(dir,name);await mkdir(dirname(file),{recursive:true});await writeFile(file,text);}
  return dir;
}
/** Canonical producer reads the SDK, using the fixture version for dependency spelling. */
async function state(pmRoot:string){return(await readLiveBeadsSnapshot(pmRoot,undefined,[],{},'compat-test',1)).map(({id,fields,pmId})=>({id,fields,pmId}));}
/** Read the committed npm-generated fixture without regenerating or normalizing its receipts. */
async function load(name:string):Promise<Golden>{const golden=JSON.parse(await readFile(join(import.meta.dirname,'fixtures','compat',name+'.json'),'utf8')) as Golden;assert.equal(golden.schema,1);assert.equal(golden.producer.version,'2026.10.26');return golden;}

for(const surface of ['cli','sdk']){
  test('released '+surface+' schema-1 transfer resumes original digests, identities and SDK checkpoints',async t=>{
    const golden=await load(surface+'-transfer'),pmRoot=await restore(t,golden),plan=golden.plan as BeadsTransferPlan;
    const original=JSON.stringify(plan);assert.equal(plan.schema,1);
    assert.deepEqual(validateBeadsTransferPlan(plan),plan);
    assert(plan.selected.indexOf('𐀀')<plan.selected.indexOf(''));
    const journal='transactions/beads-transfer/'+plan.digest+'.json';
    const before=JSON.parse(golden.tracker[journal]) as {schema:number;digest:string;rows:Record<string,{pmId:string;itemHash:string|null}>};
    const checkpointPaths=(await readdir(join(pmRoot,'transactions','sdk'))).sort();
    const completedBefore=Object.entries(golden.tracker).filter(([name])=>name.startsWith('transactions/')&&name.includes(plan.digest)&&name.endsWith('.json')&&!name.includes('/beads-transfer/'));
    const result=await applyBeadsTransfer(pmRoot,plan,'compat-test',{maxChunks:10});
    assert.equal(result.digest,plan.digest);assert.equal(result.complete,true);assert.equal(result.skipped,0);assert.equal(result.transferred,5);
    const after=JSON.parse(await readFile(join(pmRoot,journal),'utf8')) as typeof before;
    assert.equal(after.schema,1);assert.equal(after.digest,before.digest);
    assert.deepEqual(Object.fromEntries(Object.entries(after.rows).map(([id,pin])=>[id,pin.pmId])),Object.fromEntries(Object.entries(before.rows).map(([id,pin])=>[id,pin.pmId])));
    for(const [id,pin]of Object.entries(before.rows))if(pin.itemHash)assert.deepEqual(after.rows[id],pin);
    assert.equal((await readdir(join(pmRoot,'transactions','beads-transfer'))).length,1);
    for(const name of checkpointPaths){
      const saved=JSON.parse(golden.tracker['transactions/sdk/'+name]) as {schemaVersion:number;transactionId:string;stepIds:string[]};
      const resumed=JSON.parse(await readFile(join(pmRoot,'transactions','sdk',name),'utf8')) as typeof saved;
      assert.equal(resumed.schemaVersion,saved.schemaVersion);assert.equal(resumed.transactionId,saved.transactionId);assert.deepEqual(resumed.stepIds,saved.stepIds);
    }
    const checkpoints=await readdir(join(pmRoot,'transactions','sdk'));
    assert(checkpoints.every(name=>name.includes(plan.digest)));
    assert.equal(checkpoints.filter(name=>name.endsWith('-identity.json')).length,1);
    assert(completedBefore.length>0);
    assert.deepEqual(await state(pmRoot),golden.expected);assert.equal(JSON.stringify(plan),original);
    const native=(await new PmClient({pmRoot,noExtensions:true}).listAllComplete()).items;assert.equal(native.length,5);
    const ledger=await readFile(join(pmRoot,journal),'utf8');
    const replay=await applyBeadsTransfer(pmRoot,plan,'compat-test',{maxChunks:10});
    assert.equal(replay.replayedChunks,replay.totalChunks);assert.equal(replay.digest,plan.digest);
    assert.equal(await readFile(join(pmRoot,journal),'utf8'),ledger);
  });
}

test('released acknowledgement and reconciliation plan resume the old revision, raw identity ledger and checkpoint',async t=>{
  const golden=await load('sdk-reconciliation'),pmRoot=await restore(t,golden),plan=golden.plan as BeadsReconcilePlan;
  const original=JSON.stringify(plan),base=golden.baseline!;
  assert.equal(beadsAcknowledgementDigest(base),base.revision);
  const baselineFile='beads/'+createHash('sha256').update(JSON.stringify(base.source)).digest('hex')+'.json';
  assert.deepEqual(await readBeadsAcknowledgement(pmRoot,base.source),base);
  assert.equal(await readFile(join(pmRoot,baselineFile),'utf8'),golden.tracker[baselineFile]);
  const journal='transactions/beads-reconcile/'+plan.digest+'.json',ledger=await readFile(join(pmRoot,journal),'utf8');
  assert.equal(JSON.parse(ledger).schema,undefined); // Historical raw reservation map is the implicit v1 format.
  assert.deepEqual(reconcileBeadsSnapshots(base,plan.incoming,plan.live,1),plan);
  const result=await applyBeadsReconciliation(pmRoot,plan,'compat-test');
  assert.deepEqual(result,golden.result);assert.equal(result.baseRevision,golden.acknowledgement!.revision);
  assert.deepEqual(await readBeadsAcknowledgement(pmRoot,base.source),golden.acknowledgement);
  assert.equal(await readFile(join(pmRoot,journal),'utf8'),ledger);
  assert.deepEqual(await state(pmRoot),golden.expected);assert.equal(JSON.stringify(plan),original);
  assert.equal((await readdir(join(pmRoot,'transactions','beads-reconcile'))).length,1);
});

/** Independent scalar-sequence ordering oracle, without locale comparison or normalization. */
function codepoints(left:string,right:string){const a=Array.from(left,c=>c.codePointAt(0)!),b=Array.from(right,c=>c.codePointAt(0)!);for(let i=0;i<Math.min(a.length,b.length);i++)if(a[i]!==b[i])return a[i]-b[i];return a.length-b.length;}
/** Hash the exact saved representation, including its version. */
function seal<T extends {digest:string}>(plan:T):T{return {...plan,digest:createHash('sha256').update(JSON.stringify({...plan,digest:''})).digest('hex')};}

test('512 random string sets validate schema-1 UTF-16 and schema-2 code-point ordering independently',async()=>{
  const fixture=await load('sdk-transfer'),seed=fixture.plan as BeadsTransferPlan;
  let random=0x1762603;
  /** Reproducible words include BMP, astral, private use, combining and isolated surrogate strings. */
  const next=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random;};
  const alphabet=['A','a','é','e\u0301','𐀀','','𐀁','Ω','о','ο','\ud800','\udfff'];
  for(let sequence=0;sequence<512;sequence++){
    const ids=[...new Set(['𐀀','','é','e\u0301',...Array.from({length:next()%12},()=>Array.from({length:1+next()%4},()=>alphabet[next()%alphabet.length]).join(''))])];
    const text=ids.map(id=>JSON.stringify({id,title:'Title '+id})).join('\n');
    const current=planBeadsTransfer(text,ids,'property',seed.settings);
    assert.equal(current.schema,2);assert.deepEqual(current.selected,[...ids].sort(codepoints));
    assert.deepEqual(current.records.map(row=>row.id),[...ids].sort(codepoints));
    assert.deepEqual(validateBeadsTransferPlan(current),current);
    const oldIds=[...ids].sort(),byId=new Map(current.records.map(row=>[row.id,row]));
    const old=seal({...current,schema:1 as const,selected:oldIds,records:oldIds.map(id=>byId.get(id)!)});
    assert.deepEqual(validateBeadsTransferPlan(old),old);
    // Cross-version ordering is never silently accepted or resealed.
    assert.throws(()=>validateBeadsTransferPlan(seal({...old,selected:current.selected,records:current.records})));
    assert.throws(()=>validateBeadsTransferPlan(seal({...current,selected:old.selected,records:old.records})));
  }
});
