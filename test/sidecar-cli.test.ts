/** Compiled sidecar workflow through the real host and a non-git tracker. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PmClient } from '@unbrained/pm-cli/sdk';

const root = resolve(import.meta.dirname, '..');

test('capture → native import/export → restore preserves unknown nested fields without git', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'beads-sidecar-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pmRoot = join(dir, 'tracker'), extension = join(pmRoot, 'extensions', 'pm-beads'), bin = join(dir, 'bin');
  const client = new PmClient({ pmRoot, author: 'sidecar-test', noExtensions: true });
  await client.init('sample');
  await mkdir(extension, { recursive: true }); await mkdir(bin);
  for (const entry of ['dist', 'manifest.json', 'package.json']) await cp(join(root, entry), join(extension, entry), { recursive: true });
  await symlink(join(root, 'node_modules'), join(extension, 'node_modules'), 'junction');
  await symlink(process.execPath, join(bin, 'node'));
  await symlink(join(root, 'node_modules', '@unbrained', 'pm-cli', 'dist', 'cli.js'), join(bin, 'pm'));
  /** Only node and pinned pm are on PATH, so even accidental git invocation fails. */
  const invoke = (...args: string[]) => spawnSync(process.execPath, [join(bin, 'pm'), '--path', pmRoot, '--author', 'sidecar-test', ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: bin, GIT_CEILING_DIRECTORIES: tmpdir() },
  });
  const file = join(dir, 'incoming.jsonl'), sidecar = join(dir, 'extensions.json'), exported = join(dir, 'exported.jsonl'), restored = join(dir, 'restored.jsonl');
  const vendor = { settings: { layout: ['board', { width: 3, enabled: true, empty: null }] } };
  const records = [{ id: 'bd-alpha', title: 'Import first extension fixture', vendor }, { id: 'bd-beta', title: 'Round-trip second extension fixture', vendor: { another: false }, dependencies: ['bd-alpha'] }];
  await writeFile(file, records.map(row => JSON.stringify(row)).join('\n'));
  const captured = invoke('--json', 'beads', 'sidecar', '--capture', sidecar, file, '--fields', 'vendor');
  assert.equal(captured.status, 0, captured.stdout + captured.stderr);
  assert.equal(JSON.parse(captured.stdout).loss.preservedFields, 2);
  const imported = invoke('--json', 'beads', 'import', file);
  assert.equal(imported.status, 0, imported.stdout + imported.stderr);
  assert.equal(JSON.parse(imported.stdout).imported, 2);
  const exportedResult = invoke('beads', 'export', '--output', exported);
  assert.equal(exportedResult.status, 0, exportedResult.stdout + exportedResult.stderr);
  const result = invoke('beads', 'sidecar', exported, '--restore', sidecar, '--output', restored);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /preservedFields: 2/);
  assert.ok(!result.stdout.includes('layout'), 'compact TOON contains counts, never payloads');
  const rows = (await readFile(restored, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { id: string; vendor: unknown; dependencies?: unknown[] });
  assert.deepEqual(rows.find(row => row.id === 'bd-alpha')?.vendor, vendor);
  assert.deepEqual(rows.find(row => row.id === 'bd-beta')?.vendor, { another: false });
  assert.equal(rows.find(row => row.id === 'bd-beta')?.dependencies?.length, 1);
  const before = (await client.listAllComplete()).items;
  const saved = await readFile(sidecar, 'utf8');
  const savedInput = await readFile(file, 'utf8');
  await symlink('.', join(dir, 'alias'), 'dir');
  for (const args of [
    ['--capture', join(dir, 'alias', 'incoming.jsonl'), '--fields', 'vendor'],
    ['--restore', sidecar, '--output', join(dir, 'alias', 'incoming.jsonl')],
    ['--restore', sidecar, '--output', join(dir, 'alias', 'extensions.json')],
  ]) {
    const collision = invoke('--json', 'beads', 'sidecar', file, ...args);
    assert.equal(collision.status, 2, collision.stdout + collision.stderr);
    assert.match(collision.stdout + collision.stderr, /invalid_input/);
    assert.equal(await readFile(file, 'utf8'), savedInput);
    assert.equal(await readFile(sidecar, 'utf8'), saved);
  }
  const native = invoke('--json', 'beads', 'sidecar', file, '--capture', sidecar, '--fields', 'description');
  assert.equal(native.status, 2, native.stdout + native.stderr);
  assert.match(native.stdout + native.stderr, /native_conflict/);
  await writeFile(file, JSON.stringify({ id: 'bd-alpha', title: 'Unsafe', vendor: { nested: [{ API_KEY: 'synthetic' }] } }));
  const privacy = invoke('--json', 'beads', 'sidecar', file, '--capture', sidecar, '--fields', 'vendor');
  assert.equal(privacy.status, 2, privacy.stdout + privacy.stderr);
  assert.match(privacy.stdout + privacy.stderr, /privacy_limit/);
  assert.equal(await readFile(sidecar, 'utf8'), saved);
  assert.deepEqual((await client.listAllComplete()).items, before);
});
