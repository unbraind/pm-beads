/** Real compiled command and process-death acceptance without git. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { planBeadsTransfer, snapshotBeadsTransferSettings, applyBeadsTransfer } from '../transfer.ts';
const root = resolve(import.meta.dirname, '..');

test('compiled CLI plans TOON/JSON, drains and replays chunks, and emits nonzero typed refusal receipts without git', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'beads-transfer-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pmRoot = join(dir, 'tracker'), extension = join(pmRoot, 'extensions', 'pm-beads');
  const client = new PmClient({ pmRoot, author: 'cli-test', noExtensions: true });
  await client.init('sample'); await mkdir(extension, { recursive: true });
  for (const entry of ['dist', 'manifest.json', 'package.json']) await cp(join(root, entry), join(extension, entry), { recursive: true });
  await symlink(join(root, 'node_modules'), join(extension, 'node_modules'), 'junction');
  const file = join(dir, 'incoming.jsonl'), output = join(dir, 'plan.json');
  await writeFile(file, '{"id":"a","title":"A","description":"Synthetic payload omitted from receipts","dependencies":["b"]}\n{"id":"b","title":"Late B"}');
  /** Use the real pinned host; no git executable exists on its PATH. */
  const invoke = (...args: string[]) => spawnSync(process.execPath, [join(root, 'node_modules', '@unbrained', 'pm-cli', 'dist', 'cli.js'), '--path', pmRoot, '--author', 'cli-test', ...args], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: '', GIT_CEILING_DIRECTORIES: tmpdir() },
  });
  const planned = invoke('--json', 'beads', 'transfer', file, '--source', 'team', '--select', 'a', '--plan-out', output, '--chunk-size', '1');
  assert.equal(planned.status, 0, planned.stdout + planned.stderr);
  assert.equal(JSON.parse(planned.stdout).rows, 2); assert.ok(!planned.stdout.includes('Synthetic payload'));
  const first = invoke('beads-transfer', '--apply-plan', output);
  assert.equal(first.status, 0, first.stdout + first.stderr); assert.match(first.stdout, /complete: false/);
  const second = invoke('--json', 'beads', 'transfer', '--apply-plan', output);
  assert.equal(second.status, 0, second.stdout + second.stderr); assert.equal(JSON.parse(second.stdout).complete, true);
  assert.equal(JSON.parse(second.stdout).transferred, 2); assert.equal((await client.listAllComplete()).items.length, 2);
  const refused = invoke('--json', 'beads', 'transfer', file, '--source', 'team', '--select', 'a', '--max-rows', '1');
  assert.equal(refused.status, 2, refused.stdout + refused.stderr);
  const receipt = JSON.parse(refused.stdout);
  assert.equal(receipt.code, 'closure_limit'); assert.equal(receipt.omission.included, 0); assert.equal(receipt.omission.required, 2);
  const before = await readFile(file, 'utf8');
  const overwrite = invoke('--json', 'beads', 'transfer', file, '--source', 'team', '--select', 'a', '--plan-out', file);
  assert.equal(overwrite.status, 2, overwrite.stdout + overwrite.stderr); assert.equal(await readFile(file, 'utf8'), before);
});

test('a genuinely SIGKILLed transfer resumes its SDK checkpoint without duplicate items or dangling edges', { timeout: 90_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'beads-transfer-kill-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pmRoot = join(dir, 'tracker'), file = join(dir, 'plan.json');
  const client = new PmClient({ pmRoot, author: 'kill-test', noExtensions: true }); await client.init('sample');
  const plan = planBeadsTransfer('{"id":"a","title":"A","dependencies":["b"]}\n{"id":"b","title":"B"}', ['a'], 'kill-test', await snapshotBeadsTransferSettings(pmRoot), { chunkSize: 1 });
  await writeFile(file, JSON.stringify(plan));
  const killed = spawnSync(process.execPath, [join(root, 'test', 'fixtures', 'transfer-kill.ts'), pmRoot, file], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: '', GIT_CEILING_DIRECTORIES: tmpdir() },
  });
  assert.equal(killed.signal, 'SIGKILL', killed.stderr); assert.equal((await client.listAllComplete()).items.length, 1);
  // The public coordinator recovers its abandoned lease after its default 30-second TTL.
  const resumed = await applyBeadsTransfer(pmRoot, plan, 'resume-test', { maxChunks: 2, lockWaitMs: 60_000 });
  assert.equal(resumed.transferred, 2); assert.equal(resumed.complete, true);
  const items = (await client.listAllComplete()).items; assert.equal(items.length, 2);
  assert.equal(items.filter(i => i.dependencies?.length === 1).length, 1);
  assert.equal((await applyBeadsTransfer(pmRoot, plan, 'peer')).replayedChunks, 2);
});
