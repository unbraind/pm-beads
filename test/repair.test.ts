/** Dependency packet properties, exact coordinates, refusal corpora and non-git CLI acceptance. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile, mkdir, cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { PmClient, printResult } from "@unbrained/pm-cli/sdk";
import { decodeToon } from "@unbrained/pm-cli/sdk/testing";
import { explainBeadsDependencies, previewBeadsDependencyRepair, assertBeadsRepairNumbers, beadsRepairRefusalReceipt, BeadsRepairRefusal, BEADS_REPAIR_LIMITS, type BeadsRepairLimits } from "../repair.ts";
import { validateBeadsText, type BeadsItem } from "../index.ts";
import { harness, runCommand } from "./helpers.ts";

/** Exact JSONL producer, preserving blank lines when requested by callers. */
function jsonl(rows: BeadsItem[]): string { return rows.map(row => JSON.stringify(row)).join("\n"); }
const ring = jsonl([{ id: "A", title: "same", dependencies: ["a"] }, { id: "a", title: "same", blocked_by: "__proto__" }, { id: "__proto__", title: "same", dependencies: [{ depends_on_id: "A", type: "blocks" }] }]);
/** Require a structured refusal and useful retry guidance. */
function refused(code: string) { return (error: unknown) => error instanceof BeadsRepairRefusal && error.code === code && error.remedy.length > 10 && error.exitCode === 2; }
/** Use the public host renderer as the wire oracle, including its documented empty-array compaction. */
function rendered(packet: unknown, json: boolean): string {
  const saved = process.stdout.write, chunks: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => { chunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { printResult(packet, { json }); } finally { process.stdout.write = saved; }
  return chunks.join("");
}

test("three of 10000 rows yield only their exact coordinates, edges and one fully valid proposal", () => {
  const rows = Array.from({ length: 10_000 }, (_, index) => ({ id: `external-${index}`, title: "identical title", description: "private synthetic body" } as BeadsItem));
  rows[17].dependencies = ["external-4999"]; rows[4999].blocked_by = ["external-9999"]; rows[9999].dependencies = [{ id: "external-17", kind: "depends_on" }];
  const source = jsonl(rows), before = performance.now(), packet = explainBeadsDependencies(source);
  assert.equal(packet.counts.rows, 10_000); assert.equal(packet.counts.cycles, 1); assert.equal(packet.counts.edges, 3);
  assert.deepEqual(packet.cycles[0].rows.map(row => row.line), [18, 5000, 10000]);
  assert.equal(packet.cycles[0].edges.length, 3); assert.equal(packet.candidates.length, 1); assert.equal(packet.candidates[0].remove.length, 1);
  const size = Buffer.byteLength(JSON.stringify(packet)); assert(size < BEADS_REPAIR_LIMITS.maxOutputBytes);
  assert(!JSON.stringify(packet).includes("private synthetic body")); assert(!JSON.stringify(packet).includes("identical title"));
  const corrected = previewBeadsDependencyRepair(source, JSON.parse(JSON.stringify(packet.candidates[0])));
  assert.equal(validateBeadsText(corrected).valid, true); assert.equal(explainBeadsDependencies(corrected).valid, true);
  assert(performance.now() - before < 30_000, "declared 30-second acceptance ceiling includes preview regeneration");
});

test("exact identities, whitespace, CRLF, duplicate aliases and self loops retain physical addresses", () => {
  const source = "\r\n" + ring.replaceAll("\n", "\r\n") + "\r\n";
  const packet = explainBeadsDependencies(source);
  assert.deepEqual(packet.cycles[0].rows, [{ line: 2, id: "A" }, { line: 3, id: "a" }, { line: 4, id: "__proto__" }]);
  assert.equal(packet.candidates.length, 1);
  const self = jsonl([{ id: " constructor ", title: "Self", dependencies: ["constructor", { id: "constructor", kind: "blocked_by" }], blocked_by: ["constructor", "constructor"] }]);
  const p = explainBeadsDependencies(self); assert.equal(p.cycles.length, 1); assert.equal(p.cycles[0].edges.length, 1);
  assert.equal(explainBeadsDependencies(previewBeadsDependencyRepair(self, p.candidates[0])).valid, true);
  const scalar = jsonl([{ id: "x", title: "Self", blocked_by: " x " }]);
  const s = explainBeadsDependencies(scalar); assert.equal(s.candidates.length, 1);
  assert.equal(JSON.parse(previewBeadsDependencyRepair(scalar, s.candidates[0])).blocked_by, undefined);
});

test("every row fails alone; malformed and unresolved identities remain explicit gaps beside a usable cycle", () => {
  const source = ["{bad", "null", "[]", '{"id":"overflow","title":"x","priority":1e999}', '{"title":"no id"}',
    '{"id":"bad","title":"x","dependencies":[null]}', '{"id":"bad2","title":"x","dependencies":[{"id":3}]}',
    '{"id":"bad3","title":"x","blocked_by":{}}', '{"id":4,"title":"x"}', '{"id":"missing-title"}',
    '{"id":"dangling","title":"same","dependencies":["absent"]}', '{"id":"unsupported","title":"x","dependencies":[{"issue_id":"a"}],"blocks":["a"]}', ring].join("\n");
  const packet = explainBeadsDependencies(source);
  assert.equal(packet.cycles.length, 1); assert.equal(packet.candidates.length, 0);
  for (const code of ["invalid_json", "invalid_record", "missing_id", "malformed_dependency", "missing_title", "unresolved_dependency", "uninterpreted_dependency", "unsupported_blocks"]) assert(packet.gaps.some(gap => gap.code === code), code);
  assert.deepEqual(packet.gaps.find(gap => gap.code === "unresolved_dependency"), { line: 11, code: "unresolved_dependency", id: "dangling", target: "absent" });
  const duplicate = explainBeadsDependencies(jsonl([{ id: "a", title: "a", dependencies: ["b"] }, { id: "a", title: "a", dependencies: ["a"] }, { id: "b", title: "b" }]));
  assert(duplicate.gaps.some(gap => gap.code === "duplicate_id")); assert(duplicate.gaps.some(gap => gap.code === "unresolved_dependency"));
  assert.equal(duplicate.candidates.length, 0);
  const malformedTitles = [{ id: "bad-title", title: { toString: "not callable" } }, { id: "bad-name", name: 4 }];
  const isolated = explainBeadsDependencies(malformedTitles.map(row => JSON.stringify(row)).join("\n") + "\n" + ring);
  assert.equal(isolated.gaps.length, 2); assert.equal(isolated.cycles.length, 1); assert.equal(isolated.candidates.length, 0);
});

test("must-allow corpus retains prior producer fields and never guesses from matching titles", () => {
  for (const source of ["", "\n \r\n", jsonl([{ id: "é", name: "Legacy", status: "custom-active", priority: "P1", owner: { foreign: true }, dependencies: [], blocked_by: [], foreign: { nested: [1, null] } }])]) assert.equal(explainBeadsDependencies(source).valid, true);
  const packet = explainBeadsDependencies(jsonl([{ id: "correct", title: "typo", dependencies: ["typo"] }]));
  assert.equal(packet.gaps[0].target, "typo"); assert.equal(packet.candidates.length, 0);
  let deep: unknown = 1; for (let index = 0; index < 66; index++) deep = { deep };
  assert.equal(explainBeadsDependencies(jsonl([{ id: "a", title: "a", deep }])).gaps[0].code, "invalid_record");
});

test("one strict budget schema rejects unknown, sparse, nonfinite, fractional and excessive controls", () => {
  for (const value of [null, [], "x", 4]) assert.throws(() => explainBeadsDependencies("", value as never), refused("invalid_input"));
  assert.throws(() => explainBeadsDependencies("", { constructor: 2 } as never), refused("invalid_input"));
  for (const key of Object.keys(BEADS_REPAIR_LIMITS) as (keyof BeadsRepairLimits)[]) for (const value of [NaN, Infinity, -Infinity, 0, -1, 0.5, Number.MAX_SAFE_INTEGER, "2", null]) assert.throws(() => explainBeadsDependencies("", { [key]: value } as never), refused("invalid_input"));
  assert.throws(() => explainBeadsDependencies(4 as never), refused("invalid_input"));
  assert.throws(() => explainBeadsDependencies(ring, { maxRows: 2 }), refused("input_budget"));
  assert.throws(() => explainBeadsDependencies(ring, { maxEdges: 2 }), refused("input_budget"));
  assert.throws(() => explainBeadsDependencies(ring, { maxInputBytes: 2 }), refused("input_budget"));
  assert.throws(() => explainBeadsDependencies(ring, { maxOutputBytes: 2 }), refused("output_budget"));
  assert.throws(() => explainBeadsDependencies(ring, { maxWitnesses: 2 }), refused("output_budget"));
  assert.equal(explainBeadsDependencies(ring, { maxAnalyses: 1 }).candidates.length, 0);
  const multi = jsonl([{ id: "a", title: "a", dependencies: ["a", "b"] }, { id: "b", title: "b", dependencies: ["b", "a"] }]);
  assert.equal(explainBeadsDependencies(multi, { maxEdits: 1 }).candidates.length, 0);
  const p = explainBeadsDependencies(multi); assert.equal(p.candidates.length, 1); assert.equal(validateBeadsText(previewBeadsDependencyRepair(multi, p.candidates[0])).valid, true);
  for (const value of [NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => assertBeadsRepairNumbers({ value }), refused("work_budget"));
  assert.throws(() => assertBeadsRepairNumbers(new Array(2)), refused("invalid_input"));
  assert.doesNotThrow(() => assertBeadsRepairNumbers({ value: [0, Number.MAX_SAFE_INTEGER, null, false, "text"] }));
  const unexpected = new Error("unanticipated failure"); assert.throws(() => beadsRepairRefusalReceipt(unexpected), error => error === unexpected);
});

test("proposals bind exact source revisions, revalidate current text and reject forged or sparse edits", () => {
  const proposal = explainBeadsDependencies(ring).candidates[0];
  for (const source of [ring + "\n", ring.replace("same", "changed"), ring.replaceAll("\n", "\r\n")]) assert.throws(() => previewBeadsDependencyRepair(source, proposal), refused("source_changed"));
  for (const bad of [null, "x", {}, [], { ...proposal, sourceRevision: 4 }, { ...proposal, sourceRevision: "x" }, { ...proposal, revalidated: false }, { ...proposal, remove: {} }]) assert.throws(() => previewBeadsDependencyRepair(ring, bad as never), refused("invalid_candidate"));
  for (const bad of [{ ...proposal, remove: [] }, { ...proposal, remove: new Array(1) }, { ...proposal, extra: true }, { ...proposal, remove: [{ ...proposal.remove[0], line: Infinity }] }]) assert.throws(() => previewBeadsDependencyRepair(ring, bad), refused("invalid_candidate"));
  for (const edge of [null, { ...proposal.remove[0], extra: true }, { ...proposal.remove[0], id: 4 }, { ...proposal.remove[0], blocker: " " }, ...[NaN, Infinity, -1, 0, 0.5, Number.MAX_SAFE_INTEGER].map(line => ({ ...proposal.remove[0], line }))]) assert.throws(() => previewBeadsDependencyRepair(ring, { ...proposal, remove: [edge] } as never), refused("invalid_candidate"));
  assert.throws(() => previewBeadsDependencyRepair(ring, { ...proposal, remove: Array.from({ length: 33 }, () => proposal.remove[0]) }), refused("invalid_candidate"));
  assert.throws(() => previewBeadsDependencyRepair(ring, { ...proposal, remove: [{ ...proposal.remove[0], blocker: "changed" }] }), refused("invalid_candidate"));
  assert.throws(() => previewBeadsDependencyRepair(ring, { ...proposal, toJSON: () => proposal } as never), refused("invalid_candidate"));
  const getter = { ...proposal }; Object.defineProperty(getter, "remove", { get() { throw new Error("getter must never execute"); }, enumerable: true });
  assert.throws(() => previewBeadsDependencyRepair(ring, getter), refused("invalid_candidate"));
  assert.equal(validateBeadsText(previewBeadsDependencyRepair(ring, { revalidated: true, remove: proposal.remove.map(({ id, blockerLine, line, blocker }) => ({ blocker, line, id, blockerLine })), sourceRevision: proposal.sourceRevision })).valid, true);
});

test("512 seeded random graph operation sequences preserve all SDK-read native state and revalidate every candidate", async t => {
  const dir = await mkdtemp(join(tmpdir(), "beads-repair-model-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const client = new PmClient({ pmRoot: join(dir, "tracker"), author: "model", noExtensions: true }); await client.init("model");
  const ids: string[] = [];
  for (let index = 0; index < 3; index++) ids.push((await client.create({ title: `Native ${index}`, type: "Task", description: "  body\r\nnext  ", priority: index, tags: '["a,b","é"]', unset: ["parent", "sprint", "release", "assignee", "deadline", "blocked_by"] })).item.id);
  const before = await Promise.all(ids.map(async id => (await client.get(id)).item));
  let seed = 0x281026;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed ^ (seed >>> 16)) >>> 0; };
  const model = new Map<string, Set<string>>([...["A", "a", "constructor", "__proto__", "é", "e\u0301"]].map(id => [id, new Set<string>()]));
  const old: string[] = [];
  const oldPackets: ReturnType<typeof explainBeadsDependencies>[] = [];
  for (let sequence = 0; sequence < 512; sequence++) {
    const names = [...model.keys()], id = names[next() % names.length], target = names[next() % names.length];
    if (next() & 1) model.get(id)!.add(target); else model.get(id)!.delete(target);
    const source = jsonl(names.map((id, index) => ({ ...before[index % before.length], id, title: " same ", dependencies: [...model.get(id)!], parent: undefined, blocked_by: undefined }))).replaceAll("\n", sequence % 2 ? "\r\n" : "\n");
    const packet = explainBeadsDependencies(source);
    // Independent six-node transitive-closure model; no core graph algorithm is used in this oracle.
    const reach = new Map([...model].map(([id, edges]) => [id, new Set(edges)]));
    for (const middle of names) for (const from of names) for (const to of names) if (reach.get(from)!.has(middle) && reach.get(middle)!.has(to)) reach.get(from)!.add(to);
    assert.deepEqual(new Set(packet.cycles.flatMap(cycle => cycle.rows.map(row => row.id))), new Set(names.filter(id => reach.get(id)!.has(id))));
    for (const cycle of packet.cycles) for (const edge of cycle.edges) assert(model.get(edge.id)!.has(edge.blocker));
    for (const proposal of packet.candidates) {
      const corrected = previewBeadsDependencyRepair(source, proposal), actual = corrected.split("\n").map(line => JSON.parse(line) as BeadsItem);
      assert.equal(validateBeadsText(corrected).valid, true); assert.equal(explainBeadsDependencies(corrected).valid, true);
      for (let index = 0; index < actual.length; index++) {
        const expected = new Set(model.get(actual[index].id!)!);
        for (const edit of proposal.remove) if (edit.id === actual[index].id) expected.delete(edit.blocker);
        assert.deepEqual(new Set(actual[index].dependencies), expected);
        assert.equal(actual[index].description, before[index % before.length].description);
        assert.deepEqual(actual[index].tags, before[index % before.length].tags);
        const { dependencies: actualEdges, ...actualFields } = actual[index];
        const { dependencies: expectedEdges, ...expectedFields } = JSON.parse(source.split("\n")[index]) as BeadsItem;
        assert.deepEqual(actualFields, expectedFields, "every untouched native field retains its source representation");
      }
    }
    if (old.length) {
      const index = next() % old.length;
      assert.deepEqual(explainBeadsDependencies(old[index]), oldPackets[index]);
    }
    // Replay an older input independently; no receipt or plan is allowed to mutate native state.
    old.push(source);
    oldPackets.push(packet);
  }
  assert.deepEqual(await Promise.all(ids.map(async id => (await client.get(id)).item)), before);
});

test("real host handler returns typed receipts for every CLI budget and file failure", async t => {
  const ext = await harness(); t.after(() => ext.deactivate());
  const dir = await mkdtemp(join(tmpdir(), "beads-repair-handler-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "source.jsonl"); await writeFile(file, ring);
  const malformedUtf8 = join(dir, "invalid-utf8.jsonl"); await writeFile(malformedUtf8, Buffer.from([0xff]));
  const bomFile = join(dir, "bom.jsonl"); await writeFile(bomFile, "\uFEFF" + ring);
  const saved = process.exitCode; t.after(() => { process.exitCode = saved; });
  for (const [args, options, code] of [
    [[], {}, "invalid_input"], [[" "], {}, "invalid_input"], [[join(dir, "absent")], {}, "unreadable_input"], [[dir], {}, "unreadable_input"], [[malformedUtf8], {}, "invalid_input"],
    [[file], { maxRows: " " }, "invalid_input"], [[file], { "max-input-bytes": "1" }, "input_budget"],
    [[file], { maxRows: true }, "invalid_input"],
  ] as const) {
    process.exitCode = 0;
    const value = await runCommand(ext, { command: "beads repair", args: [...args], options, pmRoot: undefined }) as { code: string };
    assert.equal(value.code, code); assert.equal(process.exitCode, 2);
  }
  process.exitCode = 0;
  const packet = await runCommand(ext, { command: "beads-repair", args: [file], options: { maxRows: "10000" }, pmRoot: undefined }) as { valid: boolean };
  assert.equal(packet.valid, false); assert.equal(process.exitCode, 1);
  await writeFile(file, '{"id":"a","title":"Good"}'); process.exitCode = 0;
  assert.equal((await runCommand(ext, { command: "beads repair", args: [file], options: {}, pmRoot: undefined }) as { valid: boolean }).valid, true);
  assert.equal(process.exitCode, 0);
  const bom = await runCommand(ext, { command: "beads repair", args: [bomFile], options: {}, pmRoot: undefined });
  assert.deepEqual(bom, explainBeadsDependencies("\uFEFF" + ring), "UTF-8 decoding preserves every byte including a BOM for SDK revision agreement");
});

test("compiled CLI produces bounded JSON and TOON without git and leaves source and tracker unchanged", async t => {
  const root = resolve(import.meta.dirname, ".."), dir = await mkdtemp(join(tmpdir(), "beads-repair-cli-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const pmRoot = join(dir, "tracker"), extension = join(pmRoot, "extensions", "pm-beads");
  const client = new PmClient({ pmRoot, author: "cli", noExtensions: true }); await client.init("sample"); await mkdir(extension, { recursive: true });
  for (const entry of ["dist", "manifest.json", "package.json"]) await cp(join(root, entry), join(extension, entry), { recursive: true });
  await symlink(join(root, "node_modules"), join(extension, "node_modules"), "junction");
  const file = join(dir, "source.jsonl"); await writeFile(file, ring);
  for (const format of ["--json", "toon"]) {
    const output = spawnSync(process.execPath, [join(root, "node_modules/@unbrained/pm-cli/dist/cli.js"), "--path", pmRoot, ...(format === "--json" ? [format] : []), "beads", "repair", file], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: "", GIT_CEILING_DIRECTORIES: tmpdir() } });
    assert.equal(output.status, 1, output.stdout + output.stderr); assert(output.stdout.includes("sourceRevision"));
    const packet = format === "--json" ? JSON.parse(output.stdout) : decodeToon(output.stdout);
    const expected = rendered(explainBeadsDependencies(ring), format === "--json");
    assert.deepEqual(packet, format === "--json" ? JSON.parse(expected) : decodeToon(expected));
  }
  assert.equal(await readFile(file, "utf8"), ring); assert.equal((await client.listAllComplete()).items.length, 0);
});
