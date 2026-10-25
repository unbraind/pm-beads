/** Real compiled CLI acceptance exercises host TOON/JSON rendering with no git executable. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { cp,mkdir,mkdtemp,rm,symlink,writeFile } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { canonicalBeadsRecord,beadsAcknowledgementDigest } from '../reconcile.ts';
import { generateBeadsOutgoingDelta } from '../outgoing.ts';

test('compiled outgoing command renders exact JSON and compact TOON and refuses a wrong base without git',async t=>{
  const root=resolve(import.meta.dirname,'..'),dir=await mkdtemp(join(tmpdir(),'beads-outgoing-cli-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const pmRoot=join(dir,'tracker'),extension=join(pmRoot,'extensions','pm-beads');
  await new PmClient({pmRoot,noExtensions:true}).init('outgoing');await mkdir(extension,{recursive:true});
  for(const entry of ['dist','manifest.json','package.json'])await cp(join(root,entry),join(extension,entry),{recursive:true});
  await symlink(join(root,'node_modules'),join(extension,'node_modules'),'junction');
  const state={source:'team',previous:null,records:[canonicalBeadsRecord({id:'one',title:'One'})]};
  const base={schema:1 as const,...state,revision:beadsAcknowledgementDigest(state)};
  const changed=structuredClone(state);changed.records[0].fields.title='New';changed.records[0].fields.description='large payload '.repeat(2000);
  const target={...base,...changed,revision:beadsAcknowledgementDigest(changed)};
  const b=join(dir,'base.json'),n=join(dir,'target.json'),d=join(dir,'delta.json');
  const delta=generateBeadsOutgoingDelta(base,target);
  await writeFile(b,JSON.stringify(base));await writeFile(n,JSON.stringify(target));await writeFile(d,JSON.stringify(delta));
  /** Invoke the real pinned host in a non-git workspace with no executable search path. */
  const run=(...args:string[])=>spawnSync(process.execPath,[join(root,'node_modules','@unbrained','pm-cli','dist','cli.js'),'--path',pmRoot,...args],{cwd:dir,encoding:'utf8',env:{...process.env,PATH:'',GIT_CEILING_DIRECTORIES:tmpdir()}});
  const json=run('--json','beads','outgoing','--base',b,'--target',n);assert.equal(json.status,0,json.stderr);assert.deepEqual(JSON.parse(json.stdout),delta);
  const toon=run('beads-outgoing','--base',b,'--target',n);assert.equal(toon.status,0,toon.stderr);assert.match(toon.stdout,/mode: "delta"/);assert.match(toon.stdout,/operations\[2\]/);
  const replay=run('--json','beads','outgoing','--base',b,'--replay',d);assert.equal(replay.status,0,replay.stderr);assert.deepEqual(JSON.parse(replay.stdout),{acknowledgement:target,unchanged:false});
  const again=run('--json','beads','outgoing','--base',n,'--replay',d);assert.equal(again.status,0,again.stderr);assert.equal(JSON.parse(again.stdout).unchanged,true);
  const wrong={...base,previous:base.revision};wrong.revision=beadsAcknowledgementDigest(wrong);await writeFile(b,JSON.stringify(wrong));
  const refused=run('--json','beads','outgoing','--base',b,'--replay',d);assert.equal(refused.status,2);assert.match(refused.stdout+refused.stderr,/base_mismatch/);
});
