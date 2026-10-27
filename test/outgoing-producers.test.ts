/** Producer/consumer agreement and strict Unicode identity order using real non-git SDK trackers. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PmClient, preserveMutationStdinTokenFields, type PmClientFullMutationOptions } from '@unbrained/pm-cli/sdk';
import { ensureBeadIdentityField } from '../identity.ts';
import { canonicalBeadsRecord, parseBeadsSnapshot, readLiveBeadsSnapshot, acknowledgeBeadsSnapshot,
  readBeadsAcknowledgement, beadsAcknowledgementDigest, BeadsReconcileRefusal, planBeadsReconciliation, applyBeadsReconciliation,
  type BeadsAcknowledgement, type SnapshotRecord } from '../reconcile.ts';
import { planBeadsTransfer, snapshotBeadsTransferSettings, validateBeadsTransferPlan } from '../transfer.ts';
import { generateBeadsOutgoingDelta, replayBeadsOutgoingDelta, type BeadsOutgoingDelta } from '../outgoing.ts';
import { validateBeadsRecords, validateBeadsAcknowledgement, compareBeadsIdentities, BEADS_RECORD_SCHEMA,
  BEADS_RECORDS_SCHEMA, BEADS_ACKNOWLEDGEMENT_SCHEMA, validateBeadsSchema, checkBeadsSchema, BeadsSnapshotSchemaError } from '../snapshot-schema.ts';

const identities=['é','e\u0301','É','E\u0301','a','A','Z','z','I','İ','i','ı','o','ο','о','a\u200d','Å','A\u030a','𐀀','\ue000'];
/** Reproducible generator mixes both high and low bits before choosing variants. */
function random(seed:number) {let state=seed;return ()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return(state^(state>>>16))>>>0;};}
/** Exact persisted format; input order and property order are intentionally preserved. */
function ack(records:SnapshotRecord[],previous:string|null=null,source='producer'):BeadsAcknowledgement {const data={source,previous,records};return{schema:1,...data,revision:beadsAcknowledgementDigest(data)};}
/** Both transport modes, exact revision preservation, previous output reuse and immutable inputs. */
function exchange(base:BeadsAcknowledgement,target:BeadsAcknowledgement):BeadsAcknowledgement {
  validateBeadsRecords(target.records);validateBeadsAcknowledgement(target);
  const before=JSON.stringify({base,target}),delta=generateBeadsOutgoingDelta(base,target);
  const received=replayBeadsOutgoingDelta(base,JSON.parse(JSON.stringify(delta)) as BeadsOutgoingDelta).acknowledgement;
  assert.deepEqual(received,target);assert.equal(beadsAcknowledgementDigest(received),target.revision);
  assert.equal(replayBeadsOutgoingDelta(received,delta).unchanged,true);
  const full=generateBeadsOutgoingDelta(null,target);
  assert.deepEqual(replayBeadsOutgoingDelta(null,JSON.parse(JSON.stringify(full)) as BeadsOutgoingDelta).acknowledgement,target);
  const previous=generateBeadsOutgoingDelta(received,target);
  assert.equal(replayBeadsOutgoingDelta(received,previous).unchanged,true);
  assert.equal(JSON.stringify({base,target}),before);
  return received;
}

test('512 random identity sets have a strict total code-point order and transport every distinct spelling',()=>{
  const next=random(0x1762601);
  assert.equal(compareBeadsIdentities('',''),0);assert(compareBeadsIdentities('','a')<0);assert(compareBeadsIdentities('a','')>0);
  assert(compareBeadsIdentities('a','aa')<0);assert(compareBeadsIdentities('aa','a')>0);
  for(let sequence=0;sequence<512;sequence++){
    const ids=[...new Set([...identities,...Array.from({length:next()%8},()=>String.fromCodePoint(0x400+next()%100)+String(next()%20)), '\ud800', '\ud801'])];
    const ordered=[...ids].sort(compareBeadsIdentities);
    assert.equal(ordered.length,ids.length);
    for(let index=1;index<ordered.length;index++)assert(compareBeadsIdentities(ordered[index-1],ordered[index])<0);
    for(let i=0;i<ordered.length;i++)for(let j=i+1;j<ordered.length;j++)assert(compareBeadsIdentities(ordered[i],ordered[j])<0);
    for(const a of ids)for(const b of ids){const ab=compareBeadsIdentities(a,b),ba=compareBeadsIdentities(b,a);assert.equal(ab===0,a===b);assert.equal(Math.sign(ab)+Math.sign(ba),0);}
    const records=ordered.map(id=>canonicalBeadsRecord({id,title:'Identity',description:`row ${sequence}`}));
    const base=ack(records.filter((_,index)=>index%3!==0));
    const changed=structuredClone(records);changed[next()%changed.length].fields.description+='\r\nChanged';
    const target=ack(changed,base.revision),received=exchange(base,target);
    assert.deepEqual(received.records.map(row=>row.id),ordered);
    // Supported historical receipts may have arbitrary array/key order. Preserve their bytes, never collate them.
    const historical=ack([...changed].reverse().map(row=>({fields:Object.fromEntries(Object.entries(row.fields).reverse()) as typeof row.fields,id:row.id})),target.revision);
    assert.deepEqual(exchange(target,historical).records.map(row=>row.id),historical.records.map(row=>row.id));
    exchange(historical,ack(records,historical.revision));
  }
});

test('random real trackers: every snapshot producer, persisted legacy version and previous delta round-trips',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'beads-producer-agreement-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const oldCeiling=process.env.GIT_CEILING_DIRECTORIES,oldPath=process.env.PATH;
  process.env.GIT_CEILING_DIRECTORIES=tmpdir();process.env.PATH='';
  t.after(()=>{process.env.PATH=oldPath;if(oldCeiling===undefined)delete process.env.GIT_CEILING_DIRECTORIES;else process.env.GIT_CEILING_DIRECTORIES=oldCeiling;});
  const next=random(0x1762602);
  for(let trial=0;trial<16;trial++){
    const pmRoot=join(dir,`tracker-${trial}`),client=new PmClient({pmRoot,author:'producer-test',noExtensions:true});
    await client.init('producer');await ensureBeadIdentityField(client);
    const ids=[...new Set(['é','e\u0301','A','a',...Array.from({length:next()%4},()=>identities[next()%identities.length])])];
    const nativeIds=new Map<string,string>();
    for(const id of ids){const options:PmClientFullMutationOptions={title:`Title ${next()%100}`,type:'Task',beadId:id,description:['','  spaces  ','one\r\ntwo\r\n'][next()%3],priority:next()%5,tags:JSON.stringify(['a,b',`tag-${next()%5}`])};
      nativeIds.set(id,(await client.create(preserveMutationStdinTokenFields(options,['description']))).item.id);}
    await client.update(nativeIds.get('a')!,{parent:nativeIds.get('A'),dep:[`id=${JSON.stringify(nativeIds.get('é'))},kind=blocked_by,author=producer-test`]});
    const live=await readLiveBeadsSnapshot(pmRoot);validateBeadsRecords(live);
    assert.deepEqual(live.map(row=>row.id),[...ids].sort(compareBeadsIdentities));
    const baseline=await acknowledgeBeadsSnapshot(pmRoot,'producer',live,'producer-test');
    assert(baseline.records.every(row=>row.pmId&&row.version&&row.updatedAt));
    assert.deepEqual(await readBeadsAcknowledgement(pmRoot,'producer'),baseline);
    const empty=ack([]);exchange(empty,baseline);
    const jsonl=live.map(row=>JSON.stringify({id:row.id,title:row.fields.title,description:row.fields.description,priority:Number(row.fields.priority),tags:JSON.parse(row.fields.tags) as string[]})).join(trial%2?'\n':'\r\n');
    const parsed=parseBeadsSnapshot(jsonl);exchange(baseline,ack(parsed,baseline.revision));
    const transfer=planBeadsTransfer(jsonl,ids,'transfer',await snapshotBeadsTransferSettings(pmRoot));
    const retained=validateBeadsTransferPlan(JSON.parse(JSON.stringify(transfer)) as typeof transfer);
    for(const records of [transfer.records,retained.records])exchange(baseline,ack(records,baseline.revision));
    await client.update(nativeIds.get('é')!,{title:`Changed ${trial}`});
    await client.update(nativeIds.get('a')!,preserveMutationStdinTokenFields({description:`  Changed\r\n${trial}  `},['description']));
    const advancedLive=await readLiveBeadsSnapshot(pmRoot);
    const plan=await planBeadsReconciliation(pmRoot,'producer',advancedLive);
    for(const records of [plan.incoming,plan.live])exchange(baseline,ack(records,baseline.revision));
    await applyBeadsReconciliation(pmRoot,plan,'producer-test');
    const advanced=(await readBeadsAcknowledgement(pmRoot,'producer'))!;
    const delta=generateBeadsOutgoingDelta(baseline,advanced);
    assert(delta.recordReceipts?.length);exchange(baseline,advanced);
    assert.equal((await client.get(nativeIds.get('é')!)).item.title,`Changed ${trial}`);
    // Schema-1 historical acknowledgements without bindings, with live metadata and older field spellings.
    const source=`legacy-${trial}`,legacyRows=[...live].reverse().map(row=>({updatedAt:row.updatedAt,fields:{...row.fields,type:'bug',deadline:'2026-10-01T00:00:00Z'},version:row.version,id:row.id,pmId:row.pmId}));
    const legacy=ack(legacyRows,null,source);
    const file=join(pmRoot,'beads',createHash('sha256').update(JSON.stringify(source)).digest('hex')+'.json');
    await writeFile(file,JSON.stringify(legacy)+'\n');
    const loaded=(await readBeadsAcknowledgement(pmRoot,source))!;assert.deepEqual(loaded,legacy);
    exchange(ack([],null,source),loaded);
    exchange(loaded,ack([...legacyRows].sort((a,b)=>compareBeadsIdentities(a.id,b.id)),loaded.revision,source));
  }
});

test('shared schema rejects malformed metadata and layout receipts while allowing property-order variations',()=>{
  const record=canonicalBeadsRecord({id:'one',title:'One'}),base=ack([record]);
  const target=ack([{...record,pmId:'native',version:'revision',updatedAt:'date'}],base.revision);
  const delta=generateBeadsOutgoingDelta(base,target);assert(delta.recordReceipts);
  exchange(base,target);exchange(target,ack([record],target.revision));
  for(const key of ['pmId','version','updatedAt'])for(const value of [null,1,Infinity,[],{}])assert.throws(()=>validateBeadsRecords([{...record,[key]:value}]),BeadsSnapshotSchemaError);
  const receipt=delta.recordReceipts[0];
  for(const patch of [{keys:['id','fields','nope']},{keys:['id','fields','id']},{keys:['id','fields']},{fieldKeys:[]},{fieldKeys:Array(12).fill('title')},{extra:1},{pmId:Infinity}]){
    assert.throws(()=>replayBeadsOutgoingDelta(base,{...delta,recordReceipts:[{...receipt,...patch}]} as BeadsOutgoingDelta));
  }
  assert.throws(()=>replayBeadsOutgoingDelta(base,{...delta,recordReceipts:[receipt,receipt]}));
  assert.throws(()=>replayBeadsOutgoingDelta(base,{...delta,recordReceipts:[{...receipt,id:'absent'}]}));
  for(const order of [['one','one'],[],['absent']])assert.throws(()=>replayBeadsOutgoingDelta(base,{...delta,recordOrder:order}));
  assert.throws(()=>replayBeadsOutgoingDelta(null,{...generateBeadsOutgoingDelta(null,target),recordReceipts:[receipt]}));
  assert.throws(()=>replayBeadsOutgoingDelta(null,{...generateBeadsOutgoingDelta(null,target),recordOrder:['one']}));
  // Prior schema-1 deltas inherit their acknowledged ordering without invoking locale collation.
  const oldBase=ack(['a','Z'].map(id=>canonicalBeadsRecord({id,title:id})));
  const oldTarget=structuredClone(oldBase);oldTarget.records[0].fields.title='Old wire edit';oldTarget.previous=oldBase.revision;oldTarget.revision=beadsAcknowledgementDigest(oldTarget);
  const oldWire=generateBeadsOutgoingDelta(oldBase,oldTarget);assert.equal(oldWire.recordOrder,undefined);
  assert.deepEqual(replayBeadsOutgoingDelta(oldBase,oldWire).acknowledgement,oldTarget);
  const sentinel=new Error('unexpected getter failure');
  const hostile={...record};Object.defineProperty(hostile,'id',{get(){throw sentinel;},enumerable:true});
  assert.throws(()=>checkBeadsSchema(hostile,BEADS_RECORD_SCHEMA),error=>error===sentinel);
  assert.equal(checkBeadsSchema(null,BEADS_RECORD_SCHEMA),false);
  assert(checkBeadsSchema(record,BEADS_RECORD_SCHEMA));
  validateBeadsSchema([record],BEADS_RECORDS_SCHEMA);validateBeadsSchema(base,BEADS_ACKNOWLEDGEMENT_SCHEMA);
});

test('shared acknowledgement boundaries preserve corrupt files and refuse oversized sources without writes',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'beads-ack-boundary-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const pmRoot=join(dir,'tracker'),client=new PmClient({pmRoot,noExtensions:true,author:'producer-test'});
  await client.init('boundary');await client.create({title:'Existing',type:'Task'});
  const live=await readLiveBeadsSnapshot(pmRoot);
  const oversized='x'.repeat(257);
  await assert.rejects(acknowledgeBeadsSnapshot(pmRoot,oversized,live,'producer-test'),error=>error instanceof BeadsReconcileRefusal&&error.code==='invalid_snapshot');
  assert.equal(await readBeadsAcknowledgement(pmRoot,oversized),null);
  const baseline=await acknowledgeBeadsSnapshot(pmRoot,'producer',live,'producer-test');
  const file=join(pmRoot,'beads',createHash('sha256').update(JSON.stringify('producer')).digest('hex')+'.json');
  const original=await readFile(file,'utf8');
  const foreign={...baseline,source:'another-source'};foreign.revision=beadsAcknowledgementDigest(foreign);
  for(const value of [{...baseline,revision:'0'.repeat(64)},foreign]){
    const corrupted=JSON.stringify(value)+'\n';
    await writeFile(file,corrupted);
    await assert.rejects(readBeadsAcknowledgement(pmRoot,'producer'),error=>error instanceof BeadsReconcileRefusal&&error.code==='invalid_snapshot');
    assert.equal(await readFile(file,'utf8'),corrupted);
  }
  await writeFile(file,original);
  assert.deepEqual(await readBeadsAcknowledgement(pmRoot,'producer'),baseline);
  assert.deepEqual(await readLiveBeadsSnapshot(pmRoot),live);
});
