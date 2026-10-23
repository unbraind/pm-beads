/** Behavioral sidecar checks use real JSON snapshots and the real extension host. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureBeadsExtensions, restoreBeadsExtensions, parseBeadsExtensionSidecar, BeadsSidecarRefusal, BEADS_NATIVE_FIELDS, BEADS_SIDECAR_LIMITS, type BeadsExtensionValue } from '../index.ts';
import { harness, runCommand } from './helpers.ts';

/** Serialize one stable record with caller-controlled opaque fields. */
function snapshot(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ id: 'bd-one', title: 'One', ...fields });
}
/** Assert both the typed refusal and safe actionable message. */
function refusal(code: string): (error: unknown) => boolean {
  return error => {
    assert(error instanceof BeadsSidecarRefusal);
    assert.equal(error.code, code);
    assert.equal(error.exitCode, 2);
    assert.ok(error.remedy.length > 10);
    return true;
  };
}

test('opaque nested objects, arrays, nulls, booleans and numbers round-trip without flattening', () => {
  const vendor = { nested: { list: [null, true, 2, 0.5, { value: 'opaque' }] }, empty: {}, items: [] };
  const before = snapshot({ vendor, unselected: { message: 'not retained' } });
  const sidecar = captureBeadsExtensions(before, ['vendor', 'vendor']);
  assert.deepEqual(sidecar.fields, ['vendor']);
  assert.deepEqual(sidecar.loss, { records: 1, extensionFields: 2, preservedFields: 1, droppedFields: 1 });
  assert.equal(sidecar.version, 1);
  assert.deepEqual(parseBeadsExtensionSidecar(JSON.stringify(sidecar)), sidecar);
  const exported = snapshot({ title: 'Edited natively' });
  const result = restoreBeadsExtensions(exported, sidecar);
  assert.deepEqual(JSON.parse(result.text).vendor, vendor);
  assert.equal(JSON.parse(result.text).title, 'Edited natively');
  assert.equal(JSON.parse(result.text).unselected, undefined);
  assert.equal(result.loss.droppedFields, 1);
  assert.deepEqual(JSON.parse(restoreBeadsExtensions(snapshot({ vendor: { items: [], empty: {}, nested: vendor.nested } }), sidecar).text).vendor, vendor);
  assert.deepEqual(captureBeadsExtensions(before, []).loss, { records: 1, extensionFields: 2, preservedFields: 0, droppedFields: 2 });
  const empty = captureBeadsExtensions('', []);
  assert.equal(restoreBeadsExtensions('', empty).text, '');
  assert.deepEqual(parseBeadsExtensionSidecar(JSON.stringify(empty)), empty);
});

test('near-limit captured records parse and restore using actual sidecar and output bytes', () => {
  const rows = Array.from({ length: 523 }, (_, i) => ({ id: `bd-${i}`, title: 'X', vendor: 'x'.repeat(15980) }));
  const text = rows.map(row => JSON.stringify(row)).join('\n');
  const sidecar = captureBeadsExtensions(text, ['vendor']);
  assert.ok(Buffer.byteLength(text) < BEADS_SIDECAR_LIMITS.bytes);
  assert.ok(Buffer.byteLength(JSON.stringify(sidecar)) < BEADS_SIDECAR_LIMITS.bytes);
  const parsed = parseBeadsExtensionSidecar(JSON.stringify(sidecar));
  const exported = rows.map(({ id, title }) => JSON.stringify({ id, title })).join('\n');
  assert.equal(restoreBeadsExtensions(exported, parsed).text, text + '\n');
  assert.equal(restoreBeadsExtensions(text, sidecar).text, text + '\n');
});

test('capture refuses restored output one byte over the limit with a typed refusal', () => {
  const overhead = Buffer.byteLength(snapshot({ description: '' }));
  const fitting = snapshot({ description: 'x'.repeat(BEADS_SIDECAR_LIMITS.bytes - overhead - 1) });
  const sidecar = captureBeadsExtensions(fitting, []);
  assert.equal(Buffer.byteLength(restoreBeadsExtensions(fitting, sidecar).text), BEADS_SIDECAR_LIMITS.bytes);
  const overflowing = snapshot({ description: 'x'.repeat(BEADS_SIDECAR_LIMITS.bytes - overhead) });
  assert.equal(Buffer.byteLength(overflowing), BEADS_SIDECAR_LIMITS.bytes);
  assert.equal(Buffer.byteLength(overflowing + '\n'), BEADS_SIDECAR_LIMITS.bytes + 1);
  assert.throws(() => captureBeadsExtensions(overflowing, []), refusal('size_limit'));
  assert.throws(() => restoreBeadsExtensions(overflowing, sidecar), refusal('size_limit'));
});

test('CLI capture and restore share the SDK exact sidecar byte limit without extra framing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'beads-sidecar-limit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ext = await harness();
  // The native name alias keeps the source smaller than the sidecar envelope.
  const rows = Array.from({ length: 523 }, (_, i) => ({ id: `bd-${i}`, name: 'X', vendor: 'x'.repeat(15980) }));
  let padding = BEADS_SIDECAR_LIMITS.bytes - Buffer.byteLength(JSON.stringify(captureBeadsExtensions(rows.map(row => JSON.stringify(row)).join('\n'), ['vendor'])));
  for (const row of rows) {
    const extra = Math.min(padding, BEADS_SIDECAR_LIMITS.recordBytes - Buffer.byteLength(JSON.stringify({ vendor: row.vendor })));
    row.vendor += 'x'.repeat(extra);
    padding -= extra;
  }
  assert.equal(padding, 0);
  const raw = rows.map(row => JSON.stringify(row)).join('\n');
  const envelope = captureBeadsExtensions(raw, ['vendor']);
  const encoded = JSON.stringify(envelope);
  assert.equal(Buffer.byteLength(encoded), BEADS_SIDECAR_LIMITS.bytes);
  assert.deepEqual(parseBeadsExtensionSidecar(encoded).records.map(row => row.id), rows.map(row => row.id));
  assert.throws(() => parseBeadsExtensionSidecar(encoded + '\n'), refusal('size_limit'));
  assert.throws(() => restoreBeadsExtensions(raw, { ...envelope, digest: envelope.digest + 'x' }), refusal('size_limit'));
  const file = join(dir, 'incoming.jsonl'), sidecar = join(dir, 'extensions.json'), output = join(dir, 'restored.jsonl');
  await writeFile(file, raw);
  const receipt = await runCommand(ext, { command: 'beads sidecar', args: [file], options: { capture: sidecar, fields: 'vendor' } }) as { bytes: number };
  assert.equal(receipt.bytes, BEADS_SIDECAR_LIMITS.bytes);
  assert.equal(await readFile(sidecar, 'utf8'), encoded);
  await writeFile(file, rows.map(({ id, name }) => JSON.stringify({ id, name })).join('\n'));
  await runCommand(ext, { command: 'beads sidecar', args: [file], options: { restore: sidecar, output } });
  assert.equal(await readFile(output, 'utf8'), raw + '\n');
});

test('direct envelope validation retains identity, record-count and extension byte limits', () => {
  const good = captureBeadsExtensions(snapshot({ vendor: 1 }), ['vendor']);
  for (const id of ['', ' trailing ', 'bad]id']) {
    const invalid = { ...good, records: [{ id, fields: { vendor: 1 } }] };
    assert.throws(() => parseBeadsExtensionSidecar(JSON.stringify(invalid)), refusal('invalid_input'));
    assert.throws(() => restoreBeadsExtensions(snapshot(), invalid), refusal('invalid_input'));
  }
  assert.throws(() => parseBeadsExtensionSidecar(JSON.stringify({ ...good, records: [good.records[0], good.records[0]] })), refusal('invalid_input'));
  assert.throws(() => restoreBeadsExtensions(snapshot(), { ...good, records: Array(10001).fill(good.records[0]) }), refusal('size_limit'));
  const oversized = { ...good, records: [{ id: 'bd-one', fields: { vendor: 'x'.repeat(BEADS_SIDECAR_LIMITS.recordBytes) } }] };
  assert.throws(() => parseBeadsExtensionSidecar(JSON.stringify(oversized)), refusal('size_limit'));
  assert.throws(() => restoreBeadsExtensions(snapshot(), oversized), refusal('size_limit'));
});

test('all native names and aliases refuse opt-in, with exact id matching and collision protection', () => {
  for (const field of BEADS_NATIVE_FIELDS) assert.throws(() => captureBeadsExtensions(snapshot(), [field]), refusal('native_conflict'));
  const sidecar = captureBeadsExtensions(snapshot({ vendor: 1 }), ['vendor']);
  assert.throws(() => restoreBeadsExtensions(snapshot({ vendor: 2 }), sidecar), refusal('field_conflict'));
  assert.throws(() => restoreBeadsExtensions('', sidecar), refusal('identity_mismatch'));
  assert.throws(() => restoreBeadsExtensions(snapshot({ id: 'BD-one' }), sidecar), refusal('identity_mismatch'));
  assert.throws(() => captureBeadsExtensions(snapshot() + '\n' + snapshot(), []), refusal('invalid_input'));
  for (const id of ['', ' trailing ', 'bad]id', 3]) assert.throws(() => captureBeadsExtensions(snapshot({ id }), []), refusal('invalid_input'));
  assert.throws(() => captureBeadsExtensions('{broken', []), refusal('invalid_input'));
  assert.throws(() => captureBeadsExtensions('{"title":"No id"}', []), refusal('invalid_input'));
});

test('limits and conservative privacy checks apply before capture and again at restore', () => {
  for (const fields of [['nested.path'], [''], [3], Array(129).fill('vendor'), null]) {
    assert.throws(() => captureBeadsExtensions(snapshot(), fields as string[]), refusal('invalid_input'));
  }
  for (const key of ['apiToken', '__proto__', 'emailAddress']) assert.throws(() => captureBeadsExtensions(snapshot(), [key]), refusal('privacy_limit'));
  for (const vendor of [{ nested: { password: 'redacted' } }, { constructor: true }, 'Bearer synthetic', 'ghp_synthetic', '-----BEGIN SYNTHETIC PRIVATE KEY-----', ['sample' + '@' + 'example.invalid'], ['/' + ['home', 'synthetic', 'private'].join('/')]]) {
    assert.throws(() => captureBeadsExtensions(snapshot({ vendor }), ['vendor']), refusal('privacy_limit'));
  }
  const unchecked = snapshot({ vendor: { apiToken: 'secret fixture' } });
  assert.equal(captureBeadsExtensions(snapshot({ vendor: '-----begin '.repeat(800) }), ['vendor']).loss.preservedFields, 1);
  assert.throws(() => captureBeadsExtensions(unchecked, []), refusal('privacy_limit'), 'unselected values are screened too');
  let nested: unknown = 0;
  for (let i = 0; i < 18; i++) nested = { nested };
  for (const vendor of [nested, Array(129).fill(0), 'a'.repeat(BEADS_SIDECAR_LIMITS.recordBytes)]) {
    assert.throws(() => captureBeadsExtensions(snapshot({ vendor }), ['vendor']), refusal('size_limit'));
  }
  assert.throws(() => captureBeadsExtensions(' '.repeat(BEADS_SIDECAR_LIMITS.bytes + 1), []), refusal('size_limit'));
  assert.throws(() => captureBeadsExtensions(Array.from({ length: 10001 }, (_, i) => snapshot({ id: `bd-${i}` })).join('\n'), []), refusal('size_limit'));
  assert.throws(() => captureBeadsExtensions('{"id":"bd-one","title":"One","vendor":1e400}', ['vendor']), refusal('invalid_input'));
  assert.throws(() => captureBeadsExtensions('{"id":"bd-one","title":"One","vendor":9007199254740993}', ['vendor']), refusal('invalid_input'));
});

test('credential key normalization refuses selectors and nested capture, parse and restore values', () => {
  const keys = ['api_key', 'apiKey', 'API-KEY', 'accessToken', 'ACCESS_TOKEN', 'client_secret', 'CLIENT-SECRET',
    'password', 'pass_word', 'private_key', 'PRIVATE-KEY', 'refresh-token', 'auth-orization', 'sessionCookie', 'creden_tial', 'e_mail'];
  const good = captureBeadsExtensions(snapshot({ vendor: { retained: true } }), ['vendor']);
  for (const key of keys) {
    assert.throws(() => captureBeadsExtensions(snapshot({ [key]: 'synthetic' }), [key]), refusal('privacy_limit'), key);
    let vendor: BeadsExtensionValue = { [key]: 'synthetic' };
    for (let depth = 0; depth < 16; depth++) {
      assert.throws(() => captureBeadsExtensions(snapshot({ vendor }), ['vendor']), refusal('privacy_limit'), `${key} at depth ${depth}`);
      vendor = { nested: vendor };
    }
    vendor = { nested: [{ [key]: 'synthetic' }] };
    const unsafe = { ...good, records: [{ id: 'bd-one', fields: { vendor } }] };
    assert.throws(() => parseBeadsExtensionSidecar(JSON.stringify(unsafe)), refusal('privacy_limit'), key);
    assert.throws(() => restoreBeadsExtensions(snapshot(), unsafe), refusal('privacy_limit'), key);
    assert.throws(() => restoreBeadsExtensions(snapshot({ vendor }), good), refusal('privacy_limit'), key);
  }
  const vendor = { public_key: 'synthetic public metadata', api_version: 1, layout: [{ enabled: true }] };
  assert.deepEqual(JSON.parse(restoreBeadsExtensions(snapshot(), captureBeadsExtensions(snapshot({ vendor }), ['vendor'])).text).vendor, vendor);
});

test('capture and restore refuse real-path input aliases before writing and preserve both sources', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'beads-sidecar-alias-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ext = await harness();
  const file = join(dir, 'incoming.jsonl'), sidecar = join(dir, 'extensions.json'), alias = join(dir, 'alias');
  const raw = snapshot({ vendor: { retained: true } });
  const envelope = JSON.stringify(captureBeadsExtensions(raw, ['vendor']));
  await writeFile(file, raw);
  await writeFile(sidecar, envelope);
  await symlink('.', alias, 'dir');
  const linkedInput = join(dir, 'linked-input'), linkedSidecar = join(dir, 'linked-sidecar');
  await symlink(file, linkedInput);
  await symlink(sidecar, linkedSidecar);
  for (const source of [file, join(alias, 'incoming.jsonl'), linkedInput]) {
    for (const destination of [file, join(alias, 'incoming.jsonl'), linkedInput]) {
      await assert.rejects(runCommand(ext, { command: 'beads sidecar', args: [source], options: { capture: destination, fields: 'vendor' } }), refusal('invalid_input'));
      await assert.rejects(runCommand(ext, { command: 'beads sidecar', args: [source], options: { restore: sidecar, output: destination } }), refusal('invalid_input'));
      assert.equal(await readFile(file, 'utf8'), raw);
      assert.equal(await readFile(sidecar, 'utf8'), envelope);
    }
    for (const destination of [sidecar, join(alias, 'extensions.json'), linkedSidecar]) {
      await assert.rejects(runCommand(ext, { command: 'beads sidecar', args: [source], options: { restore: join(alias, 'extensions.json'), output: destination } }), refusal('invalid_input'));
      assert.equal(await readFile(file, 'utf8'), raw);
      assert.equal(await readFile(sidecar, 'utf8'), envelope);
    }
  }
  // Collision detection precedes even parsing invalid input.
  await writeFile(file, 'invalid snapshot');
  await assert.rejects(runCommand(ext, { command: 'beads sidecar', args: [file], options: { capture: join(alias, 'incoming.jsonl'), fields: 'vendor' } }), refusal('invalid_input'));
  assert.equal(await readFile(file, 'utf8'), 'invalid snapshot');
  await writeFile(file, raw);
  const loop = join(dir, 'loop');
  await symlink('loop', loop);
  for (const destination of [loop, join(dir, 'missing', 'output.json')]) {
    await assert.rejects(runCommand(ext, { command: 'beads sidecar', args: [file], options: { capture: destination, fields: 'vendor' } }), refusal('io_error'));
  }
  await mkdir(join(dir, 'outputs'));
  await symlink('outputs', join(dir, 'output-alias'), 'dir');
  await runCommand(ext, { command: 'beads sidecar', args: [linkedInput], options: { capture: join(dir, 'output-alias', 'new.json'), fields: 'vendor' } });
  assert.deepEqual(parseBeadsExtensionSidecar(await readFile(join(dir, 'outputs', 'new.json'), 'utf8')).records[0].fields.vendor, { retained: true });
  assert.equal(await readFile(file, 'utf8'), raw);
  assert.equal(await readFile(sidecar, 'utf8'), envelope);
});

test('untrusted sidecars refuse invalid versions, shapes, integrity, privacy and misleading loss counts', () => {
  const good = captureBeadsExtensions(snapshot({ vendor: { retained: true } }), ['vendor']);
  for (const text of ['not json', 'null', '[]', '{"schema":"other"}']) assert.throws(() => parseBeadsExtensionSidecar(text), refusal('invalid_sidecar'));
  assert.throws(() => parseBeadsExtensionSidecar(JSON.stringify({ ...good, version: 2 })), refusal('unsupported_version'));
  for (const patch of [{ fields: null }, { records: null }, { loss: [] }, { digest: null }, { extra: true }, { records: [null] }, { records: [{ id: 1, fields: {} }] }, { records: [{ id: 'bd-one', fields: null }] }, { records: [{ id: 'bd-one', fields: { other: 1 } }] }, { records: [{ ...good.records[0], extra: true }] }, { digest: 'wrong' }, { loss: { ...good.loss, records: 2 } }, { loss: { ...good.loss, preservedFields: 2 } }, { loss: { ...good.loss, droppedFields: -1 } }, { loss: { ...good.loss, extensionFields: 2 } }, { loss: { ...good.loss, records: '1' } }, { loss: { ...good.loss, extra: 1 } }]) {
    assert.throws(() => parseBeadsExtensionSidecar(JSON.stringify({ ...good, ...patch })), refusal('invalid_sidecar'));
  }
  assert.throws(() => parseBeadsExtensionSidecar(JSON.stringify({ ...good, fields: ['title'] })), refusal('native_conflict'));
  assert.throws(() => restoreBeadsExtensions(snapshot(), { ...good, records: [{ id: 'bd-one', fields: { vendor: { password: 'synthetic' } } }] }), refusal('privacy_limit'));
  const cyclic: Record<string, BeadsExtensionValue> = {};
  cyclic.self = cyclic;
  assert.throws(() => restoreBeadsExtensions(snapshot(), { ...good, records: [{ id: 'bd-one', fields: { vendor: cyclic } }] }), refusal('size_limit'));
  for (const vendor of [Infinity, NaN, 1e20]) assert.throws(() => restoreBeadsExtensions(snapshot(), { ...good, records: [{ id: 'bd-one', fields: { vendor } }] }), refusal('invalid_input'));
  let deep: unknown = true;
  for (let i = 0; i < 100; i++) deep = { nested: deep };
  assert.throws(() => restoreBeadsExtensions(snapshot({ vendor: deep }), good), refusal('size_limit'));
  const oversized = Array.from({ length: 515 }, (_, i) => snapshot({ id: `bd-${i}`, vendor: 'x'.repeat(16000) })).join('\n');
  const sidecar = captureBeadsExtensions(oversized, ['vendor']);
  const exported = Array.from({ length: 515 }, (_, i) => snapshot({ id: `bd-${i}`, description: 'y'.repeat(500) })).join('\n');
  assert.throws(() => restoreBeadsExtensions(exported, sidecar), refusal('size_limit'));
});

test('real host command receipts are compact and every refusal preserves existing output', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'beads-sidecar-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ext = await harness();
  const file = join(dir, 'incoming.jsonl'), sidecar = join(dir, 'extensions.json'), output = join(dir, 'restored.jsonl');
  await writeFile(file, snapshot({ vendor: { nested: [1, true] }, ignored: 2 }));
  const captured = await runCommand(ext, { command: 'beads sidecar', args: [file], options: { capture: sidecar, fields: 'vendor' } }) as { loss: { droppedFields: number } };
  assert.equal(captured.loss.droppedFields, 1);
  assert.ok(JSON.stringify(captured).length < 650);
  await writeFile(file, snapshot());
  await runCommand(ext, { command: 'beads sidecar', args: [file], options: { restore: sidecar, output } });
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')).vendor, { nested: [1, true] });
  await writeFile(file, snapshot({ vendor: 1 }));
  await runCommand(ext, { command: 'beads sidecar', args: [file], options: { capture: sidecar, fields: 'vendor' } });
  const saved = await readFile(output, 'utf8');
  await writeFile(file, snapshot({ vendor: 2 }));
  await assert.rejects(runCommand(ext, { command: 'beads sidecar', args: [file], options: { restore: sidecar, output } }), refusal('field_conflict'));
  assert.equal(await readFile(output, 'utf8'), saved);
  for (const options of [{}, { capture: sidecar, restore: sidecar }, { capture: sidecar }, { capture: sidecar, fields: 'vendor', output }, { restore: sidecar }, { restore: sidecar, output, fields: 'vendor' }, { capture: file, fields: 'vendor' }, { restore: sidecar, output: sidecar }]) {
    await assert.rejects(runCommand(ext, { command: 'beads sidecar', args: [file], options }), refusal('invalid_input'));
  }
  await assert.rejects(runCommand(ext, { command: 'beads sidecar', args: [], options: { capture: sidecar, fields: 'vendor' } }), refusal('invalid_input'));
  await assert.rejects(runCommand(ext, { command: 'beads sidecar', args: [join(dir, 'absent')], options: { capture: sidecar, fields: 'vendor' } }), refusal('io_error'));
  await assert.rejects(runCommand(ext, { command: 'beads sidecar', args: [dir], options: { capture: sidecar, fields: 'vendor' } }), refusal('io_error'));
  await writeFile(file, Buffer.from([255]));
  await assert.rejects(runCommand(ext, { command: 'beads sidecar', args: [file], options: { capture: sidecar, fields: 'vendor' } }), refusal('io_error'));
  await writeFile(file, snapshot());
  await assert.rejects(runCommand(ext, { command: 'beads sidecar', args: [file], options: { capture: dir, fields: 'vendor' } }), refusal('io_error'));
  await writeFile(file, ' '.repeat(BEADS_SIDECAR_LIMITS.bytes + 1));
  await assert.rejects(runCommand(ext, { command: 'beads sidecar', args: [file], options: { capture: sidecar, fields: 'vendor' } }), refusal('size_limit'));
  assert.equal(await readFile(output, 'utf8'), saved);
});
