/** Adversarial public-entrypoint checks use bounded fixtures and real filesystem operations. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureBeadsExtensions, parseBeadsExtensionSidecar, restoreBeadsExtensions, BeadsSidecarRefusal, BEADS_SIDECAR_LIMITS, type BeadsExtensionSidecar } from '../index.ts';
import { harness, runCommand } from './helpers.ts';

const base = '{"id":"bd-one","title":"One"}';
/** Require a stable typed refusal, never a RangeError or arbitrary thrown exception. */
function refusal(code: string): (error: unknown) => boolean {
  return error => error instanceof BeadsSidecarRefusal && error.code === code;
}
/** Insert raw JSON without serializing a deliberately hostile tree in the test itself. */
function snapshot(value: string, key = 'vendor'): string {
  return `{"id":"bd-one","title":"One","${key}":${value}}`;
}
/** Supply malformed SDK envelopes without weakening the public API's production type. */
function envelope(value: unknown): BeadsExtensionSidecar {
  const good = captureBeadsExtensions(snapshot('0'), ['vendor']);
  return { ...good, records: [{ id: 'bd-one', fields: { vendor: value } }] } as BeadsExtensionSidecar;
}

for (const kind of ['arrays', 'objects']) {
  test(`iterative depth preflight rejects 20000 nested ${kind} at every entrypoint`, () => {
    const raw = kind === 'arrays' ? '['.repeat(20000) + '0' + ']'.repeat(20000) : '{"n":'.repeat(20000) + '0' + '}'.repeat(20000);
    const incoming = snapshot(raw);
    if (kind === 'arrays') assert.equal(Buffer.byteLength(incoming.padEnd(40040)), 40040);
    const good = captureBeadsExtensions(base, ['vendor']);
    for (const fields of [['vendor'], []]) assert.throws(() => captureBeadsExtensions(incoming.padEnd(kind === 'arrays' ? 40040 : incoming.length), fields), refusal('size_limit'));
    assert.throws(() => captureBeadsExtensions(snapshot(raw, 'description'), []), refusal('size_limit'));
    assert.throws(() => restoreBeadsExtensions(incoming, good), refusal('size_limit'));
    assert.throws(() => restoreBeadsExtensions(snapshot(raw, 'description'), good), refusal('size_limit'));
    const direct = envelope(JSON.parse(raw));
    const encoded = JSON.stringify(good);
    const serialized = JSON.stringify(envelope(0)).replace('"vendor":0', `"vendor":${raw}`);
    assert.throws(() => parseBeadsExtensionSidecar(serialized), refusal('size_limit'));
    assert.throws(() => restoreBeadsExtensions(base, direct), refusal('size_limit'));
    // Even malformed envelope slots must be bounded before schema inspection or hashing.
    assert.throws(() => parseBeadsExtensionSidecar(encoded.slice(0, -1) + `,"extra":${raw}}`), refusal('size_limit'));
  });
}

test('iterative node and key ceilings bound wide and aggregate inputs', () => {
  const good = captureBeadsExtensions(snapshot('0'), ['vendor']);
  for (const value of [Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`k${i}`, i])), Array(BEADS_SIDECAR_LIMITS.nodes + 1).fill(0)]) {
    const raw = snapshot(JSON.stringify(value));
    assert.throws(() => captureBeadsExtensions(raw, ['vendor']), refusal('size_limit'));
    assert.throws(() => restoreBeadsExtensions(raw, good), refusal('size_limit'));
    assert.throws(() => parseBeadsExtensionSidecar(JSON.stringify(envelope(value))), refusal('size_limit'));
    assert.throws(() => restoreBeadsExtensions(base, envelope(value)), refusal('size_limit'));
  }
  const many = Array.from({ length: 800 }, (_, i) => ({ id: `bd-${i}`, title: 'One', vendor: Array(128).fill(0) }));
  assert.throws(() => captureBeadsExtensions(many.map(row => JSON.stringify(row)).join('\n'), ['vendor']), refusal('size_limit'));
  const aggregate = { ...good, records: many.map(row => ({ id: row.id, fields: { vendor: row.vendor } })) };
  assert.throws(() => restoreBeadsExtensions(base, aggregate), refusal('size_limit'));
  assert.throws(() => parseBeadsExtensionSidecar(JSON.stringify(aggregate)), refusal('size_limit'));
});

test('restore bounds combined native and extension nodes before serializing output', () => {
  const rows = Array.from({ length: 400 }, (_, i) => ({ id: `bd-${i}`, title: 'One', vendor: Array(128).fill(0) }));
  const sidecar = captureBeadsExtensions(rows.map(row => JSON.stringify(row)).join('\n'), ['vendor']);
  const native = rows.map(({ id, title }) => JSON.stringify({ id, title, tags: Array(128).fill('visible') })).join('\n');
  assert.doesNotThrow(() => captureBeadsExtensions(native, []), 'native input independently fits');
  assert.doesNotThrow(() => parseBeadsExtensionSidecar(JSON.stringify(sidecar)), 'envelope independently fits');
  assert.throws(() => restoreBeadsExtensions(native, sidecar), refusal('size_limit'));
});

test('duplicate JSON keys never silently overwrite input or evade integrity verification', () => {
  const good = captureBeadsExtensions(snapshot('1'), ['vendor']);
  for (const raw of [snapshot('1').replace('"vendor":1', '"vendor":0,"vendor":1'), snapshot('{"x":0,"\\u0078":1}'), base.replace('"id":"bd-one"', '"id":"other","id":"bd-one"')]) {
    assert.throws(() => captureBeadsExtensions(raw, ['vendor']), refusal('invalid_input'));
    assert.throws(() => restoreBeadsExtensions(raw, good), refusal('invalid_input'));
  }
  for (const raw of [JSON.stringify(good).replace('"vendor":1', '"vendor":0,"vendor":1'), JSON.stringify(good).replace('"version":1', '"version":2,"version":1')]) {
    assert.throws(() => parseBeadsExtensionSidecar(raw), refusal('invalid_sidecar'));
  }
});

test('negative zero and BOM-only lines refuse instead of changing JSON data', () => {
  const good = captureBeadsExtensions(snapshot('0'), ['vendor']);
  for (const raw of [snapshot('-0'), '\uFEFF\n' + base, '\uFEFF']) {
    assert.throws(() => captureBeadsExtensions(raw, ['vendor']), refusal('invalid_input'));
    assert.throws(() => restoreBeadsExtensions(raw, good), refusal('invalid_input'));
  }
  assert.throws(() => parseBeadsExtensionSidecar(JSON.stringify(good).replace('"vendor":0', '"vendor":-0')), refusal('invalid_input'));
  assert.throws(() => restoreBeadsExtensions(base, envelope(-0)), refusal('invalid_input'));
});

test('Unicode, prototype keys, malformed roots and truncation are explicit across SDK entrypoints', () => {
  const good = captureBeadsExtensions(snapshot('1'), ['vendor']);
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const value = JSON.parse(`{"${key}":1}`) as unknown;
    const raw = snapshot(JSON.stringify(value));
    assert.throws(() => captureBeadsExtensions(raw, ['vendor']), refusal('privacy_limit'));
    assert.throws(() => parseBeadsExtensionSidecar(JSON.stringify(envelope(value))), refusal('privacy_limit'));
    assert.throws(() => restoreBeadsExtensions(base, envelope(value)), refusal('privacy_limit'));
    assert.throws(() => restoreBeadsExtensions(raw, good), refusal('privacy_limit'));
    assert.equal(captureBeadsExtensions(raw, []).loss.droppedFields, 1);
  }
  for (const raw of ['null', '[]', 'true', '1', '"root"', '{', base.slice(0, -1), '\uFEFF' + base]) {
    assert.throws(() => captureBeadsExtensions(raw, []), refusal('invalid_input'));
    assert.throws(() => restoreBeadsExtensions(raw, good), refusal('invalid_input'));
    assert.throws(() => parseBeadsExtensionSidecar(raw), refusal('invalid_sidecar'));
  }
  for (const value of ['\uD800', '\uDC00', { ['\uD800']: 1 }]) {
    assert.throws(() => captureBeadsExtensions(snapshot(JSON.stringify(value)), ['vendor']), refusal('invalid_input'));
    assert.throws(() => parseBeadsExtensionSidecar(JSON.stringify(envelope(value))), refusal('invalid_input'));
    assert.throws(() => restoreBeadsExtensions(base, envelope(value)), refusal('invalid_input'));
    assert.throws(() => restoreBeadsExtensions(snapshot(JSON.stringify(value)), good), refusal('invalid_input'));
  }
  for (const value of [undefined, 1n, new Date(0), new Array(2), Object.assign(new Array(1), { extra: 1 }), Object.defineProperty({}, 'toJSON', { value: () => 'coerced' }), { [Symbol('extra')]: 1 }, Object.defineProperty({}, 'x', { enumerable: true, get() { throw new Error('must not run'); } })]) {
    assert.throws(() => restoreBeadsExtensions(base, envelope(value)), refusal('invalid_input'));
  }
  assert.throws(() => captureBeadsExtensions(base, new Array(1)), refusal('invalid_input'));
  const maximumFields = Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`v${i}`, i]));
  assert.equal(captureBeadsExtensions(snapshot('0').replace('\"vendor\":0', Object.entries(maximumFields).map(([key, value]) => `\"${key}\":${value}`).join(',')), Object.keys(maximumFields)).loss.preservedFields, 128);
  const nullPrototype = Object.assign(Object.create(null) as Record<string, number>, { n: 1 });
  const captured = captureBeadsExtensions(snapshot(JSON.stringify(nullPrototype)), ['vendor']);
  captured.records[0].fields.vendor = nullPrototype;
  assert.doesNotThrow(() => restoreBeadsExtensions(base, captured));
  const vendor = { unicode: '𝄞 😀', literal: 'brace { colon : quote " slash \\', list: [true, null, 0.5] };
  const crlf = snapshot(JSON.stringify(vendor)) + '\r\n';
  const sidecar = parseBeadsExtensionSidecar(JSON.stringify(captureBeadsExtensions(crlf, ['vendor']), null, 2).replaceAll('\n', '\r\n'));
  assert.deepEqual(JSON.parse(restoreBeadsExtensions(base + '\r\n', sidecar).text).vendor, vendor);
});

test('SDK raw-byte preflight bounds shared strings before serialization can overflow', () => {
  // A small shared string graph expands beyond V8's maximum serialized string size.
  const repeated = Array(128).fill('x'.repeat(4 * 1024 * 1024));
  assert.throws(() => restoreBeadsExtensions(base, envelope(repeated)), refusal('size_limit'));
  const hugeKey = { ['x'.repeat(BEADS_SIDECAR_LIMITS.bytes + 1)]: 0 };
  assert.throws(() => restoreBeadsExtensions(base, envelope(hugeKey)), refusal('size_limit'));
});

test('SDK arrays require plain prototypes before serialization or iteration', () => {
  /** Inherited serializers must never execute while validating an SDK envelope. */
  class HostileArray extends Array<unknown> {
    /** Reproduce a custom serializer crash if the array preflight is bypassed. */
    toJSON(): never { throw new RangeError('unexpected inherited serializer'); }
  }
  const custom = new HostileArray(); custom.push(1);
  for (const value of [custom, Object.setPrototypeOf([1], null)]) {
    assert.throws(() => restoreBeadsExtensions(base, envelope(value)), refusal('invalid_input'));
  }
  assert.throws(() => captureBeadsExtensions(base, Object.setPrototypeOf(['vendor'], null)), refusal('invalid_input'));
  const records = envelope(1);
  Object.setPrototypeOf(records.records, null);
  assert.throws(() => restoreBeadsExtensions(base, records), refusal('invalid_input'));
  const fields = envelope(1);
  Object.setPrototypeOf(fields.fields, null);
  assert.throws(() => restoreBeadsExtensions(base, fields), refusal('invalid_input'));
});

test('filesystem matrix refuses unsafe data and special outputs; concurrent capture publishes complete envelopes', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'beads-adversarial-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const host = await harness();
  const source = join(dir, 'source.jsonl'), sidecar = join(dir, 'sidecar.json'), output = join(dir, 'output.jsonl');
  const raw = snapshot('{"n":[1,true,null]}');
  const encoded = JSON.stringify(captureBeadsExtensions(raw, ['vendor']));
  await writeFile(source, raw); await writeFile(sidecar, encoded); await writeFile(output, 'sentinel');
  const invoke = (file: string, options: Record<string, unknown>) => runCommand(host, { command: 'beads sidecar', args: [file], options });
  // One name fails preflight; the shorter one fails atomic temporary-file creation.
  for (const length of [256, 250]) await assert.rejects(invoke(source, { capture: join(dir, 'x'.repeat(length)), fields: 'vendor' }), refusal('io_error'));
  const fifo = join(dir, 'fifo');
  execFileSync('mkfifo', [fifo]);
  const linkedSource = join(dir, 'linked-source'), linkedSidecar = join(dir, 'linked-sidecar'), linkedOutput = join(dir, 'linked-output');
  await symlink(source, linkedSource); await symlink(sidecar, linkedSidecar); await symlink(output, linkedOutput);
  for (const path of [dir, fifo]) {
    await assert.rejects(invoke(path, { capture: sidecar, fields: 'vendor' }), refusal('io_error'));
    await assert.rejects(invoke(source, { restore: path, output }), refusal('io_error'));
    for (const options of [{ capture: path, fields: 'vendor' }, { restore: sidecar, output: path }]) await assert.rejects(invoke(source, options), refusal('io_error'));
  }
  for (const options of [{ capture: linkedOutput, fields: 'vendor' }, { restore: sidecar, output: linkedOutput }]) await assert.rejects(invoke(source, options), refusal('io_error'));
  assert.ok((await lstat(fifo)).isFIFO()); assert.ok((await lstat(linkedOutput)).isSymbolicLink());
  assert.equal(await readFile(output, 'utf8'), 'sentinel');
  for (const bad of [Buffer.from([0xff]), Buffer.from([0xc0, 0xaf]), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from([0xe2, 0x82])]) {
    await writeFile(source, bad);
    await assert.rejects(invoke(source, { capture: sidecar, fields: 'vendor' }), refusal('io_error'));
    await writeFile(source, raw); await writeFile(sidecar, bad);
    await assert.rejects(invoke(source, { restore: sidecar, output }), refusal('io_error'));
  }
  for (const bad of ['\uFEFF' + raw, raw.slice(0, -1), snapshot('"\\ud800"')]) {
    await writeFile(source, bad); await writeFile(sidecar, encoded);
    await assert.rejects(invoke(source, { capture: sidecar, fields: 'vendor' }), refusal('invalid_input'));
    await assert.rejects(invoke(source, { restore: sidecar, output }), refusal('invalid_input'));
  }
  for (const bad of ['\uFEFF' + encoded, encoded.slice(0, -1)]) {
    await writeFile(source, raw); await writeFile(sidecar, bad);
    await assert.rejects(invoke(source, { restore: sidecar, output }), refusal('invalid_sidecar'));
  }
  await writeFile(source, raw); await writeFile(sidecar, encoded);
  await invoke(linkedSource, { restore: linkedSidecar, output });
  const second = join(dir, 'second.jsonl'); await writeFile(second, snapshot('2'));
  await Promise.all(Array.from({ length: 20 }, (_, i) => invoke(i % 2 ? source : second, { capture: sidecar, fields: 'vendor' })));
  const published = parseBeadsExtensionSidecar(await readFile(sidecar, 'utf8'));
  const value = published.records[0].fields.vendor;
  assert.ok(value === 2 || JSON.stringify(value) === '{"n":[1,true,null]}');
  assert.equal(await readFile(source, 'utf8'), raw);
  assert.equal((await readdir(dir)).filter(name => name.endsWith('.tmp')).length, 0);
});
