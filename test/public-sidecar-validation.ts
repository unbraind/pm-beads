/** Read-only public-tracker measurement; synthetic extension values are clearly distinguished. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { captureBeadsExtensions, restoreBeadsExtensions, BeadsSidecarRefusal, pmItemToBead, decodeBeadId, type PmItem } from '../index.ts';

const root = resolve(import.meta.dirname, '..');
const sourceHead = execFileSync('git', ['-C', root, 'rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();
const sourceTrackerTree = execFileSync('git', ['-C', root, 'rev-parse', 'origin/main:.agents/pm'], { encoding: 'utf8' }).trim();
const dir = await mkdtemp(join(tmpdir(), 'beads-sidecar-public-'));
const originalPath = process.env.PATH;
const originalCeiling = process.env.GIT_CEILING_DIRECTORIES;
const started = performance.now();
/** Protect the archived tracker against incidental caches while preserving removable scratch storage. */
async function readonlyTree(directory: string, enabled: boolean): Promise<void> {
  if (!enabled) await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await readonlyTree(join(directory, entry.name), enabled);
    else await chmod(join(directory, entry.name), enabled ? 0o400 : 0o600);
  }
  if (enabled) await chmod(directory, 0o500);
}
/** Hash every copied tracker file to demonstrate that validation is read-only. */
async function treeDigest(directory: string): Promise<string> {
  const hash = createHash('sha256');
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(entry.name);
    hash.update(entry.isDirectory() ? await treeDigest(join(directory, entry.name)) : await readFile(join(directory, entry.name)));
  }
  return hash.digest('hex');
}
try {
  const archive = execFileSync('git', ['-C', root, 'archive', 'origin/main', '.agents/pm'], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', dir], { input: archive });
  const pmRoot = join(dir, '.agents', 'pm');
  await readonlyTree(pmRoot, true);
  const copiedBefore = await treeDigest(pmRoot);
  process.env.PATH = ''; process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  const client = new PmClient({ pmRoot, noExtensions: true });
  const { items } = await client.listAllComplete();
  const ids = new Map(items.map(item => [item.id, decodeBeadId(item as PmItem) ?? item.id]));
  const native = items.map(item => pmItemToBead(item as PmItem, ids, true));
  const enriched = native.map((row, i) => ({ ...row, fleet_extension: { nested: { sequence: i, values: [true, null, 'synthetic-extension'] } }, unselected_extension: { retained: false } }));
  const incoming = enriched.map(row => JSON.stringify(row)).join('\n');
  const sidecar = captureBeadsExtensions(incoming, ['fleet_extension']);
  const exported = native.map(row => JSON.stringify(row)).join('\n');
  const result = restoreBeadsExtensions(exported, sidecar);
  const restored = result.text.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  let nestedRestored = 0;
  for (let i = 0; i < restored.length; i++) {
    assert.deepEqual(restored[i].fleet_extension, enriched[i].fleet_extension);
    assert.equal(restored[i].unselected_extension, undefined);
    nestedRestored++;
  }
  const refusals: string[] = [];
  for (const attempt of [
    () => captureBeadsExtensions(incoming, ['dependencies']),
    () => captureBeadsExtensions(JSON.stringify({ id: 'synthetic-private', title: 'Synthetic', fleet_extension: { apiToken: 'synthetic' } }), ['fleet_extension']),
    () => captureBeadsExtensions(JSON.stringify({ id: 'synthetic-large', title: 'Synthetic', fleet_extension: 'x'.repeat(17000) }), ['fleet_extension']),
    () => restoreBeadsExtensions(native.map((row, i) => JSON.stringify(i === 0 ? { ...row, fleet_extension: { conflicting: true } } : row)).join('\n'), sidecar),
  ]) {
    assert.throws(attempt, (error: unknown) => { assert(error instanceof BeadsSidecarRefusal); refusals.push(error.code); return true; });
  }
  assert.equal(await treeDigest(pmRoot), copiedBefore);
  process.env.PATH = originalPath;
  assert.equal(execFileSync('git', ['-C', root, 'rev-parse', 'origin/main:.agents/pm'], { encoding: 'utf8' }).trim(), sourceTrackerTree);
  const receipt = { schema: sidecar.schema, version: sidecar.version, action: 'restore', bytes: Buffer.byteLength(result.text), loss: result.loss,
    remedy: 'Unselected extension fields were omitted; review opt-in fields and recapture if needed.' };
  console.log(JSON.stringify({ source: 'unbraind/pm-beads', sourceHead, sourceTrackerTree, nonGit: true, gitAbsentFromPath: true, sourceUnchanged: true, copiedTrackerUnchanged: true,
    publicItemsRead: items.length, nativeExportRecords: native.length, syntheticNestedExtensionsRestored: nestedRestored, preservedFields: result.loss.preservedFields, droppedFields: result.loss.droppedFields,
    nativeJsonlBytes: Buffer.byteLength(exported), sidecarBytes: Buffer.byteLength(JSON.stringify(sidecar)), restoredJsonlBytes: Buffer.byteLength(result.text), compactJsonBytes: Buffer.byteLength(JSON.stringify(receipt)),
    refusals, elapsedSeconds: Number(((performance.now() - started) / 1000).toFixed(2)) }, null, 2));
} finally {
  if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  if (originalCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = originalCeiling;
  await readonlyTree(dir, false);
  await rm(dir, { recursive: true, force: true });
}
