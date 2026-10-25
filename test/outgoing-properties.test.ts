/** Seeded state-machine differential: native SDK state is the oracle, never hand-written normalization. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PmClient, preserveMutationStdinTokenFields, type PmClientFullMutationOptions } from '@unbrained/pm-cli/sdk';
import { ensureBeadIdentityField } from '../identity.ts';
import { canonicalBeadsRecord, readLiveBeadsSnapshot, acknowledgeBeadsSnapshot, planBeadsReconciliation, applyBeadsReconciliation, readBeadsAcknowledgement, type BeadsAcknowledgement, type SnapshotRecord } from '../reconcile.ts';
import { generateBeadsOutgoingDelta, replayBeadsOutgoingDelta, BeadsOutgoingRefusal } from '../outgoing.ts';
import { harness, runImport, runExport } from './helpers.ts';
import { beadsAcknowledgementDigest } from '../reconcile.ts';

/** Exact real-format portable acknowledgement from an SDK-owned observation. */
function snapshot(records: SnapshotRecord[], previous: string | null): BeadsAcknowledgement {
  const state = { source:'model', previous, records:records.map(({id,fields})=>({id,fields})) };
  return {schema:1,...state,revision:beadsAcknowledgementDigest(state)};
}
/** Fixed reproducible random generator. */
function random(seed:number) { let state=seed;return ()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return (state ^ (state >>> 16)) >>> 0;}; }
/** Read every transport-owned native field directly through the SDK, retaining relation identity. */
async function native(client:PmClient, ids:Map<string,string>) {
  const external = new Map([...ids].map(([external,id])=>[id,external]));
  const rows=[];
  for(const [id,pmId] of ids) {
    const item=(await client.get(pmId)).item;
    rows.push({id,title:item.title,description:item.description,status:item.status,type:item.type,priority:item.priority,
      tags:item.tags,assignee:item.assignee,parent:item.parent ? external.get(item.parent) : undefined,deadline:item.deadline,
      sprint:item.sprint,release:item.release,dependencies:item.dependencies?.map(edge=>({id:external.get(edge.id),kind:edge.kind})).sort((a,b)=>String(a.id).localeCompare(String(b.id)))});
  }
  return rows;
}

test('512 random mutation/export/delta/reconciliation sequences with older replay and SDK-read reference state, seed 0x251025', async t=>{
  const dir=await mkdtemp(join(tmpdir(),'beads-outgoing-model-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const sourceRoot=join(dir,'oracle'),targetRoot=join(dir,'receiver');
  const oracle=new PmClient({pmRoot:sourceRoot,author:'model',noExtensions:true}),receiver=new PmClient({pmRoot:targetRoot,author:'model',noExtensions:true});
  const sourceIds=new Map<string,string>(),targetIds=new Map<string,string>();
  for(const [client,ids] of [[oracle,sourceIds],[receiver,targetIds]] as const){
    await client.init('model');await ensureBeadIdentityField(client);
    for(const id of ['a','b','c']) {const options:PmClientFullMutationOptions={title:id,type:'Task',beadId:id,description:'initial'};ids.set(id,(await client.create(options)).item.id);}
  }
  const initial=(await readLiveBeadsSnapshot(targetRoot)).map(({id,fields})=>({id,fields}));
  await acknowledgeBeadsSnapshot(targetRoot,'model',initial,'model');
  let sender=snapshot(initial,null),recipient=structuredClone(sender);
  const saved:BeadsAcknowledgement[]=[sender];const next=random(0x251025);
  const fields=['title','description','status','type','priority','tags','assignee','parent','deadline','sprint','release','dependencies'] as const;
  const ext=await harness();t.after(()=>ext.deactivate());
  const oldPath=process.env.PATH;process.env.PATH=join(import.meta.dirname,'..','node_modules','.bin')+':'+oldPath;t.after(()=>{process.env.PATH=oldPath;});
  const file=join(dir,'export.jsonl');
  for(let sequence=0;sequence<512;sequence++) {
    // Each sequence contains a native mutation, a portable exchange, a retry and an older-input attempt.
    const field=fields[sequence%fields.length],id=['a','b','c'][next()%3],pmId=sourceIds.get(id)!;
    const options:PmClientFullMutationOptions={message:`sequence-${sequence}`};
    const choice=next()%4;
    if(field==='title') options.title=`  title ${next()%1000}  `;
    else if(field==='description') options.description=['  leading and trailing  ','line one\r\nline two\r\n','\r\n','',`text ${next()}`][next()%5];
    else if(field==='status') {options.status=['open','in_progress','blocked','canceled'][choice];}
    else if(field==='type') options.type=['Task','Issue','Feature','Chore'][choice];
    else if(field==='priority') options.priority=next()%5;
    else if(field==='tags') options.tags=JSON.stringify(choice?[`tag-${choice}`,'a,b']:[]);
    else if(field==='dependencies') {const item=(await oracle.get(pmId)).item;options.depRemove=(item.dependencies??[]).map(edge=>`id=${JSON.stringify(edge.id)},kind=blocked_by`);if(choice&&id!=='a')options.dep=[`id=${JSON.stringify(sourceIds.get('a'))},kind=blocked_by,author=model`];}
    else if(field==='parent') {if(choice&&id!=='a')options.parent=sourceIds.get('a');else options.unset=['parent'];}
    else if(field==='deadline') {if(choice)options.deadline=`2026-11-${String(choice+1).padStart(2,'0')}`;else options.unset=['deadline'];}
    else {if(choice)options[field]=`${field}-${choice}`;else options.unset=[field];}
    await oracle.update(pmId,preserveMutationStdinTokenFields(options,['description']));
    const observed=await readLiveBeadsSnapshot(sourceRoot);
    const target=snapshot(observed,sender.revision),before=structuredClone(recipient);
    const delta=generateBeadsOutgoingDelta(sequence%17===0?null:sender,target);
    recipient=replayBeadsOutgoingDelta(recipient,JSON.parse(JSON.stringify(delta))).acknowledgement;
    assert.deepEqual(recipient,target,`sequence ${sequence}`);
    assert.equal(replayBeadsOutgoingDelta(recipient,delta).unchanged,true);
    const plan=await planBeadsReconciliation(targetRoot,'model',recipient.records);
    await applyBeadsReconciliation(targetRoot,plan,'model');
    assert.deepEqual(await native(receiver,targetIds),await native(oracle,sourceIds),`native ${field}, sequence ${sequence}`);
    const unchanged=await planBeadsReconciliation(targetRoot,'model',recipient.records);
    assert.equal(unchanged.changes.length,0);
    if(sequence%8===0){
      // Export -> ordinary upsert is a distinct public import/export path, verified by native SDK reads.
      const expected=await native(receiver,targetIds);
      await runExport(ext,{pmRoot:targetRoot,options:{output:file}});
      const raw=await readFile(file,'utf8');await writeFile(file,raw.split('\n').filter(Boolean).join(sequence%16===0?'\r\n':'\n')+'\n');
      await runImport(ext,{pmRoot:targetRoot,args:[file],options:{upsert:true,'no-preserve-timestamps':true}});
      assert.deepEqual(await native(receiver,targetIds),expected,`upsert sequence ${sequence}`);
    }
    const old=saved[next()%saved.length],oldDelta=generateBeadsOutgoingDelta(before,old);
    if(old.revision!==recipient.revision&&before.revision!==recipient.revision)assert.throws(()=>replayBeadsOutgoingDelta(recipient,oldDelta),error=>error instanceof BeadsOutgoingRefusal&&error.code==='base_mismatch');
    assert.deepEqual(await native(receiver,targetIds),await native(oracle,sourceIds));
    assert(await readBeadsAcknowledgement(targetRoot,'model'));
    sender=target;saved.push(target);
  }
});

test('outbound snapshots retain SDK-configured custom statuses under 32 random role registries',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'beads-outgoing-status-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const client=new PmClient({pmRoot:join(dir,'tracker'),author:'model',noExtensions:true});await client.init('statuses');
  const next=random(0x510025),roles=[['active'],['active','blocked'],['terminal','terminal_done'],['terminal','terminal_canceled']];
  let current=snapshot([],null);
  for(let sequence=0;sequence<32;sequence++){
    const status=`custom_${next().toString(36)}`;
    await client.schemaAddStatus(status,{role:roles[next()%roles.length]});
    const created=await client.create({title:`Status ${sequence}`,type:'Task',status,closeReason:'Synthetic lifecycle fixture'});
    const item=(await client.get(created.item.id)).item;
    const row=canonicalBeadsRecord({id:`r${sequence}`,title:item.title});
    // Status strings are opaque transport data. SDK registry roles remain the authority for lifecycle decisions.
    assert.equal(typeof item.status,'string');
    row.fields.status=item.status!;
    const target=snapshot([row],current.revision),delta=generateBeadsOutgoingDelta(current,target);
    assert.equal(replayBeadsOutgoingDelta(current,delta).acknowledgement.records[0].fields.status,item.status);
    current=target;
  }
});
