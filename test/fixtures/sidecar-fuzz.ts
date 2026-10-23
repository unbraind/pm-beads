/** Deterministic JSON fuzzing with a hard parent deadline and real non-git tracker/filesystem checks. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PmClient } from '@unbrained/pm-cli/sdk';
import { BEADS_NATIVE_FIELDS, BeadsSidecarRefusal, captureBeadsExtensions, parseBeadsExtensionSidecar, restoreBeadsExtensions, type BeadsExtensionSidecar } from '../../index.ts';
import { harness, runCommand } from '../helpers.ts';

let seed = 0x163e2026;
const generated = new Set<string>();
/** Reproducible unsigned xorshift32, without dependencies or platform randomness. */
function random(limit: number): number {
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return (seed >>> 0) % limit;
}
/** Generate raw JSON so overflow, malformed numbers and deep trees survive fixture construction. */
function jsonValue(depth = 0): string {
  const leaves = ['null', 'true', 'false', '0', '-0', '1.5', '1e309', '-1e309', '9007199254740993', 'NaN', '"NaN"', '"\\ud800"', '"\\udfff"', '"😀"', '"visible"', '"../../escape.json"'];
  const kind = random(depth < 3 ? 10 : 6);
  if (kind < 6) { const leaf = leaves[random(leaves.length)]; generated.add(leaf); return leaf; }
  if (kind === 6) return '[' + Array.from({ length: random(5) }, () => jsonValue(depth + 1)).join(',') + ']';
  if (kind === 7) {
    const key = ['toString', 'valueOf', '__proto__', 'constructor', 'nested', 'key\\ud800'][random(6)];
    generated.add(key);
    return '{"' + key + '":' + jsonValue(depth + 1) + '}';
  }
  if (kind === 8) { generated.add('huge'); return '"' + 'x'.repeat(17000 + random(4096)) + '"'; }
  generated.add('deep');
  const nesting = 20 + random(120);
  return '['.repeat(nesting) + '0' + ']'.repeat(nesting);
}
/** Independent canonical digest keeps valid random payloads on the integrity-verification path. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return '{' + Object.keys(row).sort().map(key => JSON.stringify(key) + ':' + canonical(row[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
/** Fingerprint all files outside the explicitly allowed input and destination. */
async function fingerprint(directory: string, excluded: Set<string>): Promise<string> {
  const hash = createHash('sha256');
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(directory, entry.name);
    if (excluded.has(file)) continue;
    hash.update(entry.name);
    hash.update(entry.isDirectory() ? await fingerprint(file, excluded) : await readFile(file));
  }
  return hash.digest('hex');
}

const started = performance.now();
const dir = await mkdtemp(join(tmpdir(), 'beads-seeded-'));
let calls = 0, successes = 0, refusals = 0;
const stages: Record<string, { successes: number; refusals: number }> = {};
const categories = new Set<string>();
/** Only documented, payload-free PM refusals count as expected failure. */
function checked<T>(stage: string, attempt: () => T): T | undefined {
  calls++;
  const counts = stages[stage] ??= { successes: 0, refusals: 0 };
  try { const result = attempt(); successes++; counts.successes++; return result; }
  catch (error) {
    assert.ok(error instanceof BeadsSidecarRefusal, 'raw seeded exception: ' + (error instanceof Error ? error.name : typeof error));
    assert.equal(error.exitCode, 2);
    assert.ok(error.remedy.length > 10);
    refusals++;
    counts.refusals++;
    categories.add(error.code);
    return undefined;
  }
}
try {
  const pmRoot = join(dir, 'tracker');
  const client = new PmClient({ pmRoot, author: 'sidecar-test', noExtensions: true });
  await client.init('sample');
  const host = await harness();
  const destinationDir = join(dir, 'destination');
  await mkdir(destinationDir);
  const source = join(dir, 'source.jsonl'), destination = join(destinationDir, 'result'), sidecarFile = join(dir, 'sidecar.json');
  const base = '{"id":"bd-one","title":"One"}';
  const good = captureBeadsExtensions(base, ['vendor']);
  await writeFile(sidecarFile, JSON.stringify(good));
  await writeFile(join(dir, 'escape.json'), 'outside destination sentinel');
  const exclusions = new Set([source, destination]);
  const before = await fingerprint(dir, exclusions);
  const fields = new Set<string>();
  for (let index = 0; index < 2048; index++) {
    // The known blocker is a permanent seed-corpus entry; the remaining 2047 cases are PRNG-generated.
    const value = index === 0 ? '{"toString":0}' : jsonValue();
    const field = index === 0 ? 'title' : [...BEADS_NATIVE_FIELDS, 'vendor', 'unselected'][random(BEADS_NATIVE_FIELDS.length + 2)];
    fields.add(field);
    const raw = '{' + Object.entries({ id: 'bd-one', title: 'One' }).filter(([key]) => key !== field).map(([key, entry]) => JSON.stringify(key) + ':' + JSON.stringify(entry)).join(',') + ',' + JSON.stringify(field) + ':' + value + '}';
    const captured = checked('capture', () => captureBeadsExtensions(raw, ['vendor']));
    // Serialized envelope parsing, including independent valid-digest random values or malformed JSON.
    let candidate = '{"schema":"pm-beads/extensions","version":1,"extra":' + value + '}';
    let direct: BeadsExtensionSidecar = good;
    try {
      const payload: unknown = JSON.parse(value);
      direct = { ...good, records: [{ id: 'bd-one', fields: { vendor: payload } }] } as BeadsExtensionSidecar;
      direct.loss = { records: 1, extensionFields: 1, preservedFields: 1, droppedFields: 0 };
      direct.digest = createHash('sha256').update(canonical({ ...direct, digest: '' })).digest('hex');
      candidate = JSON.stringify(direct);
    } catch (error) { assert.ok(error instanceof SyntaxError); }
    checked('parse', () => parseBeadsExtensionSidecar(candidate));
    const restored = checked('restore', () => restoreBeadsExtensions(raw, captured ?? good));
    if (restored) assert.deepEqual(JSON.parse(restored.text), JSON.parse(raw), 'accepted snapshot changed during restore');
    // Direct SDK restore executes the same shape/digest verification without a serialization boundary.
    checked('verify', () => restoreBeadsExtensions(base, index % 7 === 0 ? { ...direct, digest: 'tampered' } : direct));
    // SDK paths are pure; a bounded sample also exercises the real filesystem handler.
    if (index >= 16) continue;
    await writeFile(source, raw);
    await writeFile(destination, 'destination sentinel');
    calls++;
    try {
      await runCommand(host, { command: 'beads sidecar', pmRoot, args: [source], options: index % 2 ? { restore: sidecarFile, output: destination } : { capture: destination, fields: 'vendor' } });
      successes++;
      assert.ok(index % 2 ? restored : captured, 'filesystem operation accepted a snapshot refused by its SDK equivalent');
      if (index % 2) assert.equal(await readFile(destination, 'utf8'), restoreBeadsExtensions(raw, good).text);
      else assert.deepEqual(parseBeadsExtensionSidecar(await readFile(destination, 'utf8')), captured);
    } catch (error) {
      assert.ok(error instanceof BeadsSidecarRefusal, 'raw CLI exception at seeded case ' + index + ': ' + (error instanceof Error ? error.name : typeof error));
      assert.equal(error.exitCode, 2);
      categories.add(error.code);
      refusals++;
      assert.equal(await readFile(destination, 'utf8'), 'destination sentinel');
    }
    assert.equal(await readFile(source, 'utf8'), raw);
  }
  assert.equal(await fingerprint(dir, exclusions), before);
  assert.deepEqual(await readdir(destinationDir), ['result']);
  for (const counts of Object.values(stages)) { assert.equal(counts.successes + counts.refusals, 2048); assert.ok(counts.successes > 0 && counts.refusals > 0); }
  for (const field of BEADS_NATIVE_FIELDS) assert.ok(fields.has(field), 'unfuzzed native field');
  for (const kind of ['toString', 'valueOf', '__proto__', 'deep', 'huge', '1e309', 'NaN', '"\\ud800"', '"\\udfff"']) assert.ok(generated.has(kind), 'missing hostile family');
  console.log(JSON.stringify({ seed: '0x163e2026', cases: 2048, calls, successes, refusals, stages, categories: [...categories].sort(), outsideDestinationUnchanged: true, milliseconds: Math.round(performance.now() - started) }));
} finally { await rm(dir, { recursive: true, force: true }); }
