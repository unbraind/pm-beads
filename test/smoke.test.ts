import assert from "node:assert/strict";
import test from "node:test";

import extension, {
  CommandError,
  EXIT_CODE,
  buildBeadIndex,
  decodeBeadId,
  encodeBeadId,
  extractBlockerIds,
  extractCreatedId,
  normalizeBeadKey,
  pmItemToBead,
  resolvePreserveIds,
  stripBeadIdMarker,
  validateBeadsText,
} from "../dist/index.js";

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
