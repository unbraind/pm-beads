import assert from "node:assert/strict";
import test from "node:test";

import extension, {
  CommandError,
  EXIT_CODE,
  assertBeadsImportable,
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
  resolveImportInputFile,
  resolvePreserveIds,
  resolvePreserveTimestamps,
  stripBeadIdMarker,
  validateBeadsText,
  detectDependencyCycles,
  DIFF_FIELDS,
  normalizeDiffField,
  changedFields,
  indexBeadsById,
  diffBeads,
  parseDiffOptions,
} from "../dist/index.js";

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mirror the real ExtensionApi surface so activate() can register every
// capability the extension uses (commands, importers, exporters, schema fields,
// hooks). A missing method makes activate() throw a TypeError.
function makeApi(
  registered: string[],
  captured: {
    commands: Record<string, any>;
    importers: Record<string, any>;
    exporters: Record<string, any>;
    importerOptions?: Record<string, any>;
    exporterOptions?: Record<string, any>;
    preflight?: any;
  } = {
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
    registerPreflight: (fn: any) => {
      registered.push("preflight");
      captured.preflight = fn;
    },
    registerService: () => registered.push("service"),
    registerFlags: () => registered.push("flags"),
    registerItemFields: () => registered.push("itemFields"),
    registerItemTypes: () => registered.push("itemTypes"),
    registerMigration: () => registered.push("migration"),
    registerRenderer: () => registered.push("renderer"),
    registerImporter: (name: string, fn: any, options?: any) => {
      registered.push(`importer:${name}`);
      captured.importers[name] = fn;
      if (captured.importerOptions && options) captured.importerOptions[name] = options;
    },
    registerExporter: (name: string, fn: any, options?: any) => {
      registered.push(`exporter:${name}`);
      captured.exporters[name] = fn;
      if (captured.exporterOptions && options) captured.exporterOptions[name] = options;
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

test("extension registers importer, exporter, schema and commands — but NOT preflight", () => {
  const registered: string[] = [];
  extension.activate(makeApi(registered) as any);
  assert.ok(registered.includes("importer:beads"), "should register the beads importer");
  assert.ok(registered.includes("exporter:beads"), "should register the beads exporter");
  assert.ok(registered.includes("itemFields"), "should register the bead_id schema field");
  assert.ok(registered.includes("command"), "should register at least one command");
  // The fail-fast import gate must NOT depend on the single-winner preflight
  // override surface: a co-installed package (e.g. pm-todos) shadows it
  // (extension_preflight_override_collision) and a malformed file would then
  // partially import. The gate lives inside the import core instead.
  assert.ok(!registered.includes("preflight"), "must not occupy the single-winner preflight slot");
});

test("importer/exporter registrations carry first-class command metadata (options arg)", () => {
  const registered: string[] = [];
  const captured = {
    commands: {} as Record<string, any>,
    importers: {} as Record<string, any>,
    exporters: {} as Record<string, any>,
    importerOptions: {} as Record<string, any>,
    exporterOptions: {} as Record<string, any>,
  };
  extension.activate(makeApi(registered, captured) as any);
  const imp = captured.importerOptions["beads"];
  assert.ok(imp, "importer should pass the ImportExportRegistrationOptions third argument");
  assert.ok(typeof imp.description === "string" && imp.description.length > 0);
  assert.ok(Array.isArray(imp.flags) && imp.flags.some((f: any) => f.long === "--upsert"));
  assert.ok(imp.flags.every((f: any) => f.value_type === "string" || f.value_type === "boolean"));
  const exp = captured.exporterOptions["beads"];
  assert.ok(exp, "exporter should pass the ImportExportRegistrationOptions third argument");
  assert.ok(Array.isArray(exp.flags) && exp.flags.some((f: any) => f.long === "--output"));
});

test("resolveImportInputFile picks the first non-flag argument", () => {
  assert.strictEqual(resolveImportInputFile(["items.jsonl", "--dry-run"]), "items.jsonl");
  assert.strictEqual(resolveImportInputFile(["--upsert", "data.jsonl"]), "data.jsonl");
  assert.strictEqual(resolveImportInputFile(["--type", "Task", "f.jsonl"]), "f.jsonl");
  assert.strictEqual(resolveImportInputFile(["--priority", "2", "--tags", "a,b", "f.jsonl"]), "f.jsonl");
  assert.strictEqual(resolveImportInputFile([]), undefined);
  assert.strictEqual(resolveImportInputFile(["--dry-run"]), undefined);
  assert.strictEqual(resolveImportInputFile(undefined), undefined);
});

test("assertBeadsImportable passes a valid file silently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beads-gate-valid-"));
  const file = join(dir, "valid.jsonl");
  writeFileSync(file, '{"id":"bd-1","title":"First","status":"open"}\n', "utf-8");
  await assert.doesNotReject(() => assertBeadsImportable(file));
});

test("assertBeadsImportable rejects a malformed file with a line-naming CommandError", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beads-gate-bad-"));
  const file = join(dir, "bad.jsonl");
  writeFileSync(
    file,
    ['{"id":"b-1","title":"First"}', '{"id":"b-2","title":"Second"', '{"id":"b-3"}'].join("\n") + "\n",
    "utf-8",
  );
  await assert.rejects(
    () => assertBeadsImportable(file),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.GENERIC_FAILURE);
      assert.match((err as Error).message, /nothing was imported/);
      assert.match((err as Error).message, /line 2 \[invalid_json\]/);
      assert.match((err as Error).message, /line 3 \[missing_title\]/);
      return true;
    },
  );
});

test("assertBeadsImportable maps a missing file to NOT_FOUND", async () => {
  await assert.rejects(
    () => assertBeadsImportable("/nonexistent/definitely-missing.jsonl"),
    (err: unknown) => {
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.NOT_FOUND);
      return true;
    },
  );
});

test("beads importer fail-fast: a malformed file aborts BEFORE any pm write", async () => {
  // The gate is part of runImport itself (not the shadowable preflight slot),
  // so invoking the registered importer with a malformed file must reject with
  // the validation error — proving no create/update spawn can ever happen.
  const registered: string[] = [];
  const captured = { commands: {} as Record<string, any>, importers: {} as Record<string, any>, exporters: {} as Record<string, any> };
  extension.activate(makeApi(registered, captured) as any);
  const importer = captured.importers["beads"];
  const dir = mkdtempSync(join(tmpdir(), "beads-gate-imp-"));
  const file = join(dir, "bad.jsonl");
  writeFileSync(file, '{"id":"x","title":"ok"}\n{broken\n', "utf-8");
  await assert.rejects(
    async () => importer({ args: [file], options: {}, pm_root: undefined }),
    (err: unknown) => {
      assert.match((err as Error).message, /Beads JSONL validation failed/);
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.GENERIC_FAILURE);
      return true;
    },
  );
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
  assert.deepStrictEqual(
    extractBlockerIds({
      dependencies: [{ issue_id: "current", depends_on_id: "upstream", type: "blocks" }],
    }),
    ["upstream"],
  );
  assert.deepStrictEqual(
    extractBlockerIds({
      dependencies: [{ issue_id: 2 as unknown as string, depends_on_id: 1 as unknown as string, type: "blocks" }],
    }),
    ["1"],
  );
  assert.deepStrictEqual(
    extractBlockerIds({ dependencies: [{ id: "downstream", kind: "blocks" }] }),
    [],
    "legacy kind=blocks points downstream and must not be imported as an upstream blocker",
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
  // The README documents `pm beads validate <file>` as the canonical form; it
  // must exist as a real command (the `beads` group only gets import/export
  // from the importer/exporter, so validate needs an explicit registerCommand).
  assert.ok(captured.commands["beads validate"], "should register the canonical 'beads validate' command");
});

test("normalizeBeadKey trims and preserves case but drops empties", () => {
  assert.strictEqual(normalizeBeadKey("  Bd-Mixed-01  "), "Bd-Mixed-01");
  assert.strictEqual(normalizeBeadKey(123 as unknown), "123");
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

test("validateBeadsText accepts current bd export dependency rows", () => {
  const text = [
    JSON.stringify({ _type: "issue", id: "bd-a", title: "First", issue_type: "feature", labels: ["import"] }),
    JSON.stringify({
      _type: "issue",
      id: "bd-b",
      title: "Second",
      issue_type: "task",
      owner: "alice",
      dependencies: [{ issue_id: "bd-b", depends_on_id: "bd-a", type: "blocks" }],
    }),
  ].join("\n");
  const report = validateBeadsText(text);
  assert.strictEqual(report.valid, true);
  assert.strictEqual(report.records, 2);
  assert.strictEqual(report.issues.length, 0);
});

test("validateBeadsText coerces numeric bead ids and dependency ids", () => {
  const text = [
    JSON.stringify({ id: 1, title: "First" }),
    JSON.stringify({
      id: 2,
      title: "Second",
      dependencies: [{ issue_id: 2, depends_on_id: 1, type: "blocks" }],
    }),
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

test("validateBeadsText flags a direct dependency cycle as an error", () => {
  const text = [
    JSON.stringify({ id: "a", title: "A", dependencies: [{ id: "b", kind: "blocked_by" }] }),
    JSON.stringify({ id: "b", title: "B", dependencies: [{ id: "a", kind: "blocked_by" }] }),
  ].join("\n");
  const report = validateBeadsText(text);
  assert.strictEqual(report.valid, false, "a circular dependency must fail validation");
  const cyc = report.issues.find((i) => i.code === "dependency_cycle");
  assert.ok(cyc, "expected a dependency_cycle issue");
  assert.strictEqual(cyc!.severity, "error");
});

test("validateBeadsText flags a self-dependency as a cycle", () => {
  const text = JSON.stringify({ id: "a", title: "A", blocked_by: "a" });
  const report = validateBeadsText(text);
  assert.strictEqual(report.valid, false);
  assert.ok(report.issues.some((i) => i.code === "dependency_cycle"));
});

test("validateBeadsText does NOT report a cycle for an acyclic chain", () => {
  const text = [
    JSON.stringify({ id: "a", title: "A" }),
    JSON.stringify({ id: "b", title: "B", dependencies: [{ id: "a", kind: "blocked_by" }] }),
    JSON.stringify({ id: "c", title: "C", dependencies: [{ id: "b", kind: "blocked_by" }] }),
  ].join("\n");
  const report = validateBeadsText(text);
  assert.strictEqual(report.valid, true);
  assert.ok(!report.issues.some((i) => i.code === "dependency_cycle"));
});

test("detectDependencyCycles finds a multi-node cycle once and ignores acyclic edges", () => {
  // a→b→c→a is a cycle; d→a is acyclic and must not add a second cycle.
  const adj = new Map<string, string[]>([
    ["a", ["b"]],
    ["b", ["c"]],
    ["c", ["a"]],
    ["d", ["a"]],
  ]);
  const cycles = detectDependencyCycles(adj);
  assert.strictEqual(cycles.length, 1, "exactly one distinct cycle");
  // closed path: starts and ends on the same id, covers all three members
  const members = new Set(cycles[0]);
  assert.ok(members.has("a") && members.has("b") && members.has("c"));
  assert.strictEqual(cycles[0][0], cycles[0][cycles[0].length - 1], "path is closed");
});

test("detectDependencyCycles returns nothing for a DAG", () => {
  const adj = new Map<string, string[]>([["a", ["b", "c"]], ["b", ["c"]], ["c", []]]);
  assert.deepStrictEqual(detectDependencyCycles(adj), []);
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

test("beadPassesFilter reads current bd issue_type", () => {
  const bead = { title: "x", status: "open", issue_type: "feature" };
  assert.strictEqual(beadPassesFilter(bead, undefined, { types: new Set(["feature"]) }), true);
  assert.strictEqual(beadPassesFilter(bead, undefined, { types: new Set(["task"]) }), false);
});

test("pmItemPassesFilter matches on the exported Beads status and type", () => {
  const item = { id: "pm-1", title: "x", status: "in_progress", type: "Feature" };
  assert.strictEqual(pmItemPassesFilter(item, { statuses: new Set(["in_progress"]) }), true);
  assert.strictEqual(pmItemPassesFilter(item, { statuses: new Set(["closed"]) }), false);
  assert.strictEqual(pmItemPassesFilter(item, { types: new Set(["feature"]) }), true);
  assert.strictEqual(pmItemPassesFilter(item, {}), true);
});

test("pmItemToBead preserves bead id and translates dependency edges", () => {
  const pmToBead = new Map<string, string>([["pm-up", "bd-up"], ["pm-parent", "bd-parent"]]);
  const bead = pmItemToBead(
    {
      id: "pm-down",
      title: "Downstream",
      description: encodeBeadId("body", "bd-down"),
      status: "in_progress",
      type: "Task",
      assignee: "alice",
      parent: "pm-parent",
      deadline: "2026-07-01",
      sprint: "S17",
      release: "2026.7",
      dependencies: [{ id: "pm-up", kind: "blocked_by" }],
    },
    pmToBead,
    true,
  );
  assert.strictEqual(bead.id, "bd-down");
  assert.strictEqual(bead.status, "in_progress");
  assert.strictEqual(bead.description, "body");
  assert.strictEqual(bead.assignee, "alice");
  assert.strictEqual(bead.parent, "bd-parent");
  assert.strictEqual(bead.deadline, "2026-07-01");
  assert.strictEqual(bead.sprint, "S17");
  assert.strictEqual(bead.release, "2026.7");
  assert.strictEqual(bead.issue_type, "task");
  assert.deepStrictEqual(bead.dependencies, [{ issue_id: "bd-down", depends_on_id: "bd-up", type: "blocks" }]);
});

test("pmItemToBead emits current bd labels and owner fields", () => {
  const bead = pmItemToBead(
    {
      id: "pm-1",
      title: "Current shape",
      description: encodeBeadId("body", "bd-1"),
      type: "Feature",
      tags: ["ctx", "sync"],
      assignee: "alice",
    },
    new Map(),
    true,
  );
  assert.strictEqual(bead.issue_type, "feature");
  assert.deepStrictEqual(bead.labels, ["ctx", "sync"]);
  assert.strictEqual(bead.owner, "alice");
});

// --- Diff core (feature: round-trip fidelity audit) --------------------------

import { spawnSync } from "node:child_process";

test("indexBeadsById keys on bead id, first wins, skips id-less records", () => {
  const idx = indexBeadsById([
    { id: "bd-1", title: "First" },
    { id: "bd-2", title: "Second" },
    { id: "bd-1", title: "Dup ignored" },
    { title: "No id" },
  ]);
  assert.strictEqual(idx.size, 2);
  assert.strictEqual(idx.get("bd-1")?.title, "First");
  assert.strictEqual(idx.get("bd-2")?.title, "Second");
});

test("diffBeads reports zero drift for identical lists", () => {
  const beads = [
    { id: "bd-1", title: "A", status: "open", type: "Task" },
    { id: "bd-2", title: "B", status: "closed", type: "Bug", dependencies: [{ id: "bd-1", kind: "blocked_by" }] },
  ];
  const d = diffBeads(beads, beads.map((b) => ({ ...b })));
  assert.strictEqual(d.drift, false);
  assert.strictEqual(d.unchanged, 2);
  assert.deepStrictEqual(d.added, []);
  assert.deepStrictEqual(d.removed, []);
  assert.deepStrictEqual(d.changed, []);
  assert.strictEqual(d.countA, 2);
  assert.strictEqual(d.countB, 2);
});

test("diffBeads treats legacy and current bd shapes as equivalent", () => {
  const legacy = [{
    id: "bd-2",
    title: "B",
    status: "open",
    type: "Task",
    tags: ["x", "y"],
    assignee: "alice",
    dependencies: [{ id: "bd-1", kind: "blocked_by" }],
  }];
  const current = [{
    _type: "issue",
    id: "bd-2",
    title: "B",
    status: "open",
    issue_type: "task",
    labels: ["y", "x"],
    owner: "alice",
    dependencies: [{ issue_id: "bd-2", depends_on_id: "bd-1", type: "blocks" }],
  }];
  const d = diffBeads(legacy, current);
  assert.strictEqual(d.drift, false);
  assert.strictEqual(d.unchanged, 1);
});

test("diffBeads treats numeric owner and string assignee as equivalent", () => {
  const a = [{ id: "bd-1", title: "A", status: "open", issue_type: "task", owner: 42 as unknown as string }];
  const b = [{ id: "bd-1", title: "A", status: "open", issue_type: "task", assignee: "42" }];
  const d = diffBeads(a, b);
  assert.strictEqual(d.drift, false);
  assert.strictEqual(d.unchanged, 1);
});

test("diffBeads treats semantically-equal status/tag-order/priority-form as unchanged", () => {
  const a = [{ id: "bd-1", title: "A", status: "done", type: "Task", priority: 2, tags: ["x", "y"] }];
  const b = [{ id: "bd-1", title: "A", status: "closed", type: "task", priority: "2", tags: ["y", "x"] }];
  const d = diffBeads(a, b);
  assert.strictEqual(d.drift, false, "done==closed, tag order and 2=='2' must not be drift");
  assert.strictEqual(d.unchanged, 1);
});

test("diffBeads filters nullish label values instead of stringifying them", () => {
  const a = [{ id: "bd-1", title: "A", status: "open", issue_type: "task", labels: ["x", null, undefined] as unknown as string[] }];
  const b = [{ id: "bd-1", title: "A", status: "open", issue_type: "task", tags: ["x"] }];
  const d = diffBeads(a, b);
  assert.strictEqual(d.drift, false);
  assert.strictEqual(d.unchanged, 1);
});

test("diffBeads handles non-string status and missing default priority defensively", () => {
  const a = [{ id: 101 as unknown as string, title: "A", status: 7 as unknown as string, issue_type: "task" }];
  const b = [{ id: "101", title: "A", status: "open", issue_type: "task", priority: 2 }];
  const d = diffBeads(a, b);
  assert.strictEqual(d.drift, false, "numeric ids, non-string statuses, and missing default priority should not crash or drift");
  assert.strictEqual(d.unchanged, 1);
});

test("diffBeads detects added and removed beads", () => {
  const a = [{ id: "bd-1", title: "Stays" }, { id: "bd-2", title: "Goes away" }];
  const b = [{ id: "bd-1", title: "Stays" }, { id: "bd-3", title: "New" }];
  const d = diffBeads(a, b);
  assert.deepStrictEqual(d.added, ["bd-3"]);
  assert.deepStrictEqual(d.removed, ["bd-2"]);
  assert.strictEqual(d.unchanged, 1);
  assert.strictEqual(d.drift, true);
});

test("diffBeads detects per-field changes for matched beads", () => {
  const a = [{ id: "bd-1", title: "Old title", status: "open", type: "Task", priority: 1, assignee: "alice", parent: "bd-9", deadline: "2026-01-01", tags: ["a"] }];
  const b = [{ id: "bd-1", title: "New title", status: "in_progress", type: "Bug", priority: 3, assignee: "bob", parent: "bd-8", deadline: "2026-02-02", tags: ["a", "b"] }];
  const d = diffBeads(a, b);
  assert.strictEqual(d.changed.length, 1);
  assert.strictEqual(d.changed[0].id, "bd-1");
  assert.deepStrictEqual(
    d.changed[0].fields.sort(),
    ["assignee", "deadline", "parent", "priority", "status", "tags", "title", "type"].sort(),
  );
  assert.strictEqual(d.unchanged, 0);
});

test("diffBeads detects dependency edge changes", () => {
  const a = [{ id: "bd-2", title: "T", dependencies: [{ id: "bd-1", kind: "blocked_by" }] }];
  const b = [{ id: "bd-2", title: "T", dependencies: [{ id: "bd-1", kind: "blocked_by" }, { id: "bd-3", kind: "blocked_by" }] }];
  const d = diffBeads(a, b);
  assert.strictEqual(d.changed.length, 1);
  assert.deepStrictEqual(d.changed[0].fields, ["dependencies"]);
  // Same edges spelled differently (blocked_by string vs dependencies array) are equal.
  const c = diffBeads(
    [{ id: "bd-2", title: "T", blocked_by: "bd-1" }],
    [{ id: "bd-2", title: "T", dependencies: [{ id: "bd-1", kind: "blocked_by" }] }],
  );
  assert.strictEqual(c.drift, false, "blocked_by:'bd-1' == dependencies:[{id:bd-1}]");
});

test("normalizeDiffField and changedFields cover all DIFF_FIELDS", () => {
  assert.deepStrictEqual([...DIFF_FIELDS], ["title", "status", "type", "priority", "tags", "assignee", "parent", "deadline", "dependencies"]);
  // beadDeadline alias: due_date is honored when deadline is absent.
  assert.strictEqual(normalizeDiffField({ due_date: "2026-03-03" } as any, "deadline"), "2026-03-03");
  assert.deepStrictEqual(changedFields({ id: "x", title: "Same" }, { id: "x", title: "Same" }), []);
  assert.deepStrictEqual(changedFields({ id: "x", title: "A" }, { id: "x", title: "B" }), ["title"]);
});

test("diffBeads honors a status/type row filter on both sides", () => {
  const a = [
    { id: "bd-1", title: "Open task", status: "open", type: "Task" },
    { id: "bd-2", title: "Closed bug", status: "closed", type: "Bug" },
  ];
  const b = [
    { id: "bd-1", title: "Open task", status: "open", type: "Task" },
    { id: "bd-2", title: "Closed bug CHANGED", status: "closed", type: "Bug" },
  ];
  // Filtering to open-only excludes bd-2, so the changed title is invisible.
  const d = diffBeads(a, b, { statuses: new Set(["open"]) });
  assert.strictEqual(d.drift, false);
  assert.strictEqual(d.countA, 1);
  assert.strictEqual(d.countB, 1);
  // Without the filter, the change surfaces.
  const all = diffBeads(a, b);
  assert.strictEqual(all.changed.length, 1);
});

test("parseDiffOptions reads flags from options and the global --json", () => {
  const o = parseDiffOptions({ "against-workspace": true, strict: true, "filter-status": "open" }, {}, "/pm");
  assert.strictEqual(o.againstWorkspace, true);
  assert.strictEqual(o.strict, true);
  assert.strictEqual(o.preserveIds, true);
  assert.deepStrictEqual([...o.filter.statuses!], ["open"]);
  assert.strictEqual(o.pmRoot, "/pm");
  // --json may arrive on the global flag bag instead of the command options.
  assert.strictEqual(parseDiffOptions({}, { json: true }).json, true);
  assert.strictEqual(parseDiffOptions({ json: true }, {}).json, true);
  assert.strictEqual(parseDiffOptions({}, {}).json, false);
});

test("extension registers the diff command and its hyphenated alias", () => {
  const registered: string[] = [];
  const captured = { commands: {} as Record<string, any>, importers: {} as Record<string, any>, exporters: {} as Record<string, any> };
  extension.activate(makeApi(registered, captured) as any);
  assert.ok(captured.commands["beads diff"], "should register the canonical 'beads diff' command");
  assert.ok(captured.commands["beads-diff"], "should register the 'beads-diff' rich-help alias");
});

// --against-workspace path: build a real fixture pm workspace via the `pm` CLI,
// export it through the shared export core, then diff a Beads file against the
// live workspace through the registered `beads diff` command handler. This
// exercises buildBeadsFromWorkspace -> spawnSync("pm", ...) end to end.
test("beads diff --against-workspace compares a file against the live workspace", { skip: !hasPmCli() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "beads-diff-ws-"));
  const pmRoot = join(root, ".agents", "pm");
  mkdirSync(pmRoot, { recursive: true });

  // Initialize the tracker so create/list-all work against this fixture root.
  const init = spawnSync("pm", ["--path", pmRoot, "init"], { encoding: "utf-8" });
  assert.strictEqual(init.status, 0, `pm init failed: ${init.stderr}`);

  // Seed one item carrying a bead_id provenance marker so the workspace export
  // re-emits that native bead id (the stable diff key).
  const create = spawnSync(
    "pm",
    ["--path", pmRoot, "--json", "create", "--title", "Workspace task", "--type", "Task",
     "--status", "open", "--description", encodeBeadId("body", "bd-ws-1")],
    { encoding: "utf-8" },
  );
  assert.strictEqual(create.status, 0, `pm create failed: ${create.stderr}`);

  const registered: string[] = [];
  const captured = { commands: {} as Record<string, any>, importers: {} as Record<string, any>, exporters: {} as Record<string, any> };
  extension.activate(makeApi(registered, captured) as any);
  const diffCmd = captured.commands["beads diff"];
  assert.ok(diffCmd, "beads diff command should be registered");

  // File A matches the workspace bead exactly (same id + title) -> no drift,
  // plus an extra bead only in the file -> classified as "removed" (only in A).
  const fileA = join(root, "a.jsonl");
  writeFileSync(
    fileA,
    [
      // priority 2 matches pm's default so this bead is byte-identical to the
      // workspace export (otherwise the priority default would read as drift).
      JSON.stringify({ id: "bd-ws-1", title: "Workspace task", status: "open", type: "Task", priority: 2 }),
      JSON.stringify({ id: "bd-extra", title: "Only in file", status: "open", type: "Task", priority: 2 }),
    ].join("\n") + "\n",
    "utf-8",
  );

  // Pass args the way the real CLI does: the boolean flag token rides along in
  // ctx.args next to the positional file. runDiff must extract the positional
  // file and not mistake the flag for a second file.
  const result = await diffCmd.run({
    args: [fileA, "--against-workspace"],
    options: { "against-workspace": true, json: true },
    global: {},
    pm_root: pmRoot,
  });
  // bd-ws-1 is in both (unchanged); bd-extra is only in the file (A) -> removed.
  assert.strictEqual(result.b, "workspace");
  assert.ok(result.removed.includes("bd-extra"), "file-only bead is 'removed' (only in A)");
  assert.ok(!result.added.includes("bd-ws-1"));
  assert.strictEqual(result.unchanged, 1, "the matching bead is unchanged");
  assert.strictEqual(result.drift, true);
});

test("beads diff requires a second file without --against-workspace (USAGE)", async () => {
  const registered: string[] = [];
  const captured = { commands: {} as Record<string, any>, importers: {} as Record<string, any>, exporters: {} as Record<string, any> };
  extension.activate(makeApi(registered, captured) as any);
  const diffCmd = captured.commands["beads diff"];
  const dir = mkdtempSync(join(tmpdir(), "beads-diff-usage-"));
  const fileA = join(dir, "a.jsonl");
  writeFileSync(fileA, JSON.stringify({ id: "bd-1", title: "T" }) + "\n", "utf-8");
  await assert.rejects(
    async () => diffCmd.run({ args: [fileA], options: {}, global: {}, pm_root: dir }),
    (err: unknown) => {
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.USAGE);
      return true;
    },
  );
});

test("beads diff --strict exits nonzero (throws) on drift, zero otherwise", async () => {
  const registered: string[] = [];
  const captured = { commands: {} as Record<string, any>, importers: {} as Record<string, any>, exporters: {} as Record<string, any> };
  extension.activate(makeApi(registered, captured) as any);
  const diffCmd = captured.commands["beads diff"];
  const dir = mkdtempSync(join(tmpdir(), "beads-diff-strict-"));
  const a = join(dir, "a.jsonl");
  const b = join(dir, "b.jsonl");
  writeFileSync(a, JSON.stringify({ id: "bd-1", title: "One" }) + "\n", "utf-8");
  writeFileSync(b, JSON.stringify({ id: "bd-2", title: "Two" }) + "\n", "utf-8");
  // Drift + --strict -> throws a CommandError with a nonzero exit code.
  await assert.rejects(
    async () => diffCmd.run({ args: [a, b], options: { strict: true }, global: {}, pm_root: dir }),
    (err: unknown) => {
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.GENERIC_FAILURE);
      assert.match((err as Error).message, /Drift detected/);
      return true;
    },
  );
  // Identical files + --strict -> no throw, returns a no-drift result.
  const same = await diffCmd.run({ args: [a, a], options: { strict: true }, global: {}, pm_root: dir });
  assert.strictEqual(same.drift, false);
});

test("beads diff hard-fails on a malformed JSONL line", async () => {
  const registered: string[] = [];
  const captured = { commands: {} as Record<string, any>, importers: {} as Record<string, any>, exporters: {} as Record<string, any> };
  extension.activate(makeApi(registered, captured) as any);
  const diffCmd = captured.commands["beads diff"];
  const dir = mkdtempSync(join(tmpdir(), "beads-diff-bad-"));
  const a = join(dir, "a.jsonl");
  const b = join(dir, "b.jsonl");
  writeFileSync(a, "{not json\n", "utf-8");
  writeFileSync(b, JSON.stringify({ id: "bd-1", title: "T" }) + "\n", "utf-8");
  await assert.rejects(
    async () => diffCmd.run({ args: [a, b], options: {}, global: {}, pm_root: dir }),
    (err: unknown) => {
      assert.match((err as Error).message, /invalid JSON/);
      return true;
    },
  );
});

function hasPmCli(): boolean {
  try {
    const r = spawnSync("pm", ["--version"], { encoding: "utf-8" });
    return r.status === 0;
  } catch {
    return false;
  }
}
