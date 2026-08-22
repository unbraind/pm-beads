/**
 * Tests for the canonical complete-read contract: every independent refusal
 * signal of {@link assertListAllComplete}, the injected spawn seam's failure
 * classification inside the workspace read, and the read-buffer override.
 *
 * Each refusal is driven by taking a real-shaped complete envelope (the same
 * receipt fields the pm CLI emits) and mutating exactly one field — so a test
 * name names the signal it trips and nothing else changes.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertListAllComplete,
  buildBeadsFromWorkspace,
  IncompleteWorkspaceReadError,
  CommandError,
  spawnPmListAll,
  type ListAllEnvelope,
  type PmListAllSpawnResult,
} from "../index.ts";

/** A complete `pm list --all --json` envelope: every receipt present, exact. */
function completeEnvelope(overrides: Partial<ListAllEnvelope> = {}): ListAllEnvelope {
  return {
    items: [{ id: "pm-1", title: "One" }],
    count: 1,
    total: 1,
    truncated: false,
    has_more: false,
    next_cursor: null,
    completeness: { status: "complete", unreadable_item_count: 0, unreadable_directory_count: 0 },
    omission_receipt: { has_omissions: false, omitted_field_group_count: 0, omitted_field_groups: [] },
    projection: { mode: "full" },
    read_output: {
      contract_version: 1,
      command: "list",
      requested_dimensions: ["include", "amount", "cost"],
      within_budget: true,
      strings_compacted: false,
      rows_compacted: false,
      result_omitted: false,
    },
    ...overrides,
  } as ListAllEnvelope;
}

/** Assert the mutated envelope is refused with an error naming the mutation. */
function refuses(name: string, mutate: (env: ListAllEnvelope) => void): void {
  test(`refuses an envelope whose ${name}`, () => {
    const env = completeEnvelope();
    mutate(env);
    assert.throws(() => assertListAllComplete(env), IncompleteWorkspaceReadError);
  });
}

test("accepts a fully complete envelope", () => {
  assert.doesNotThrow(() => assertListAllComplete(completeEnvelope()));
});

test("refuses a non-object answer outright (array or null)", () => {
  assert.throws(() => assertListAllComplete([completeEnvelope()]), IncompleteWorkspaceReadError);
  assert.throws(() => assertListAllComplete(null), IncompleteWorkspaceReadError);
});

test("refuses a top-level array and a null answer outright", () => {
  assert.throws(() => assertListAllComplete([completeEnvelope()]), /top-level object/);
  assert.throws(() => assertListAllComplete(null), /top-level object/);
});
refuses("truncated flag is not exactly false", (env) => {
  env.truncated = true;
});
refuses("truncated flag is missing", (env) => {
  delete (env as Record<string, unknown>).truncated;
});
refuses("has_more flag is not exactly false", (env) => {
  env.has_more = true;
});
refuses("has_more flag is missing", (env) => {
  delete (env as Record<string, unknown>).has_more;
});
refuses("next_cursor is non-null", (env) => {
  env.next_cursor = "cursor-1";
});
refuses("next_cursor is missing", (env) => {
  delete (env as Record<string, unknown>).next_cursor;
});
refuses("completeness.status is not complete", (env) => {
  env.completeness = { status: "partial", unreadable_item_count: 2, unreadable_directory_count: 1 };
});
refuses("completeness block is missing", (env) => {
  delete (env as Record<string, unknown>).completeness;
});
refuses("unreadable_item_count is nonzero", (env) => {
  if (env.completeness) env.completeness.unreadable_item_count = 3;
});
refuses("unreadable_directory_count is nonzero", (env) => {
  if (env.completeness) env.completeness.unreadable_directory_count = 1;
});
refuses("omission_receipt is not an object", (env) => {
  env.omission_receipt = undefined;
});
refuses("omission_receipt reports omissions", (env) => {
  env.omission_receipt = { has_omissions: true, omitted_field_group_count: 1, omitted_field_groups: ["body"] };
});
refuses("omitted_field_group_count is nonzero", (env) => {
  if (env.omission_receipt) env.omission_receipt.omitted_field_group_count = 2;
});
refuses("omitted_field_groups is not an empty array", (env) => {
  env.omission_receipt = { has_omissions: false, omitted_field_group_count: 0, omitted_field_groups: undefined };
});
refuses("projection.mode is not full", (env) => {
  env.projection = { mode: "brief" };
});
refuses("read_output.contract_version is not 1", (env) => {
  if (env.read_output) env.read_output.contract_version = 2;
});
refuses("read_output.command is not list", (env) => {
  if (env.read_output) env.read_output.command = "show";
});
refuses("read_output.within_budget is not true", (env) => {
  if (env.read_output) env.read_output.within_budget = false;
});
refuses("strings_compacted is true", (env) => {
  if (env.read_output) env.read_output.strings_compacted = true;
});
refuses("rows_compacted is true", (env) => {
  if (env.read_output) env.read_output.rows_compacted = true;
});
refuses("result_omitted is true", (env) => {
  if (env.read_output) env.read_output.result_omitted = true;
});
refuses("requested_dimensions misses a required dimension", (env) => {
  if (env.read_output) env.read_output.requested_dimensions = ["include"];
});
refuses("requested_dimensions is not an array", (env) => {
  if (env.read_output) env.read_output.requested_dimensions = "include";
});
refuses("a budget truncation disclosure is present", (env) => {
  (env as Record<string, unknown>).output_budget_truncation = { note: "cut" };
});
refuses("a budget omission disclosure is present", (env) => {
  (env as Record<string, unknown>).output_budget_exceeded = { note: "cut" };
});
refuses("count is negative", (env) => {
  env.count = -1;
});
refuses("count is not a safe integer", (env) => {
  env.count = Number.NaN;
});
refuses("total is negative", (env) => {
  env.total = -5;
});
refuses("total is missing", (env) => {
  delete (env as Record<string, unknown>).total;
});
refuses("items is not an array", (env) => {
  env.items = undefined;
});
refuses("count disagrees with total", (env) => {
  env.total = 7;
});
refuses("items.length disagrees with count", (env) => {
  env.items = [];
});
refuses("an item row is not an object", (env) => {
  env.items = ["nope"];
});
refuses("an item row has an empty id", (env) => {
  env.items = [{ id: "   " }];
});
refuses("two item rows share one id", (env) => {
  env.items = [
    { id: "pm-1", title: "One" },
    { id: "pm-1", title: "Two" },
  ];
  env.count = 2;
  env.total = 2;
});

test("the refusal message carries the count/total figures for pagination signals", () => {
  const env = completeEnvelope({ truncated: true, total: 9 });
  try {
    assertListAllComplete(env);
    assert.fail("expected refusal");
  } catch (err: unknown) {
    assert.match((err as Error).message, /count 1 of total 9/);
  }
});

// --- The injected spawn seam over the whole workspace read -----------------

const PM_ROOT = "/tmp/not-a-real-workspace";

/** Wrap a spawn double so it also records the maxBuffer it was handed. */
function spawnRecordingMaxBuffer(
  impl: (args: string[], maxBuffer: number) => PmListAllSpawnResult,
): { calls: Array<{ args: string[]; maxBuffer: number }>; spawn: (args: string[], maxBuffer: number) => PmListAllSpawnResult } {
  const calls: Array<{ args: string[]; maxBuffer: number }> = [];
  return {
    calls,
    spawn: (args: string[], maxBuffer: number) => {
      calls.push({ args, maxBuffer });
      return impl(args, maxBuffer);
    },
  };
}

function okSpawn(stdout: string): (args: string[], maxBuffer: number) => PmListAllSpawnResult {
  return () => ({ status: 0, stdout, stderr: "" });
}

test("buildBeadsFromWorkspace requests the unbounded full projection and forwards the buffer cap", () => {
  const { calls, spawn } = spawnRecordingMaxBuffer(okSpawn(JSON.stringify(completeEnvelope())));
  const beads = buildBeadsFromWorkspace(PM_ROOT, { preserveIds: false, filter: {} }, spawn);
  assert.strictEqual(beads.length, 1);
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].args.includes("--output-budget"));
  assert.deepStrictEqual(
    calls[0].args.filter((a) => ["unbounded"].includes(a)).length,
    2,
    "both output bounds must be explicitly unbounded",
  );
  assert.ok(calls[0].maxBuffer >= 64 * 1024 * 1024, "default cap is 64 MiB");
});

test("PM_JSON_MAX_BUFFER overrides the cap; garbage falls back to the default", () => {
  const original = process.env.PM_JSON_MAX_BUFFER;
  try {
    const first = spawnRecordingMaxBuffer(okSpawn(JSON.stringify(completeEnvelope())));
    process.env.PM_JSON_MAX_BUFFER = "1048576";
    buildBeadsFromWorkspace(PM_ROOT, { preserveIds: false, filter: {} }, first.spawn);
    assert.strictEqual(first.calls[0].maxBuffer, 1048576);

    // parseInt would silently yield 64 out of "64MiB" — a 64-BYTE cap; Number()
    // rejects the whole string instead, which is why the fallback must hold.
    const second = spawnRecordingMaxBuffer(okSpawn(JSON.stringify(completeEnvelope())));
    process.env.PM_JSON_MAX_BUFFER = "64MiB";
    buildBeadsFromWorkspace(PM_ROOT, { preserveIds: false, filter: {} }, second.spawn);
    assert.strictEqual(second.calls[0].maxBuffer, 64 * 1024 * 1024);

    const third = spawnRecordingMaxBuffer(okSpawn(JSON.stringify(completeEnvelope())));
    process.env.PM_JSON_MAX_BUFFER = "-5";
    buildBeadsFromWorkspace(PM_ROOT, { preserveIds: false, filter: {} }, third.spawn);
    assert.strictEqual(third.calls[0].maxBuffer, 64 * 1024 * 1024);
  } finally {
    if (original === undefined) delete process.env.PM_JSON_MAX_BUFFER;
    else process.env.PM_JSON_MAX_BUFFER = original;
  }
});

test("a spawn error is classified: ENOBUFS names the buffer, anything else names the cause", () => {
  const enobufs = new Error("spawn ENOBUFS") as NodeJS.ErrnoException & Error;
  enobufs.code = "ENOBUFS";
  assert.throws(
    () => buildBeadsFromWorkspace(PM_ROOT, { preserveIds: false, filter: {} }, () => ({ status: null, stdout: "", stderr: "", error: enobufs })),
    (err: unknown) => err instanceof CommandError && /exceeded the \d+ byte read buffer/.test(err.message),
  );
  const plain = new Error("pm binary missing");
  assert.throws(
    () => buildBeadsFromWorkspace(PM_ROOT, { preserveIds: false, filter: {} }, () => ({ status: null, stdout: "", stderr: "", error: plain })),
    (err: unknown) => err instanceof CommandError && /pm read failed: pm binary missing/.test(err.message),
  );
});

test("a nonzero pm exit surfaces the child's stderr verbatim", () => {
  assert.throws(
    () => buildBeadsFromWorkspace(PM_ROOT, { preserveIds: false, filter: {} }, () => ({ status: 2, stdout: "", stderr: "boom" })),
    (err: unknown) => err instanceof CommandError && err.message === "boom",
  );
});

test("unparseable pm stdout is refused as a parse failure, not consumed as zero items", () => {
  assert.throws(
    () => buildBeadsFromWorkspace(PM_ROOT, { preserveIds: false, filter: {} }, okSpawn("{not json")),
    (err: unknown) => err instanceof CommandError && /Could not parse/.test(err.message),
  );
});

test("a completeness refusal propagates as its own subtype through the workspace read", async () => {
  await assert.rejects(
    async () => {
      // Thrown synchronously inside the seam consumer; wrap to observe it as a
      // rejection the same way the async import path would.
      buildBeadsFromWorkspace(PM_ROOT, { preserveIds: false, filter: {} }, okSpawn(JSON.stringify(completeEnvelope({ truncated: true }))));
    },
    IncompleteWorkspaceReadError,
  );
});

test("the real spawn seam normalises a failed start's undefined stdout/stderr to empty strings", () => {
  // With no PATH there is no `pm` to resolve, so the real spawnSync reports a
  // spawn error with undefined stdout/stderr — the runtime shape TypeScript's
  // overload types do not model. The seam must coalesce both to "".
  const savedPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const result = spawnPmListAll(["list", "--all", "--json"], 1024 * 1024);
    assert.notEqual(result.error, undefined, "a PATH-less spawn reports its error");
    assert.equal(result.status, null);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  } finally {
    process.env.PATH = savedPath;
  }
});
