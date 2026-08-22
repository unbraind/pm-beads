/**
 * Export and diff path tests: the stdout/file/dry-run branches of the exporter,
 * the diff command's usage errors, strict drift gates, human summary, and the
 * field normalizers both pipelines share. Workspace reads run against the
 * scripted `pm` binary so the full production read pipeline executes.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  changedFields,
  CommandError,
  DIFF_FIELDS,
  diffBeads,
  EXIT_CODE,
  indexBeadsById,
  isInvalidTypeValueError,
  locateItemFile,
  normalizeDiffField,
  pmItemPassesFilter,
  pmItemToBead,
} from "../index.ts";
import { envelopeWith, harness, jsonl, runCommand, runExport, runImport, stubScenario } from "./helpers.ts";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function captureStderr(fn: () => unknown): { lines: string[]; result: unknown } {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { lines, result: fn() };
  } finally {
    console.error = original;
  }
}

// --- Exporter --------------------------------------------------------------

test("export writes JSONL to --output and reports the count", async () => {
  const ext = await harness();
  const s = stubScenario({
    listEnvelope: JSON.parse(envelopeWith([
      { id: "pm-1", title: "One", description: "[bead_id: bd-1]", status: "open" },
      { id: "pm-2", title: "Two", status: "in_progress" },
    ])),
  });
  try {
    const out = s.jsonlPath("out.jsonl");
    const result = (await runExport(ext, {
      options: { output: out },
      pmRoot: join(s.dir, "ws"),
    })) as { exported?: number; output?: string };
    assert.equal(result.exported, 2);
    assert.ok((result.output ?? "").endsWith("out.jsonl"));
    const text = await import("node:fs").then((fs) => fs.readFileSync(out, "utf-8"));
    assert.match(text.split("\n")[0]!, /"id":"bd-1"/);
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("export --dry-run serializes in memory but writes neither file nor stdout", async () => {
  const ext = await harness();
  const s = stubScenario({ listEnvelope: JSON.parse(envelopeWith([{ id: "pm-1", title: "One", status: "open" }])) });
  try {
    const result = (await runExport(ext, {
      options: { "dry-run": true },
      pmRoot: join(s.dir, "ws"),
    })) as { dryRun?: boolean; wouldExport?: number };
    assert.equal(result.dryRun, true);
    assert.equal(result.wouldExport, 1);
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("export to an unwritable output path fails with a semantic error naming the file", async () => {
  const ext = await harness();
  const s = stubScenario({ listEnvelope: JSON.parse(envelopeWith([{ id: "pm-1", title: "One", status: "open" }])) });
  try {
    const bad = join(s.dir, "no-such-dir", "out.jsonl");
    await assert.rejects(
      () => runExport(ext, { options: { output: bad }, pmRoot: join(s.dir, "ws") }),
      (err: unknown) => err instanceof CommandError && /Failed to write/.test(err.message),
    );
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

// --- Diff command ----------------------------------------------------------

const BEAD_A = { id: "bd-a", title: "A", status: "open", issue_type: "task" };
const BEAD_B = { id: "bd-b", title: "B", status: "open", issue_type: "task" };

async function twoFileSetup(): Promise<ReturnType<typeof stubScenario>> {
  const s = stubScenario({});
  writeFileSync(s.jsonlPath("a.jsonl"), jsonl([BEAD_A]), "utf-8");
  return s;
}

test("diff requires a second source unless --against-workspace is given", async () => {
  const ext = await harness();
  const s = await twoFileSetup();
  try {
    await assert.rejects(
      () => runCommand(ext, { command: "beads diff", args: [s.jsonlPath("a.jsonl")], options: {}, pmRoot: undefined }),
      (err: unknown) => err instanceof CommandError && err.exitCode === EXIT_CODE.USAGE && /Provide two files/.test(err.message),
    );
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("diff rejects a second file combined with --against-workspace", async () => {
  const ext = await harness();
  const s = await twoFileSetup();
  try {
    await assert.rejects(
      () => runCommand(ext, {
        command: "beads diff",
        args: [s.jsonlPath("a.jsonl"), s.jsonlPath("b.jsonl")],
        options: { "against-workspace": true },
        pmRoot: join(s.dir, "ws"),
      }),
      (err: unknown) => err instanceof CommandError && err.exitCode === EXIT_CODE.USAGE
        && /exactly one file with --against-workspace/.test(err.message),
    );
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("diff refuses --against-workspace when no workspace root can be resolved", async () => {
  const ext = await harness();
  const s = await twoFileSetup();
  try {
    await assert.rejects(
      () => runCommand(ext, {
        command: "beads diff",
        args: [s.jsonlPath("a.jsonl")],
        options: { "against-workspace": true },
        pmRoot: undefined,
      }),
      (err: unknown) => err instanceof CommandError && err.exitCode === EXIT_CODE.GENERIC_FAILURE
        && /Cannot resolve the pm workspace root/.test(err.message),
    );
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("diff against the workspace classifies added/removed/changed drift under --json --strict", async () => {
  const ext = await harness();
  const s = stubScenario({
    listEnvelope: JSON.parse(envelopeWith([
      { id: "pm-x", title: "A-renamed", status: "open", description: "[bead_id: bd-a]" },
      { id: "pm-z", title: "B-original", status: "open", description: "[bead_id: bd-b]" },
      { id: "pm-y", title: "C", status: "open", description: "[bead_id: bd-c]" },
    ])),
  });
  try {
    // File has bd-a + bd-b (both title-drift vs workspace) and workspace adds bd-c.
    writeFileSync(s.jsonlPath("file.jsonl"), jsonl([BEAD_A, { ...BEAD_B, title: "B-renamed" }]), "utf-8");
    process.exitCode = 0;
    const result = (await runCommand(ext, {
      command: "beads-diff",
      args: [s.jsonlPath("file.jsonl")],
      options: { "against-workspace": true, strict: true },
      global: { json: true },
      pmRoot: join(s.dir, "ws"),
    })) as { added?: string[]; removed?: string[]; changed?: Array<{ id: string; fields: string[] }>; unchanged?: number };
    assert.deepEqual(result.added, ["bd-c"]);
    assert.deepEqual(result.removed, [], "bd-b still exists in the workspace (renamed there)");
    assert.deepEqual(
      result.changed,
      [
        { id: "bd-a", fields: ["title"] },
        { id: "bd-b", fields: ["title"] },
      ],
      "changed entries are sorted by id (the comparator only runs with two or more)",
    );
    assert.equal(result.unchanged, 0);
    assert.equal(process.exitCode, EXIT_CODE.GENERIC_FAILURE, "--strict + drift sets a nonzero exit without throwing in json mode");
    process.exitCode = 0;
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("diff prints a per-bead drift summary and throws under non-json --strict", async () => {
  const ext = await harness();
  const s = stubScenario({});
  try {
    writeFileSync(s.jsonlPath("a.jsonl"), jsonl([BEAD_A, BEAD_B]), "utf-8");
    writeFileSync(s.jsonlPath("b.jsonl"), jsonl([{ ...BEAD_A, title: "Changed A" }]), "utf-8");
    let summary: string[] = [];
    await assert.rejects(
      () => {
        const captured = captureStderr(() =>
          runCommand(ext, { command: "beads diff", args: [s.jsonlPath("a.jsonl"), s.jsonlPath("b.jsonl")], options: { strict: true }, pmRoot: undefined }),
        );
        summary = captured.lines;
        return Promise.resolve(captured.result);
      },
      (err: unknown) => err instanceof CommandError && /Drift detected: 0 added, 1 removed, 1 changed\./.test(err.message),
    );
    assert.ok(summary.some((l) => l.includes("Removed (only in A): 1")));
    assert.ok(summary.some((l) => l.startsWith("    - bd-b")));
    assert.ok(summary.some((l) => l.includes("Changed: 1") || l.includes("~ bd-a (title)")));
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("diff over a malformed line hard-fails naming the line, for both invalid JSON and non-objects", async () => {
  const ext = await harness();
  const s = stubScenario({});
  try {
    writeFileSync(s.jsonlPath("bad.jsonl"), "{not json\n", "utf-8");
    writeFileSync(s.jsonlPath("arr.jsonl"), "[1,2]\n", "utf-8");
    writeFileSync(s.jsonlPath("good.jsonl"), jsonl([BEAD_A]), "utf-8");
    await assert.rejects(
      () => runCommand(ext, { command: "beads diff", args: [s.jsonlPath("bad.jsonl"), s.jsonlPath("good.jsonl")], options: {}, pmRoot: undefined }),
      (err: unknown) => err instanceof CommandError && /Line 1: invalid JSON/.test(err.message),
    );
    await assert.rejects(
      () => runCommand(ext, { command: "beads diff", args: [s.jsonlPath("arr.jsonl"), s.jsonlPath("good.jsonl")], options: {}, pmRoot: undefined }),
      (err: unknown) => err instanceof CommandError && /Line 1: not a JSON object/.test(err.message),
    );
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

// --- Shared field normalizers ----------------------------------------------

test("normalizeDiffField canonicalizes every compared dimension symmetrically", () => {
  const done = { ...BEAD_A, status: "done", priority: 3, labels: ["zeta", "alpha"], assignee: "ana", due_date: "2030-01-01T00:00:00Z" };
  const closed = { ...BEAD_A, status: "closed", priority: "3", tags: ["alpha", "zeta"], owner: "ana", deadline: "2030-01-01T00:00:00Z" };
  for (const field of DIFF_FIELDS) {
    assert.equal(normalizeDiffField(done, field), normalizeDiffField(closed, field), `${field} compares equal`);
  }
  assert.equal(normalizeDiffField(BEAD_A, "priority"), "2", "an unset priority defaults to the middle of the scale");
  assert.equal(normalizeDiffField(BEAD_A, "dependencies"), "", "no edges normalize to an empty set");
});

test("the exhaustive-field guard returns its input rather than silently mapping unknown fields", () => {
  // Unreachable through typed callers by construction; driven directly here so
  // the runtime behavior of the never-guard stays pinned and covered.
  const bogus = "nonexistent-field" as typeof DIFF_FIELDS[number];
  assert.equal(normalizeDiffField(BEAD_A, bogus), "nonexistent-field");
});

test("changedFields reports exactly the dimensions that differ", () => {
  const a = { ...BEAD_A, priority: 1 };
  const b = { ...BEAD_A, priority: 2, status: "done" };
  assert.deepEqual(changedFields(a, b), ["status", "priority"]);
});

test("indexBeadsById keeps the first occurrence and skips id-less records", () => {
  const index = indexBeadsById([{ ...BEAD_A, title: "first" }, { title: "no id" }, { ...BEAD_A, title: "second" }]);
  assert.equal(index.size, 1);
  assert.equal(index.get("bd-a")?.title, "first");
});

test("diffBeads applies the row filter to both sides before comparing", () => {
  const a = [BEAD_A, BEAD_B];
  const b = [{ ...BEAD_A, title: "Changed A" }];
  const filter = { statuses: new Set(["open"]), types: new Set(["bug"]) };
  // Both beads are type task → filtered away on both sides → no drift at all.
  const diff = diffBeads(a, b, filter);
  assert.equal(diff.drift, false);
});

test("pmItemPassesFilter matches on the exported (beads) status spelling", () => {
  const item = { status: "closed", type: "Bug" };
  assert.equal(pmItemPassesFilter(item as never, { statuses: new Set(["closed"]), types: undefined }), true);
  assert.equal(pmItemPassesFilter(item as never, { statuses: new Set(["done"]), types: undefined }), false);
  assert.equal(pmItemPassesFilter(item as never, { statuses: undefined, types: new Set(["bug"]) }), true);
  assert.equal(pmItemPassesFilter(item as never, { statuses: undefined, types: new Set(["task"]) }), false);
});

test("isInvalidTypeValueError requires both the machine code and the human phrase", () => {
  assert.equal(isInvalidTypeValueError(undefined), false);
  assert.equal(isInvalidTypeValueError(""), false);
  assert.equal(isInvalidTypeValueError("invalid_argument_value only"), false);
  assert.equal(isInvalidTypeValueError("Invalid type value only"), false);
  assert.equal(isInvalidTypeValueError('{"code":"invalid_argument_value","message":"Invalid type value: bug"}'), true);
});

test("pmItemToBead carries optional fields and translates dependencies back to bead ids", () => {
  const pmToBead = new Map([["pm-upstream", "bd-up"]]);
  const bead = pmItemToBead(
    {
      id: "pm-1",
      title: "T",
      status: "in_progress",
      type: "Feature",
      priority: null,
      dependencies: [
        { id: "pm-upstream", kind: "blocked_by" },
        { id: "pm-other", kind: "related" },
        { id: "pm-nokind" },
      ],
      parent: "pm-unmapped-parent",
      sprint: "S9",
      release: "R2",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-02T00:00:00Z",
    } as never,
    pmToBead,
    true,
  );
  assert.deepEqual(bead.dependencies, [
    { issue_id: "pm-1", depends_on_id: "bd-up", type: "blocks" },
    { issue_id: "pm-1", depends_on_id: "pm-nokind", type: "blocks" },
  ],
    "blocked_by edges translate (missing kind defaults to blocked_by); other kinds are dropped");
  assert.equal(bead.priority, undefined, "a null priority is omitted");
  assert.equal(bead.parent, "pm-unmapped-parent", "unmapped parents keep their pm id");
  assert.equal(bead.sprint, "S9");
  assert.equal(bead.release, "R2");
  assert.equal(bead.created_at, "2026-01-01T00:00:00Z");
  assert.equal(bead.updated_at, "2026-01-02T00:00:00Z");
  assert.equal("labels" in bead, false, "empty/absent tags emit no labels field");
});

// --- locateItemFile edge arms ----------------------------------------------

test("locateItemFile degrades on an unreadable root and skips entries that vanish mid-scan", () => {
  assert.equal(locateItemFile("/nonexistent/pm-root-xyz", "pm-1"), undefined);
  const dir = mkdtempSync(join(tmpdir(), "beads-locate-"));
  try {
    mkdirSync(join(dir, "tasks"), { recursive: true });
    mkdirSync(join(dir, "features"), { recursive: true });
    symlinkSync(join(dir, "gone-target"), join(dir, "tasks", "dangling-link-dir"));
    writeFileSync(join(dir, "features", "pm-2.md"), "id: pm-2\n");
    assert.match(locateItemFile(dir, "pm-2") ?? "", /features[/\\]pm-2\.md$/);
    assert.equal(locateItemFile(dir, "pm-missing"), undefined);
  } finally {
    void import("node:fs").then((fs) => fs.rmSync(dir, { recursive: true, force: true }));
  }
});

test("diff with no usable file argument is a usage error naming both forms", async () => {
  const ext = await harness();
  const s = await twoFileSetup();
  try {
    await assert.rejects(
      () => runCommand(ext, { command: "beads diff", args: ["--strict"], options: {}, pmRoot: undefined }),
      (err: unknown) => err instanceof CommandError && err.exitCode === EXIT_CODE.USAGE && /Usage: pm beads diff/.test(err.message),
    );
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("the legacy beads-export alias command runs the same export core", async () => {
  const ext = await harness();
  const s = stubScenario({ listEnvelope: JSON.parse(envelopeWith([{ id: "pm-1", title: "One", status: "open" }])) });
  try {
    const result = (await runCommand(ext, {
      command: "beads-export",
      options: { "dry-run": true },
      pmRoot: join(s.dir, "ws"),
    })) as { dryRun?: boolean; wouldExport?: number };
    assert.equal(result.dryRun, true);
    assert.equal(result.wouldExport, 1);
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

const ISO = "2026-01-02T03:04:05.000Z";

test("an unreadable item file is reported as a read failure, not a locate failure", async () => {
  const ext = await harness();
  const s = stubScenario({ listEnvelope: JSON.parse(envelopeWith([])) });
  try {
    const itemFile = join(s.dir, "tasks", "pm-stub-1.toon");
    mkdirSync(join(s.dir, "tasks"), { recursive: true });
    writeFileSync(itemFile, 'id: pm-stub-1\ntitle: T\ncreated_at: "2000-01-01T00:00:00.000Z"\n', "utf-8");
    chmodSync(itemFile, 0o000); // stat succeeds, read fails
    const file = s.jsonlPath("in.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-1", title: "Dark", created_at: ISO }]), "utf-8");
    const result = await runImport(ext, { args: [file], options: {}, pmRoot: s.dir });
    assert.equal(result.timestamped ?? 0, 0);
  } finally {
    chmodSync(join(s.dir, "tasks", "pm-stub-1.toon"), 0o644);
    await ext.deactivate();
    s.restorePath();
  }
});

test("locateItemFile keeps scanning past an entry that vanishes between listing and stat", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beads-vanish-"));
  try {
    symlinkSync(join(dir, "gone"), join(dir, "dangling-dir"));
    assert.equal(locateItemFile(dir, "pm-none"), undefined,
      "the dangling entry is skipped without aborting the scan");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("diff ignores empty-string tokens among the raw args", async () => {
  const ext = await harness();
  const s = await twoFileSetup();
  try {
    await assert.rejects(
      () => runCommand(ext, { command: "beads diff", args: ["", s.jsonlPath("a.jsonl")], options: {}, pmRoot: undefined }),
      (err: unknown) => err instanceof CommandError && err.exitCode === EXIT_CODE.USAGE,
    );
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("diff treats absent raw args the same as empty ones", async () => {
  const ext = await harness();
  const s = await twoFileSetup();
  try {
    await assert.rejects(
      () => runCommand(ext, { command: "beads diff", args: undefined, options: {}, pmRoot: undefined }),
      (err: unknown) => err instanceof CommandError && err.exitCode === EXIT_CODE.USAGE && /Usage: pm beads diff/.test(err.message),
    );
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});
