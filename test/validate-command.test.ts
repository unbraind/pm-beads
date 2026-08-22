/**
 * Validate-command behavior: usage errors, JSON and human reporting modes,
 * exit-code semantics, and every branch of the workspace dependency
 * cross-check (SDK store success, CLI fallback over the scripted binary,
 * legitimate absence degradation, and fail-loud propagation). Cycle detection
 * is driven directly because its in-file graph shapes are unreachable through
 * JSONL that passes the structural gate's other rules.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  assertBeadsImportable,
  CommandError,
  detectDependencyCycles,
  EXIT_CODE,
  validateBeadsText,
} from "../index.ts";
import { captureStderrAsync, CHMOD_ROOT_SKIP, envelopeWith, harness, jsonl, runCommand, stubScenario } from "./helpers.ts";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PM_BIN = fileURLToPath(import.meta.resolve("../node_modules/.bin/pm"));

function captureStderr<T>(fn: () => T): { lines: string[]; result: T } {
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

test("validate without a file argument is a usage error", async () => {
  const ext = await harness();
  try {
    await assert.rejects(
      () => runCommand(ext, { command: "beads validate", args: [], options: {}, pmRoot: undefined }),
      (err: unknown) => err instanceof CommandError && err.exitCode === EXIT_CODE.USAGE && /Usage: pm beads validate/.test(err.message),
    );
  } finally {
    await ext.deactivate();
  }
});

test("validating a directory maps the read failure to GENERIC_FAILURE", async () => {
  const ext = await harness();
  const dir = mkdtempSync(join(tmpdir(), "beads-validate-"));
  try {
    await assert.rejects(
      () => runCommand(ext, { command: "beads validate", args: [dir], options: {}, pmRoot: undefined }),
      (err: unknown) => err instanceof CommandError && err.exitCode === EXIT_CODE.GENERIC_FAILURE && /Failed to read file/.test(err.message),
    );
  } finally {
    await ext.deactivate();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("JSON mode returns the structured report and signals failure through the exit code", async () => {
  const ext = await harness();
  const s = stubScenario({});
  try {
    const file = s.jsonlPath("bad.jsonl");
    writeFileSync(file, '{"id":"a"}\n', "utf-8"); // missing title
    process.exitCode = 0;
    const report = (await runCommand(ext, {
      command: "beads validate",
      args: [file],
      options: {},
      global: { json: true },
      pmRoot: undefined,
    })) as { valid?: boolean; records?: number; issues?: Array<{ code: string }> };
    assert.equal(report.valid, false);
    assert.equal(report.records, 1);
    assert.ok(report.issues?.some((i) => i.code === "missing_title"));
    assert.equal(process.exitCode, EXIT_CODE.GENERIC_FAILURE);
    process.exitCode = 0;
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("human mode lists every issue, counts errors vs warnings, and throws on errors", async () => {
  const ext = await harness();
  const s = stubScenario({});
  try {
    const file = s.jsonlPath("mixed.jsonl");
    writeFileSync(file, [
      JSON.stringify({ id: "bd-a", status: "weird", title: "Odd status" }),
      JSON.stringify({ id: "bd-a", title: "Duplicate id" }),
      JSON.stringify({ id: "bd-b", dependencies: ["bd-zzz"] }),
      "{broken",
    ].join("\n") + "\n", "utf-8");
    let lines: string[] = [];
    await assert.rejects(
      () => {
        const captured = captureStderr(() =>
          runCommand(ext, { command: "beads validate", args: [file], options: { "no-workspace": true }, pmRoot: undefined }),
        );
        lines = captured.lines;
        return Promise.resolve(captured.result);
      },
      (err: unknown) => err instanceof CommandError && /Validation failed: 3 structural error\(s\)\./.test(err.message),
    );
    assert.ok(lines.some((l) => l.includes("WARNING [unknown_status]")));
    assert.ok(lines.some((l) => l.includes("WARNING [duplicate_id]")));
    assert.ok(lines.some((l) => l.includes('ERROR [invalid_json] line 4')));
    assert.ok(lines.some((l) => l.includes("ERROR [dangling_dependency]")));
    assert.ok(lines.some((l) => l.includes("3 record(s): 3 error(s), 2 warning(s)."), "the malformed line is refused, not counted as a record"));
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("a clean file reports OK and keeps a zero exit", async () => {
  const ext = await harness();
  const s = stubScenario({});
  try {
    const file = s.jsonlPath("clean.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-ok", title: "Fine", status: "open" }]), "utf-8");
    let lines: string[] = [];
    const report = await (() => {
      const captured = captureStderr(() =>
        runCommand(ext, {
          command: "beads validate",
          args: [file],
          options: { "no-workspace": true },
          pmRoot: undefined,
        }),
      );
      lines = captured.lines;
      return captured.result as Promise<{ valid?: boolean }>;
    })();
    assert.equal(report.valid, true);
    assert.ok(lines.some((l) => l.includes("OK: 1 record(s), no issues.")));
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("--no-workspace keeps a resolvable-in-workspace dependency a hard error", async () => {
  const ext = await harness();
  const s = stubScenario({ listEnvelope: JSON.parse(envelopeWith([{ id: "pm-x", title: "X", description: "[bead_id: bd-real]" }])) });
  try {
    const file = s.jsonlPath("dep.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-1", title: "Dependent", dependencies: ["bd-real"] }]), "utf-8");
    const { lines } = await captureStderrAsync(() =>
      runCommand(ext, {
        command: "beads validate",
        args: [file],
        options: { "no-workspace": true },
        pmRoot: join(s.dir, "ws"),
      }).then(
        (r) => r,
        (err: unknown) => {
          assert.ok(err instanceof CommandError && err.exitCode === EXIT_CODE.GENERIC_FAILURE);
          return { valid: false };
        },
      ),
    );
    assert.ok(lines.some((l) => l.includes('references unknown bead id "bd-real"')),
      "without the cross-check, an edge that would resolve in the workspace stays dangling");
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("a nonexistent pm root legitimately degrades the cross-check instead of failing validation", async () => {
  const ext = await harness();
  const s = stubScenario({});
  try {
    const file = s.jsonlPath("dep.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-1", title: "Dependent", dependencies: ["bd-gone"] }]), "utf-8");
    const { lines } = await captureStderrAsync(() =>
      runCommand(ext, {
        command: "beads validate",
        args: [file],
        options: {},
        pmRoot: join(s.dir, "never-initialized"),
      }).then(
        (r) => r,
        (err: unknown) => {
          assert.ok(err instanceof CommandError && err.exitCode === EXIT_CODE.GENERIC_FAILURE);
          return { valid: false };
        },
      ),
    );
    assert.ok(lines.some((l) => l.includes('references unknown bead id "bd-gone"')),
      "a missing root degrades the cross-check, so the edge stays a hard dangling error");
  } finally {
    await ext.deactivate();
    s.restorePath();
  }
});

test("an unreadable root falls back to the CLI read and downgrades resolvable edges", { skip: CHMOD_ROOT_SKIP }, async () => {
  const ext = await harness();
  const s = stubScenario({
    listEnvelope: JSON.parse(envelopeWith([
      { id: "pm-x", title: "X", status: "open", description: "[bead_id: bd-real]" },
    ])),
  });
  try {
    // The SDK store refuses an unreadable root while existsSync still passes —
    // exactly the split that makes the CLI fallback the correct next step.
    const ws = join(s.dir, "ws");
    mkdirSync(ws, { recursive: true });
    chmodSync(ws, 0o000);
    const file = s.jsonlPath("dep.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-1", title: "Dependent", dependencies: ["bd-real"] }]), "utf-8");
    let lines: string[] = [];
    const report = await (() => {
      const captured = captureStderr(() =>
        runCommand(ext, {
          command: "beads validate",
          args: [file],
          options: {},
          pmRoot: ws,
        }),
      );
      lines = captured.lines;
      return captured.result as Promise<{ valid?: boolean; issues?: Array<{ code: string }> }>;
    })();
    assert.equal(report.valid, true, "a resolvable edge is a warning, not a refusal");
    assert.ok(report.issues?.some((i) => i.code === "cross_workspace_dependency"));
    assert.equal(process.exitCode ?? 0, 0);
    void lines;
  } finally {
    chmodSync(join(s.dir, "ws"), 0o755); // so cleanup can remove the tree
    await ext.deactivate();
    s.restorePath();
  }
});

test("a failing CLI fallback propagates instead of feeding the gate an empty cross-check", { skip: CHMOD_ROOT_SKIP }, async () => {
  const ext = await harness();
  const s = stubScenario({ listFail: { status: 7, stderr: "workspace exploded" } });
  try {
    const ws = join(s.dir, "ws");
    mkdirSync(ws, { recursive: true });
    chmodSync(ws, 0o000); // SDK refuses; the fallback must run and fail loudly
    const file = s.jsonlPath("dep.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-1", title: "Dependent" }]), "utf-8");
    await assert.rejects(
      () => runCommand(ext, {
        command: "beads validate",
        args: [file],
        options: {},
        pmRoot: ws,
      }),
      (err: unknown) => err instanceof CommandError && /^workspace exploded\n?$/.test(err.message),
    );
  } finally {
    chmodSync(join(s.dir, "ws"), 0o755);
    await ext.deactivate();
    s.restorePath();
  }
});

test("the SDK store success path recovers bead ids from the persisted marker", async () => {
  const ext = await harness();
  const ws = mkdtempSync(join(tmpdir(), "beads-sdk-ws-")) + "/ws";
  execFileSync(PM_BIN, ["--path", ws, "init"], { stdio: "ignore" });
  execFileSync(PM_BIN, ["--path", ws, "create", "--title", "Real item", "--description", "[bead_id: bd-real]"], { stdio: "ignore" });
  const s = stubScenario({});
  try {
    const file = s.jsonlPath("dep.jsonl");
    writeFileSync(file, jsonl([{ id: "bd-1", title: "Dependent", dependencies: ["bd-real"] }]), "utf-8");
    const report = (await runCommand(ext, {
      command: "beads validate",
      args: [file],
      options: {},
      pmRoot: ws,
    })) as { valid?: boolean; issues?: Array<{ code: string }> };
    assert.equal(report.valid, true, "the SDK store resolved the marker without any CLI spawn");
    assert.ok(report.issues?.some((i) => i.code === "cross_workspace_dependency"));
  } finally {
    await ext.deactivate();
    s.restorePath();
    rmSync(ws, { recursive: true, force: true });
  }
});

// --- Structural validator and cycle detection ------------------------------

test("validateBeadsText tolerates blank lines and reports them nowhere", () => {
  const report = validateBeadsText('\n{"id":"a","title":"ok"}\n\n');
  assert.equal(report.records, 1);
  assert.equal(report.valid, true);
  assert.equal(report.file, undefined);
});

test("validateBeadsText rejects non-object lines and accepts alias field spellings", () => {
  const report = validateBeadsText('[1]\n{"name":"aliased title"}\n');
  assert.equal(report.valid, false);
  assert.ok(report.issues.some((i) => i.code === "not_object"));
  assert.ok(!report.issues.some((i) => i.code === "missing_title"), "`name` satisfies the title requirement");
});

test("detectDependencyCycles finds self-loops, two-cycles and longer cycles exactly once each", () => {
  const cycles = detectDependencyCycles(new Map([
    ["self", ["self"]],
    ["a", ["b"]],
    ["b", ["c"]],
    ["c", ["a"]],
    ["x", ["y"]],
    ["y", ["x"]],
    ["diamond-root", ["l", "r"]],
    ["l", ["bottom"]],
    ["r", ["bottom"]],
  ]));
  const members = cycles.map((c) => [...c].sort().join(",")).sort();
  assert.deepEqual(members, ["a,a,b,c", "self,self", "x,x,y"], "a diamond without a back-edge is not a cycle");
});

test("the importable-gate failure message summarizes beyond ten errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "beads-many-"));
  try {
    const file = join(dir, "many.jsonl");
    const records = Array.from({ length: 12 }, (_, i2) => JSON.stringify({ id: `bd-${i2}` }));
    writeFileSync(file, records.join("\n") + "\n", "utf-8"); // all 12 lack titles
    await assert.rejects(
      () => assertBeadsImportable(file),
      (err: unknown) => {
        assert.ok(err instanceof CommandError);
        assert.match(err.message, /…and 2 more error\(s\)/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
