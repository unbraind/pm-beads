/** Read purity, explicit migration, lock guards and authors on real non-git trackers. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { PmClient, getHistoryPath, readHistorySnapshot, locateItem, runWithActiveExtensions } from '@unbrained/pm-cli/sdk';
import { listAllItemMetadata } from '@unbrained/pm-cli/sdk/runtime';
import { migrateBeadIdentities, type BeadsMigrationBoundary } from '../identity.ts';
import { acknowledgeBeadsSnapshot, parseBeadsSnapshot, readLiveBeadsSnapshot, planBeadsReconciliation, applyBeadsReconciliation } from '../reconcile.ts';
import { planBeadsTransfer, snapshotBeadsTransferSettings } from '../transfer.ts';
import { harness, runCommand } from './helpers.ts';

const root = resolve(import.meta.dirname, '..');

/** Include every regular file's bytes, symlink target and directory, without following dependencies. */
async function trackerBytes(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  /** Walk only the disposable tracker, including hidden files and history. */
  async function visit(relative: string): Promise<void> {
    for (const entry of await readdir(join(dir, relative), { withFileTypes: true })) {
      const name = join(relative, entry.name);
      if (entry.isDirectory()) { files[name] = 'directory'; await visit(name); }
      else if (entry.isSymbolicLink()) files[name] = `symlink:${await readlink(join(dir, name))}`;
      else files[name] = (await readFile(join(dir, name))).toString('base64');
    }
  }
  await visit(''); return files;
}

test('every read-only legacy command preserves the whole tracker bytes and history', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'beads-pure-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const pmRoot = join(dir, 'tracker'), extension = join(pmRoot, 'extensions', 'pm-beads');
  const client = new PmClient({ pmRoot, author: 'fixture', noExtensions: true }); await client.init('sample');
  const item = (await client.create({ title: 'Original', description: 'Body\n\n[bead_id: legacy]' })).item;
  const input = join(dir, 'rows.jsonl'), output = join(dir, 'export.jsonl'), plan = join(dir, 'plan.json');
  const raw = '{"id":"legacy","title":"Original","description":"Body"}\n'; await writeFile(input, raw);
  await acknowledgeBeadsSnapshot(pmRoot, 'team', parseBeadsSnapshot(raw), 'fixture');
  await client.create({ title: 'Pending legacy', description: '[bead_id: pending]' });
  await mkdir(extension, { recursive: true });
  for (const entry of ['dist', 'manifest.json', 'package.json']) await cp(join(root, entry), join(extension, entry), { recursive: true });
  await symlink(join(root, 'node_modules'), join(extension, 'node_modules'), 'junction');
  // PM's derived runtime caches are initialized during fixture setup, using core
  // reads only. No Beads command runs before the byte snapshot or can pre-migrate it.
  await client.listAllComplete();
  const primed = spawnSync(process.execPath, [join(root, 'node_modules', '@unbrained', 'pm-cli', 'dist', 'cli.js'), '--path', pmRoot, '--json', 'list', '--all', '--full'], { cwd: dir, encoding: 'utf8' });
  assert.equal(primed.status, 0, primed.stderr);
  await runWithActiveExtensions({ path: pmRoot }, async () => { await listAllItemMetadata(pmRoot); });
  const baseline = await trackerBytes(pmRoot);
  /** All output files stay outside the tracker whose full bytes are certified. */
  const commands = [
    ['list', '--all', '--full'], ['ops', 'stats'],
    ['beads', 'export', '--output', output], ['beads-export', '--dry-run'],
    ['beads', 'export', '--dry-run', '--output', output],
    ['beads', 'diff', input, '--against-workspace'], ['beads', 'validate', input],
    ['beads', 'import', input, '--dry-run', '--upsert'], ['beads', 'import', input, '--validate-only'],
    ['beads', 'reconcile', input, '--source', 'team'],
    ['beads-reconcile', input, '--source', 'team', '--plan-out', plan],
    ['beads', 'transfer', input, '--source', 'team', '--select', 'legacy'],
    ['beads-transfer', input, '--source', 'team', '--select', 'legacy', '--plan-out', plan],
    ['beads', 'migrate-identities'],
    ['beads', 'transfer', input, '--source', 'team', '--select', 'legacy', '--migrate-identities'],
  ];
  for (const args of commands) {
    const result = spawnSync(process.execPath, [join(root, 'node_modules', '@unbrained', 'pm-cli', 'dist', 'cli.js'), '--path', pmRoot, '--json', ...args], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: join(root, 'node_modules', '.bin') + delimiter + process.env.PATH, GIT_CEILING_DIRECTORIES: tmpdir() },
    });
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout} ${result.stderr}`);
    const after = await trackerBytes(pmRoot);
    assert.deepEqual(Object.keys(after), Object.keys(baseline), args.join(' '));
    for (const name of Object.keys(baseline)) assert.equal(after[name], baseline[name], `${args.join(' ')}: ${name}`);
    if (args[1] === 'export' || args[1] === 'reconcile') assert.match(result.stderr, /need identity migration/);
  }
  await readLiveBeadsSnapshot(pmRoot);
  await planBeadsReconciliation(pmRoot, 'team', parseBeadsSnapshot(raw));
  assert.deepEqual(await trackerBytes(pmRoot), baseline, 'SDK snapshots and plans are also pure');
  assert.equal((await client.get(item.id)).item.bead_id, undefined);
});

test('migration previews by default and skips peer edits at every read-to-write boundary', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'beads-guard-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const client = new PmClient({ pmRoot: dir, author: 'fixture', noExtensions: true }); await client.init('sample');
  for (const boundary of ['listed', 'located', 'read', 'before_schema', 'after_schema', 'before_update', 'locked'] satisfies BeadsMigrationBoundary[]) {
    const item = (await client.create({ title: boundary, description: `Body\n\n[bead_id: ${boundary}]` })).item;
    await client.listAllComplete();
    const before = await trackerBytes(dir);
    const preview = await migrateBeadIdentities(dir);
    assert.ok(preview.pending.includes(item.id)); assert.equal(preview.dryRun, true);
    assert.deepEqual(await trackerBytes(dir), before);
    let peerEdit: Promise<unknown> | undefined;
    let edited = false;
    const receipt = await migrateBeadIdentities(dir, 'migrator', { apply: true, async onTransition(phase, id) {
      if (id !== item.id || phase !== boundary || edited) return;
      edited = true;
      // Once locked, a real SDK peer queues behind migration; waiting here would deadlock.
      const child = spawn(process.execPath, ['--input-type=module', '-e',
        `import { PmClient } from '@unbrained/pm-cli/sdk';
        const client = new PmClient({ pmRoot: process.argv[1], author: 'peer', noExtensions: true });
        process.stdout.write('ready\\n');
        await client.update(process.argv[2], { title: 'Peer title', description: 'Peer description', message: 'Peer edit' });`, dir, id], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      let errors = ''; child.stderr.on('data', chunk => { errors += String(chunk); });
      peerEdit = new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(errors))); });
      if (phase === 'locked') await new Promise<void>(resolve => { child.stdout.once('data', () => resolve()); });
      else await peerEdit;
    } });
    await peerEdit;
    assert.ok(edited);
    const saved = (await client.get(item.id)).item;
    assert.equal(saved.title, 'Peer title'); assert.equal(saved.description, 'Peer description');
    if (boundary === 'listed' || boundary === 'located') { assert.ok(!receipt.pending.includes(item.id)); assert.equal(saved.bead_id, undefined); }
    else if (boundary === 'locked') { assert.ok(receipt.migrated.includes(item.id)); assert.equal(saved.bead_id, boundary); }
    else { assert.ok(receipt.skipped.includes(item.id)); assert.equal(saved.bead_id, undefined); }
    const history = (await readHistorySnapshot(getHistoryPath(dir, item.id), item.id)).entries;
    assert.equal(history.at(-1)!.author, 'peer');
    if (boundary !== 'locked') assert.ok(!history.some(entry => entry.message?.includes('Migrate legacy')));
  }
});

test('explicit migration CLI history honors author flag then environment then package default', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'beads-authors-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const pmRoot = join(dir, 'tracker'), extension = join(pmRoot, 'extensions', 'pm-beads');
  const client = new PmClient({ pmRoot, author: 'fixture', noExtensions: true }); await client.init('sample');
  await mkdir(extension, { recursive: true });
  for (const entry of ['dist', 'manifest.json', 'package.json']) await cp(join(root, entry), join(extension, entry), { recursive: true });
  await symlink(join(root, 'node_modules'), join(extension, 'node_modules'), 'junction');
  for (const [author, environment, expected] of [['reviewer', 'environment', 'reviewer'], [undefined, 'environment', 'environment'], [undefined, undefined, 'pm-beads']]) {
    const item = (await client.create({ title: expected!, description: `Body\n\n[bead_id: ${expected}]` })).item;
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: '', GIT_CEILING_DIRECTORIES: tmpdir() }; delete env.PM_AUTHOR;
    if (environment) env.PM_AUTHOR = environment;
    const args = author ? ['--author', author] : [];
    const result = spawnSync(process.execPath, [join(root, 'node_modules', '@unbrained', 'pm-cli', 'dist', 'cli.js'), '--path', pmRoot, '--json', ...args, 'beads', 'migrate-identities', '--apply'], { cwd: dir, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).migrated, [item.id]);
    assert.equal((await client.get(item.id)).item.description, 'Body');
    const history = (await readHistorySnapshot(getHistoryPath(pmRoot, item.id), item.id)).entries;
    assert.equal(history.at(-1)!.author, expected);
    // The CLI host may normalize --author into PM_AUTHOR. Exercise the handler's
    // explicit SDK boundary separately so that host behavior cannot mask a regression.
    const previous = process.env.PM_AUTHOR;
    try {
      if (environment) process.env.PM_AUTHOR = environment; else delete process.env.PM_AUTHOR;
      const sdkItem = (await client.create({ title: 'SDK legacy', description: '[bead_id: sdk-legacy]' })).item;
      await migrateBeadIdentities(pmRoot, author, { apply: true });
      const sdkHistory = (await readHistorySnapshot(getHistoryPath(pmRoot, sdkItem.id), sdkItem.id)).entries;
      assert.equal(sdkHistory.at(-1)!.author, expected);
    } finally { if (previous === undefined) delete process.env.PM_AUTHOR; else process.env.PM_AUTHOR = previous; }
  }
});

test('transfer apply explicitly migrates legacy identity with the invocation author', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'beads-transfer-migration-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const client = new PmClient({ pmRoot: dir, author: 'fixture', noExtensions: true }); await client.init('sample');
  const item = (await client.create({ title: 'Legacy', description: '[bead_id: old]' })).item;
  const plan = planBeadsTransfer('{"id":"new","title":"New"}', ['new'], 'team', await snapshotBeadsTransferSettings(dir));
  assert.equal((await client.get(item.id)).item.bead_id, undefined);
  const file = join(dir, 'plan.json'); await writeFile(file, JSON.stringify(plan));
  const ext = await harness(); t.after(() => ext.deactivate());
  await runCommand(ext, { command: 'beads transfer', pmRoot: dir, options: { applyPlan: file, migrateIdentities: true }, global: { author: 'transfer-author' } });
  assert.equal((await client.get(item.id)).item.bead_id, 'old');
  const history = (await readHistorySnapshot(getHistoryPath(dir, item.id), item.id)).entries;
  assert.equal(history.at(-1)!.author, 'transfer-author');
  const second = (await client.create({ title: 'Second legacy', description: '[bead_id: second]' })).item;
  await runCommand(ext, { command: 'beads-transfer', pmRoot: dir, options: { 'apply-plan': file, 'migrate-identities': true }, global: { author: 'alias-author' } });
  assert.equal((await client.get(second.id)).item.bead_id, 'second');
  assert.equal((await readHistorySnapshot(getHistoryPath(dir, second.id), second.id)).entries.at(-1)!.author, 'alias-author');
});

test('migration skips vanished items and propagates unrelated SDK mutation failures', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'beads-migration-errors-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const client = new PmClient({ pmRoot: dir, author: 'fixture', noExtensions: true }); await client.init('sample');
  const item = (await client.create({ title: 'Gone', description: '[bead_id: old]' })).item;
  const located = (await locateItem(dir, item.id))!;
  const skipped = await migrateBeadIdentities(dir, 'migrator', { apply: true, async onTransition(phase) {
    if (phase === 'listed') await rm(located.itemPath);
  } });
  assert.deepEqual(skipped.skipped, [item.id]);
  // A separate disposable tracker avoids fabricating history for the vanished fixture.
  const other = join(dir, 'other'); const second = new PmClient({ pmRoot: other, author: 'fixture', noExtensions: true }); await second.init('sample');
  await second.create({ title: 'Legacy', description: '[bead_id: legacy]' });
  await assert.rejects(migrateBeadIdentities(other, 'migrator', { apply: true, onTransition(phase) {
    if (phase === 'locked') throw new Error('observer failure');
  } }), /Extension mutation guard/);
  const ext = await harness(); t.after(() => ext.deactivate());
  const preview = await runCommand(ext, { command: 'beads migrate-identities', pmRoot: other });
  assert.equal((preview as { dryRun: boolean }).dryRun, true);
});


test('migration guards annotation-only edits and skips deletion immediately before update', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'beads-migration-annotations-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const client = new PmClient({ pmRoot: dir, author: 'fixture', noExtensions: true }); await client.init('sample');
  for (const operation of ['annotation', 'delete']) {
    const item = (await client.create({ title: 'Legacy', description: '[bead_id: legacy]' })).item;
    const located = (await locateItem(dir, item.id))!;
    const result = await migrateBeadIdentities(dir, 'migrator', { apply: true, async onTransition(phase, id) {
      if (phase !== 'before_update' || id !== item.id) return;
      if (operation === 'delete') await rm(located.itemPath);
      else await client.comments(item.id, { add: 'Peer annotation', author: 'peer' });
    } });
    assert.ok(result.skipped.includes(item.id));
    if (operation === 'annotation') {
      const saved = (await client.get(item.id)).item;
      assert.equal(saved.bead_id, undefined); assert.equal(saved.description, '[bead_id: legacy]');
      assert.equal((await client.comments(item.id)).comments.at(-1)!.text, 'Peer annotation');
    }
  }
});

test('reconciliation requires explicit migration before replacing legacy descriptions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'beads-reconcile-migration-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const client = new PmClient({ pmRoot: dir, author: 'fixture', noExtensions: true }); await client.init('sample');
  const item = (await client.create({ title: 'Legacy', description: 'Body\n\n[bead_id: legacy]' })).item;
  await acknowledgeBeadsSnapshot(dir, 'team', parseBeadsSnapshot('{"id":"legacy","title":"Legacy","description":"Body"}'), 'fixture');
  const incoming = parseBeadsSnapshot('{"id":"legacy","title":"Legacy","description":"Changed"}');
  const plan = await planBeadsReconciliation(dir, 'team', incoming);
  const history = await readFile(getHistoryPath(dir, item.id));
  await assert.rejects(applyBeadsReconciliation(dir, plan, 'reviewer'), /identity_migration_required/);
  assert.deepEqual(await readFile(getHistoryPath(dir, item.id)), history);
  await migrateBeadIdentities(dir, 'reviewer', { apply: true });
  await applyBeadsReconciliation(dir, await planBeadsReconciliation(dir, 'team', incoming), 'reviewer');
  assert.equal((await client.get(item.id)).item.bead_id, 'legacy');
  assert.equal((await client.get(item.id)).item.description, 'Changed');
});


test('migration skips a vanished read and refuses corrupt source bytes', async t => {
  for (const action of ['vanish', 'corrupt']) {
    const dir = await mkdtemp(join(tmpdir(), 'beads-migration-read-')); t.after(() => rm(dir, { recursive: true, force: true }));
    const client = new PmClient({ pmRoot: dir, author: 'fixture', noExtensions: true }); await client.init('sample');
    const item = (await client.create({ title: 'Legacy', description: '[bead_id: legacy]' })).item;
    const located = (await locateItem(dir, item.id))!;
    const run = () => migrateBeadIdentities(dir, 'migrator', { apply: true, async onTransition(phase) {
      if (phase !== 'located') return;
      if (action === 'vanish') await rm(located.itemPath);
      else await writeFile(located.itemPath, new Uint8Array([255]));
    } });
    if (action === 'vanish') assert.deepEqual((await run()).skipped, [item.id]);
    else await assert.rejects(run(), /invalid UTF-8/);
  }
});
