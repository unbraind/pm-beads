import assert from "node:assert/strict";
import test from "node:test";

import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import type { GlobalOptions } from "@unbrained/pm-cli/sdk";

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
  parseFilterExpression,
  mergeRowFilters,
  parseMergeStrategy,
  parsePositiveIntOption,
  parseExportOptions,
  readAndValidateBeads,
  MERGE_STRATEGIES,
  patchTimestampLines,
  pmItemPassesFilter,
  pmItemToBead,
  resolveImportInputFile,
  resolvePreserveIds,
  resolvePreserveTimestamps,
  resolveWorkspaceCheck,
  stripBeadIdMarker,
  validateBeadsText,
  detectDependencyCycles,
  DIFF_FIELDS,
  normalizeDiffField,
  changedFields,
  indexBeadsById,
  diffBeads,
  parseDiffOptions,
  isInvalidTypeValueError,
  type RowFilter,
} from "../index.ts";

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Activate pm-beads through pm's real host engine with the manifest's declared
 * capabilities. Replaces the hand-rolled api doubles these tests used to build —
 * a double accepts every registration unconditionally, so it cannot observe
 * host-side rejection (which is how `--json` flags that shadow a host-owned
 * global stayed green in CI while commands failed to register). */
async function harness(): Promise<ExtensionTestHarness> {
  const ext = await createExtensionTestHarness(extension, {
    name: "pm-beads",
    capabilities: ["commands", "schema", "importers"],
  });
  assert.deepEqual(ext.activation.failed, [], "activation must not fail");
  return ext;
}
interface ImportResult {
  imported?: number;
  updated?: number;
  skipped?: number;
  dependencies?: number;
  wouldImport?: number;
  wouldSkip?: number;
  batches?: number;
  validateOnly?: boolean;
  records?: number;
  valid?: boolean;
  dryRun?: boolean;
}

async function runImport(
  ext: ExtensionTestHarness,
  opts: { args?: readonly string[]; options?: Record<string, unknown>; pmRoot?: string; global?: Partial<GlobalOptions> },
): Promise<ImportResult> {
  const { result } = await ext.runImporter({ importer: "beads", ...opts, global: opts.global ?? { json: false } });
  return result as ImportResult;
}

async function runExport(
  ext: ExtensionTestHarness,
  opts: { args?: readonly string[]; options?: Record<string, unknown>; pmRoot?: string; global?: Partial<GlobalOptions> },
): Promise<Record<string, unknown>> {
  const { result } = await ext.runExporter({ exporter: "beads", ...opts, global: opts.global ?? { json: false } });
  return result as Record<string, unknown>;
}

test("extension has required shape", () => {
  assert.ok(extension, "module should export a default value");
  assert.strictEqual(typeof extension, "object", "extension should be an object");
  assert.ok("name" in extension, "extension should have a name property");
  assert.ok("activate" in extension, "extension should have an activate method");
  assert.strictEqual(typeof extension.activate, "function", "activate should be a function");
});

test("extension registers importer, exporter, schema and commands — but NOT preflight", async () => {
  const ext = await harness();
  const { registrations } = ext.activation;
  assert.ok(registrations.importers.some((r) => r.importer === "beads"), "should register the beads importer");
  assert.ok(registrations.exporters.some((r) => r.exporter === "beads"), "should register the beads exporter");
  assert.ok(registrations.item_fields.length > 0, "should register schema fields");
  assert.ok(registrations.commands.length > 0, "should register at least one command");
  // The fail-fast import gate must NOT depend on the single-winner preflight
  // override surface: a co-installed package (e.g. pm-todos) shadows it
  // (extension_preflight_override_collision) and a malformed file would then
  // partially import. The gate lives inside the import core instead.
  assert.strictEqual(ext.activation.preflight.overrides.length, 0, "must not occupy the single-winner preflight slot");
  await ext.deactivate();
});

test("importer/exporter registrations carry first-class command metadata (options arg)", async () => {
  const ext = await harness();
  // Importer/exporter options are registered as command metadata at the
  // "beads import" / "beads export" command paths.
  const impContract = ext.assertCommandContract({ command: "beads import", flags: ["--upsert"] });
  assert.ok(impContract.command.description && impContract.command.description.length > 0,
    "importer should carry a description");
  assert.deepStrictEqual(impContract.command.arguments, [
    { name: "file", required: true, description: "Path to the Beads JSONL source file." },
  ]);
  assert.ok(impContract.flags.some((f) => f.long === "--upsert"));
  assert.ok(impContract.flags.every((f) => f.value_type === "string" || f.value_type === "boolean"));
  const expContract = ext.assertCommandContract({ command: "beads export", flags: ["--output"] });
  assert.ok(expContract.flags.some((f) => f.long === "--output"));
  await ext.deactivate();
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
  const ext = await harness();
  const dir = mkdtempSync(join(tmpdir(), "beads-gate-imp-"));
  const file = join(dir, "bad.jsonl");
  writeFileSync(file, '{"id":"x","title":"ok"}\n{broken\n', "utf-8");
  await assert.rejects(
    () => runImport(ext, { args: [file], options: {}, global: { json: false } }),
    (err: unknown) => {
      assert.match((err as Error).message, /Beads JSONL validation failed/);
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.GENERIC_FAILURE);
      return true;
    },
  );
  await ext.deactivate();
});

test("beads importer rejects a missing file argument with a USAGE exit code", async () => {
  const ext = await harness();
  await assert.rejects(
    () => runImport(ext, { args: [], options: {}, global: { json: false }, pmRoot: ".agents/pm" }),
    (err: unknown) => {
      assert.match((err as Error).message, /Usage: pm beads import/);
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.USAGE);
      return true;
    },
  );
  await ext.deactivate();
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

test("resolveWorkspaceCheck defaults on and honors every --no-workspace shape", () => {
  assert.strictEqual(resolveWorkspaceCheck({}), true);
  // Runtime normalizes --no-workspace to { workspace: false } — the shape the
  // validate handler previously ignored, making the flag a silent no-op.
  assert.strictEqual(resolveWorkspaceCheck({ workspace: false }), false);
  assert.strictEqual(resolveWorkspaceCheck({ workspace: "false" }), false);
  assert.strictEqual(resolveWorkspaceCheck({ noWorkspace: true }), false);
  assert.strictEqual(resolveWorkspaceCheck({ "no-workspace": true }), false);
  assert.strictEqual(resolveWorkspaceCheck({ workspace: true }), true);
});

test("extractCreatedId reads both top-level and nested id shapes", () => {
  assert.strictEqual(extractCreatedId('{"id":"pm-abcd"}'), "pm-abcd");
  assert.strictEqual(extractCreatedId('{"item":{"id":"pm-wxyz"}}'), "pm-wxyz");
  assert.strictEqual(extractCreatedId("not json"), undefined);
});

test("extension registers the validate command", async () => {
  const ext = await harness();
  const { registrations } = ext.activation;
  assert.ok(registrations.commands.some((c) => c.command === "beads-validate"), "should register the beads-validate command");
  // The README documents `pm beads validate <file>` as the canonical form; it
  // must exist as a real command (the `beads` group only gets import/export
  // from the importer/exporter, so validate needs an explicit registerCommand).
  assert.ok(registrations.commands.some((c) => c.command === "beads validate"), "should register the canonical 'beads validate' command");
  await ext.deactivate();
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

test("detectDependencyCycles handles a very deep DAG without call-stack overflow", () => {
  const depth = 25_000;
  const adj = new Map<string, string[]>();
  for (let i = 0; i < depth; i++) {
    adj.set(`node-${i}`, i + 1 < depth ? [`node-${i + 1}`] : []);
  }
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
  assert.strictEqual(normalizeDiffField({ due_date: "2026-03-03" } as unknown as Record<string, unknown>, "deadline"), "2026-03-03");
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
  // `--json` is a host-owned global read from the global flag bag, not
  // command options (the flag declaration was removed to avoid shadowing).
  assert.strictEqual(parseDiffOptions({}, { json: true }).json, true);
  assert.strictEqual(parseDiffOptions({}, {}).json, false);
});

test("extension registers the diff command and its hyphenated alias", async () => {
  const ext = await harness();
  const { registrations } = ext.activation;
  assert.ok(registrations.commands.some((c) => c.command === "beads diff"), "should register the canonical 'beads diff' command");
  assert.ok(registrations.commands.some((c) => c.command === "beads-diff"), "should register the 'beads-diff' rich-help alias");
  await ext.deactivate();
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

  const ext = await harness();

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
  // `--json` is a host-owned global read from ctx.global, so pass it via global.
  const { result } = await ext.runCommand({
    command: "beads diff",
    args: [fileA, "--against-workspace"],
    options: { "against-workspace": true },
    global: { json: true },
    pmRoot,
  });
  const diff = result as { b: string; removed: string[]; added: string[]; unchanged: number; drift: boolean };
  // bd-ws-1 is in both (unchanged); bd-extra is only in the file (A) -> removed.
  assert.strictEqual(diff.b, "workspace");
  assert.ok(diff.removed.includes("bd-extra"), "file-only bead is 'removed' (only in A)");
  assert.ok(!diff.added.includes("bd-ws-1"));
  assert.strictEqual(diff.unchanged, 1, "the matching bead is unchanged");
  assert.strictEqual(diff.drift, true);
  await ext.deactivate();
});

test("beads diff requires a second file without --against-workspace (USAGE)", async () => {
  const ext = await harness();
  const dir = mkdtempSync(join(tmpdir(), "beads-diff-usage-"));
  const fileA = join(dir, "a.jsonl");
  writeFileSync(fileA, JSON.stringify({ id: "bd-1", title: "T" }) + "\n", "utf-8");
  await assert.rejects(
    () => ext.runCommand({ command: "beads diff", args: [fileA], options: {}, global: { json: false }, pmRoot: dir }),
    (err: unknown) => {
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.USAGE);
      return true;
    },
  );
  await ext.deactivate();
});

test("beads diff --strict exits nonzero (throws) on drift, zero otherwise", async () => {
  const ext = await harness();
  const dir = mkdtempSync(join(tmpdir(), "beads-diff-strict-"));
  const a = join(dir, "a.jsonl");
  const b = join(dir, "b.jsonl");
  writeFileSync(a, JSON.stringify({ id: "bd-1", title: "One" }) + "\n", "utf-8");
  writeFileSync(b, JSON.stringify({ id: "bd-2", title: "Two" }) + "\n", "utf-8");
  // Drift + --strict -> throws a CommandError with a nonzero exit code.
  // Use json:false so runDiff takes the throw path (json:true sets exitCode instead).
  await assert.rejects(
    () => ext.runCommand({ command: "beads diff", args: [a, b], options: { strict: true }, global: { json: false }, pmRoot: dir }),
    (err: unknown) => {
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.GENERIC_FAILURE);
      assert.match((err as Error).message, /Drift detected/);
      return true;
    },
  );
  // Identical files + --strict -> no throw, returns a no-drift result.
  const { result: same } = await ext.runCommand({ command: "beads diff", args: [a, a], options: { strict: true }, global: { json: false }, pmRoot: dir });
  assert.strictEqual((same as { drift: boolean }).drift, false);
  await ext.deactivate();
});

test("beads diff hard-fails on a malformed JSONL line", async () => {
  const ext = await harness();
  const dir = mkdtempSync(join(tmpdir(), "beads-diff-bad-"));
  const a = join(dir, "a.jsonl");
  const b = join(dir, "b.jsonl");
  writeFileSync(a, "{not json\n", "utf-8");
  writeFileSync(b, JSON.stringify({ id: "bd-1", title: "T" }) + "\n", "utf-8");
  await assert.rejects(
    () => ext.runCommand({ command: "beads diff", args: [a, b], options: {}, global: { json: false }, pmRoot: dir }),
    (err: unknown) => {
      assert.match((err as Error).message, /invalid JSON/);
      return true;
    },
  );
  await ext.deactivate();
});

test("beads diff maps a missing file to NOT_FOUND", async () => {
  const ext = await harness();
  await assert.rejects(
    () => ext.runCommand({ command: "beads diff", args: ["/nonexistent/beads-a.jsonl", "/nonexistent/beads-b.jsonl"], options: {}, global: { json: false } }),
    (err: unknown) => {
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.NOT_FOUND);
      return true;
    },
  );
  await ext.deactivate();
});

// --- Enhancement: --validate-only / --batch-size / --filter / --merge-strategy / export --dry-run ---

test("parseFilterExpression parses the combined `type:...;status:...` form", () => {
  assert.deepStrictEqual(parseFilterExpression(undefined), { statuses: undefined, types: undefined });
  assert.deepStrictEqual(parseFilterExpression(""), { statuses: undefined, types: undefined });
  const f = parseFilterExpression("type:Bug,Feature;status:open,in_progress");
  assert.deepStrictEqual([...f.types!].sort(), ["bug", "feature"]);
  assert.deepStrictEqual([...f.statuses!].sort(), ["in_progress", "open"]);
  // Unknown dimensions are ignored (forward-compatible), not fatal.
  assert.deepStrictEqual(parseFilterExpression("sprint:S17"), { statuses: undefined, types: undefined });
  // Tolerates ids/aliases and stray whitespace.
  assert.deepStrictEqual([...parseFilterExpression("statuses: closed").statuses!], ["closed"]);
});

test("mergeRowFilters lets the override dimension win, base otherwise", () => {
  const base = parseFilterExpression("type:Bug;status:open");
  const override: RowFilter = { statuses: new Set(["closed"]) };
  const merged = mergeRowFilters(base, override);
  assert.deepStrictEqual([...merged.statuses!], ["closed"]); // override wins
  assert.deepStrictEqual([...merged.types!], ["bug"]); // base carries over
});

test("parseRowFilter merges --filter with granular flags (granular wins per-dimension)", () => {
  // Granular --filter-type overrides the type dimension of --filter, but the
  // status dimension from --filter is preserved.
  const f = parseRowFilter({ filter: "type:Bug;status:open", "filter-type": "Task" });
  assert.deepStrictEqual([...f.types!], ["task"]);
  assert.deepStrictEqual([...f.statuses!], ["open"]);
  // --filter alone is honored when no granular flag is given.
  const g = parseRowFilter({ filter: "type:Bug;status:closed" });
  assert.deepStrictEqual([...g.types!], ["bug"]);
  assert.deepStrictEqual([...g.statuses!], ["closed"]);
});

test("parseMergeStrategy defaults to update and rejects unknown values", () => {
  assert.strictEqual(parseMergeStrategy({}), "update");
  assert.strictEqual(parseMergeStrategy({ "merge-strategy": "skip" }), "skip");
  assert.strictEqual(parseMergeStrategy({ mergeStrategy: "FAIL" }), "fail");
  assert.throws(
    () => parseMergeStrategy({ "merge-strategy": "overwrite" }),
    (err: unknown) => {
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.USAGE);
      assert.match((err as Error).message, /Unknown --merge-strategy/);
      return true;
    },
  );
  assert.deepStrictEqual([...MERGE_STRATEGIES], ["update", "skip", "fail"]);
});

test("parsePositiveIntOption reads strings/numbers and rejects invalid explicit values", () => {
  assert.strictEqual(parsePositiveIntOption({ "batch-size": "100" }, "batch-size", "batchSize"), 100);
  assert.strictEqual(parsePositiveIntOption({ batchSize: "50" }, "batch-size", "batchSize"), 50);
  assert.strictEqual(parsePositiveIntOption({ batchSize: 25 }, "batch-size", "batchSize"), 25);
  for (const value of ["0", "-3", "abc", "1.5", "", true]) {
    assert.throws(
      () => parsePositiveIntOption({ "batch-size": value }, "batch-size", "batchSize"),
      (err: unknown) => {
        assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.USAGE);
        assert.match((err as Error).message, /Must be a positive integer/);
        return true;
      },
    );
  }
  assert.strictEqual(parsePositiveIntOption({}, "batch-size", "batchSize"), undefined);
});

test("parseImportOptions wires every new import flag", async () => {
  // Re-exercise via the registered importer handler using dry-run + new flags
  // so no pm CLI is required to validate option plumbing.
  const ext = await harness();
  const dir = mkdtempSync(join(tmpdir(), "beads-opts-"));
  const file = join(dir, "in.jsonl");
  writeFileSync(file, JSON.stringify({ id: "bd-1", title: "A", status: "open", type: "Task" }) + "\n", "utf-8");

  // --validate-only short-circuits before any pm spawn (pm_root undefined so
  // the workspace cross-check is skipped entirely).
  const ir = await runImport(ext, {
    args: [file],
    options: { "validate-only": true },
    pmRoot: undefined,
  });
  assert.strictEqual(ir.validateOnly, true);
  assert.strictEqual(ir.records, 1);
  assert.strictEqual(ir.valid, true);
});

test("--validate-only surfaces a nonzero exit on a malformed file", async () => {
  const ext = await harness();
  const dir = mkdtempSync(join(tmpdir(), "beads-vo-bad-"));
  const file = join(dir, "bad.jsonl");
  writeFileSync(file, '{"id":"a","title":"ok"}\n{broken\n', "utf-8");
  await assert.rejects(
    async () => runImport(ext, { args: [file], options: { "validate-only": true }, pmRoot: undefined }),
    (err: unknown) => {
      assert.match((err as Error).message, /Validation failed/);
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.GENERIC_FAILURE);
      return true;
    },
  );
});

test("--validate-only ignores write-only merge strategy constraints", async () => {
  const ext = await harness();
  const dir = mkdtempSync(join(tmpdir(), "beads-vo-merge-"));
  const file = join(dir, "in.jsonl");
  writeFileSync(file, JSON.stringify({ id: "bd-1", title: "A" }) + "\n", "utf-8");

  const ir = await runImport(ext, {
    args: [file],
    options: { "validate-only": true, "merge-strategy": "fail" },
    pmRoot: undefined,
  });
  assert.strictEqual(ir.validateOnly, true);
  assert.strictEqual(ir.valid, true);
});

test("--merge-strategy without --upsert is a USAGE error", async () => {
  const ext = await harness();
  const dir = mkdtempSync(join(tmpdir(), "beads-ms-noup-"));
  const file = join(dir, "in.jsonl");
  writeFileSync(file, JSON.stringify({ id: "bd-1", title: "A" }) + "\n", "utf-8");
  await assert.rejects(
    async () => runImport(ext, { args: [file], options: { "merge-strategy": "skip" }, pmRoot: dir }),
    (err: unknown) => {
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.USAGE);
      assert.match((err as Error).message, /--merge-strategy only applies with --upsert/);
      return true;
    },
  );
});

test("--batch-size chunks the dry-run preview and reports batches", async () => {
  const ext = await harness();
  const dir = mkdtempSync(join(tmpdir(), "beads-batch-"));
  const file = join(dir, "in.jsonl");
  const lines = [];
  for (let i = 1; i <= 5; i++) lines.push(JSON.stringify({ id: `bd-${i}`, title: `T${i}`, status: "open", type: "Task" }));
  writeFileSync(file, lines.join("\n") + "\n", "utf-8");
  // dry-run never spawns pm, so a bogus pm_root is safe. batchSize 2 -> 3 batches.
  const ir = await runImport(ext, {
    args: [file],
    options: { "dry-run": true, "batch-size": "2" },
    pmRoot: join(dir, "no-pm"),
  });
  assert.strictEqual(ir.dryRun, true);
  assert.strictEqual(ir.wouldImport, 5);
  assert.strictEqual(ir.batches, 3);
});

test("--merge-strategy skip/fail in dry-run against a seeded workspace", { skip: !hasPmCli() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "beads-ms-ws-"));
  const pmRoot = join(root, ".agents", "pm");
  mkdirSync(pmRoot, { recursive: true });
  assert.strictEqual(spawnSync("pm", ["--path", pmRoot, "init"], { encoding: "utf-8" }).status, 0);
  // Seed an existing item carrying bead_id bd-1 so --upsert matches it.
  assert.strictEqual(
    spawnSync("pm", ["--path", pmRoot, "--json", "create", "--title", "Existing", "--type", "Task",
      "--status", "open", "--description", encodeBeadId("body", "bd-1")], { encoding: "utf-8" }).status,
    0,
  );

  const file = join(root, "in.jsonl");
  writeFileSync(file, JSON.stringify({ id: "bd-1", title: "Existing", status: "open", type: "Task" }) + "\n", "utf-8");

  const ext = await harness();

  // skip: leaves the existing item alone — wouldImport 0, wouldSkip 1.
  const ir = await runImport(ext, {
    args: [file], options: { "dry-run": true, upsert: true, "merge-strategy": "skip" }, pmRoot: pmRoot,
  });
  assert.strictEqual(ir.wouldImport, 0);
  assert.strictEqual(ir.wouldSkip, 1);

  // A real skip-only import is a successful no-op, not a malformed-input
  // failure. This is a common idempotent sync path for agents.
  const ir2 = await runImport(ext, {
    args: [file], options: { upsert: true, "merge-strategy": "skip" }, pmRoot: pmRoot,
  });
  assert.strictEqual(ir2.imported, 0);
  assert.strictEqual(ir2.updated, 0);
  assert.strictEqual(ir2.skipped, 1);

  // fail: aborts the import on the first duplicate.
  await assert.rejects(
    async () => runImport(ext, {
      args: [file], options: { "dry-run": true, upsert: true, "merge-strategy": "fail" }, pmRoot: pmRoot,
    }),
    (err: unknown) => {
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.GENERIC_FAILURE);
      assert.match((err as Error).message, /already imported/);
      return true;
    },
  );
});

test("--merge-strategy fail preflights all collisions before writing", { skip: !hasPmCli() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "beads-ms-atomic-"));
  const pmRoot = join(root, ".agents", "pm");
  mkdirSync(pmRoot, { recursive: true });
  assert.strictEqual(spawnSync("pm", ["--path", pmRoot, "init"], { encoding: "utf-8" }).status, 0);
  assert.strictEqual(
    spawnSync("pm", ["--path", pmRoot, "--json", "create", "--title", "Existing", "--type", "Task",
      "--status", "open", "--description", encodeBeadId("body", "bd-existing")], { encoding: "utf-8" }).status,
    0,
  );

  const file = join(root, "in.jsonl");
  writeFileSync(file, [
    JSON.stringify({ id: "bd-new", title: "Must Not Be Created", status: "open", type: "Task" }),
    JSON.stringify({ id: "bd-existing", title: "Existing", status: "open", type: "Task" }),
  ].join("\n") + "\n", "utf-8");

  const ext = await harness();
  await assert.rejects(
    () => runImport(ext, {
      args: [file], options: { upsert: true, "merge-strategy": "fail" }, pmRoot: pmRoot,
    }),
    /aborting before any writes/,
  );

  const search = spawnSync("pm", ["--path", pmRoot, "--json", "search", "Must Not Be Created"], { encoding: "utf-8" });
  assert.strictEqual(search.status, 0, search.stderr);
  const searchResult = JSON.parse(search.stdout) as { items?: Array<{ title?: string }> };
  assert.ok(
    !(searchResult.items ?? []).some((item) => item.title === "Must Not Be Created"),
    "preflight failure must leave no partially created item",
  );

  const duplicateFile = join(root, "duplicate-input.jsonl");
  writeFileSync(duplicateFile, [
    JSON.stringify({ id: "bd-duplicate", title: "First duplicate", status: "open", type: "Task" }),
    JSON.stringify({ id: "bd-duplicate", title: "Second duplicate", status: "open", type: "Task" }),
  ].join("\n") + "\n", "utf-8");
  await assert.rejects(
    () => runImport(ext, {
      args: [duplicateFile], options: { upsert: true, "merge-strategy": "fail" }, pmRoot: pmRoot,
    }),
    /appears more than once in the input.*aborting before any writes/,
  );

  const duplicateSearch = spawnSync("pm", ["--path", pmRoot, "--json", "search", "First duplicate"], { encoding: "utf-8" });
  assert.strictEqual(duplicateSearch.status, 0, duplicateSearch.stderr);
  const duplicateResult = JSON.parse(duplicateSearch.stdout) as { items?: Array<{ title?: string }> };
  assert.strictEqual(duplicateResult.items?.length ?? 0, 0, "duplicate-input preflight must not create either row");
});

test("upsert refreshes status index for repeated terminal-status rows", { skip: !hasPmCli() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "beads-upsert-status-"));
  const pmRoot = join(root, ".agents", "pm");
  mkdirSync(pmRoot, { recursive: true });
  assert.strictEqual(spawnSync("pm", ["--path", pmRoot, "init"], { encoding: "utf-8" }).status, 0);
  assert.strictEqual(
    spawnSync("pm", ["--path", pmRoot, "--json", "create", "--title", "Existing", "--type", "Task",
      "--status", "open", "--description", encodeBeadId("body", "bd-repeat")], { encoding: "utf-8" }).status,
    0,
  );

  const file = join(root, "repeat.jsonl");
  writeFileSync(file, [
    JSON.stringify({ id: "bd-repeat", title: "Closed once", status: "closed", type: "Task" }),
    JSON.stringify({ id: "bd-repeat", title: "Closed twice", status: "closed", type: "Task" }),
  ].join("\n") + "\n", "utf-8");

  const ext = await harness();
  const ir = await runImport(ext, {
    args: [file], options: { upsert: true }, pmRoot: pmRoot,
  });
  assert.strictEqual(ir.updated, 2, "both rows should update without attempting to re-close the terminal item");
  assert.strictEqual(ir.skipped, 0);
});

test("eligible import failures are not masked by filtered rows", { skip: !hasPmCli() }, async () => {
  const root = mkdtempSync(join(tmpdir(), "beads-filter-failure-"));
  const pmRoot = join(root, ".agents", "pm");
  mkdirSync(pmRoot, { recursive: true });
  assert.strictEqual(spawnSync("pm", ["--path", pmRoot, "init"], { encoding: "utf-8" }).status, 0);

  const file = join(root, "mixed.jsonl");
  writeFileSync(file, [
    JSON.stringify({ id: "bad-type", title: "Eligible but invalid", status: "open", type: "DefinitelyUnknown" }),
    JSON.stringify({ id: "filtered", title: "Filtered task", status: "open", type: "Task" }),
  ].join("\n") + "\n", "utf-8");

  const ext = await harness();
  await assert.rejects(
    () => runImport(ext, {
      args: [file], options: { "filter-type": "DefinitelyUnknown" }, pmRoot: pmRoot,
    }),
    /No items imported — all 1 attempted record\(s\) failed/,
  );
});

test("readAndValidateBeads returns the report without throwing on errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beads-rav-"));
  const file = join(dir, "bad.jsonl");
  writeFileSync(file, '{"id":"a"}\n{bad\n', "utf-8");
  const report = await readAndValidateBeads(file);
  assert.strictEqual(report.valid, false);
  assert.ok(report.issues.some((i) => i.code === "missing_title"));
  assert.ok(report.issues.some((i) => i.code === "invalid_json"));
  // A clean file yields a valid report.
  const ok = join(dir, "ok.jsonl");
  writeFileSync(ok, JSON.stringify({ id: "x", title: "T" }) + "\n", "utf-8");
  const okReport = await readAndValidateBeads(ok);
  assert.strictEqual(okReport.valid, true);
});

test("readAndValidateBeads maps a missing file to NOT_FOUND", async () => {
  await assert.rejects(
    () => readAndValidateBeads("/nonexistent/definitely-missing.jsonl"),
    (err: unknown) => {
      assert.strictEqual((err as CommandError).exitCode, EXIT_CODE.NOT_FOUND);
      return true;
    },
  );
});

test("parseExportOptions reads dry-run, output and filter flags", () => {
  const o = parseExportOptions({ "dry-run": true, output: "out.jsonl", filter: "type:Bug" });
  assert.strictEqual(o.dryRun, true);
  assert.strictEqual(o.output, "out.jsonl");
  assert.deepStrictEqual([...o.filter.types!], ["bug"]);
  assert.strictEqual(parseExportOptions({}).dryRun, false);
});

test("exporter registration advertises dry-run and combined filter flags", async () => {
  const ext = await harness();
  const expContract = ext.assertCommandContract({ command: "beads export", flags: ["--dry-run", "--filter"] });
  assert.ok(expContract.flags.some((f) => f.long === "--dry-run"));
  assert.ok(expContract.flags.some((f) => f.long === "--filter"));
  await ext.deactivate();
});

test("diff registration advertises the combined filter flag", async () => {
  const ext = await harness();
  const contract = ext.assertCommandContract({ command: "beads diff", flags: ["--filter"] });
  assert.ok(contract.flags.some((f) => f.long === "--filter"));
  await ext.deactivate();
});

test("importer registration advertises the new import flags", async () => {
  const ext = await harness();
  const impContract = ext.assertCommandContract({ command: "beads import" });
  const longs = impContract.flags.map((f) => f.long);
  for (const f of ["--validate-only", "--merge-strategy", "--batch-size", "--filter"]) {
    assert.ok(longs.includes(f), `importer should advertise ${f}`);
  }
});

function hasPmCli(): boolean {
  try {
    const r = spawnSync("pm", ["--version"], { encoding: "utf-8" });
    return r.status === 0;
  } catch {
    return false;
  }
}

test("isInvalidTypeValueError matches only pm's invalid-type rejection", () => {
  assert.strictEqual(isInvalidTypeValueError(undefined), false);
  assert.strictEqual(isInvalidTypeValueError(null), false);
  assert.strictEqual(isInvalidTypeValueError(""), false);
  assert.strictEqual(isInvalidTypeValueError("some other error"), false);
  // Needs BOTH the machine code and the type-specific detail.
  assert.strictEqual(isInvalidTypeValueError('"code": "invalid_argument_value"'), false);
  assert.strictEqual(isInvalidTypeValueError("Invalid type value \"bug\""), false);
  assert.strictEqual(
    isInvalidTypeValueError('{"code": "invalid_argument_value", "detail": "Invalid type value \\"bug\\". Allowed: ..."}'),
    true,
  );
});

test("upsert of a synonym-typed bead keeps the record AND its inbound dependency edges", { skip: !hasPmCli() }, async () => {
  // Regression: `pm create` maps synonym types (bug -> Issue) through its
  // fallback table but `pm update` rejects them. Before the retry-without---type
  // fix, an upsert re-import of a "bug" bead failed the record, dropped it from
  // the bead->pm map, and the --replace-deps pass then silently stripped every
  // dependency edge pointing at it from the other upserted items.
  const root = mkdtempSync(join(tmpdir(), "beads-upsert-synonym-"));
  const pmRoot = join(root, ".agents", "pm");
  mkdirSync(pmRoot, { recursive: true });
  assert.strictEqual(spawnSync("pm", ["--path", pmRoot, "init"], { encoding: "utf-8" }).status, 0);

  const file = join(root, "in.jsonl");
  writeFileSync(file, [
    JSON.stringify({ id: "bd-bug", title: "Crash", status: "open", issue_type: "bug" }),
    JSON.stringify({ id: "bd-feat", title: "Feature", status: "open", issue_type: "feature", dependencies: ["bd-bug"] }),
  ].join("\n") + "\n", "utf-8");

  const ext = await harness();

  const ir = await runImport(ext, { args: [file], options: {}, pmRoot: pmRoot });
  assert.strictEqual(ir.imported, 2);
  assert.strictEqual(ir.dependencies, 1);

  // Re-import with --upsert: the "bug" bead must update (via the --type retry),
  // not fail, and the bd-feat -> bd-bug edge must survive --replace-deps.
  const ir2 = await runImport(ext, { args: [file], options: { upsert: true }, pmRoot: pmRoot });
  assert.strictEqual(ir2.imported, 0);
  assert.strictEqual(ir2.updated, 2, "synonym-typed bead must not fail the upsert update");
  assert.strictEqual(ir2.dependencies, 1, "inbound edge to the synonym-typed bead must survive");

  const out = join(root, "out.jsonl");
  await runExport(ext, { args: [], options: { output: out }, pmRoot: pmRoot });
  const rows = readFileSync(out, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  const feat = rows.find((r) => r.id === "bd-feat");
  assert.ok(feat, "bd-feat must round-trip");
  assert.ok(
    Array.isArray(feat.dependencies) && feat.dependencies.some((d: { depends_on_id?: string }) => (d.depends_on_id ?? String(d)) === "bd-bug"),
    "bd-feat must still depend on bd-bug after an upsert re-import",
  );
});

// ---------------------------------------------------------------------------
// Suite-wide guard: no command redeclares a host-owned global flag
// ---------------------------------------------------------------------------

test("no command redeclares a host-owned global flag", async () => {
  // Guards the whole surface, not just the commands that regressed:
  // registering any of these makes the host reject the command outright, and
  // the value must be read from ctx.global instead.
  const hostOwned = new Set([
    "--json",
    "--quiet",
    "--path",
    "--lean",
    "--id-only",
    "--author",
    "--no-changed-fields",
    "--full-changed-fields",
    "--pm-path",
  ]);
  const ext = await harness();

  for (const registration of ext.activation.registrations.flags) {
    for (const flag of registration.flags) {
      assert.ok(
        flag.long === undefined || !hostOwned.has(flag.long),
        `${registration.target_command} must not redeclare host-owned global flag ${flag.long}`,
      );
    }
  }

  await ext.deactivate();
});
