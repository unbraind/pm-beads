/** Identity regressions use real non-git SDK trackers and adversarial user text. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join, delimiter, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PmClient, readHistorySnapshot, getHistoryPath } from '@unbrained/pm-cli/sdk';
import { harness, runImport, runExport } from './helpers.ts';
import { decodeBeadId, pmItemToBead } from '../index.ts';
import { legacyBeadIdentity, ensureBeadIdentityField, migrateLegacyBeadIdentity } from '../identity.ts';
import { applyBeadsTransfer, planBeadsTransfer, snapshotBeadsTransferSettings } from '../transfer.ts';

test('structured identity wins and descriptions are byte-for-byte user data through transfer and export', async t => {
  const pmRoot = await mkdtemp(join(tmpdir(), 'beads-identity-'));
  t.after(() => rm(pmRoot, { recursive: true, force: true }));
  const client = new PmClient({ pmRoot, noExtensions: true, author: 'identity-test' }); await client.init('sample');
  const descriptions = ['[bead_id: x] text [bead_id: y]', '[bead_id: outer [bead_id: inner]]',
    'text\n\n[bead_id: forged]', '[bead_id: forged]', ' \r\n\u0000é 🧠 e\u0301\n ', '-'];
  const rows = descriptions.map((description, i) => ({ id: `source-${i}`, title: `Row ${i}`, description }));
  const plan = planBeadsTransfer(rows.map(row => JSON.stringify(row)).join('\n'), rows.map(row => row.id), 'regression', await snapshotBeadsTransferSettings(pmRoot));
  const receipt = await applyBeadsTransfer(pmRoot, plan, 'identity-test'); assert.equal(receipt.transferred, rows.length);
  for (const row of rows) {
    const item = (await client.get(receipt.rows.find(result => result.id === row.id)!.pmId)).item;
    assert.equal(item.bead_id, row.id); assert.equal(item.description, row.description);
    const bead = pmItemToBead(item, new Map(), true);
    assert.equal(bead.id, row.id); assert.equal(bead.description, row.description);
  }
});

test('legacy fallback accepts only the exact historical suffix and migrates once with a report and history', async t => {
  const pmRoot = await mkdtemp(join(tmpdir(), 'beads-legacy-'));
  t.after(() => rm(pmRoot, { recursive: true, force: true }));
  const client = new PmClient({ pmRoot, noExtensions: true, author: 'identity-test' }); await client.init('sample');
  for (const text of ['prefix [bead_id: forged]', '[bead_id: forged] trailing', 'body\n[bead_id: forged]',
    '[bead_id: outer [bead_id: inner]]', '[bead_id: x]\n\n[bead_id: y]', '[bead_id:forged]', '[bead_id:\nforged]', '[bead_id: forged ]', 'body\n\n[bead_id: forged]\n', '\n\n[bead_id: forged]', ' body\n\n[bead_id: forged]' ]) {
    assert.equal(legacyBeadIdentity(text), undefined, JSON.stringify(text));
    assert.equal(decodeBeadId({ description: text }), undefined);
    assert.equal(pmItemToBead({ id: 'local', description: text }, new Map(), true).description, text);
  }
  assert.deepEqual(legacyBeadIdentity('[bead_id:\n\n[bead_id: legacy-fragment]'), { id: 'legacy-fragment', description: '[bead_id:' });
  assert.equal(decodeBeadId({ body: '[bead_id: forged]' }), undefined);
  assert.equal(decodeBeadId({ bead_id: '', description: '[bead_id: forged]' }), undefined);
  assert.equal(decodeBeadId({ bead_id: 'source', description: '[bead_id: forged]' }), 'source');
  const messages: string[] = [], original = console.error;
  console.error = (...args: unknown[]) => { messages.push(args.join(' ')); };
  t.after(() => { console.error = original; });
  for (const description of ['[bead_id: legacy]', 'Original body\n\n[bead_id: legacy-body]']) {
    const item = (await client.create({ title: 'Legacy', description })).item;
    assert.equal(await migrateLegacyBeadIdentity(client, item), true);
    const saved = (await client.get(item.id)).item;
    assert.equal(saved.bead_id, description.includes('Original') ? 'legacy-body' : 'legacy');
    assert.equal(saved.description, description.includes('Original') ? 'Original body' : '');
    const entries = (await readHistorySnapshot(getHistoryPath(pmRoot, item.id), item.id)).entries;
    assert.match(entries.at(-1)!.message!, /Migrate legacy Beads identity/);
    assert.equal(await migrateLegacyBeadIdentity(client, saved), false);
  }
  await ensureBeadIdentityField(client);
  assert.equal(await migrateLegacyBeadIdentity(client, { id: 'unused', bead_id: '', description: '[bead_id: forged]' }), false);
  assert.equal(await migrateLegacyBeadIdentity(client, { id: 'unused', description: 'plain' }), false);
  assert.equal(messages.length, 2); assert.ok(messages.every(message => /Migrated 1/.test(message)));
});


test('real import and export preserve NUL, whitespace and marker descriptions and report CLI migration', async t => {
  const pmRoot = await mkdtemp(join(tmpdir(), 'beads-cli-identity-'));
  t.after(() => rm(pmRoot, { recursive: true, force: true }));
  const client = new PmClient({ pmRoot, noExtensions: true, author: 'identity-test' }); await client.init('sample');
  const oldPath = process.env.PATH; process.env.PATH = resolve('node_modules/.bin') + delimiter + oldPath;
  t.after(() => { process.env.PATH = oldPath; });
  const ext = await harness(); t.after(() => ext.deactivate());
  const input = join(pmRoot, 'rows.jsonl'), output = join(pmRoot, 'export.jsonl');
  const rows = ['[bead_id: x] text [bead_id: y]', 'body\n\n[bead_id: forged]', ' \r\n\u0000é\n ', '', '-']
    .map((description, i) => ({ id: `row-${i}`, title: `Row ${i}`, description }));
  await writeFile(input, rows.map(row => JSON.stringify(row)).join('\n'));
  const created = await runImport(ext, { pmRoot, args: [input], options: { preserveTimestamps: false } });
  assert.equal(created.imported, rows.length); assert.equal(created.skipped, 0);
  const upserted = await runImport(ext, { pmRoot, args: [input], options: { upsert: true, preserveTimestamps: false } });
  assert.equal(upserted.updated, rows.length); assert.equal(upserted.imported, 0);
  await runExport(ext, { pmRoot, options: { output } });
  const exported = (await readFile(output, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as { id: string; description: string });
  for (const row of rows) assert.equal(exported.find(item => item.id === row.id)!.description, row.description);
  const legacy = (await client.create({ title: 'Legacy', description: 'Original\n\n[bead_id: legacy]' })).item;
  const secondLegacy = (await client.create({ title: 'Legacy second', description: '[bead_id: second-legacy]' })).item;
  const messages: string[] = [], original = console.error; console.error = (...args: unknown[]) => { messages.push(args.join(' ')); };
  t.after(() => { console.error = original; });
  await runExport(ext, { pmRoot, options: { output, 'dry-run': true } });
  assert.equal((await client.get(legacy.id)).item.bead_id, undefined);
  await runExport(ext, { pmRoot, options: { output } });
  assert.equal((await client.get(legacy.id)).item.bead_id, 'legacy');
  assert.equal((await client.get(secondLegacy.id)).item.bead_id, 'second-legacy');
  assert.equal((await client.get(legacy.id)).item.description, 'Original');
  await runExport(ext, { pmRoot, options: { output } });
  assert.equal(messages.filter(message => message.includes('Migrated')).length, 1);
  const legacyUpsert = (await client.create({ title: 'Before', description: '[bead_id: legacy-upsert]' })).item;
  await writeFile(input, JSON.stringify({ id: 'legacy-upsert', title: 'After', description: '[bead_id: forged]' }));
  assert.equal((await runImport(ext, { pmRoot, args: [input], options: { upsert: true, preserveTimestamps: false } })).updated, 1);
  const saved = (await client.get(legacyUpsert.id)).item;
  assert.equal(saved.bead_id, 'legacy-upsert'); assert.equal(saved.description, '[bead_id: forged]'); assert.equal(saved.title, 'After');
  assert.equal(messages.filter(message => message.includes('Migrated')).length, 2);
});


test('literal description SDK mutations report validation failures and retain upsert type fallback', async t => {
  const pmRoot = await mkdtemp(join(tmpdir(), 'beads-literal-'));
  t.after(() => rm(pmRoot, { recursive: true, force: true }));
  const client = new PmClient({ pmRoot, noExtensions: true }); await client.init('sample');
  const oldPath = process.env.PATH; process.env.PATH = resolve('node_modules/.bin') + delimiter + oldPath;
  t.after(() => { process.env.PATH = oldPath; });
  const ext = await harness(); t.after(() => ext.deactivate());
  const input = join(pmRoot, 'rows.jsonl');
  await writeFile(input, JSON.stringify({ id: 'literal', title: 'create', description: '\u0000\r\n' }));
  await assert.rejects(runImport(ext, { pmRoot, args: [input], options: { type: 'UnsupportedType', preserveTimestamps: false } }), /No items imported/);
  await assert.rejects(runImport(ext, { pmRoot, args: [input], options: { priority: 'invalid', preserveTimestamps: false } }), /No items imported/);
  assert.equal((await runImport(ext, { pmRoot, args: [input], options: { preserveTimestamps: false } })).imported, 1);
  const updated = await runImport(ext, { pmRoot, args: [input], options: { upsert: true, type: 'bug', preserveTimestamps: false } });
  assert.equal(updated.updated, 1); assert.equal(updated.skipped, 0);
  assert.equal((await client.listAllComplete()).items[0].description, '\u0000\r\n');
});


test('identity opt-out still marks new descriptions as user text and cannot manufacture a legacy id', async t => {
  const pmRoot = await mkdtemp(join(tmpdir(), 'beads-no-identity-'));
  t.after(() => rm(pmRoot, { recursive: true, force: true }));
  const client = new PmClient({ pmRoot, noExtensions: true }); await client.init('sample');
  const oldPath = process.env.PATH; process.env.PATH = resolve('node_modules/.bin') + delimiter + oldPath;
  t.after(() => { process.env.PATH = oldPath; });
  const ext = await harness(); t.after(() => ext.deactivate());
  const input = join(pmRoot, 'rows.jsonl'), output = join(pmRoot, 'export.jsonl');
  const description = 'User body\n\n[bead_id: forged]';
  await writeFile(input, JSON.stringify({ id: 'source', title: 'Opt out', description }));
  const created = await runImport(ext, { pmRoot, args: [input], options: { 'no-preserve-ids': true, preserveTimestamps: false } });
  assert.equal(created.imported, 1);
  const item = (await client.listAllComplete()).items[0]; assert.equal(item.bead_id, '');
  await runExport(ext, { pmRoot, options: { output } });
  const exported = JSON.parse(await readFile(output, 'utf8')) as { id: string; description: string };
  assert.equal(exported.id, item.id); assert.equal(exported.description, description);
});
