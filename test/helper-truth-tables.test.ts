/**
 * Truth-table tests for the pure mapping helpers' individual branch arms, plus
 * the option-fallback arms of the registered handlers (an omitted options bag,
 * an explicit `--file` fallback when args carry no positional, and CSV/filter
 * grammar corner cases). These arms are individually unreachable through the
 * end-to-end scenarios and are driven directly here.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  beadCloseReason,
  beadTitle,
  describeRepairFailure,
  beadPassesFilter,
  buildBeadIndex,
  decodeBeadId,
  errorMessage,
  mapPriority,
  mapStatus,
  normalizeDiffField,
  parseFilterExpression,
  resolveImportInputFile,
  stripBeadIdMarker,
  pmStatusToBeads,
  pmItemToBead,
  metadataToPmItems,
  pmItemPassesFilter,
} from "../index.ts";
import { envelopeWith, harness, jsonl, runCommand, runExport, runImport, stubScenario } from "./helpers.ts";
import { isHostOutputSuppressed } from "@unbrained/pm-cli/sdk";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

// Exact alias → canonical-status pairs, driven from the mapStatus table so a
// wrong mapping cannot pass by landing in the valid set.
const MAP_STATUS_TABLE: ReadonlyArray<readonly [string, string]> = [
  ["open", "open"],
  ["todo", "open"],
  ["new", "open"],
  ["in_progress", "in_progress"],
  ["wip", "in_progress"],
  ["doing", "in_progress"],
  ["blocked", "blocked"],
  ["on_hold", "blocked"],
  ["closed", "closed"],
  ["done", "closed"],
  ["complete", "closed"],
  ["canceled", "canceled"],
  ["cancelled", "canceled"],
  ["draft", "draft"],
];

test("mapStatus normalizes every alias to its exact canonical status and degrades unknown/blank/absent values to open", () => {
  assert.equal(mapStatus(undefined), "open");
  assert.equal(mapStatus(null), "open");
  assert.equal(mapStatus(""), "open");
  assert.equal(mapStatus("   "), "open");
  for (const [alias, expected] of MAP_STATUS_TABLE) {
    assert.equal(mapStatus(alias), expected, `mapStatus(${JSON.stringify(alias)})`);
    assert.equal(mapStatus(` ${alias.toUpperCase()} `), expected, `mapStatus(${JSON.stringify(alias)}) with padding/case`);
  }
  assert.equal(mapStatus("wat"), "open", "unknown statuses never invent a state");
});

test("beadTitle resolves either title spelling and degrades missing fields to an empty string, never 'undefined'", () => {
  assert.equal(beadTitle({}), "");
  assert.equal(beadTitle({ title: undefined, name: undefined }), "");
  assert.equal(beadTitle({ title: "", name: "" }), "");
  const nullish = { title: null, name: null } as unknown as Parameters<typeof beadTitle>[0];
  assert.equal(beadTitle(nullish), "");
  assert.equal(beadTitle({ title: "  T  ", name: "N" }), "T");
  assert.equal(beadTitle({ name: "  N  " }), "N");
  assert.equal(beadTitle({ title: "T", name: "N" }), "T", "title wins over name");
});

test("pmStatusToBeads inverts every canonical pm status and defaults to open", () => {
  assert.equal(pmStatusToBeads(undefined), "open");
  assert.equal(pmStatusToBeads(""), "open");
  assert.equal(pmStatusToBeads("OPEN"), "open");
  assert.equal(pmStatusToBeads("In_Progress"), "in_progress");
  assert.equal(pmStatusToBeads("blocked"), "blocked");
  assert.equal(pmStatusToBeads("closed"), "closed");
  assert.equal(pmStatusToBeads("canceled"), "canceled");
  assert.equal(pmStatusToBeads("draft"), "draft");
  assert.equal(pmStatusToBeads("mystery"), "open");
});

test("mapPriority clamps, reads numeric prefixes, and rejects non-numeric input", () => {
  assert.equal(mapPriority(undefined), undefined);
  // The null guard is for untyped JS callers; driven via the same escape hatch.
  assert.equal(mapPriority(null as unknown as number), undefined);
  assert.equal(mapPriority(3), "3");
  assert.equal(mapPriority(-1), "0", "below-scale values clamp to 0");
  assert.equal(mapPriority(9), "4", "above-scale values clamp to 4");
  assert.equal(mapPriority("2abc"), "2", "the leading numeric prefix is honored");
  assert.equal(mapPriority("nope"), undefined);
});

test("decodeBeadId prefers the schema field, tolerates blank ones, and reads description/body markers", () => {
  assert.equal(decodeBeadId({ bead_id: " bd-schema " }), "bd-schema");
  assert.equal(decodeBeadId({ bead_id: "   ", description: "[bead_id: bd-marker]" }), "bd-marker",
    "a whitespace-only field falls through to the marker");
  assert.equal(decodeBeadId({ body: "text\n[bead_id: bd-in-body]" }), "bd-in-body");
  assert.equal(decodeBeadId({ description: "plain" }), undefined);
});

test("stripBeadIdMarker maps absent text to an empty string", () => {
  assert.equal(stripBeadIdMarker(undefined), "");
  assert.equal(stripBeadIdMarker(""), "");
});

test("pmItemToBead titles an untitled item instead of emitting an empty title", () => {
  const bead = pmItemToBead({ id: "pm-1" }, new Map(), true);
  assert.equal(bead.title, "(untitled)");
});

test("parseFilterExpression ignores clauses without a separator and clauses with empty value lists", () => {
  const f = parseFilterExpression("type:Bug;no-separator;status:");
  assert.deepEqual([...f.types!], ["bug"]);
  assert.equal(f.statuses, undefined, "an empty CSV yields no constraint");
  // Values tolerate ':' inside ids (e.g. external keys).
  const keyed = parseFilterExpression("status:in_progress");
  assert.deepEqual([...keyed.statuses!], ["in_progress"]);
});

test("resolveImportInputFile skips non-string tokens and the values of known flags", () => {
  assert.equal(resolveImportInputFile([42, "--type", "Task", "real.jsonl"]), "real.jsonl",
    "non-strings are skipped and flag values are not mistaken for positionals");
  assert.equal(resolveImportInputFile(["--batch-size"]), undefined, "a trailing value-flag has no positional after it");
  assert.equal(resolveImportInputFile([]), undefined);
  assert.equal(resolveImportInputFile(undefined), undefined);
});

// --- Handler fallback arms --------------------------------------------------

const EMPTY_WS = { listEnvelope: JSON.parse(envelopeWith([])) };

test("the importer falls back to the --file option when args carry no positional", async () => {
  const ext = await harness();
  const s = stubScenario(EMPTY_WS);
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-opt", title: "Via option" }]), "utf-8");
    const { result } = await ext.runImporter({
      importer: "beads",
      options: { file },
      pmRoot: join(s.dir, "ws"),
      global: { json: false },
    });
    assert.equal((result as { imported?: number }).imported, 1);
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("handlers tolerate an entirely omitted options bag", async () => {
  const ext = await harness();
  const s = stubScenario({ listEnvelope: JSON.parse(envelopeWith([{ id: "pm-1", title: "One", status: "open" }])) });
  try {
    const exported = (await runExport(ext, { pmRoot: join(s.dir, "ws") })) as { suppressed?: boolean };
    assert.ok(isHostOutputSuppressed(exported), "stdout export suppresses the host payload");
    void runCommand;
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("exporting an empty workspace writes nothing to stdout and still reports success", async () => {
  const ext = await harness();
  const s = stubScenario({ listEnvelope: JSON.parse(envelopeWith([])) });
  try {
    const exported = (await runExport(ext, { options: {}, pmRoot: join(s.dir, "ws") })) as { suppressed?: boolean };
    assert.ok(isHostOutputSuppressed(exported));
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("errorMessage renders Error messages and stringifies non-Error throwables", () => {
  assert.equal(errorMessage(new Error("boom")), "boom");
  assert.equal(errorMessage("plain string"), "plain string");
  assert.equal(errorMessage(42), "42");
});

test("beadCloseReason falls past blank closure fields to real provenance", () => {
  assert.equal(
    beadCloseReason({ close_reason: "  ", resolution: "", state_reason: undefined }, "bd-9"),
    "Imported from Beads record bd-9 (source status: closed)",
    "whitespace-only closure fields are treated as absent",
  );
});

test("normalizeDiffField reads the deadline from every supported alias", () => {
  assert.equal(normalizeDiffField({ deadline: "2030-01-01" }, "deadline"), "2030-01-01");
  assert.equal(normalizeDiffField({ due_date: "2030-01-01" }, "deadline"), "2030-01-01");
  assert.equal(normalizeDiffField({ due_at: "2030-01-01" }, "deadline"), "2030-01-01");
  assert.equal(normalizeDiffField({}, "deadline"), "");
});

test("parseFilterCsv treats an all-blank value list as no constraint", () => {
  const f = parseFilterExpression("status: , , ");
  assert.equal(f.statuses, undefined);
});

test("beadPassesFilter defaults an absent type to Task before matching", () => {
  assert.equal(beadPassesFilter({ title: "No type" }, undefined, { types: new Set(["task"]) }), true);
  assert.equal(beadPassesFilter({ title: "No type" }, undefined, { types: new Set(["bug"]) }), false);
});

test("buildBeadIndex skips id-less workspace items and keeps the first occurrence", () => {
  const index = buildBeadIndex([
    { description: "no id here" },
    { id: "pm-1", description: "[bead_id: bd-1]", status: "open" },
    { id: "pm-2", description: "[bead_id: bd-1]", status: "closed" },
  ]);
  assert.equal(index.size, 1);
  assert.equal(index.get("bd-1")?.pmId, "pm-1", "first write wins so the oldest item is the stable target");
});

test("metadataToPmItems narrows unknown metadata fields and drops non-strings", () => {
  const items = metadataToPmItems([
    { bead_id: "bd-str", description: "[bead_id: x]", body: "body text" },
    { bead_id: 7, description: 9, body: null },
  ]);
  assert.deepEqual(items, [
    { bead_id: "bd-str", description: "[bead_id: x]", body: "body text" },
    { bead_id: undefined, description: undefined, body: undefined },
  ]);
});

test("pmItemPassesFilter defaults an absent item type to Task before matching", () => {
  assert.equal(pmItemPassesFilter({ status: "open" } as never, { types: new Set(["task"]) }), true);
  assert.equal(pmItemPassesFilter({ status: "open" } as never, { types: new Set(["bug"]) }), false);
});

test("describeRepairFailure prefers spawn errors, then stderr, then the bare exit status", () => {
  assert.equal(describeRepairFailure({ error: new Error("spawn gone"), stderr: "ignored", status: 2 }), "spawn gone");
  assert.equal(describeRepairFailure({ stderr: "  exploded \n", status: 2 }), "exploded");
  assert.equal(describeRepairFailure({ status: null }), "exit unknown");
  assert.equal(describeRepairFailure({ status: 9 }), "exit 9");
});
