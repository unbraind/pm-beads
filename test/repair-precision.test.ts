/** Adversarial source-byte oracles cover opaque JSON precision across repair and sidecar paths. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile, writeFile, mkdir, cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { decodeToon } from "@unbrained/pm-cli/sdk/testing";
import { explainBeadsDependencies, previewBeadsDependencyRepair } from "../repair.ts";
import { captureBeadsExtensions, restoreBeadsExtensions, parseBeadsExtensionSidecar, BeadsSidecarRefusal } from "../sidecar.ts";
import { validateBeadsText } from "../index.ts";

const lexemes = ["9007199254740993", "-9007199254740993", "-0", "1e400", "-1e400", "0.123456789012345678901234567890123456789", "1e-400", "1.0000000000000000000000000000000001"];

test("512 seeded source-byte properties preserve every untouched lexeme, duplicate key and surviving edge value", () => {
  let seed = 188;
  for (let index = 0; index < 512; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const number = index < lexemes.length ? lexemes[index] : `${9007199254740993n + BigInt(seed)}.${seed}00001`;
    const spacing = index % 2 ? " \t" : "", ending = index % 3 ? "\r\n" : "\n";
    const foreign = `"foreign_revision" : ${number},"duplicate":${number},"duplicate":-0,"nested":{"a":[1e400,${number}],"quoted":"} \\\" [ \\\\ ","x":1,"x":2}`;
    const keep = `{ "id" : "keep", "kind":"blocked_by", "opaque":${number},"dup":1,"dup":2 }`;
    const prefix = `${spacing}{"id":"masked","id":"x", "title":"Precision",${foreign},"dependencies":["x"],"dependenci\\u0065s" : `;
    const suffix = `,"blocked_by" : [ "x", "keep", "x" ],"tail":${number} }${spacing}`;
    const source = ending + prefix + `[ "x",${keep}, {"id":" x ","kind":"blocked_by","opaque":${number}} ]` + suffix + ending + '{"id":"keep","title":"Keep"}' + ending;
    const expected = ending + prefix + `[${keep}]` + suffix.replace('[ "x", "keep", "x" ]', '["keep"]') + ending + '{"id":"keep","title":"Keep"}' + ending;
    const packet = explainBeadsDependencies(source);
    assert.equal(packet.candidates.length, 1, `numeric lexeme ${number}`);
    const corrected = previewBeadsDependencyRepair(source, packet.candidates[0]);
    assert.equal(corrected, expected, `only the edited dependency field values may differ, sequence ${index}`);
    assert.equal(validateBeadsText(corrected).valid, true);
    assert.equal(explainBeadsDependencies(corrected).valid, true);
  }
});

test("deleting a scalar alias removes every duplicate occurrence so a masked dependency cannot reappear", () => {
  for (const fields of [
    '"blocked_by":"x","blocked_by":"x","id":"x","title":"X"',
    '"id":"x","blocked_by":"x","title":"X","blocked_by":"x"',
    '"id":"x","title":"X","blocked_by":"x","blocked_by":"x"',
  ]) {
    const source = `{ ${fields},"foreign":9007199254740993 }\r\n`;
    const packet = explainBeadsDependencies(source);
    assert.equal(packet.candidates.length, 1);
    const corrected = previewBeadsDependencyRepair(source, packet.candidates[0]);
    assert.equal(explainBeadsDependencies(corrected).valid, true);
    assert(corrected.includes('"foreign":9007199254740993'));
    assert(!corrected.includes('"blocked_by"'));
  }
  for (const alias of ['" keep "', '[ "keep" ]']) {
    const source = ` {"id":"x","title":"X","blocked_by" : ${alias},"foreign":9007199254740993,"dependencies":["x"] }\r\n{"id":"keep","title":"Keep"}\r\n`;
    const packet = explainBeadsDependencies(source);
    assert.equal(previewBeadsDependencyRepair(source, packet.candidates[0]), source.replace('["x"]', "[]"), "an unrelated alias retains every byte");
  }
  const spaced = '{ \t"blocked_by" : "x"  , \t"id" : "x", "title":"X", "foreign":9007199254740993  }\r\n';
  const packet = explainBeadsDependencies(spaced);
  assert.equal(previewBeadsDependencyRepair(spaced, packet.candidates[0]), '{ \t   \t"id" : "x", "title":"X", "foreign":9007199254740993  }\r\n');
});

test("sidecar restoration preserves native numeric spelling and whitespace, and capture refuses unrepresentable new values", () => {
  const source = ' \t{ "id" : "x", "title":"X", "priority":1.00, "vendor":{"value":0.5} }\r';
  const sidecar = captureBeadsExtensions(source, ["vendor"]);
  const native = ' \t{ "id" : "x", "title":"X", "priority":1.00 }\r';
  assert.equal(restoreBeadsExtensions(native, sidecar).text, native.replace("1.00", '1.00,"vendor":{"value":0.5}') + "\n");
  assert.equal(restoreBeadsExtensions(source, sidecar).text, source + "\n");
  for (const number of lexemes) {
    const raw = `{"id":"x","title":"X","vendor":${number}}`;
    assert.throws(() => captureBeadsExtensions(raw, ["vendor"]), error => error instanceof BeadsSidecarRefusal && error.code === "invalid_input");
    const encoded = JSON.stringify(captureBeadsExtensions('{"id":"x","title":"X","vendor":0.5}', ["vendor"])).replace('"vendor":0.5', `"vendor":${number}`);
    assert.throws(() => parseBeadsExtensionSidecar(encoded), error => error instanceof BeadsSidecarRefusal && error.code === "invalid_input");
  }
  for (const number of ["0.5000", "5e-1", "-0.12500", "100e-2", "0e99999999999999999999999999"]) {
    const raw = `{"id":"x","title":"X","vendor":${number}}`;
    assert.doesNotThrow(() => captureBeadsExtensions(raw, ["vendor"]), "exact equivalent decimal spellings remain supported");
  }
});

test("compiled JSON and TOON commands on a non-git tracker produce proposals whose SDK previews preserve precision", async t => {
  const root = resolve(import.meta.dirname, ".."), dir = await mkdtemp(join(tmpdir(), "beads-precision-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pmRoot = join(dir, "tracker"), client = new PmClient({ pmRoot, noExtensions: true, author: "precision" });
  await client.init("precision");
  const created = (await client.create({ title: "Unchanged", type: "Task", unset: ["parent", "sprint", "release", "assignee", "deadline", "blocked_by"] })).item;
  const before = (await client.get(created.id)).item;
  const extension = join(pmRoot, "extensions", "pm-beads"); await mkdir(extension, { recursive: true });
  for (const entry of ["dist", "package.json", "manifest.json"]) await cp(join(root, entry), join(extension, entry), { recursive: true });
  await symlink(join(root, "node_modules"), join(extension, "node_modules"), "junction");
  const raw = ` {"id":"x","title":"X","foreign":[${lexemes.join(",")}],"dup":1,"dup":2,"dependencies" : ["x"] }\r\n`, file = join(dir, "input.jsonl");
  await writeFile(file, raw);
  for (const [command, format] of [["beads", "--json"], ["beads-repair", "toon"]]) {
    const result = spawnSync(process.execPath, [join(root, "node_modules/@unbrained/pm-cli/dist/cli.js"), "--path", pmRoot, ...(format === "--json" ? [format] : []), command, ...(command === "beads" ? ["repair"] : []), file], {
      cwd: dir, encoding: "utf8", env: { ...process.env, PATH: "", GIT_CEILING_DIRECTORIES: tmpdir() },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const packet = format === "--json" ? JSON.parse(result.stdout) : decodeToon(result.stdout);
    assert.equal(previewBeadsDependencyRepair(raw, packet.candidates[0]), raw.replace('["x"]', "[]"));
  }
  assert.equal(await readFile(file, "utf8"), raw);
  const sidecarInput = join(dir, "sidecar-input.jsonl"), sidecarOutput = join(dir, "sidecar.json");
  await writeFile(sidecarInput, '{"id":"x","title":"X","vendor":0.12345678901234567890123456789}');
  await writeFile(sidecarOutput, "unchanged output");
  for (const format of ["--json", "toon"]) {
    const result = spawnSync(process.execPath, [join(root, "node_modules/@unbrained/pm-cli/dist/cli.js"), "--path", pmRoot, ...(format === "--json" ? [format] : []), "beads", "sidecar", sidecarInput, "--capture", sidecarOutput, "--fields", "vendor"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, PATH: "", GIT_CEILING_DIRECTORIES: tmpdir() },
    });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /invalid_input/);
    assert.equal(await readFile(sidecarOutput, "utf8"), "unchanged output");
  }
  assert.deepEqual((await client.get(before.id)).item, before);
});
