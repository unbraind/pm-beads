/**
 * Import-path behavior tests driven through a scripted real `pm` executable.
 *
 * These tests exercise the spawn-based branches of the importer black-box: by
 * putting ./fixtures/stub-pm.ts on PATH, `index.ts` runs its production code
 * unchanged while the child answers with scripted failure and recovery behavior
 * (failing updates, invalid-type rejections, failing closes and history
 * repairs). A few pure helpers that are unreachable through the CLI surface are
 * driven directly and labeled as such.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CommandError,
  EXIT_CODE,
  parseBeadsFile,
} from "../index.ts";
import {CHMOD_ROOT_SKIP, EXISTING_MARKER_ITEM, envelope, harness, jsonl, runCommand, runImport, stubScenario, type ImportResult} from "./helpers.ts";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("an empty input file reports zero imports without spawning any pm command", async () => {
  const ext = await harness();
  const s = stubScenario({});
  try {
    const file = s.jsonlPath("empty.jsonl");
    writeFileSync(file, "\n\n", "utf-8");
    const result = await runImport(ext, { args: [file], options: {}, pmRoot: join(s.dir, "ws") });
    assert.deepEqual(result, { imported: 0, skipped: 0 });
    assert.deepEqual(s.logLines(), []);
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("--upsert without preserved ids is a usage error", async () => {
  const ext = await harness();
  const s = stubScenario({});
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-1", title: "A" }]), "utf-8");
    await assert.rejects(
      () => runImport(ext, { args: [file], options: { upsert: true, "no-preserve-ids": true }, pmRoot: join(s.dir, "ws") }),
      (err: unknown) => err instanceof CommandError && err.exitCode === EXIT_CODE.USAGE && /--upsert requires/.test(err.message),
    );
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("--merge-strategy without --upsert is a usage error", async () => {
  const ext = await harness();
  const s = stubScenario({});
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-1", title: "A" }]), "utf-8");
    await assert.rejects(
      () => runImport(ext, { args: [file], options: { "merge-strategy": "skip" }, pmRoot: join(s.dir, "ws") }),
      (err: unknown) => err instanceof CommandError && err.exitCode === EXIT_CODE.USAGE && /only applies with --upsert/.test(err.message),
    );
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("merge-strategy fail aborts before any write when a bead id already exists in the workspace", async () => {
  const ext = await harness();
  const s = stubScenario({ listEnvelope: envelope([EXISTING_MARKER_ITEM]) });
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-1", title: "A" }]), "utf-8");
    await assert.rejects(
      () => runImport(ext, {
        args: [file],
        options: { upsert: true, "merge-strategy": "fail" },
        pmRoot: join(s.dir, "ws"),
      }),
      (err: unknown) => {
        assert.ok(err instanceof CommandError && /already imported as pm-existing-1/.test(err.message));
        // All-or-nothing: only the list read may have happened, no writes.
        assert.ok(s.logLines().every((argv) => argv.includes("list")));
        return true;
      },
    );
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("merge-strategy fail aborts when the same bead id appears twice in the input", async () => {
  const ext = await harness();
  const s = stubScenario({ listEnvelope: envelope([]) });
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([
      { id: "bd-9", title: "First" },
      { id: "bd-9", title: "Second" },
    ]), "utf-8");
    await assert.rejects(
      () => runImport(ext, {
        args: [file],
        options: { upsert: true, "merge-strategy": "fail" },
        pmRoot: join(s.dir, "ws"),
      }),
      (err: unknown) => err instanceof CommandError && /appears more than once in the input \(records 1 and 2\)/.test(err.message),
    );
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("dry-run previews creates per batch without writing anything", async () => {
  const ext = await harness();
  const s = stubScenario({});
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([
      { id: "bd-1", title: "One" },
      { id: "bd-2", title: "Two" },
    ]), "utf-8");
    const result = await runImport(ext, {
      args: [file],
      options: { "dry-run": true, "batch-size": "1" },
      pmRoot: join(s.dir, "ws"),
    });
    assert.equal(result.wouldImport, 2);
    assert.equal(result.batches, 2);
    assert.deepEqual(s.logLines(), []);
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("a successful import wires blocker edges and parent links to the created ids", async () => {
  const ext = await harness();
  const s = stubScenario({
    listEnvelope: envelope([]),
    create: {},
  });
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([
      { id: "bd-1", title: "Parent task", priority: 1, labels: ["core"], assignee: "ana", sprint: "S1", release: "R1", deadline: "2030-01-02T03:04:05Z" },
      { id: "bd-2", title: "Child task", parent: "bd-1", dependencies: [{ depends_on_id: "bd-1" }] },
    ]), "utf-8");
    const result = await runImport(ext, { args: [file], options: {}, pmRoot: join(s.dir, "ws") });
    assert.equal(result.imported, 2);
    assert.equal(result.dependencies, 1);
    assert.equal(result.parents, 1);
    assert.equal(result.filtered, undefined);
    const updates = s.logLines().filter((argv) => argv.includes("update"));
    const childUpdate = updates.find((argv) => argv.includes("pm-stub-2"))!;
    assert.ok(childUpdate.some((a) => a.startsWith("id=pm-stub-1")), "blocker edge resolves to the created parent id");
    const parentUpdate = updates.find((argv) => argv.includes("--parent"))!;
    assert.ok(parentUpdate.includes("pm-stub-1"), "parent link resolves via beadToPm");
    const firstCreate = s.logLines().find((argv) => argv.includes("create"))!;
    for (const flag of ["--priority", "1", "--tags", "core", "--assignee", "ana", "--sprint", "S1", "--release", "R1", "--deadline"]) {
      assert.ok(firstCreate.includes(flag), `create carries ${flag}`);
    }
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("merge-strategy skip leaves matched items untouched but keeps their edges resolvable", async () => {
  const ext = await harness();
  const s = stubScenario({
    listEnvelope: envelope([EXISTING_MARKER_ITEM]),
  });
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([
      { id: "bd-1", title: "Existing" },
      { id: "bd-2", title: "Blocked by existing", dependencies: ["bd-1"] },
    ]), "utf-8");
    const result = await runImport(ext, {
      args: [file],
      options: { upsert: true, "merge-strategy": "skip" },
      pmRoot: join(s.dir, "ws"),
    });
    assert.equal(result.imported, 1);
    assert.equal(result.skipped, 1);
    assert.ok(!s.logLines().some((argv) => argv.includes("update") && !argv.includes("--dep")),
      "the matched item is never updated");
    const depArgs = s.logLines().find((argv) => argv.includes("--dep"))!;
    assert.ok(depArgs.includes("id=pm-existing-1,kind=blocked_by"), "edges resolve to the skipped item's pm id");
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("upsert update omits an unchanged status, routes closed through pm close, and replaces deps", async () => {
  const ext = await harness();
  const s = stubScenario({
    listEnvelope: envelope([
      { ...EXISTING_MARKER_ITEM, status: "open" },
      { id: "pm-existing-2", title: "Second", status: "closed", description: "[bead_id: bd-2]" },
    ]),
  });
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([
      { id: "bd-1", title: "Existing", status: "closed", close_reason: "done upstream", closed_at: "2029-05-05T05:05:05Z" },
      { id: "bd-2", title: "Already closed", status: "closed", dependencies: ["bd-1"] },
    ]), "utf-8");
    const result = await runImport(ext, {
      args: [file],
      options: { upsert: true },
      pmRoot: join(s.dir, "ws"),
    });
    assert.equal(result.updated, 2);
    const closeCalls = s.logLines().filter((argv) => argv.includes("close"));
    assert.equal(closeCalls.length, 1, "an already-closed item is not closed again");
    assert.ok(closeCalls[0].includes("done upstream"), "close reason is the source record's own evidence");
    assert.ok(closeCalls[0].includes("--completed-at"), "source completion time is carried");
    const firstUpdate = s.logLines().find((argv) => argv.includes("update") && argv.includes("pm-existing-1"))!;
    assert.ok(!firstUpdate.includes("--status"), "unchanged status is omitted");
    assert.ok(s.logLines().some((argv) => argv.includes("--replace-deps")), "upsert replaces deps atomically");
    assert.ok(s.logLines().some((a) => a.some((x) => x.startsWith("id=pm-existing-1,"))), "edge resolves to existing item id");
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("a strict-type rejection on update retries once without --type and preserves the canonical type", async () => {
  const ext = await harness();
  const s = stubScenario({
    listEnvelope: envelope([EXISTING_MARKER_ITEM]),
    update: { invalidTypeTimes: 1 },
  });
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-1", title: "Synonym typed", issue_type: "bug" }]), "utf-8");
    const result = await runImport(ext, {
      args: [file],
      options: { upsert: true },
      pmRoot: join(s.dir, "ws"),
    });
    assert.equal(result.updated, 1);
    const titleUpdates = s.logLines().filter((argv) =>
      argv.includes("update") && !argv.some((a) => ["--dep", "--replace-deps", "--clear-deps", "--parent"].includes(a)));
    assert.equal(titleUpdates.length, 2, "the rejected update is retried exactly once as a separate process");
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("a failed update counts the record as skipped and still resolves other records' edges to it", async () => {
  const ext = await harness();
  const s = stubScenario({
    listEnvelope: envelope([EXISTING_MARKER_ITEM]),
    update: { fail: true },
  });
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([
      { id: "bd-1", title: "Broken" },
      { id: "bd-3", title: "Depends on broken", dependencies: ["bd-1"] },
    ]), "utf-8");
    const result = await runImport(ext, {
      args: [file],
      options: { upsert: true },
      pmRoot: join(s.dir, "ws"),
    });
    assert.equal(result.updated, 0);
    assert.equal(result.skipped, 1);
    const depArgs = s.logLines().find((argv) => argv.includes("--dep"))!;
    assert.ok(depArgs.includes("id=pm-existing-1,kind=blocked_by"), "edge kept pointing at the existing item");
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("when every attempted record fails the import throws instead of reporting success", async () => {
  const ext = await harness();
  const s = stubScenario({ listEnvelope: envelope([]), create: { fail: true } });
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-1", title: "Doomed" }]), "utf-8");
    await assert.rejects(
      () => runImport(ext, { args: [file], options: {}, pmRoot: join(s.dir, "ws") }),
      (err: unknown) => err instanceof CommandError && /No items imported — all 1 attempted record\(s\) failed\./.test(err.message),
    );
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("a create that succeeds without a usable id fails that record, not the import", async () => {
  const ext = await harness();
  const s = stubScenario({ listEnvelope: envelope([]), create: { noId: true } });
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-1", title: "Ghost" }]), "utf-8");
    await assert.rejects(
      () => runImport(ext, { args: [file], options: {}, pmRoot: join(s.dir, "ws") }),
      (err: unknown) => err instanceof CommandError && /No items imported/.test(err.message),
    );
    // The child exited 0 — the record failed on id extraction, not on the spawn.
    assert.equal(s.logLines().filter((argv) => argv.includes("create")).length, 1);
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("a failed terminal close on a fresh create counts the record as failed", async () => {
  const ext = await harness();
  const s = stubScenario({
    listEnvelope: envelope([]),
    create: {},
    close: { fail: true },
  });
  try {
    const file = s.jsonlPath("in.jsonl");
    // The open record succeeds so the import completes; only the closed one fails.
    writeFileSync(file, jsonl([
      { id: "bd-1", title: "Healthy" },
      { id: "bd-2", title: "Closed upstream", status: "done" },
    ]), "utf-8");
    const result = await runImport(ext, { args: [file], options: {}, pmRoot: join(s.dir, "ws") });
    assert.equal(result.imported, 1);
    assert.equal(result.skipped, 1);
    assert.ok(s.logLines().some((argv) => argv.includes("close") && argv.includes("--reason")));
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("dependency-edge and parent-link failures degrade to warnings, not crashes", async () => {
  const ext = await harness();
  const s = stubScenario({
    listEnvelope: envelope([]),
    depFail: true,
    parentFail: true,
  });
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([
      { id: "bd-1", title: "Anchor" },
      { id: "bd-2", title: "Wired", dependencies: ["bd-1"], parent: "bd-ghost-parent" },
    ]), "utf-8");
    const result = await runImport(ext, { args: [file], options: {}, pmRoot: join(s.dir, "ws") });
    assert.equal(result.imported, 2);
    assert.equal(result.dependencies ?? 0, 0);
    assert.equal(result.parents ?? 0, 0);
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

// --- Timestamp fidelity ----------------------------------------------------

const ISO = "2026-01-02T03:04:05.000Z";

/** Scenario preloaded with a persisted item file the stub-created id maps to. */
function scenarioWithItem(itemBody: string): ReturnType<typeof stubScenario> {
  return stubScenario(
    { listEnvelope: envelope([]) },
    { "tasks/pm-stub-1.toon": itemBody },
  );
}

test("preserve-timestamps patches the persisted item and re-anchors history", async () => {
  const ext = await harness();
  const s = scenarioWithItem('id: pm-stub-1\ntitle: T\ncreated_at: "2000-01-01T00:00:00.000Z"\nupdated_at: "2000-01-01T00:00:00.000Z"\n');
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-1", title: "Timed", created_at: ISO, updated_at: ISO }]), "utf-8");
    const result = await runImport(ext, { args: [file], options: {}, pmRoot: s.dir });
    assert.equal(result.timestamped, 1);
    const patched = readFileSync(join(s.dir, "tasks", "pm-stub-1.toon"), "utf-8");
    assert.ok(patched.includes(`created_at: "${ISO}"`));
    assert.ok(s.logLines().some((argv) => argv.includes("history-repair")), "history is re-anchored after the raw patch");
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("records without timestamps skip the timestamp pass entirely", async () => {
  const ext = await harness();
  const s = scenarioWithItem("id: pm-stub-1\ntitle: T\n");
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-1", title: "Untimed" }]), "utf-8");
    const result = await runImport(ext, { args: [file], options: {}, pmRoot: s.dir });
    assert.equal(result.timestamped ?? 0, 0);
    assert.ok(!s.logLines().some((argv) => argv.includes("history-repair")));
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("timestamps whose item file cannot be located are skipped with a warning", async () => {
  const ext = await harness();
  const s = stubScenario({ listEnvelope: envelope([]) }); // no item file on disk
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-1", title: "Unlocatable", created_at: ISO }]), "utf-8");
    const result = await runImport(ext, { args: [file], options: {}, pmRoot: join(s.dir, "nowhere") });
    assert.equal(result.timestamped ?? 0, 0);
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("an unreadable item file skips its timestamp instead of failing the import", async () => {
  const ext = await harness();
  const s = stubScenario({ listEnvelope: envelope([]) });
  try {
    // A directory where the item file should be: statSync finds it, readFileSync throws EISDIR.
    mkdirSync(join(s.dir, "tasks", "pm-stub-1.toon"), { recursive: true });
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-1", title: "Undrinkable", created_at: ISO }]), "utf-8");
    const result = await runImport(ext, { args: [file], options: {}, pmRoot: s.dir });
    assert.equal(result.timestamped ?? 0, 0);
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("valid timestamps on an item file without timestamp lines leave nothing to patch", async () => {
  const ext = await harness();
  const s = scenarioWithItem("id: pm-stub-1\ntitle: T\nbody: no front-matter dates here\n");
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-1", title: "Patchless", created_at: ISO }]), "utf-8");
    const result = await runImport(ext, { args: [file], options: {}, pmRoot: s.dir });
    assert.equal(result.timestamped ?? 0, 0);
    assert.ok(!s.logLines().some((argv) => argv.includes("history-repair")), "no patch means no repair");
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("an unwritable item file skips its timestamp instead of failing the import", async () => {
  const ext = await harness();
  const s = scenarioWithItem('id: pm-stub-1\ntitle: T\ncreated_at: "2000-01-01T00:00:00.000Z"\n');
  try {
    chmodSync(join(s.dir, "tasks", "pm-stub-1.toon"), 0o444);
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-1", title: "Frozen", created_at: ISO }]), "utf-8");
    const result = await runImport(ext, { args: [file], options: {}, pmRoot: s.dir });
    assert.equal(result.timestamped ?? 0, 0);
  } finally {
    chmodSync(join(s.dir, "tasks", "pm-stub-1.toon"), 0o644); // so cleanup can remove the tree
    await ext.deactivate();
    s.restorePath();
  }
});

test("a failed history-repair reverts the patch so no drift is left behind", async () => {
  const ext = await harness();
  const s = stubScenario(
    { listEnvelope: envelope([]), historyRepair: { fail: true } },
    { "tasks/pm-stub-1.toon": 'id: pm-stub-1\ntitle: T\ncreated_at: "2000-01-01T00:00:00.000Z"\n' },
  );
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-1", title: "Reverting", created_at: ISO }]), "utf-8");
    const result = await runImport(ext, { args: [file], options: {}, pmRoot: s.dir });
    assert.equal(result.timestamped ?? 0, 0);
    assert.ok(readFileSync(join(s.dir, "tasks", "pm-stub-1.toon"), "utf-8").includes("2000-01-01"), "original value restored");
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("a failed history-repair that also blocks the revert tells the operator to repair manually", async () => {
  const ext = await harness();
  const s = stubScenario(
    { listEnvelope: envelope([]), historyRepair: { fail: true, chmodItemReadonly: true } },
    { "tasks/pm-stub-1.toon": 'id: pm-stub-1\ntitle: T\ncreated_at: "2000-01-01T00:00:00.000Z"\n' },
  );
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-1", title: "Stuck", created_at: ISO }]), "utf-8");
    const result = await runImport(ext, { args: [file], options: {}, pmRoot: s.dir });
    assert.equal(result.imported, 1, "the import itself still succeeds");
  } finally {
    chmodSync(join(s.dir, "tasks", "pm-stub-1.toon"), 0o644); // undo the stub's chmod for cleanup
    await ext.deactivate();
    s.restorePath();
  }
});

// --- Directly-driven defensive helpers -------------------------------------

test("parseBeadsFile substitutes an __invalid sentinel instead of dropping a malformed line", () => {
  const dir = mkdtempSync(join(tmpdir(), "beads-parse-"));
  try {
    const file = join(dir, "mixed.jsonl");
    writeFileSync(file, '{"id":"a","title":"ok"}\n{broken}\n', "utf-8");
    const records = parseBeadsFile(file);
    assert.equal(records.length, 2);
    assert.equal(records[1].__invalid, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a row filter excludes matching records from a real import and reports the count", async () => {
  const ext = await harness();
  const s = stubScenario({ listEnvelope: envelope([]) });
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([
      { id: "bd-keep", title: "Keep", issue_type: "bug" },
      { id: "bd-skip", title: "Skip", issue_type: "task" },
    ]), "utf-8");
    const result = await runImport(ext, {
      args: [file],
      options: { "filter-type": "bug" },
      pmRoot: join(s.dir, "ws"),
    });
    assert.equal(result.imported, 1);
    assert.equal(result.filtered, 1);
    const createdTitles = s.logLines().filter((argv) => argv.includes("create"));
    assert.equal(createdTitles.length, 1);
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("a failed dependency replace on an upserted item degrades to a warning", async () => {
  const ext = await harness();
  const s = stubScenario({
    listEnvelope: envelope([{ ...EXISTING_MARKER_ITEM }]),
    depFail: true,
  });
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([
      // The workspace-matched bead (bd-1 via the marker) carries edges itself,
      // so its UPSERT path takes the failing --replace-deps call.
      { id: "bd-1", title: "Existing", dependencies: ["bd-3"] },
      { id: "bd-3", title: "Fresh anchor" },
    ]), "utf-8");
    const result = await runImport(ext, {
      args: [file],
      options: { upsert: true },
      pmRoot: join(s.dir, "ws"),
    });
    // bd-1 is upserted WITH edges → the --replace-deps call fails → warning.
    assert.ok(s.logLines().some((argv) => argv.includes("--replace-deps")));
    assert.equal(result.dependencies ?? 0, 0);
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("the legacy beads-import alias command runs the same import core", async () => {
  const ext = await harness();
  const s = stubScenario({ listEnvelope: envelope([]) });
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-alias", title: "Via alias" }]), "utf-8");
    const result = (await runCommand(ext, {
      command: "beads-import",
      args: [file],
      options: {},
      pmRoot: join(s.dir, "ws"),
    })) as ImportResult;
    assert.equal(result.imported, 1);
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("a cross-workspace dependency that resolves in the workspace skips its edge with a warning", { skip: CHMOD_ROOT_SKIP }, async () => {
  const ext = await harness();
  const s = stubScenario({
    listEnvelope: envelope([{ id: "pm-old", title: "Old", description: "[bead_id: bd-old]" }]),
  });
  try {
    // An unreadable root forces the SDK store to refuse so the CLI fallback
    // (the scripted pm) supplies the workspace marker ids.
    mkdirSync(join(s.dir, "ws"), { recursive: true });
    chmodSync(join(s.dir, "ws"), 0o000);
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-new", title: "Depends on old", dependencies: ["bd-old"] }]), "utf-8");
    const result = await runImport(ext, { args: [file], options: {}, pmRoot: join(s.dir, "ws") });
    assert.equal(result.imported, 1);
    // bd-old is not imported this run, so the edge is skipped (not dangling).
    assert.ok(!s.logLines().some((argv) => argv.includes("--dep")));
  } finally {
    chmodSync(join(s.dir, "ws"), 0o755);
    await ext.deactivate();
    s.restorePath();
  }
});

test("--tags overrides record labels; --no-preserve-timestamps skips pass three", async () => {
  const ext = await harness();
  const s = stubScenario({ listEnvelope: envelope([]) });
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([
      { id: "bd-t1", title: "Tagged", labels: ["from-record"], created_at: "2026-01-01T00:00:00.000Z" },
      { id: "bd-t2", name: "Name Field Wins" },
    ]), "utf-8");
    const result = await runImport(ext, {
      args: [file],
      options: { tags: "override-all", "no-preserve-timestamps": true },
      pmRoot: join(s.dir, "ws"),
    });
    assert.equal(result.imported, 2);
    assert.equal(result.timestamped ?? 0, 0, "timestamps are not preserved when opted out");
    const firstCreate = s.logLines().find((argv) => argv.includes("create"))!;
    assert.deepEqual(firstCreate.slice(firstCreate.indexOf("--tags") + 1, firstCreate.indexOf("--tags") + 2), ["override-all"]);
    const creates = s.logLines().filter((argv) => argv.includes("create"));
    const secondCreate = creates[1]!;
    assert.ok(secondCreate.includes("Name Field Wins"), `the \`name\` alias satisfies the title: ${JSON.stringify(creates)}`);
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("a one-byte read buffer kills the real pm child and is reported as a buffer overrun", async () => {
  const ext = await harness();
  const dir = mkdtempSync(join(tmpdir(), "beads-enobufs-"));
  mkdirSync(dir, { recursive: true });
  const savedPath = process.env.PATH ?? "";
  const originalBuffer = process.env.PM_JSON_MAX_BUFFER;
  // The repo-local CLI answers every list with more than one byte, so a 1-byte
  // cap kills the child mid-read — the exact unattributable failure the cap
  // exists to name.
  process.env.PATH = `${join(process.cwd(), "node_modules", ".bin")}:${savedPath}`;
  process.env.PM_JSON_MAX_BUFFER = "1";
  try {
    // The input file itself must be readable; the overrun then happens in the
    // workspace cross-check's real `pm list` child.
    writeFileSync(join(dir, "in.jsonl"), '{"id":"bd-1","title":"Fine"}\n', "utf-8");
    mkdirSync(join(dir, "ws-exists-but-uninitialized"), { recursive: true });
    // An unreadable root makes the SDK store refuse, forcing the real CLI read
    // that then overruns the one-byte buffer.
    chmodSync(join(dir, "ws-exists-but-uninitialized"), 0o000);
    await assert.rejects(
      () => runCommand(ext, {
        command: "beads validate",
        args: [join(dir, "in.jsonl")],
        options: {},
        pmRoot: join(dir, "ws-exists-but-uninitialized"),
      }),
      (err: unknown) => err instanceof CommandError && /exceeded the 1 byte read buffer/.test(err.message),
    );
  } finally {
    process.env.PATH = savedPath;
    if (originalBuffer === undefined) delete process.env.PM_JSON_MAX_BUFFER;
    else process.env.PM_JSON_MAX_BUFFER = originalBuffer;
    chmodSync(join(dir, "ws-exists-but-uninitialized"), 0o755);
    await ext.deactivate();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--no-preserve-ids imports without bead markers and --batch-size batches real writes", async () => {
  const ext = await harness();
  const s = stubScenario({ listEnvelope: envelope([]) });
  try {
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([
      { id: "bd-a", title: "A" },
      { id: "bd-b", title: "B" },
    ]), "utf-8");
    const result = await runImport(ext, {
      args: [file],
      options: { "no-preserve-ids": true, "batch-size": "1" },
      pmRoot: join(s.dir, "ws"),
    });
    assert.equal(result.imported, 2);
    assert.equal(result.batches, 2);
    for (const create of s.logLines().filter((argv) => argv.includes("create"))) {
      assert.ok(!create.some((a) => String(a).includes("[bead_id:")), "no provenance marker is written");
    }
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("the legacy beads-import alias also falls back to the --file option", async () => {
  const ext = await harness();
  const s = stubScenario({ listEnvelope: envelope([]) });
  try {
    const file = s.jsonlPath("opt.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-opt2", title: "Via alias option" }]), "utf-8");
    const result = (await runCommand(ext, {
      command: "beads-import",
      options: { file },
      pmRoot: join(s.dir, "ws"),
    })) as ImportResult;
    assert.equal(result.imported, 1);
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});
