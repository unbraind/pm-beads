import assert from "node:assert/strict";
import test from "node:test";

import extension, {
  CommandError,
  EXIT_CODE,
  buildBeadIndex,
  beadPassesFilter,
  decodeBeadId,
  encodeBeadId,
  extractBlockerIds,
  extractCreatedId,
  locateItemFile,
  normalizeBeadKey,
  normalizeIsoTimestamp,
  parseRowFilter,
  patchTimestampLines,
  pmItemPassesFilter,
  pmItemToBead,
  resolvePreserveIds,
  resolvePreserveTimestamps,
  stripBeadIdMarker,
  validateBeadsText,
} from "../dist/index.js";

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mirror the real ExtensionApi surface so activate() can register every
// capability the extension uses (commands, importers, exporters, schema fields,
// hooks). A missing method makes activate() throw a TypeError.
function makeApi(
  registered: string[],
  captured: { commands: Record<string, any>; importers: Record<string, any>; exporters: Record<string, any> } = {
    commands: {},
    importers: {},
    exporters: {},
  },
) {
  const noop = () => {};
  return {
    registerCommand: (def: any) => {
      registered.push("command");
      if (def?.name) captured.commands[def.name] = def;
    },
    registerParser: () => registered.push("parser"),
    registerPreflight: () => registered.push("preflight"),
    registerService: () => registered.push("service"),
    registerFlags: () => registered.push("flags"),
    registerItemFields: () => registered.push("itemFields"),
    registerItemTypes: () => registered.push("itemTypes"),
    registerMigration: () => registered.push("migration"),
    registerRenderer: () => registered.push("renderer"),
    registerImporter: (name: string, fn: any) => {
      registered.push(`importer:${name}`);
      captured.importers[name] = fn;
    },
    registerExporter: (name: string, fn: any) => {
      registered.push(`exporter:${name}`);
      captured.exporters[name] = fn;
    },
    registerSearchProvider: () => registered.push("search"),
    registerVectorStoreAdapter: () => registered.push("vectorStore"),
    hooks: {
      beforeCommand: noop,
      afterCommand: noop,
      onWrite: noop,
      onRead: noop,
      onIndex: noop,
    },
  };
}

test("extension has required shape", () => {
  assert.ok(extension, "module should export a default value");
  assert.strictEqual(typeof extension, "object", "extension should be an object");
  assert.ok("name" in extension, "extension should have a name property");
  assert.ok("activate" in extension, "extension should have an activate method");
  assert.strictEqual(typeof extension.activate, "function", "activate should be a function");
});

test("extension registers importer, exporter, schema and commands", () => {
  const registered: string[] = [];
  extension.activate(makeApi(registered) as any);
  assert.ok(registered.includes("importer:beads"), "should register the beads importer");
  assert.ok(registered.includes("exporter:beads"), "should register the beads exporter");
  assert.ok(registered.includes("itemFields"), "should register the bead_id schema field");
  assert.ok(registered.includes("command"), "should register at least one command");
});

test("beads importer rejects a missing file argument with a USAGE exit code", async () => {
  const registered: string[] = [];
  const captured = { commands: {} as Record<string, any>, importers: {} as Record<string, any>, exporters: {} as Record<string, any> };
  extension.activate(makeApi(registered, captured) as any);
  const importer = captured.importers["beads"];
  assert.ok(importer, "beads importer should be registered");
  await assert.rejects(
    async () => importer({ args: [], options: {}, pm_root: ".agents/pm" }),
    (err: unknown) => {
      assert.match((err as Error).message, /Usage: pm beads import/);
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.USAGE);
      return true;
    },
  );
});

test("bead id round-trips through the description marker", () => {
  const desc = encodeBeadId("Original body text", "bd-42");
  assert.match(desc, /\[bead_id: bd-42\]/);
  assert.strictEqual(decodeBeadId({ description: desc }), "bd-42");
  assert.strictEqual(stripBeadIdMarker(desc), "Original body text");
});

test("encodeBeadId does not duplicate an existing marker and tolerates empty body", () => {
  const once = encodeBeadId("x", "bd-1");
  assert.strictEqual(encodeBeadId(once, "bd-1"), once);
  assert.strictEqual(encodeBeadId("", "bd-9"), "[bead_id: bd-9]");
  assert.strictEqual(encodeBeadId("x", undefined), "x");
});

test("extractBlockerIds normalizes the various Beads edge shapes", () => {
  assert.deepStrictEqual(
    extractBlockerIds({ dependencies: ["a", { id: "b", kind: "blocked_by" }, { id: "c", kind: "blocks" }] }),
    ["a", "b"],
  );
  assert.deepStrictEqual(extractBlockerIds({ blocked_by: "z" }), ["z"]);
  assert.deepStrictEqual(extractBlockerIds({ blocked_by: ["z", "y"] }), ["z", "y"]);
});

test("resolvePreserveIds defaults on and honors negation", () => {
  assert.strictEqual(resolvePreserveIds({}), true);
  assert.strictEqual(resolvePreserveIds({ preserveIds: false }), false);
  assert.strictEqual(resolvePreserveIds({ "preserve-ids": false }), false);
  assert.strictEqual(resolvePreserveIds({ "no-preserve-ids": true }), false);
});

test("extractCreatedId reads both top-level and nested id shapes", () => {
  assert.strictEqual(extractCreatedId('{"id":"pm-abcd"}'), "pm-abcd");
  assert.strictEqual(extractCreatedId('{"item":{"id":"pm-wxyz"}}'), "pm-wxyz");
  assert.strictEqual(extractCreatedId("not json"), undefined);
});

test("extension registers the validate command", () => {
  const registered: string[] = [];
  const captured = { commands: {} as Record<string, any>, importers: {} as Record<string, any>, exporters: {} as Record<string, any> };
  extension.activate(makeApi(registered, captured) as any);
  assert.ok(captured.commands["beads-validate"], "should register the beads-validate command");
});

test("normalizeBeadKey trims and preserves case but drops empties", () => {
  assert.strictEqual(normalizeBeadKey("  Bd-Mixed-01  "), "Bd-Mixed-01");
  assert.strictEqual(normalizeBeadKey(""), undefined);
  assert.strictEqual(normalizeBeadKey("   "), undefined);
  assert.strictEqual(normalizeBeadKey(undefined), undefined);
});

test("buildBeadIndex keys existing pm items by their decoded bead id (first wins) and carries status", () => {
  const index = buildBeadIndex([
    { id: "pm-1", status: "closed", description: encodeBeadId("a", "bd-1") },
    { id: "pm-2", status: "open", description: encodeBeadId("b", "bd-2") },
    { id: "pm-3", description: encodeBeadId("dup", "bd-1") }, // later dup ignored
    { id: "pm-4", description: "no marker here" },
  ]);
  assert.strictEqual(index.get("bd-1")?.pmId, "pm-1");
  assert.strictEqual(index.get("bd-1")?.status, "closed");
  assert.strictEqual(index.get("bd-2")?.pmId, "pm-2");
  assert.strictEqual(index.size, 2, "items without a bead marker are not indexed");
});

test("validateBeadsText passes a clean file", () => {
  const text = [
    JSON.stringify({ id: "a", title: "First" }),
    JSON.stringify({ id: "b", title: "Second", dependencies: [{ id: "a", kind: "blocked_by" }] }),
    "", // blank lines allowed
  ].join("\n");
  const report = validateBeadsText(text);
  assert.strictEqual(report.valid, true);
  assert.strictEqual(report.records, 2);
  assert.strictEqual(report.issues.length, 0);
});

test("validateBeadsText flags invalid JSON, missing title and dangling deps as errors", () => {
  const text = [
    "{ not json",
    JSON.stringify({ id: "a" }), // missing title
    JSON.stringify({ id: "b", title: "Has dep", blocked_by: "ghost" }), // dangling
  ].join("\n");
  const report = validateBeadsText(text);
  assert.strictEqual(report.valid, false);
  const codes = report.issues.map((i) => i.code).sort();
  assert.ok(codes.includes("invalid_json"));
  assert.ok(codes.includes("missing_title"));
  assert.ok(codes.includes("dangling_dependency"));
});

test("validateBeadsText warns (does not fail) on unknown status and duplicate ids", () => {
  const text = [
    JSON.stringify({ id: "a", title: "One", status: "frobnicated" }),
    JSON.stringify({ id: "a", title: "Two" }),
  ].join("\n");
  const report = validateBeadsText(text);
  assert.strictEqual(report.valid, true, "warnings alone keep the file valid");
  const codes = report.issues.map((i) => i.code);
  assert.ok(codes.includes("unknown_status"));
  assert.ok(codes.includes("duplicate_id"));
});

// --- Timestamp fidelity (feature 1) -----------------------------------------

test("normalizeIsoTimestamp accepts valid ISO and rejects garbage", () => {
  assert.strictEqual(normalizeIsoTimestamp("2026-01-02T03:04:05.000Z"), "2026-01-02T03:04:05.000Z");
  assert.strictEqual(normalizeIsoTimestamp("2026-01-02"), "2026-01-02T00:00:00.000Z");
  assert.strictEqual(normalizeIsoTimestamp("not a date"), undefined);
  assert.strictEqual(normalizeIsoTimestamp(""), undefined);
  assert.strictEqual(normalizeIsoTimestamp(undefined), undefined);
  assert.strictEqual(normalizeIsoTimestamp(12345 as unknown), undefined);
});

test("patchTimestampLines rewrites existing front-matter lines only", () => {
  const toon = [
    'id: pm-x',
    'title: T',
    'created_at: "2026-06-03T23:00:00.000Z"',
    'updated_at: "2026-06-03T23:00:00.000Z"',
    'body: ""',
  ].join("\n");
  const out = patchTimestampLines(toon, {
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-02-02T00:00:00.000Z",
  });
  assert.ok(out);
  assert.match(out!, /created_at: "2025-01-01T00:00:00.000Z"/);
  assert.match(out!, /updated_at: "2025-02-02T00:00:00.000Z"/);
  assert.match(out!, /title: T/); // untouched
  // No matching key -> no change.
  assert.strictEqual(patchTimestampLines("title: T\n", { created_at: "2025-01-01T00:00:00.000Z" }), null);
});

test("patchTimestampLines round-trips a created_at through normalize+patch losslessly", () => {
  const iso = normalizeIsoTimestamp("2024-12-25T08:30:00Z")!;
  const file = `created_at: "2026-06-03T23:00:00.000Z"\nupdated_at: "2026-06-03T23:00:00.000Z"\n`;
  const out = patchTimestampLines(file, { created_at: iso, updated_at: iso })!;
  assert.match(out, new RegExp(`created_at: "${iso.replace(/[.]/g, "\\.")}"`));
});

test("locateItemFile finds the per-type item file and skips sidecars", () => {
  const root = mkdtempSync(join(tmpdir(), "pmbeads-loc-"));
  mkdirSync(join(root, "tasks"), { recursive: true });
  mkdirSync(join(root, "history"), { recursive: true });
  writeFileSync(join(root, "tasks", "pm-abc.toon"), "id: pm-abc\n");
  writeFileSync(join(root, "history", "pm-abc.jsonl"), "{}\n"); // must be ignored
  assert.strictEqual(locateItemFile(root, "pm-abc"), join(root, "tasks", "pm-abc.toon"));
  assert.strictEqual(locateItemFile(root, "pm-missing"), undefined);
});

test("resolvePreserveTimestamps defaults on and honors negation", () => {
  assert.strictEqual(resolvePreserveTimestamps({}), true);
  assert.strictEqual(resolvePreserveTimestamps({ "no-preserve-timestamps": true }), false);
  assert.strictEqual(resolvePreserveTimestamps({ noPreserveTimestamps: true }), false);
  assert.strictEqual(resolvePreserveTimestamps({ preserveTimestamps: false }), false);
});

// --- Workspace dependency validation (feature 2) -----------------------------

test("validateBeadsText downgrades a workspace-resolvable dep to a warning", () => {
  const text = JSON.stringify({ id: "b", title: "Dep on prior import", blocked_by: "bd-external" });
  // Without workspace info: hard error.
  const noWs = validateBeadsText(text);
  assert.strictEqual(noWs.valid, false);
  assert.ok(noWs.issues.some((i) => i.code === "dangling_dependency"));
  // With the dep present in the workspace: downgraded to a warning, still valid.
  const ws = validateBeadsText(text, undefined, new Set(["bd-external"]));
  assert.strictEqual(ws.valid, true);
  assert.ok(ws.issues.some((i) => i.code === "cross_workspace_dependency"));
  assert.ok(!ws.issues.some((i) => i.code === "dangling_dependency"));
});

test("validateBeadsText keeps an error for a dep absent from both file and workspace", () => {
  const text = JSON.stringify({ id: "b", title: "Dep on nothing", blocked_by: "ghost" });
  const ws = validateBeadsText(text, undefined, new Set(["bd-other"]));
  assert.strictEqual(ws.valid, false);
  assert.ok(ws.issues.some((i) => i.code === "dangling_dependency"));
});

test("validateBeadsText prefers in-file resolution over workspace check", () => {
  const text = [
    JSON.stringify({ id: "a", title: "Upstream" }),
    JSON.stringify({ id: "b", title: "Downstream", blocked_by: "a" }),
  ].join("\n");
  const ws = validateBeadsText(text, undefined, new Set<string>());
  assert.strictEqual(ws.valid, true);
  assert.strictEqual(ws.issues.length, 0);
});

// --- Row filters (feature 3) -------------------------------------------------

test("parseRowFilter reads both kebab and camel flag spellings", () => {
  const f = parseRowFilter({ "filter-status": "Open, in_progress", filterType: "Bug,Task" });
  assert.deepStrictEqual([...f.statuses!].sort(), ["in_progress", "open"]);
  assert.deepStrictEqual([...f.types!].sort(), ["bug", "task"]);
  assert.deepStrictEqual(parseRowFilter({}), { statuses: undefined, types: undefined });
});

test("beadPassesFilter matches on mapped status and effective type", () => {
  const bead = { title: "x", status: "done", type: "Bug" };
  // "done" maps to pm "closed".
  assert.strictEqual(beadPassesFilter(bead, undefined, { statuses: new Set(["closed"]) }), true);
  assert.strictEqual(beadPassesFilter(bead, undefined, { statuses: new Set(["open"]) }), false);
  assert.strictEqual(beadPassesFilter(bead, undefined, { types: new Set(["bug"]) }), true);
  assert.strictEqual(beadPassesFilter(bead, undefined, { types: new Set(["task"]) }), false);
  // Type override wins over the bead's own type.
  assert.strictEqual(beadPassesFilter(bead, "Task", { types: new Set(["task"]) }), true);
  // No filter set -> passes.
  assert.strictEqual(beadPassesFilter(bead, undefined, {}), true);
});

test("pmItemPassesFilter matches on the exported Beads status and type", () => {
  const item = { id: "pm-1", title: "x", status: "in_progress", type: "Feature" };
  assert.strictEqual(pmItemPassesFilter(item, { statuses: new Set(["in_progress"]) }), true);
  assert.strictEqual(pmItemPassesFilter(item, { statuses: new Set(["closed"]) }), false);
  assert.strictEqual(pmItemPassesFilter(item, { types: new Set(["feature"]) }), true);
  assert.strictEqual(pmItemPassesFilter(item, {}), true);
});

test("pmItemToBead preserves bead id and translates dependency edges", () => {
  const pmToBead = new Map<string, string>([["pm-up", "bd-up"]]);
  const bead = pmItemToBead(
    {
      id: "pm-down",
      title: "Downstream",
      description: encodeBeadId("body", "bd-down"),
      status: "in_progress",
      type: "Task",
      dependencies: [{ id: "pm-up", kind: "blocked_by" }],
    },
    pmToBead,
    true,
  );
  assert.strictEqual(bead.id, "bd-down");
  assert.strictEqual(bead.status, "in_progress");
  assert.strictEqual(bead.description, "body");
  assert.deepStrictEqual(bead.dependencies, [{ id: "bd-up", kind: "blocked_by" }]);
});
