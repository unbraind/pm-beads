# Released fixture generator

Run this TypeScript program as `generate.ts` beside the extracted npm `package` directory in a scratch directory. Link that directory's `node_modules` and `package/node_modules` to the package's installed, pinned development dependencies. Pass the output fixture directory as the first argument. This executes the published JavaScript, including its CLI extension. It never imports the working branch implementation.

The generator captures synthetic durable text verbatim before completing each exchange with the old version. Cache and extension directories are omitted. No existing tracker is read or modified. SDK-generated identities, timestamps, history and coordinator receipts are intentionally frozen; regenerate only as a reviewed compatibility-fixture change.

```typescript
/** Generate immutable Unicode upgrade evidence with the published npm package. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, writeFile, cp, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { PmClient, WorkspaceTransactionInterruptedError } from '@unbrained/pm-cli/sdk';
import { planBeadsTransfer, snapshotBeadsTransferSettings, applyBeadsTransfer } from './package/dist/transfer.js';
import { parseBeadsSnapshot, readLiveBeadsSnapshot, acknowledgeBeadsSnapshot, planBeadsReconciliation, applyBeadsReconciliation } from './package/dist/reconcile.js';
const output=process.argv[2],root=await mkdtemp(join(tmpdir(),'beads-released-golden-'));
const author='compat-test';
const input=[{id:'𐀀',title:'Astral 𐀀 / BMP A / private  / é',tags:['unicode'],priority:1},{id:'',title:'Private  / astral 𐀀'},{id:'é',title:'Composed é'},{id:'é',title:'Combining é'},{id:'Z',title:'BMP Z',dependencies:['𐀀',''],parent:'𐀀'}].map(r=>JSON.stringify(r)).join('\n');
const selected=['','𐀀','é','é','Z'];
/** Capture only durable text; SDK caches and extension installation are disposable. */
async function files(dir:string):Promise<Record<string,string>> {
  const result:Record<string,string>={};
  for(const entry of await readdir(dir,{withFileTypes:true})){
    if(['runtime','extensions','locks','.cache'].includes(entry.name))continue;
    if(entry.isDirectory())for(const [name,text]of Object.entries(await files(join(dir,entry.name))))result[entry.name+'/'+name]=text;
    else if(entry.isFile())result[entry.name]=await readFile(join(dir,entry.name),'utf8');
  }return result;
}
/** Compare canonical producer fields read through the real SDK, retaining exact reserved identities. */
async function state(pmRoot:string){return (await readLiveBeadsSnapshot(pmRoot)).map(({id,fields,pmId})=>({id,fields,pmId}));}
await mkdir(output,{recursive:true});
for(const mode of ['cli','sdk']){
 const pmRoot=join(root,mode),client=new PmClient({pmRoot,author,noExtensions:true});await client.init('compat');
 let plan;
 if(mode==='cli'){
   const ext=join(pmRoot,'extensions','pm-beads');await cp(join(import.meta.dirname,'package'),ext,{recursive:true,filter:p=>!p.endsWith('node_modules')});
   await symlink(join(import.meta.dirname,'node_modules'),join(ext,'node_modules'),'junction');
   const file=join(root,'input.jsonl'),saved=join(root,'plan.json');await writeFile(file,input);
   /** Invoke the actual published extension through the pinned host with git unavailable. */
   const cli=(...args:string[])=>spawnSync(process.execPath,[join(import.meta.dirname,'node_modules','@unbrained','pm-cli','dist','cli.js'),'--path',pmRoot,'--author',author,'--json','beads','transfer',...args],{cwd:root,encoding:'utf8',env:{...process.env,PATH:'',GIT_CEILING_DIRECTORIES:tmpdir()}});
   const planned=cli(file,'--source','compat-cli','--select',selected.join(','),'--chunk-size','1','--plan-out',saved);assert.equal(planned.status,0,planned.stdout+planned.stderr);
   plan=JSON.parse(await readFile(saved,'utf8'));
   const partial=cli('--apply-plan',saved);assert.equal(partial.status,0,partial.stdout+partial.stderr);assert.equal(JSON.parse(partial.stdout).complete,false);
 }else{
   plan=planBeadsTransfer(input,selected,'compat-sdk',await snapshotBeadsTransferSettings(pmRoot),{chunkSize:2});
   await assert.rejects(applyBeadsTransfer(pmRoot,plan,author,{onIdentityTransition(c){if(c.transition==='step_applied')throw new WorkspaceTransactionInterruptedError('golden identity bootstrap');}}),WorkspaceTransactionInterruptedError);
 }
 const before=await files(pmRoot);
 const result=await applyBeadsTransfer(pmRoot,plan,author,{maxChunks:10});assert.equal(result.complete,true);assert.equal(result.skipped,0);
 const fixture={schema:1,producer:{package:'pm-beads',version:'2026.10.26',surface:mode,host:'@unbrained/pm-cli@2026.10.20'},plan,tracker:before,expected:await state(pmRoot)};
 await writeFile(join(output,mode+'-transfer.json'),JSON.stringify(fixture,null,2)+'\n');
}
// An old acknowledgement plus a saved reconciliation identity ledger and checkpoint.
{
 const pmRoot=join(root,'reconcile'),client=new PmClient({pmRoot,author,noExtensions:true});await client.init('compat');
 const seed=planBeadsTransfer(input,selected,'seed',await snapshotBeadsTransferSettings(pmRoot));await applyBeadsTransfer(pmRoot,seed,author,{maxChunks:10});
 const baseline=await acknowledgeBeadsSnapshot(pmRoot,'compat-ack',await readLiveBeadsSnapshot(pmRoot),author);
 const incoming=parseBeadsSnapshot(input+'\n'+JSON.stringify({id:'new𐀀é',title:'New 𐀀é',dependencies:['','𐀀']}));
 const plan=await planBeadsReconciliation(pmRoot,'compat-ack',incoming);
 await assert.rejects(applyBeadsReconciliation(pmRoot,plan,author,{onTransition(c){if(c.transition==='prepared')throw new WorkspaceTransactionInterruptedError('golden reconciliation checkpoint');}}),WorkspaceTransactionInterruptedError);
 const before=await files(pmRoot);
 const result=await applyBeadsReconciliation(pmRoot,plan,author);
 const acknowledgement=JSON.parse(await readFile(join(pmRoot,'beads',createHash('sha256').update(JSON.stringify('compat-ack')).digest('hex')+'.json'),'utf8'));
 await writeFile(join(output,'sdk-reconciliation.json'),JSON.stringify({schema:1,producer:{package:'pm-beads',version:'2026.10.26',surface:'sdk',host:'@unbrained/pm-cli@2026.10.20'},plan,baseline,tracker:before,expected:await state(pmRoot),acknowledgement,result},null,2)+'\n');
}
console.log(JSON.stringify({version:'2026.10.26',fixtures:3}));

```
