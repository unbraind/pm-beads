/** Read-only public tracker measurement and transfer acceptance in an independent non-git receiver. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PmClient, WorkspaceTransactionInterruptedError } from '@unbrained/pm-cli/sdk';
import { planBeadsTransfer, snapshotBeadsTransferSettings, applyBeadsTransfer, summarizeBeadsTransfer, BeadsTransferRefusal, pmItemToBead, decodeBeadId, type PmItem } from '../index.ts';
const root = resolve(import.meta.dirname, '..');
const sourceDirectory = process.argv[2] ? resolve(process.argv[2]) : root;
const sourceRepository = process.argv[3] ?? 'unbraind/pm-beads';
const sourceHead = execFileSync('git', ['-C', sourceDirectory, 'rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();
const sourceTrackerTree = execFileSync('git', ['-C', sourceDirectory, 'rev-parse', 'origin/main:.agents/pm'], { encoding: 'utf8' }).trim();
const dir = await mkdtemp(join(tmpdir(), 'beads-transfer-public-'));
const originalPath = process.env.PATH, originalCeiling = process.env.GIT_CEILING_DIRECTORIES;
const started = performance.now();
/** Apply or lift read-only permissions recursively within this one archived tracker. */
async function readonlyTree(directory: string, enabled: boolean): Promise<void> {
  if (!enabled) await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await readonlyTree(join(directory, entry.name), enabled);
    else await chmod(join(directory, entry.name), enabled ? 0o400 : 0o600);
  }
  if (enabled) await chmod(directory, 0o500);
}
/** Hash every archived path and byte to detect incidental writes. */
async function treeDigest(directory: string): Promise<string> {
  const hash = createHash('sha256');
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(entry.name);
    hash.update(entry.isDirectory() ? await treeDigest(join(directory, entry.name)) : await readFile(join(directory, entry.name)));
  }
  return hash.digest('hex');
}
try {
  execFileSync('tar', ['-x', '-C', dir], { input: execFileSync('git', ['-C', sourceDirectory, 'archive', 'origin/main', '.agents/pm'], { maxBuffer: 64 * 1024 * 1024 }) });
  const sourceRoot = join(dir, '.agents', 'pm'); await readonlyTree(sourceRoot, true);
  const before = await treeDigest(sourceRoot);
  process.env.PATH = ''; process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  const source = new PmClient({ pmRoot: sourceRoot, noExtensions: true });
  const { items } = await source.listAllComplete();
  const ids = new Map(items.map(item => [item.id, decodeBeadId(item as PmItem) ?? item.id]));
  const rows = items.map(item => pmItemToBead(item as PmItem, ids, true));
  const text = rows.map(row => JSON.stringify(row)).join('\n');
  const pmRoot = join(dir, 'receiver'); const receiver = new PmClient({ pmRoot, author: 'public-transfer-validation', noExtensions: true }); await receiver.init('sample');
  const settings = await snapshotBeadsTransferSettings(pmRoot);
  const plan = planBeadsTransfer(text, rows.map(row => row.id!), 'public-fleet', settings, { chunkSize: 15 });
  let interrupted = false;
  await assert.rejects(applyBeadsTransfer(pmRoot, plan, 'public-transfer-validation', { maxChunks: 10_000, onTransition(c) {
    if (!interrupted && c.transition === 'step_applied') { interrupted = true; throw new WorkspaceTransactionInterruptedError('deterministic public-data interruption'); }
  } }), WorkspaceTransactionInterruptedError);
  const result = await applyBeadsTransfer(pmRoot, plan, 'public-transfer-validation', { maxChunks: 10_000 });
  const replay = await applyBeadsTransfer(pmRoot, plan, 'public-transfer-validation', { maxChunks: 10_000 });
  const received = (await receiver.listAllComplete()).items; const receivedIds = new Set(received.map(row => row.id));
  const dependencies = received.flatMap(row => row.dependencies ?? []);
  const parents = received.filter(row => row.parent);
  assert.equal(received.length, rows.length); assert.equal(result.transferred, rows.length); assert.equal(result.skipped, 0);
  assert.equal(replay.replayedChunks, result.totalChunks);
  assert(dependencies.every(edge => receivedIds.has(edge.id))); assert(parents.every(row => receivedIds.has(row.parent!)));
  const refusals: string[] = [];
  for (const options of [{ maxRows: 1 }, { maxBytes: 1 }]) {
    assert.throws(() => planBeadsTransfer(text, rows.map(row => row.id!), 'public-fleet', settings, options), (error: unknown) => {
      assert(error instanceof BeadsTransferRefusal); refusals.push(error.omission!.dimension); return true;
    });
  }
  assert.equal(await treeDigest(sourceRoot), before);
  process.env.PATH = originalPath;
  assert.equal(execFileSync('git', ['-C', sourceDirectory, 'rev-parse', 'origin/main:.agents/pm'], { encoding: 'utf8' }).trim(), sourceTrackerTree);
  console.log(JSON.stringify({ source: sourceRepository, sourceHead, sourceTrackerTree, nonGit: true, gitAbsentFromPath: true, copiedTrackerReadOnly: true,
    sourceUnchanged: true, copiedTrackerUnchanged: true, publicItemsRead: items.length, inputJsonlBytes: Buffer.byteLength(text), plannedRows: plan.records.length,
    plannedChunks: result.totalChunks, transferred: result.transferred, skipped: result.skipped, duplicateRows: received.length - rows.length,
    resolvedDependencyEdges: dependencies.length, resolvedParentLinks: parents.length, danglingEdges: 0, replayedChunks: replay.replayedChunks,
    closureRefusals: refusals, planBytes: Buffer.byteLength(JSON.stringify(plan)), compactPlanJsonBytes: Buffer.byteLength(JSON.stringify(summarizeBeadsTransfer(plan))),
    compactResumeJsonBytes: Buffer.byteLength(JSON.stringify(result)), elapsedSeconds: Number(((performance.now() - started) / 1000).toFixed(2)) }, null, 2));
} finally {
  if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
  if (originalCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = originalCeiling;
  await readonlyTree(dir, false); await rm(dir, { recursive: true, force: true });
}
