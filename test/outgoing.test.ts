/** Outbound protocol acceptance, adversarial boundaries and read-only command behavior. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalBeadsRecord, beadsAcknowledgementDigest, type BeadsAcknowledgement, type SnapshotRecord, RECONCILE_FIELDS } from '../reconcile.ts';
import { BEADS_OUTGOING_LIMITS, generateBeadsOutgoingDelta, replayBeadsOutgoingDelta, BeadsOutgoingRefusal, type BeadsOutgoingDelta } from '../outgoing.ts';
import { compareBeadsIdentities } from '../snapshot-schema.ts';
import { harness, runCommand } from './helpers.ts';

/** Produce a real-format acknowledgement receipt for pure protocol tests. */
export function ack(records: SnapshotRecord[], previous: string | null = null, source = 'team'): BeadsAcknowledgement {
  const state = { source, previous, records: structuredClone(records).sort((a,b) => compareBeadsIdentities(a.id,b.id)), bindings: Object.fromEntries(records.map(row => [row.id, `pm-${row.id}`])) };
  return { schema: 1, ...state, revision: beadsAcknowledgementDigest(state) };
}
/** Require actionable typed refusal, never a raw parsing/type error. */
function refusal(code: string) { return (error: unknown) => error instanceof BeadsOutgoingRefusal && error.code === code && error.remedy.length > 20 && error.exitCode === 2; }
/** Snapshot row with canonical fields supplied by the existing package contract. */
function row(id = 'r1', description = 'text') { return canonicalBeadsRecord({ id, title: id, description }); }

test('exactly two field operations among 1,000 records, deterministic receipts, replay and wrong base', () => {
  const base = ack(Array.from({ length: 1000 }, (_, i) => row(`r${i}`)));
  const next = structuredClone(base.records); next[0].fields.title = 'Changed'; next[999].fields.description = 'Changed prose';
  const target = ack(next, base.revision), before = structuredClone({base,target});
  const delta = generateBeadsOutgoingDelta(base, target);
  assert.equal(delta.mode, 'delta'); if (delta.mode !== 'delta') throw Error('mode');
  assert.deepEqual(delta.operations, [{ op: 'set', id: next[0].id, field: 'title', value: 'Changed' }, { op: 'set', id: next[999].id, field: 'description', value: 'Changed prose' }]);
  assert.equal(delta.baseDigest, base.revision); assert.equal(delta.targetDigest, target.revision); assert.match(delta.sourceDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(delta, generateBeadsOutgoingDelta(base,target));
  assert.deepEqual(replayBeadsOutgoingDelta(base, delta), { acknowledgement: target, unchanged: false });
  assert.deepEqual(replayBeadsOutgoingDelta(target, delta), { acknowledgement: target, unchanged: true });
  assert.equal(generateBeadsOutgoingDelta(target,target).mode, 'delta');
  assert.deepEqual((generateBeadsOutgoingDelta(target,target) as {operations: unknown[]}).operations, []);
  assert.throws(() => replayBeadsOutgoingDelta(ack([row()]), delta), refusal('base_mismatch'));
  assert.throws(() => replayBeadsOutgoingDelta(null, delta), refusal('base_mismatch'));
  const advanced = ack(target.records,target.revision);
  const receiptOnly = generateBeadsOutgoingDelta(target,advanced);
  assert.equal(receiptOnly.mode,'delta'); if (receiptOnly.mode !== 'delta') throw Error('mode');
  assert.equal(receiptOnly.operations.length,0);
  assert.equal(replayBeadsOutgoingDelta(target,receiptOnly).unchanged,false);
  assert.equal(replayBeadsOutgoingDelta(advanced,receiptOnly).unchanged,true);
  assert.throws(()=>replayBeadsOutgoingDelta(advanced,delta),refusal('base_mismatch'));
  assert.deepEqual({base,target},before);
  assert(Buffer.byteLength(JSON.stringify(delta)) < Buffer.byteLength(JSON.stringify(target))/10);
});

test('explicit removals, collection clears, creations and missing-base fallback preserve source receipts', () => {
  const base = ack([row('keep'), row('remove')]);
  base.records[0].fields.tags = '["x"]'; base.revision = beadsAcknowledgementDigest(base);
  const target = ack([row('keep', ''), row('new')],base.revision);
  const delta = generateBeadsOutgoingDelta(base,target);
  assert.equal(delta.mode,'delta'); if (delta.mode !== 'delta') throw Error('mode');
  assert(delta.operations.some(op => op.op === 'remove' && op.id === 'remove'));
  assert(delta.operations.some(op => op.op === 'unset' && op.field === 'description'));
  assert(delta.operations.some(op => op.op === 'unset' && op.field === 'tags'));
  assert.deepEqual(replayBeadsOutgoingDelta(base,delta).acknowledgement,target);
  const full = generateBeadsOutgoingDelta(null,target); assert.equal(full.mode,'snapshot');
  assert.deepEqual(replayBeadsOutgoingDelta(null,full).acknowledgement,target);
  assert.deepEqual(replayBeadsOutgoingDelta(base,full).acknowledgement,target);
  assert.equal(replayBeadsOutgoingDelta(target,full).unchanged,true);
  assert.throws(() => generateBeadsOutgoingDelta(ack([],null,'other'),target),refusal('source_mismatch'));
  assert.throws(() => replayBeadsOutgoingDelta(ack([],null,'other'),delta),refusal('source_mismatch'));
  const legacy = ack([row()]); delete legacy.bindings; legacy.revision = beadsAcknowledgementDigest(legacy);
  assert.deepEqual(replayBeadsOutgoingDelta(null,generateBeadsOutgoingDelta(null,legacy)).acknowledgement,legacy);
  assert.deepEqual(replayBeadsOutgoingDelta(target,generateBeadsOutgoingDelta(target,legacy)).acknowledgement,legacy);
  const cleared = structuredClone(base.records); cleared[0].fields.dependencies = '["remove"]';
  const linked = ack(cleared); const unlinked = ack(base.records,linked.revision);
  assert.deepEqual(replayBeadsOutgoingDelta(linked,generateBeadsOutgoingDelta(linked,unlinked)).acknowledgement,unlinked);
});

test('strict schema fuzz rejects sparse collections, unknown fields, nonfinite numbers and excessive sizes', () => {
  const base = ack([row()]), target = ack([row('r1','changed')],base.revision);
  const valid = generateBeadsOutgoingDelta(base,target);
  const extreme: unknown[] = [null, undefined, 0, -1, NaN, Infinity, -Infinity, Number.MAX_VALUE, [], 'x', {}, true];
  for (const value of extreme) {
    assert.throws(() => generateBeadsOutgoingDelta(null,value as BeadsAcknowledgement),refusal('invalid_input'));
    assert.throws(() => replayBeadsOutgoingDelta(base,value as BeadsOutgoingDelta),refusal('invalid_input'));
    for (const key of ['schema','source','revision','previous','records','bindings']) {
      const bad = {...target,[key]:value};
      // A null previous is valid only with its receipt recomputed; all mutations here have old receipts.
      assert.throws(() => generateBeadsOutgoingDelta(null,bad as BeadsAcknowledgement),refusal('invalid_input'),`${key}=${String(value)}`);
    }
  }
  const hidden = structuredClone(target);Object.defineProperty(hidden,'hidden',{value:1});
  const nullPrototype = structuredClone(target);nullPrototype.bindings=Object.assign(Object.create(null) as Record<string,string>,target.bindings);
  assert.deepEqual(generateBeadsOutgoingDelta(null,nullPrototype),generateBeadsOutgoingDelta(null,target));
  assert.deepEqual(replayBeadsOutgoingDelta(base,Object.setPrototypeOf(structuredClone(valid),null)).acknowledgement,target);
  class ExtendedArray extends Array<SnapshotRecord> {}
  const extended = new ExtendedArray();extended.push(row());
  const variants: unknown[] = [ hidden, {...target,bindings:new Date()}, {...target,records:extended}, {...target, extra: true}, {...target, records: new Array(1)}, {...target,records:Array(BEADS_OUTGOING_LIMITS.records+1).fill(row())}, {...target,source:'x'.repeat(257)}, {...target,bindings:{r1:''}}, {...target,bindings:{a:'same',b:'same'}}, {...target,records:[row(),row()]}, {...target,records:[row('z'),row('a')]}, {...target,records:[{...row(),extra:1}]} ];
  for (const field of RECONCILE_FIELDS) {
    for (const value of [null, NaN, Infinity, [], {}, 'x'.repeat(BEADS_OUTGOING_LIMITS.string+1)]) variants.push({...target,records:[{...row(),fields:{...row().fields,[field]:value}}]});
  }
  for (const field of ['tags','dependencies']) for (const value of ['broken','null','{}','[1]','["'+ 'a'.repeat(4098)+'"]']) variants.push({...target,records:[{...row(),fields:{...row().fields,[field]:value}}]});
  for (const value of ['5','-1','Infinity','2.5']) variants.push({...target,records:[{...row(),fields:{...row().fields,priority:value}}]});
  variants.push({...target,records:[{...row(),fields:{...row().fields,title:'  '}}]});
  for (const bad of variants) assert.throws(() => generateBeadsOutgoingDelta(null,bad as BeadsAcknowledgement),refusal('invalid_input'));
  const invalidOperations = [new Array(1), Array(BEADS_OUTGOING_LIMITS.operations+1).fill({op:'remove',id:'r1'}), [{op:'explode'}], [{op:'remove',id:''}], [{op:'unset',id:'r1',field:'unknown'}], [{op:'unset',id:'r1',field:'priority',value:'extra'}], [{op:'set',id:'r1',field:'priority',value:Infinity}], [{op:'set',id:'r1',field:'description',value:'a',extra:true}], [{op:'add',record:null}], [{op:'remove',id:'r1'},{op:'remove',id:'r1'}], [{op:'remove',id:'r1'},{op:'set',id:'r1',field:'description',value:'x'}], [{op:'set',id:'r1',field:'description',value:'x'},{op:'remove',id:'r1'}]];
  for (const operations of invalidOperations) assert.throws(() => replayBeadsOutgoingDelta(base,{...valid,operations} as BeadsOutgoingDelta),refusal('invalid_input'));
  for (const changes of [{mode:'nope'}, {sourceDigest:'0'.repeat(64)}, {baseDigest:null}, {records:[]}, {bindings:null}, {targetDigest:'NaN'}, {inheritBindings:false}, {inheritBindings:true,bindings:{}}]) assert.throws(() => replayBeadsOutgoingDelta(base,{...valid,...changes} as BeadsOutgoingDelta),refusal('invalid_input'));
  const sparse = [row()]; delete sparse[0]; Object.assign(sparse,{other:row()});
  assert.throws(() => generateBeadsOutgoingDelta(null,{...target,records:sparse}),refusal('invalid_input'));
  const sharedPayload = 'x'.repeat(BEADS_OUTGOING_LIMITS.string);
  const oversizedSdkValue = {...target,records:Array.from({length:20_000},(_,i)=>({id:`r${String(i).padStart(5,'0')}`,fields:{...row().fields,description:sharedPayload}}))};
  // Shared strings represent a multi-gigabyte serialization without allocating that serialization in the test.
  assert.throws(()=>generateBeadsOutgoingDelta(null,oversizedSdkValue),refusal('invalid_input'));
  const tooLarge = ack(Array.from({length:18},(_,i)=>row(`r${i}`,'x'.repeat(BEADS_OUTGOING_LIMITS.string))));
  assert.throws(() => generateBeadsOutgoingDelta(null,tooLarge),refusal('invalid_input'));
});

test('forged operations and target receipts refuse without mutation', () => {
  const base = ack([row()]), target = ack([row('r1','changed')],base.revision), valid = generateBeadsOutgoingDelta(base,target);
  for (const operations of [[{op:'add',record:row()}], [{op:'remove',id:'absent'}], [{op:'set',id:'absent',field:'description',value:'x'}]]) {
    assert.throws(()=>replayBeadsOutgoingDelta(base,{...valid,operations} as BeadsOutgoingDelta),refusal('invalid_input'));
  }
  assert.throws(()=>replayBeadsOutgoingDelta(base,{...valid,targetDigest:'0'.repeat(64)}),refusal('target_mismatch'));
  const full = generateBeadsOutgoingDelta(null,target);
  assert.throws(()=>replayBeadsOutgoingDelta(null,{...full,inheritBindings:true}),refusal('invalid_input'));
  assert.throws(()=>replayBeadsOutgoingDelta(null,{...full,operations:[]} as unknown as BeadsOutgoingDelta),refusal('invalid_input'));
  assert.throws(()=>replayBeadsOutgoingDelta(null,{...full,baseDigest:base.revision}),refusal('invalid_input'));
  const before = structuredClone(base);
  assert.throws(()=>replayBeadsOutgoingDelta(base,{...valid,operations:[]} as BeadsOutgoingDelta),refusal('target_mismatch'));
  assert.deepEqual(base,before);
});

test('CLI aliases generate and replay in a non-git directory, with typed input remedies', async t => {
  const dir = await mkdtemp(join(tmpdir(),'beads-outgoing-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const ext = await harness(); t.after(()=>ext.deactivate());
  const base = ack([row()]),target = ack([row('r1','changed')],base.revision);
  const b = join(dir,'base.json'), n = join(dir,'target.json'), d = join(dir,'delta.json');
  await writeFile(b,JSON.stringify(base)); await writeFile(n,JSON.stringify(target));
  const run = (options:Record<string,unknown>,command='beads outgoing')=>runCommand(ext,{command,pmRoot:join(dir,'tracker'),options});
  const previousPath=process.env.PATH; const previousCeiling=process.env.GIT_CEILING_DIRECTORIES;
  process.env.PATH=''; process.env.GIT_CEILING_DIRECTORIES=tmpdir();
  t.after(()=>{process.env.PATH=previousPath;if(previousCeiling===undefined)delete process.env.GIT_CEILING_DIRECTORIES;else process.env.GIT_CEILING_DIRECTORIES=previousCeiling;});
  const delta = await run({base:b,target:n}); assert.deepEqual(delta,generateBeadsOutgoingDelta(base,target));
  await writeFile(d,JSON.stringify(delta));
  assert.deepEqual(await run({base:b,replay:d},'beads-outgoing'),{acknowledgement:target,unchanged:false});
  assert.equal((await run({target:n}) as BeadsOutgoingDelta).mode,'snapshot');
  await writeFile(d,JSON.stringify(generateBeadsOutgoingDelta(null,target)));
  assert.deepEqual(await run({replay:d}),{acknowledgement:target,unchanged:false});
  for (const options of [{},{target:n,replay:d},{target:join(dir,'absent')}]) await assert.rejects(run(options),refusal('invalid_input'));
  await writeFile(d,'broken'); await assert.rejects(run({replay:d}),refusal('invalid_input'));
  await writeFile(d,' '.repeat(BEADS_OUTGOING_LIMITS.bytes+1)); await assert.rejects(run({replay:d}),refusal('invalid_input'));
});
