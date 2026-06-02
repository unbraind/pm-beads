import assert from "node:assert/strict";
import test from "node:test";

import extension, {
  CommandError,
  EXIT_CODE,
  decodeBeadId,
  encodeBeadId,
  extractBlockerIds,
  extractCreatedId,
  pmItemToBead,
  resolvePreserveIds,
  stripBeadIdMarker,
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
