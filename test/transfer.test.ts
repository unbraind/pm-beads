/** Dependency closure and crash/concurrency behavior against real non-git SDK trackers. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readBeadsItemDocument } from '../item-access.ts';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PmClient, WorkspaceTransactionInterruptedError, getHistoryPath, readSettings, type WorkspaceTransactionTransitionContext } from '@unbrained/pm-cli/sdk';
import { planBeadsTransfer as buildTransfer, snapshotBeadsTransferSettings, applyBeadsTransfer, summarizeBeadsTransfer, BeadsTransferRefusal, type BeadsTransferPlan, type BeadsTransferLimits } from '../transfer.ts';
import { harness, runCommand } from './helpers.ts';

// The synchronous planner consumes an explicit snapshot from a real default receiver.
const settingsDir = await mkdtemp(join(tmpdir(), 'beads-plan-settings-'));
await new PmClient({ pmRoot: settingsDir, author: 'transfer-test', noExtensions: true }).init('sample');
const baselineSettings = await snapshotBeadsTransferSettings(settingsDir);
await rm(settingsDir, { recursive: true });
/** Plan fixture inputs against the same default receiver configuration used below. */
function planBeadsTransfer(text: string, selected: readonly string[], source: string, options: Partial<BeadsTransferLimits> = {}) {
  return buildTransfer(text, selected, source, baselineSettings, options);
}
/** Serialize synthetic Beads source records through the same public entry point as users. */
function plan(source = 'team', chunkSize = 2): BeadsTransferPlan {
  return planBeadsTransfer([
    { id: 'a', title: 'Dependent', dependencies: ['b'], parent: 'c', priority: 1, tags: ['triage'], assignee: 'agent', deadline: '2027-01-01', sprint: 's', release: 'r' },
    { id: 'b', title: 'Late blocker', status: 'closed', close_reason: 'done' },
    { id: 'c', title: 'Parent' },
    { id: 'unselected', title: 'Unrelated' },
  ].map(row => JSON.stringify(row)).join('\n'), ['a'], source, { chunkSize });
}
/** Check typed refusals without coupling callers to remedy prose. */
function refusal(code: string) { return (error: unknown) => error instanceof BeadsTransferRefusal && error.code === code && error.remedy.length > 10 && error.exitCode === 2; }
/** Init a real tracker outside git and remove only this test's scratch directory. */
async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'beads-transfer-'));
  const pmRoot = join(dir, 'tracker');
  const client = new PmClient({ pmRoot, author: 'transfer-test', noExtensions: true });
  await client.init('sample');
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, pmRoot, client };
}
/** Stop after durable SDK allocation so collision tests can occupy an exact reserved identity. */
async function reservedIdentity(pmRoot: string, p: BeadsTransferPlan, id: string): Promise<string> {
  await assert.rejects(applyBeadsTransfer(pmRoot, p, 'test', { onIdentityTransition(c) {
    if (c.transition === 'step_applied') throw new WorkspaceTransactionInterruptedError('identity allocation only');
  } }), WorkspaceTransactionInterruptedError);
  const journal = JSON.parse(await readFile(join(pmRoot, 'transactions', 'beads-transfer', `${p.digest}.json`), 'utf8')) as { rows: Record<string, { pmId: string }> };
  return journal.rows[id].pmId;
}
/** Deterministic transition identity used for exhaustive boundary injection. */
function boundary(c: WorkspaceTransactionTransitionContext): string { return `${c.transition}:${c.stepId ?? ''}`; }

test('closure includes late blockers and parents, orders them first, and refuses measured limits', () => {
  const p = plan();
  assert.deepEqual(p.records.map(row => row.id), ['b', 'c', 'a']);
  assert.equal(summarizeBeadsTransfer(p).addedDependencies, 2);
  assert.equal(summarizeBeadsTransfer(p).chunks, 2);
  const text = '{"id":"a","title":"A","dependencies":["b","c"]}\n{"id":"b","title":"B"}\n{"id":"c","title":"C"}';
  for (const [options, dimension] of [[{ maxRows: 1 }, 'maxRows'], [{ maxEdges: 1 }, 'maxEdges'], [{ maxBytes: 1 }, 'maxBytes']] as const) {
    assert.throws(() => planBeadsTransfer(text, ['a'], 'team', options), (error: unknown) => {
      assert(error instanceof BeadsTransferRefusal); assert.equal(error.code, 'closure_limit');
      assert.equal(error.omission?.dimension, dimension); assert.equal(error.omission?.included, 0);
      assert.ok(error.omission!.required > error.omission!.limit); return true;
    });
  }
  assert.throws(() => planBeadsTransfer(' '.repeat(16_777_217), ['a'], 'team'), refusal('closure_limit'));
  for (const value of [0, -1, 1.2, NaN, Infinity, 101]) assert.throws(() => planBeadsTransfer(text, ['a'], 'team', { chunkSize: value }), refusal('invalid_input'));
  for (const text of ['bad', '{"id":"a","title":"A","dependencies":["missing"]}', '{"id":"a","title":"A","status":"unsupported"}', '{"id":"a","title":"A"}\n{"id":"a","title":"Duplicate"}']) assert.throws(() => planBeadsTransfer(text, ['a'], 'team'), refusal('invalid_input'));
  for (const source of ['', 'x'.repeat(129)]) assert.throws(() => planBeadsTransfer(text, ['a'], source), refusal('invalid_input'));
  for (const selection of [[], [''], [' '], null as unknown as string[]]) assert.throws(() => planBeadsTransfer(text, selection, 'team'), refusal('invalid_input'));
  assert.throws(() => planBeadsTransfer(text, ['absent'], 'team'), refusal('missing_selection'));
  assert.throws(() => planBeadsTransfer('{"id":"a","title":"A","parent":"absent"}', ['a'], 'team'), refusal('missing_selection'));
  assert.throws(() => planBeadsTransfer('{"id":"a","title":"A","parent":"b"}\n{"id":"b","title":"B","parent":"a"}', ['a'], 'team'), refusal('invalid_input'));
  assert.equal(planBeadsTransfer(text, ['a', 'a', 'b'], 'team').records.length, 3);
  const many = planBeadsTransfer(Array.from({ length: 25 }, (_, i) => JSON.stringify({ id: `r${i}`, title: `Row ${i}` })).join('\n'), Array.from({ length: 25 }, (_, i) => `r${i}`), 'many');
  assert.equal(summarizeBeadsTransfer(many).selectedOmitted, 5);
});

test('bounded drain resumes chunks without duplicates, resolves cross-chunk links and preserves peer edits', async t => {
  const { pmRoot, client } = await fixture(t); const p = plan();
  const first = await applyBeadsTransfer(pmRoot, p, 'transfer-test');
  assert.equal(first.completedChunks, 1); assert.equal(first.complete, false); assert.equal(first.transferred, 2);
  const second = await applyBeadsTransfer(pmRoot, p, 'second-agent');
  assert.equal(second.complete, true); assert.equal(second.replayedChunks, 1); assert.equal(second.transferred, 3);
  await client.update(first.rows[0].pmId, { title: 'Later peer edit' });
  const items = (await client.listAllComplete()).items;
  assert.equal(items.length, 3); assert.equal((await client.get(first.rows[0].pmId)).item.title, 'Later peer edit');
  const dependent = items.find(i => i.bead_id === 'a')!;
  assert.equal(dependent.parent, second.rows.find(r => r.id === 'c')!.pmId);
  assert.equal(dependent.dependencies![0].id, second.rows.find(r => r.id === 'b')!.pmId);
  assert.equal(dependent.priority, 1);
  const histories = await Promise.all(items.map(i => readFile(getHistoryPath(pmRoot, i.id), 'utf8')));
  const replay = await applyBeadsTransfer(pmRoot, p, 'third-agent');
  assert.equal(replay.replayedChunks, 2); assert.equal(replay.complete, true); assert.equal(replay.skipped, 1);
  assert.deepEqual(await Promise.all(items.map(i => readFile(getHistoryPath(pmRoot, i.id), 'utf8'))), histories);
  for (const invalid of [{ ...p, digest: 'bad' }, { ...p, schema: 3 }, { ...p, records: null }, { ...p, limits: { ...p.limits, chunkSize: 0 } }, null]) {
    await assert.rejects(applyBeadsTransfer(pmRoot, invalid as unknown as BeadsTransferPlan, 'test'), refusal('invalid_plan'));
  }
  for (const options of [{ maxChunks: 0 }, { lockWaitMs: 0 }]) await assert.rejects(applyBeadsTransfer(pmRoot, p, 'test', options), refusal('invalid_input'));
});

test('every coordinator boundary is interrupted and competed on the SAME non-git tracker', async t => {
  const { pmRoot, client } = await fixture(t);
  const observed: string[] = [];
  await applyBeadsTransfer(pmRoot, plan('trace', 3), 'transfer-test', { onTransition(c) { observed.push(boundary(c)); } });
  assert.equal(observed.length, 9); // prepared, two per row, committing, committed
  let before = (await client.listAllComplete()).items.length;
  for (const [index, stop] of observed.entries()) {
    const p = plan(`boundary-${index}`, 3); let injected = false;
    await assert.rejects(applyBeadsTransfer(pmRoot, p, 'first-agent', { async onTransition(c) {
      if (boundary(c) !== stop || injected) return;
      injected = true;
      await assert.rejects(applyBeadsTransfer(pmRoot, p, 'peer-agent', { lockWaitMs: 1 }), refusal('busy'));
      throw new WorkspaceTransactionInterruptedError('synthetic interruption');
    } }), WorkspaceTransactionInterruptedError);
    assert(injected, `injected ${stop}`);
    const resumed = await applyBeadsTransfer(pmRoot, p, 'peer-agent');
    assert.equal(resumed.complete, true); assert.equal(resumed.transferred, 3); assert.equal(resumed.skipped, 0);
    assert.equal((await client.listAllComplete()).items.length, before + 3);
    before += 3;
    const repeat = await applyBeadsTransfer(pmRoot, p, 'first-agent');
    assert.equal(repeat.replayedChunks, 1); assert.equal(repeat.transferred, 3);
  }
  // Before acquisition: two real drainers race on one ledger and both report the same durable completion.
  const p = plan('parallel', 3);
  const peers = await Promise.all([applyBeadsTransfer(pmRoot, p, 'agent-one'), applyBeadsTransfer(pmRoot, p, 'agent-two')]);
  assert.equal(peers[0].transferred, 3); assert.equal(peers[1].transferred, 3);
  assert.equal(peers.filter(r => r.replayedChunks === 1).length, 1);
  assert.equal((await client.listAllComplete()).items.length, before + 3);
});

test('foreign records and missing or corrupt foreign histories are skipped with reasons and never mutated', async t => {
  const { pmRoot, client } = await fixture(t);
  for (const variant of ['normal', 'missing', 'corrupt']) {
    const p = plan(`foreign-${variant}`, 3);
    const id = await reservedIdentity(pmRoot, p, 'b');
    await client.create({ id, title: 'Foreign occupied identity', description: '[bead_id: b]' });
    const history = getHistoryPath(pmRoot, id);
    if (variant === 'missing') await rm(history);
    if (variant === 'corrupt') await writeFile(history, 'invalid');
    const before = await readFile(history, 'utf8').catch(() => 'missing');
    const result = await applyBeadsTransfer(pmRoot, p, 'transfer-test');
    assert.equal(result.skipped, 2); assert.equal(result.transferred, 1); assert.equal(result.complete, true);
    assert.equal(result.rows.find(r => r.id === 'b')!.reason, 'foreign_record');
    assert.equal(result.rows.find(r => r.id === 'a')!.reason, 'dependency_unavailable');
    assert.equal(await readFile(history, 'utf8').catch(() => 'missing'), before);
  }
});

test('ordinary failures preserve completed creations through every compensation boundary and retry', async t => {
  const { pmRoot, client } = await fixture(t);
  const transitions: string[] = [];
  const p = plan('compensation-trace', 3);
  await assert.rejects(applyBeadsTransfer(pmRoot, p, 'test', { onTransition(c) {
    transitions.push(boundary(c)); if (c.transition === 'committing') throw new Error('ordinary failure');
  } }), /ordinary failure/);
  const compensation = transitions.filter(s => s.startsWith('compensat') || s.startsWith('step_compensat'));
  assert.equal(compensation.length, 8);
  assert.equal((await client.listAllComplete()).items.length, 3);
  assert.equal((await applyBeadsTransfer(pmRoot, p, 'test')).transferred, 3);
  for (const [index, stop] of compensation.entries()) {
    const attempt = plan(`compensation-${index}`, 3); let injected = false;
    await assert.rejects(applyBeadsTransfer(pmRoot, attempt, 'test', { async onTransition(c) {
      if (c.transition === 'committing') throw new Error('ordinary failure');
      if (boundary(c) !== stop || injected) return;
      injected = true;
      await assert.rejects(applyBeadsTransfer(pmRoot, attempt, 'peer', { lockWaitMs: 1 }), refusal('busy'));
      throw new WorkspaceTransactionInterruptedError('compensation interruption');
    } }));
    assert(injected);
    assert.equal((await applyBeadsTransfer(pmRoot, attempt, 'peer')).transferred, 3);
  }
});

test('agent results bound row details while preserving totals', async t => {
  const { pmRoot } = await fixture(t);
  const p = planBeadsTransfer(Array.from({ length: 23 }, (_, i) => JSON.stringify({ id: `r${i}`, title: `Item ${i}` })).join('\n'), Array.from({ length: 23 }, (_, i) => `r${i}`), 'many');
  const result = await applyBeadsTransfer(pmRoot, p, 'test');
  assert.equal(result.transferred, 23); assert.equal(result.rows.length, 20); assert.equal(result.omitted, 3);
});

test('CLI handler supports planning, aliases, typed refusals, saved plan resumes and safe output paths', async t => {
  const { dir, pmRoot } = await fixture(t); const ext = await harness();
  const file = join(dir, 'incoming.jsonl'), output = join(dir, 'plan.json');
  await writeFile(file, '{"id":"a","title":"A"}');
  const call = (options: Record<string, unknown> = {}, args: string[] = [file], command = 'beads transfer') => runCommand(ext, { command, args, options, pmRoot });
  const result = await call({ source: 'team', select: 'a', 'plan-out': output, 'max-rows': '5', 'max-edges': '5', 'max-bytes': '10000', 'chunk-size': '1' }) as { rows: number };
  assert.equal(result.rows, 1);
  assert.equal((await call({ 'apply-plan': output }, [], 'beads-transfer') as { complete: boolean }).complete, true);
  assert.equal((await call({ source: 'team', select: 'a' }) as { rows: number }).rows, 1);
  const oldExitCode = process.exitCode;
  try {
    for (const [options, args, code] of [
      [{}, [], 'invalid_input'], [{ source: 'team', select: 'a' }, ['absent.jsonl'], 'invalid_input'],
      [{ source: 'team', select: 'a', planOut: file }, [file], 'invalid_input'],
      [{ source: 'team', select: 'a', planOut: join(dir, 'absent', 'out') }, [file], 'invalid_input'],
      [{ source: 'team', select: 'a', maxBytes: '1' }, [file], 'closure_limit'],
      [{ applyPlan: file }, [], 'invalid_plan'], [{ applyPlan: 'absent.json' }, [], 'invalid_plan'],
      [{ applyPlan: output, chunks: '0' }, [], 'invalid_input'],
    ] as const) {
      const refusal = await call(options, [...args]) as { refused: boolean; code: string; remedy: string };
      assert.equal(refusal.refused, true); assert.equal(refusal.code, code); assert.ok(refusal.remedy.length > 10);
      assert.equal(process.exitCode, 2);
    }
  } finally { process.exitCode = oldExitCode; }
});

test('row creation boundaries preserve competing foreign creates and peer edits under the same lease', async t => {
  const { pmRoot, client } = await fixture(t);
  for (const phase of ['before_create', 'after_create'] as const) {
    const p = plan(`row-${phase}`, 3); let calls = 0;
    const result = await applyBeadsTransfer(pmRoot, p, 'test', { async onRowTransition(c) {
      if (c.phase !== phase) return;
      calls++;
      await assert.rejects(applyBeadsTransfer(pmRoot, p, 'peer', { lockWaitMs: 1 }), refusal('busy'));
      if (phase === 'before_create') await client.create({ id: c.pmId, title: 'Foreign winner' });
      else await client.update(c.pmId, { title: 'Peer edit after creation' });
    } });
    assert.equal(calls, 2);
    assert.equal(result.transferred, 0);
    assert.equal(result.skipped, 3);
    if (phase === 'after_create') for (const row of result.rows.filter(row => row.reason === 'item_changed')) assert.equal((await client.get(row.pmId)).item.title, 'Peer edit after creation');
  }
  const p = plan('failed-create', 3); p.records[0].fields.type = 'invalid-type';
  // Regenerate a valid plan with a source type the receiving core schema does not declare.
  const unsupported = planBeadsTransfer('{"id":"a","title":"A","type":"invalid-type"}', ['a'], 'unsupported');
  await assert.rejects(applyBeadsTransfer(pmRoot, unsupported, 'test'), /type|Type/);
  const long = 'a'.repeat(129);
  assert.throws(() => planBeadsTransfer(JSON.stringify({ id: long, title: 'A' }), [long], 'team'), refusal('invalid_input'));
});

test('disappearing creations are reported as skipped and command handler propagates unexpected failures', async t => {
  const { pmRoot, client, dir } = await fixture(t);
  const p = planBeadsTransfer('{"id":"a","title":"A"}', ['a'], 'disappeared');
  const result = await applyBeadsTransfer(pmRoot, p, 'test', { async onRowTransition(c) {
    if (c.phase === 'after_create') await client.delete(c.pmId, { force: true });
  } });
  assert.equal(result.skipped, 1);
  const ext = await harness(); const file = join(dir, 'unsupported.json');
  await writeFile(file, JSON.stringify(planBeadsTransfer('{"id":"a","title":"A","type":"invalid-type"}', ['a'], 'unsupported-cli')));
  await assert.rejects(runCommand(ext, { command: 'beads transfer', args: [], options: { applyPlan: file }, pmRoot }), /type|Type/);
  const input = join(dir, 'input.jsonl'); await writeFile(input, '{"id":"a","title":"A"}');
  const exit = process.exitCode;
  try {
    const refusal = await runCommand(ext, { command: 'beads transfer', args: [input], options: {}, pmRoot }) as { code: string };
    assert.equal(refusal.code, 'invalid_input');
  } finally { process.exitCode = exit; }
});

test('foreign tombstoned identities remain reserved and skip without attempting to recreate them', async t => {
  const { pmRoot, client } = await fixture(t);
  const p = plan('foreign-reserved', 3);
  const pmId = await reservedIdentity(pmRoot, p, 'b');
  await client.create({ id: pmId, title: 'Foreign original' });
  await client.delete(pmId, { force: true });
  const history = await readFile(getHistoryPath(pmRoot, pmId), 'utf8');
  const result = await applyBeadsTransfer(pmRoot, p, 'test');
  assert.equal(result.skipped, 2); assert.equal(result.transferred, 1);
  assert.equal(result.rows.find(r => r.id === 'b')!.reason, 'foreign_record');
  assert.equal(result.rows.find(r => r.id === 'a')!.reason, 'dependency_unavailable');
  assert.equal(await readFile(getHistoryPath(pmRoot, pmId), 'utf8'), history);
  const replay = await applyBeadsTransfer(pmRoot, p, 'peer');
  assert.equal(replay.skipped, 2);
});


test('SDK hash pins retain legacy document-hash ledgers and reject invalid hash kinds', async t => {
  const { pmRoot } = await fixture(t);
  const p = planBeadsTransfer('{"id":"a","title":"Legacy pin"}', ['a'], 'legacy-pins');
  const first = await applyBeadsTransfer(pmRoot, p, 'test');
  const file = join(pmRoot, 'transactions', 'beads-transfer', `${p.digest}.json`);
  const ledger = JSON.parse(await readFile(file, 'utf8')) as { rows: Record<string, { pmId: string; itemHash: string; hashKind?: string }> };
  ledger.rows.a.itemHash = createHash('sha256').update(JSON.stringify(await readBeadsItemDocument(pmRoot, first.rows[0].pmId))).digest('hex');
  delete ledger.rows.a.hashKind;
  await writeFile(file, JSON.stringify(ledger));
  assert.equal((await applyBeadsTransfer(pmRoot, p, 'test')).transferred, 1);
  ledger.rows.a.itemHash = '0'.repeat(64);
  await writeFile(file, JSON.stringify(ledger));
  assert.equal((await applyBeadsTransfer(pmRoot, p, 'test')).skipped, 1);
  ledger.rows.a.hashKind = 'unknown';
  await writeFile(file, JSON.stringify(ledger));
  await assert.rejects(applyBeadsTransfer(pmRoot, p, 'test'), refusal('invalid_journal'));
});
