/** Seeded serialization properties and exhaustive per-row settings drift in real non-git trackers. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { delimiter, resolve } from 'node:path';
import { harness, runImport, runExport } from './helpers.ts';
import type { BeadsItem } from '../index.ts';
import { PmClient, WorkspaceTransactionInterruptedError, readSettings, locateItem } from '@unbrained/pm-cli/sdk';
import {
  planBeadsTransfer, validateBeadsTransferPlan, snapshotBeadsTransferSettings, applyBeadsTransfer,
  BeadsTransferRefusal, type BeadsTransferPlan,
} from '../transfer.ts';

/** Create and clean up only this test's isolated tracker, without git or SDK mocks. */
async function receiver(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'beads-property-')), pmRoot = join(dir, 'tracker');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const client = new PmClient({ pmRoot, author: 'property-test', noExtensions: true });
  await client.init('sample');
  return { pmRoot, client };
}
/** Deterministic unsigned PRNG, with its seed retained in each test name. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
}
/** Require the typed settings refusal and its recovery instructions. */
function changed(error: unknown): boolean {
  return error instanceof BeadsTransferRefusal && error.code === 'plan_settings_changed' && error.remedy.includes('Restore');
}

for (const seed of [0x1652026, 0xc0ffee]) {
  test(`full transfer-export-upsert pipeline preserves 512 adversarial rows, seed ${seed}`, async t => {
    const { pmRoot, client } = await receiver(t), next = random(seed);
    const fragments = ['', '[bead_id: x] text [bead_id: y]', '[bead_id: outer [bead_id: inner]]',
      '[bead_id:', '[bead_id: ] [bead_id: a]', 'é 🧠 中文 e\u0301 \u0000', 'line one\r\nline two\r\n',
      'long'.repeat(4096), '[bead_id: x]\r\n[bead_id: y]\r\n[bead_id: z]',
      'legacy position\n\n[bead_id: conflicting]', '[bead_id: r0]', '  whitespace\n\n', '\r\n'];
    const rows = Array.from({ length: 512 }, (_, index) => ({ id: `r${index}`, title: `Row ${index}`,
      description: fragments[index % fragments.length] + (index < fragments.length ? "" : fragments[next() % fragments.length]),
      tags: [`tag-${next() % 13}`, 'Unicode-é'], dependencies: index && index % 64 === 0 ? [`r${index - 1}`] : [] }));
    const plan = planBeadsTransfer(rows.map(row => JSON.stringify(row)).join('\r\n'), rows.map(row => row.id), `seed-${seed}`,
      await snapshotBeadsTransferSettings(pmRoot), { maxBytes: 16_777_216 });
    const saved = JSON.stringify(plan) + '\n', before = structuredClone(plan);
    const file = join(pmRoot, 'saved-plan.json'); await writeFile(file, saved);
    const loaded = JSON.parse(await readFile(file, 'utf8')) as BeadsTransferPlan;
    const validated = validateBeadsTransferPlan(loaded);
    assert.equal(validated.records.length, 512);
    assert.deepEqual(plan, before); assert.deepEqual(loaded, before);
    assert.equal(JSON.stringify(validated) + '\n', saved);
    assert.equal(JSON.stringify(validateBeadsTransferPlan(JSON.parse(JSON.stringify(validated)) as BeadsTransferPlan)) + '\n', saved);
    assert.ok(validated.records.some(row => row.fields.description.includes('[bead_id: y]')));
    const source = new Map(rows.map(row => [row.id, row]));
    for (const row of validated.records) assert.equal(row.fields.description, source.get(row.id)!.description);
    const receipt = await applyBeadsTransfer(pmRoot, validated, 'property-test', { maxChunks: 100 });
    assert.equal(receipt.transferred, 512); assert.equal(receipt.skipped, 0); assert.equal(receipt.complete, true);
    const originalIds = new Map(receipt.rows.map(row => [row.id, row.pmId]));
    const ext = await harness(); t.after(() => ext.deactivate());
    const oldPath = process.env.PATH;
    process.env.PATH = resolve('node_modules/.bin') + delimiter + oldPath;
    t.after(() => { process.env.PATH = oldPath; });
    const output = join(pmRoot, 'export.jsonl');
    await runExport(ext, { pmRoot, options: { output } });
    const exported = (await readFile(output, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as BeadsItem);
    assert.equal(exported.length, 512);
    for (const row of exported) {
      assert.ok(source.has(row.id!), `exported id ${row.id} must be a source id`);
      assert.equal(row.id, `r${String(row.title).slice(4)}`);
      assert.equal(row.description, source.get(row.id!)!.description);
      row.title = `Upsert exactly ${row.id}`;
    }
    await writeFile(output, exported.map(row => JSON.stringify(row)).join('\n'));
    const upsert = await runImport(ext, { pmRoot, args: [output], options: { upsert: true, 'no-preserve-timestamps': true } });
    assert.equal(upsert.imported, 0); assert.equal(upsert.updated, 512); assert.equal(upsert.skipped, 0);
    const after = (await client.listAllComplete()).items;
    assert.equal(after.length, 512);
    for (const item of after) {
      const id = String(item.bead_id);
      assert.equal(item.id, originalIds.get(id));
      assert.equal(item.title, `Upsert exactly ${id}`);
      assert.equal(item.description, source.get(id)!.description);
    }
    await runExport(ext, { pmRoot, options: { output } });
    for (const line of (await readFile(output, 'utf8')).trimEnd().split('\n')) {
      const row = JSON.parse(line) as BeadsItem;
      assert.ok(source.has(row.id!)); assert.equal(row.description, source.get(row.id!)!.description);
    }

  });
}

test('every created row survives interruption and each mutable setting without duplicate identities', async t => {
  const mutations = ['id_prefix', 'ids', 'templates', 'focus'] as const;
  for (const setting of mutations) for (const stop of [1, 2, 3]) for (const chunkSize of [1, 3]) {
    const { pmRoot, client } = await receiver(t);
    const settings = await snapshotBeadsTransferSettings(pmRoot);
    const text = ['a', 'b', 'c'].map((id, i) => JSON.stringify({ id, title: id, dependencies: i ? [String.fromCharCode(96 + i)] : [] })).join('\n');
    const plan = planBeadsTransfer(text, ['c'], `drift-${setting}-${stop}-${chunkSize}`, settings, { chunkSize });
    let created = 0;
    await assert.rejects(applyBeadsTransfer(pmRoot, plan, 'property-test', { maxChunks: 3, onRowTransition(c) {
      if (c.phase === 'after_create' && ++created === stop) throw new WorkspaceTransactionInterruptedError('row interruption');
    } }), WorkspaceTransactionInterruptedError);
    const original = (await client.listAllComplete()).items;
    assert.equal(original.length, stop);
    const ledgerFile = join(pmRoot, 'transactions', 'beads-transfer', `${plan.digest}.json`);
    const ledger = JSON.parse(await readFile(ledgerFile, 'utf8')) as { rows: Record<string, { pmId: string; itemHash: string | null }> };
    for (const item of original) {
      const pin = Object.values(ledger.rows).find(pin => pin.pmId === item.id);
      assert.match(pin!.itemHash!, /^[a-f0-9]{64}$/);
    }
    // The exact unchanged plan is replayed after changing just one ambient input.
    const rawSettings = await readFile(join(pmRoot, 'settings.json'), 'utf8');
    const sessionFile = join(pmRoot, 'runtime', 'session.json');
    if (setting === 'id_prefix' || setting === 'ids') {
      const receiverSettings = await readSettings(pmRoot);
      if (setting === 'id_prefix') receiverSettings.id_prefix = 'changed-';
      else receiverSettings.ids.token_length = 8;
      await writeFile(join(pmRoot, 'settings.json'), JSON.stringify(receiverSettings));
    } else if (setting === 'templates') {
      await mkdir(join(pmRoot, 'templates'), { recursive: true });
      await writeFile(join(pmRoot, 'templates', 'ambient.json'), JSON.stringify({ options: { tags: 'changed' } }));
    } else {
      await mkdir(join(pmRoot, 'runtime'), { recursive: true });
      await writeFile(sessionFile, JSON.stringify({ focused_item: original[0].id }));
    }
    if (stop < 3) await assert.rejects(applyBeadsTransfer(pmRoot, plan, 'resume', { maxChunks: 3 }), changed);
    else {
      const receipt = await applyBeadsTransfer(pmRoot, plan, 'resume', { maxChunks: 3 });
      assert.equal(receipt.transferred, 3); assert.equal(receipt.skipped, 0); assert.equal(receipt.complete, true);
    }
    assert.equal((await client.listAllComplete()).items.length, stop);
    assert.equal(await readFile(ledgerFile, 'utf8'), JSON.stringify(ledger) + '\n');
    await writeFile(join(pmRoot, 'settings.json'), rawSettings);
    if (setting === 'templates') await rm(join(pmRoot, 'templates'), { recursive: true });
    if (setting === 'focus') await rm(sessionFile);
    const resumed = await applyBeadsTransfer(pmRoot, plan, 'resume', { maxChunks: 3 });
    assert.equal(resumed.transferred, 3); assert.equal(resumed.complete, true);
    const items = (await client.listAllComplete()).items;
    assert.equal(items.length, 3); assert.equal(new Set(items.map(item => item.id)).size, 3);
    for (const item of original) assert.ok(items.some(current => current.id === item.id));
    for (const item of items) for (const edge of item.dependencies ?? []) assert.ok(items.some(target => target.id === edge.id));
    assert.equal((await applyBeadsTransfer(pmRoot, plan, 'replay', { maxChunks: 3 })).replayedChunks, 3 / chunkSize);
  }
});

test('settings changed before first apply refuse; committed replay verifies missing and edited pinned items', async t => {
  const { pmRoot, client } = await receiver(t);
  const plan = planBeadsTransfer('{"id":"a","title":"A"}', ['a'], 'initial-drift', await snapshotBeadsTransferSettings(pmRoot));
  const raw = await readFile(join(pmRoot, 'settings.json'), 'utf8');
  const settings = await readSettings(pmRoot); settings.id_prefix = 'changed-';
  await writeFile(join(pmRoot, 'settings.json'), JSON.stringify(settings));
  await assert.rejects(applyBeadsTransfer(pmRoot, plan, 'apply'), changed);
  assert.equal((await client.listAllComplete()).items.length, 0);
  await writeFile(join(pmRoot, 'settings.json'), raw);
  const created = await applyBeadsTransfer(pmRoot, plan, 'apply');
  const id = created.rows[0].pmId;
  await client.update(id, { title: 'Peer edit' });
  let replay = await applyBeadsTransfer(pmRoot, plan, 'replay');
  assert.equal(replay.transferred, 0); assert.equal(replay.skipped, 1); assert.equal(replay.rows[0].reason, 'item_changed');
  const item = await locateItem(pmRoot, id); assert.ok(item);
  await rm(item.itemPath);
  replay = await applyBeadsTransfer(pmRoot, plan, 'replay');
  assert.equal(replay.transferred, 0); assert.equal(replay.skipped, 1);
  assert.equal((await client.listAllComplete()).items.length, 0);
});

test('creation-to-journal interruption recovers only its recorded identity and an unchanged creation', async t => {
  for (const variant of ['unchanged', 'edited', 'raw-edit']) {
    const { pmRoot, client } = await receiver(t);
    const plan = planBeadsTransfer('{"id":"a","title":"A"}', ['a'], `gap-${variant}`, await snapshotBeadsTransferSettings(pmRoot));
    let id = '';
    await assert.rejects(applyBeadsTransfer(pmRoot, plan, 'apply', { onRowTransition(c) {
      if (c.phase === 'created_unrecorded') { id = c.pmId; throw new WorkspaceTransactionInterruptedError('creation gap'); }
    } }), WorkspaceTransactionInterruptedError);
    if (variant === 'edited') await client.update(id, { title: 'Peer edit before identity hash was recorded' });
    if (variant === 'raw-edit') {
      const item = await locateItem(pmRoot, id); assert.ok(item);
      const raw = await readFile(item.itemPath, 'utf8');
      const edited = raw.replace(/^title:.*$/m, 'title: "Untracked edit"');
      assert.notEqual(edited, raw); await writeFile(item.itemPath, edited);
    }
    const receipt = await applyBeadsTransfer(pmRoot, plan, 'resume');
    assert.equal(receipt.transferred, variant === 'unchanged' ? 1 : 0);
    assert.equal(receipt.skipped, variant === 'unchanged' ? 0 : 1);
    assert.equal((await client.listAllComplete()).items.length, 1);
    assert.equal(receipt.rows[0].pmId, id);
  }
});

test('lost, corrupt and mismatched identity journals refuse instead of reconstructing identities', async t => {
  for (const variant of ['missing', 'json', 'shape', 'duplicate', 'hash', 'extra']) {
    const { pmRoot, client } = await receiver(t);
    const plan = planBeadsTransfer('{"id":"a","title":"A"}\n{"id":"b","title":"B"}', ['a', 'b'], `journal-${variant}`, await snapshotBeadsTransferSettings(pmRoot));
    const receipt = await applyBeadsTransfer(pmRoot, plan, 'apply');
    const file = join(pmRoot, 'transactions', 'beads-transfer', `${plan.digest}.json`);
    const journal = JSON.parse(await readFile(file, 'utf8')) as { rows: Record<string, { pmId: string; itemHash: string | null }> };
    if (variant === 'missing') await rm(file);
    else if (variant === 'json') await writeFile(file, '{');
    else {
      if (variant === 'shape') delete journal.rows.a;
      if (variant === 'duplicate') journal.rows.b.pmId = journal.rows.a.pmId;
      if (variant === 'hash') journal.rows.a.itemHash = 'bad';
      if (variant === 'extra') journal.rows.a.pmId = 'foreign-pin';
      await writeFile(file, JSON.stringify(journal));
    }
    await assert.rejects(applyBeadsTransfer(pmRoot, plan, 'resume'), (error: unknown) => error instanceof BeadsTransferRefusal && error.code === 'invalid_journal');
    const items = (await client.listAllComplete()).items;
    assert.equal(items.length, 2); assert.ok(items.some(item => item.id === receipt.rows[0].pmId));
  }
});

test('identity bootstrap interruption and ordinary compensation retain the same pins', async t => {
  for (const transition of ['step_applied', 'committing'] as const) {
    const { pmRoot } = await receiver(t);
    const plan = planBeadsTransfer('{"id":"a","title":"A"}', ['a'], `bootstrap-${transition}`, await snapshotBeadsTransferSettings(pmRoot));
    await assert.rejects(applyBeadsTransfer(pmRoot, plan, 'apply', { onIdentityTransition(c) {
      if (c.transition === transition) {
        if (transition === 'step_applied') throw new WorkspaceTransactionInterruptedError('bootstrap interrupted');
        throw new Error('ordinary bootstrap failure');
      }
    } }));
    const file = join(pmRoot, 'transactions', 'beads-transfer', `${plan.digest}.json`);
    const pins = JSON.parse(await readFile(file, 'utf8')) as { rows: Record<string, { pmId: string }> };
    const receipt = await applyBeadsTransfer(pmRoot, plan, 'resume');
    assert.equal(receipt.transferred, 1); assert.equal(receipt.rows[0].pmId, pins.rows.a.pmId);
  }
});

test('ledger disappearance at mutation boundaries refuses without recreating progress', async t => {
  for (const boundary of ['prepared', 'created_unrecorded', 'committed'] as const) {
    const { pmRoot, client } = await receiver(t);
    const plan = planBeadsTransfer('{"id":"a","title":"A"}', ['a'], `lost-${boundary}`, await snapshotBeadsTransferSettings(pmRoot));
    const file = join(pmRoot, 'transactions', 'beads-transfer', `${plan.digest}.json`);
    await assert.rejects(applyBeadsTransfer(pmRoot, plan, 'apply', {
      async onTransition(c) { if (c.transition === boundary) await rm(file); },
      async onRowTransition(c) { if (c.phase === boundary) await client.delete(c.pmId, { force: true }); },
    }), (error: unknown) => error instanceof BeadsTransferRefusal && error.code === 'invalid_journal');
    assert.equal((await client.listAllComplete()).items.length, boundary === 'committed' ? 1 : 0);
  }
});

test('plan validation rejects malformed snapshots and descriptions without modifying its input', async t => {
  const { pmRoot } = await receiver(t), settings = await snapshotBeadsTransferSettings(pmRoot);
  for (const invalid of [null, { ...settings, focus: 1 }]) {
    assert.throws(() => planBeadsTransfer('{"id":"a","title":"A"}', ['a'], 'bad-settings', invalid as unknown as typeof settings),
      (error: unknown) => error instanceof BeadsTransferRefusal && error.code === 'invalid_input');
  }
  const plan = planBeadsTransfer('{"id":"a","title":"A"}', ['a'], 'bad-description', settings);
  const invalid = structuredClone(plan); Object.assign(invalid.records[0].fields, { description: 1 });
  assert.throws(() => validateBeadsTransferPlan(invalid), (error: unknown) => error instanceof BeadsTransferRefusal && error.code === 'invalid_plan');
});

test('template snapshot is deterministic and refuses unreadable or indirect ambient state', async t => {
  const { pmRoot } = await receiver(t);
  const templates = join(pmRoot, 'templates');
  await mkdir(join(templates, 'nested'), { recursive: true });
  await writeFile(join(templates, 'a.json'), '{}'); await writeFile(join(templates, 'b.json'), '{}');
  await writeFile(join(templates, 'nested', 'child.json'), '{}');
  const settings = await snapshotBeadsTransferSettings(pmRoot);
  assert.deepEqual(await snapshotBeadsTransferSettings(pmRoot), settings);
  await symlink(join(templates, 'a.json'), join(templates, 'linked.json'));
  await assert.rejects(snapshotBeadsTransferSettings(pmRoot), (error: unknown) => error instanceof BeadsTransferRefusal && error.code === 'invalid_input');
  await rm(templates, { recursive: true }); await writeFile(templates, '{}');
  await assert.rejects(snapshotBeadsTransferSettings(pmRoot), { code: 'ENOTDIR' });
  await rm(templates); await mkdir(join(pmRoot, 'runtime', 'session.json'), { recursive: true });
  await assert.rejects(snapshotBeadsTransferSettings(pmRoot), { code: 'EISDIR' });
});

test('prefix drift after the only created row replays its recorded identity without duplicating a', async t => {
  const { pmRoot, client } = await receiver(t);
  const plan = planBeadsTransfer('{"id":"a","title":"A"}', ['a'], 'prefix-replay', await snapshotBeadsTransferSettings(pmRoot));
  let originalId = '';
  await assert.rejects(applyBeadsTransfer(pmRoot, plan, 'apply', { onRowTransition(c) {
    if (c.phase === 'after_create') { originalId = c.pmId; throw new WorkspaceTransactionInterruptedError('created a'); }
  } }), WorkspaceTransactionInterruptedError);
  const settings = await readSettings(pmRoot); settings.id_prefix = 'changed-';
  await writeFile(join(pmRoot, 'settings.json'), JSON.stringify(settings));
  const receipt = await applyBeadsTransfer(pmRoot, plan, 'resume');
  assert.equal((await client.listAllComplete()).items.length, 1, 'the same source row must never acquire a second identity');
  assert.equal(receipt.transferred, 1); assert.equal(receipt.rows[0].pmId, originalId); assert.equal(receipt.complete, true);
});
