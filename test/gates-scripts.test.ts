/**
 * The executable tooling gates, measured by their own suite: `coverageGate`
 * includes `scripts/`, so coverage-gate.ts, docstring-gate.ts and the merge
 * driver preparer must themselves be exercised to 100%.
 *
 * The coverage gate is tested against real fixture repositories (a package.json,
 * a source module, and a test that imports it) through its exported pure
 * {@link runGate}, which spawns a real `node --test` child per fixture — these
 * are the adversarial checks proving the gate fails closed on an unexecuted
 * source, a threshold regression, and every misconfigured escape hatch.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  collectReportedFiles,
  evaluateRun,
  isMainInvocation,
  main as coverageGateMain,
  runGate,
} from "../scripts/coverage-gate.ts";
import {
  isExecutableFile,
  isMainInvocation as isPrepareMain,
  pmOnPath,
  runPrepare,
} from "../scripts/prepare-merge-driver.ts";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.resolve("../package.json")), "..");

/** Fixtures live under the repo so `npx tsc` resolves this repo's typescript. */
function fixtureRoot(name: string): string {
  const root = join(REPO_ROOT, ".tmp-coverage-fixtures", name);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}

interface FixtureOptions {
  manifest?: Record<string, unknown>;
  sources?: Array<{ name: string; content: string }>;
  tests?: Array<{ name: string; content: string }>;
  extraFiles?: Record<string, string>;
}

/** A minimal fixture package whose single source is fully covered by its test. */
function writeFixture(root: string, opts: FixtureOptions = {}): void {
  const covered = opts.sources ?? [
    {
      name: "covered.ts",
      content: 'export function twice(n: number): number {\n  if (n > 0) return n * 2;\n  return -n;\n}\n',
    },
  ];
  for (const s of covered) {
    mkdirSync(join(root, s.name, ".."), { recursive: true });
    writeFileSync(join(root, s.name), s.content, "utf-8");
  }
  for (const t of opts.tests ?? [
    {
      name: join("test", "covered.test.ts"),
      content: 'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { twice } from "../covered.ts";\ntest("twice", () => {\n  assert.equal(twice(2), 4);\n  assert.equal(twice(-1), 1);\n});\n',
    },
  ]) {
    mkdirSync(join(root, t.name, ".."), { recursive: true });
    writeFileSync(join(root, t.name), t.content, "utf-8");
  }
  for (const [name, content] of Object.entries(opts.extraFiles ?? {})) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), content, "utf-8");
  }
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(opts.manifest ?? {
      coverageGate: {
        sources: ["."],
        tests: ["test/*.test.ts"],
        thresholds: { lines: 100, branches: 100, functions: 100 },
      },
    }),
    "utf-8",
  );
}

test("runGate measures sources in nested directories and prunes skipped ones", () => {
  const root = fixtureRoot("nested");
  writeFixture(root, {
    sources: [
      { name: "lib/nested/covered.ts", content: 'export function twice(n: number): number {\n  return n < 0 ? -n : n * 2;\n}\n' },
    ],
    tests: [
      { name: join("test", "covered.test.ts"), content: 'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { twice } from "../lib/nested/covered.ts";\ntest("twice", () => {\n  assert.equal(twice(2), 4);\n  assert.equal(twice(-1), 1);\n});\n' },
    ],
  });
  try {
    const result = runGate(root);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /coverage-gate: 1 source file\(s\) reported/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runGate passes a fully covered fixture and reports the measured file count", () => {
  const root = fixtureRoot("pass");
  writeFixture(root);
  try {
    const result = runGate(root);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /coverage-gate: 1 source file\(s\) reported, thresholds met\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runGate fails naming a source that never loaded — the silent-omission escape is closed", () => {
  const root = fixtureRoot("unexecuted");
  writeFixture(root, {
    sources: [
      { name: "covered.ts", content: 'export const x = 1;\n' },
      { name: "ghost.ts", content: 'export const y = 2;\n' },
    ],
    tests: [
      { name: join("test", "covered.test.ts"), content: 'import test from "node:test";\nimport "../covered.ts";\ntest("loads", () => {});\n' },
    ],
  });
  try {
    const result = runGate(root);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /never loaded during the run/);
    assert.match(result.stderr, /ghost\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runGate fails on a threshold regression even when every file loaded", () => {
  const root = fixtureRoot("regression");
  writeFixture(root, {
    // The test never exercises the negative branch → branch coverage < 100.
    sources: [{ name: "covered.ts", content: 'export function twice(n: number): number {\n  if (n > 0) return n * 2;\n  return -n;\n}\n' }],
    tests: [
      { name: join("test", "covered.test.ts"), content: 'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { twice } from "../covered.ts";\ntest("only positive", () => {\n  assert.equal(twice(2), 4);\n});\n' },
    ],
  });
  try {
    const result = runGate(root);
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr + result.stdout, /coverage|ERROR|failing/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runGate refuses to run without a coverageGate block", () => {
  const root = fixtureRoot("no-block");
  writeFixture(root, { manifest: {} });
  try {
    const result = runGate(root);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /no `coverageGate` block/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runGate fails closed on an unreadable package.json", () => {
  const root = fixtureRoot("bad-manifest");
  writeFixture(root, { manifest: {} });
  writeFileSync(join(root, "package.json"), "{not json", "utf-8");
  try {
    const result = runGate(root);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /could not read package\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runGate rejects a configured source location that does not exist", () => {
  const root = fixtureRoot("missing-source");
  writeFixture(root, {
    manifest: {
      coverageGate: { sources: ["./gone"], tests: ["test/*.test.ts"], thresholds: { lines: 100, branches: 100, functions: 100 } },
    },
  });
  try {
    const result = runGate(root);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runGate rejects non-TypeScript and declaration-file source entries as unsatisfiable", () => {
  const root = fixtureRoot("dts-source");
  writeFixture(root);
  const config = {
    coverageGate: { sources: [".", "./types.d.ts"], tests: ["test/*.test.ts"], thresholds: { lines: 100, branches: 100, functions: 100 } },
  };
  writeFileSync(join(root, "types.d.ts"), "export type T = 1;\n", "utf-8");
  writeFileSync(join(root, "package.json"), JSON.stringify(config), "utf-8");
  try {
    const result = runGate(root);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /not a TypeScript source file/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runGate refuses when the walk finds no measurable files at all", () => {
  const root = fixtureRoot("empty-walk");
  writeFixture(root, {
    sources: [],
    tests: [],
    manifest: {
      coverageGate: { sources: ["./lib"], tests: [], thresholds: { lines: 100, branches: 100, functions: 100 } },
    },
  });
  mkdirSync(join(root, "lib"), { recursive: true });
  try {
    const result = runGate(root);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /found no files/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runGate rejects an ignore entry that is not under any source root", () => {
  const root = fixtureRoot("ignore-not-under");
  writeFixture(root, {
    manifest: {
      coverageGate: {
        sources: ["./src"],
        tests: ["test/*.test.ts"],
        thresholds: { lines: 100, branches: 100, functions: 100 },
        ignore: ["elsewhere.ts"],
      },
    },
    extraFiles: {
      "src/covered.ts": 'export const x = 1;\n',
      "test/covered.test.ts": 'import "../src/covered.ts";\nimport test from "node:test";\ntest("loads", () => {});\n',
      "elsewhere.ts": "export const z = 3;\n",
    },
  });
  try {
    const result = runGate(root);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /is not under `sources`/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runGate refuses to verify an ignore entry when the compiler cannot be consulted", () => {
  const root = fixtureRoot("no-compiler");
  writeFixture(root, {
    manifest: {
      coverageGate: {
        sources: ["."],
        tests: ["test/*.test.ts"],
        thresholds: { lines: 100, branches: 100, functions: 100 },
        ignore: ["type-only.ts"],
      },
    },
    extraFiles: { "type-only.ts": "export type Only = 1;\n" },
  });
  // With no `npx` reachable, the effective emit layout is unknowable; the gate
  // must refuse rather than clear an exemption it could not verify.
  const emptyBin = mkdtempSync(join(tmpdir(), "empty-bin-"));
  const savedPath = process.env.PATH ?? "";
  process.env.PATH = emptyBin;
  try {
    const result = runGate(root);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /could not resolve the effective tsconfig/);
  } finally {
    process.env.PATH = savedPath;
    rmSync(emptyBin, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});


test("runGate refuses an ignore entry whose emitted output is missing", () => {
  const root = fixtureRoot("ignore-unbuilt");
  writeFixture(root, {
    manifest: {
      coverageGate: {
        sources: ["."],
        tests: ["test/*.test.ts"],
        thresholds: { lines: 100, branches: 100, functions: 100 },
        ignore: ["type-only.ts"],
      },
    },
    extraFiles: {
      "type-only.ts": "export type Only = 1;\n",
      "tsconfig.json": '{"compilerOptions":{"outDir":"dist","rootDir":"."}}',
    },
  });
  try {
    const result = runGate(root);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /no compiled output at/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runGate refuses an ignore entry that actually emits runtime code", () => {
  const root = fixtureRoot("ignore-runtime");
  writeFixture(root, {
    manifest: {
      coverageGate: {
        sources: ["."],
        tests: ["test/*.test.ts"],
        thresholds: { lines: 100, branches: 100, functions: 100 },
        ignore: ["runtime-in-disguise.ts"],
      },
    },
    extraFiles: {
      "runtime-in-disguise.ts": "export const sneaky = 1;\n",
      "tsconfig.json": '{"compilerOptions":{"outDir":"dist","rootDir":"."}}',
      [join("dist", "runtime-in-disguise.js")]: "export const sneaky = 1;\n",
    },
  });
  try {
    const result = runGate(root);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /emits runtime code/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runGate honors a genuinely type-only ignore entry", () => {
  const root = fixtureRoot("ignore-type-only");
  writeFixture(root, {
    manifest: {
      coverageGate: {
        sources: ["."],
        tests: ["test/*.test.ts"],
        thresholds: { lines: 100, branches: 100, functions: 100 },
        ignore: ["type-only.ts"],
      },
    },
    extraFiles: {
      "type-only.ts":
        "/** A type-only module. */\nexport type Only = 1;\nexport {};\n",
      "tsconfig.json": '{"compilerOptions":{"outDir":"dist","rootDir":"."}}',
      [join("dist", "type-only.js")]:
        "/** Compiled from a type-only module: comments plus the empty export are all tsc emits. */\nexport {};\n",
    },
  });
  try {
    const result = runGate(root);
    assert.equal(result.exitCode, 0, result.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("collectReportedFiles parses SF entries relativised to the root; unreadable reports yield undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "lcov-parse-"));
  try {
    const lcov = join(dir, "lcov.info");
    writeFileSync(lcov, "SF:index.ts\nDA:1,1\nend_of_record\nSF:" + join(dir, "nested.ts") + "\nend_of_record\n", "utf-8");
    const files = collectReportedFiles(lcov, dir);
    assert.ok(files);
    assert.deepEqual([...files].sort(), ["index.ts", "nested.ts"]);
    assert.equal(collectReportedFiles(join(dir, "absent.info"), dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the coverage-gate main entry writes streams, appends newlines, and sets the exit code", () => {
  const chunks: Array<{ stream: "out" | "err"; text: string }> = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const savedExit = process.exitCode;
  (process.stdout.write as unknown as (c: string) => boolean) = ((c: string) => {
    void origOut;
    chunks.push({ stream: "out", text: c });
    return true;
  }) as typeof process.stdout.write;
  (process.stderr.write as unknown as (c: string) => boolean) = ((c: string) => {
    chunks.push({ stream: "err", text: c });
    return true;
  }) as typeof process.stderr.write;
  try {
    const root = fixtureRoot("main-fail");
    writeFixture(root, { manifest: {} });
    try {
      coverageGateMain(root);
      assert.equal(process.exitCode, 1);
      assert.ok(chunks.some((c) => c.stream === "err" && c.text.endsWith("\n")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exitCode = savedExit;
  }
});

test("isMainInvocation matches only the exact canonicalised script path", () => {
  const gateUrl = import.meta.resolve("../scripts/coverage-gate.ts");
  const gate = fileURLToPath(gateUrl);
  assert.equal(isMainInvocation(["node", fileURLToPath(import.meta.url)], gateUrl), false,
    "this test file is not the coverage gate itself");
  assert.equal(isMainInvocation(["node"], gateUrl), false);
  assert.equal(isMainInvocation(["node", gate], gateUrl), true,
    "the gate invoked as its own entry point is the main invocation");
  assert.equal(isMainInvocation(["node", join(REPO_ROOT, "package.json")], gateUrl), false);
});

// --- prepare-merge-driver --------------------------------------------------

function makeExecutable(path: string): void {
  writeFileSync(path, "#!/bin/sh\nexit 0\n", "utf-8");
  chmodSync(path, 0o755);
}

test("isExecutableFile accepts regular executables and rejects directories, missing paths and plain files", (t) => {
  if (process.platform === "win32") t.skip("POSIX mode-bit semantics");
  const dir = mkdtempSync(join(tmpdir(), "pmmerge-"));
  try {
    const exe = join(dir, "pm");
    makeExecutable(exe);
    assert.equal(isExecutableFile(exe), true);
    assert.equal(isExecutableFile(dir), false, "a directory named pm is not a command");
    assert.equal(isExecutableFile(join(dir, "absent")), false);
    const plain = join(dir, "plain");
    writeFileSync(plain, "", "utf-8");
    assert.equal(isExecutableFile(plain), false, "non-executable files do not resolve like commands");
    assert.equal(isExecutableFile(exe, "win32"), true, "Windows keys executability off PATHEXT instead");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pmOnPath resolves pm across POSIX and Windows PATH spellings", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pmonpath-"));
  try {
    makeExecutable(join(dir, "pm"));
    assert.equal(pmOnPath({ pathEnv: dir, platform: "linux" }), true);
    assert.equal(pmOnPath({ pathEnv: "", platform: "linux" }), false);
    // An empty POSIX entry means the current directory.
    const savedCwd = process.cwd();
    process.chdir(dir);
    try {
      assert.equal(pmOnPath({ pathEnv: ":", platform: "linux" }), true);
    } finally {
      process.chdir(savedCwd);
    }
    // Windows: quoted entries, PATHEXT suffixes, no mode bit required.
    const winDir = mkdtempSync(join(tmpdir(), "pmonpath-win-"));
    // Exact case matters: a Linux host resolves PATH candidates case-sensitively,
    // so the fixture spells the file the way PATHEXT will probe it.
    writeFileSync(join(winDir, "pm.CMD"), "@echo off\n", "utf-8");
    assert.equal(
      pmOnPath({ pathEnv: `"${winDir}"`, pathExt: ".CMD;.EXE", platform: "win32" }),
      true,
    );
    assert.equal(pmOnPath({ pathEnv: winDir, pathExt: ".EXE", platform: "win32" }), false);
    assert.equal(
      pmOnPath({ pathEnv: `"${winDir}"`, pathExt: ".CMD;.EXE", platform: "win32" }),
      true,
    );
    assert.equal(pmOnPath({ pathEnv: "", pathExt: undefined, platform: "win32" }), false);
    rmSync(winDir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPrepare skips silently without pm and wires drivers through the injected executor with it", () => {
  const savedPath = process.env.PATH ?? "";
  const emptyDir = mkdtempSync(join(tmpdir(), "pmmerge-none-"));
  process.env.PATH = emptyDir; // no pm anywhere
  try {
    const skipped = runPrepare({ exec: () => assert.fail("must not execute without pm on PATH") });
    assert.equal(skipped.exitCode, 0);
    assert.equal(skipped.wired, false);
  } finally {
    process.env.PATH = savedPath;
    rmSync(emptyDir, { recursive: true, force: true });
  }
  let executed = "";
  const wired = runPrepare({ exec: (command) => { executed = command; } });
  assert.equal(wired.wired, true);
  assert.equal(executed, "pm merge install");
});

test("runPrepare's default executor shells out to a pm binary found on PATH", () => {
  // A disposable git repo + a stub pm on PATH prove the default exec branch
  // runs the real command without touching this repository's own git config.
  const workDir = mkdtempSync(join(tmpdir(), "pmmerge-default-"));
  execFileSync("git", ["init", "-q", join(workDir, "repo")]);
  const bin = join(workDir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "pm"), "#!/bin/sh\necho \"wired: $@\"\n", "utf-8");
  chmodSync(join(bin, "pm"), 0o755);
  const savedPath = process.env.PATH ?? "";
  const savedCwd = process.cwd();
  process.env.PATH = `${bin}:${savedPath}`;
  process.chdir(join(workDir, "repo"));
  try {
    const result = runPrepare(); // default exec: execSync("pm merge install")
    assert.equal(result.wired, true);
  } finally {
    process.chdir(savedCwd);
    process.env.PATH = savedPath;
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("pmOnPath falls back to the live environment when no explicit PATH is injected", () => {
  const dir = mkdtempSync(join(tmpdir(), "pmonpath-env-"));
  try {
    makeExecutable(join(dir, "pm"));
    const saved = process.env.PATH ?? "";
    process.env.PATH = dir;
    try {
      assert.equal(pmOnPath(), true, "the default reads the live PATH");
    } finally {
      process.env.PATH = saved;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pmOnPath treats a missing PATH variable as no candidates", () => {
  const saved = process.env.PATH;
  delete process.env.PATH;
  try {
    assert.equal(pmOnPath(), false);
  } finally {
    process.env.PATH = saved;
  }
});

test("prepare-merge-driver isMainInvocation mirrors the sibling gate contract", () => {
  const prepUrl = import.meta.resolve("../scripts/prepare-merge-driver.ts");
  assert.equal(isPrepareMain(["node"], prepUrl), false);
  assert.equal(isPrepareMain(["node", fileURLToPath(prepUrl)], prepUrl), true);
  assert.equal(isPrepareMain(["node", fileURLToPath(import.meta.url)], prepUrl), false);
});

test("runGate accepts a single .ts FILE as a source entry", () => {
  const root = fixtureRoot("file-source");
  writeFixture(root, {
    manifest: {
      coverageGate: { sources: ["./covered.ts"], tests: ["test/*.test.ts"], thresholds: { lines: 100, branches: 100, functions: 100 } },
    },
  });
  try {
    const result = runGate(root);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /coverage-gate: 1 source file\(s\) reported/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runGate refuses an exemption when the compiler answer cannot be parsed", () => {
  const root = fixtureRoot("garbage-tsc");
  writeFixture(root, {
    manifest: {
      coverageGate: {
        sources: ["."],
        tests: ["test/*.test.ts"],
        thresholds: { lines: 100, branches: 100, functions: 100 },
        ignore: ["type-only.ts"],
      },
    },
    extraFiles: { "type-only.ts": "export type Only = 1;\n" },
  });
  // A PATH whose only `npx` answers exit 0 with non-JSON output is exactly the
  // "compiler spoke but said nothing usable" case the parse guard exists for.
  const fakeBin = mkdtempSync(join(tmpdir(), "fake-npx-"));
  writeFileSync(join(fakeBin, "npx"), "#!/bin/sh\necho 'not json'\n", "utf-8");
  chmodSync(join(fakeBin, "npx"), 0o755);
  const savedPath = process.env.PATH ?? "";
  process.env.PATH = `${fakeBin}:${savedPath}`;
  try {
    const result = runGate(root);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /could not resolve the effective tsconfig/);
  } finally {
    process.env.PATH = savedPath;
    rmSync(fakeBin, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveEmitPaths falls back to the default emit layout when the config omits paths", () => {
  // A fake npx answers with a VALID config that simply omits outDir/rootDir —
  // exercising the default fallback arms inside resolveEmitPaths itself.
  const root = fixtureRoot("defaults-tsc");
  writeFixture(root, {
    manifest: {
      coverageGate: {
        sources: ["."],
        tests: ["test/*.test.ts"],
        thresholds: { lines: 100, branches: 100, functions: 100 },
        ignore: ["type-only.ts"],
      },
    },
    extraFiles: { "type-only.ts": "export type Only = 1;\n" },
  });
  const fakeBin = mkdtempSync(join(tmpdir(), "empty-config-npx-"));
  writeFileSync(join(fakeBin, "npx"), '#!/bin/sh\necho \'{"compilerOptions":{}}\'\n', "utf-8");
  chmodSync(join(fakeBin, "npx"), 0o755);
  const savedPath = process.env.PATH ?? "";
  process.env.PATH = `${fakeBin}:${savedPath}`;
  try {
    const result = runGate(root);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /no compiled output at dist.type-only\.js/);
  } finally {
    process.env.PATH = savedPath;
    rmSync(fakeBin, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("the shipped gate script refuses to run as main without a root argument", () => {
  const run = spawnFileSync(process.execPath, [join(REPO_ROOT, "scripts", "coverage-gate.ts")], { cwd: REPO_ROOT });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /pass the repository root to measure/);
});

test("the shipped gate script measures a fixture root end-to-end when run as main", () => {
  const root = fixtureRoot("as-main");
  writeFixture(root);
  try {
    // Executing the REAL shipped script with an explicit root argument exercises
    // its actual main-invocation wiring against a fast fixture instead of
    // recursing into this package's full suite.
    const run = spawnFileSync(
      process.execPath,
      [join(REPO_ROOT, "scripts", "coverage-gate.ts"), root],
      { cwd: REPO_ROOT },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /coverage-gate: 1 source file\(s\) reported, thresholds met\./);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a green runner that wrote no lcov report is refused, not read as zero files", () => {
  const root = fixtureRoot("no-lcov");
  writeFixture(root);
  try {
    const result = evaluateRun(
      root,
      join(root, "coverage", "lcov.info"),
      ["covered.ts"],
      { status: 0, stdout: "all green\n", stderr: "" },
    );
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /no coverage report was written/);
    assert.equal(result.stdout, "all green\n", "the child's output still passes through");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("evaluateRun propagates a failed runner before reading any report", () => {
  const root = fixtureRoot("runner-fail");
  writeFixture(root);
  try {
    const boom = new Error("spawn ENOBUFS");
    const failed = evaluateRun(root, join(root, "coverage", "lcov.info"), ["covered.ts"], {
      status: null,
      error: boom,
      stdout: "",
      stderr: "",
    });
    assert.equal(failed.exitCode, 1);
    assert.match(failed.stderr, /ENOBUFS/);

    const nonzero = evaluateRun(root, join(root, "coverage", "lcov.info"), ["covered.ts"], {
      status: 3,
      stdout: "",
      stderr: "suite exploded\n",
    });
    assert.equal(nonzero.exitCode, 3);
    assert.match(nonzero.stderr, /suite exploded/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a spawn error paired with exit status 0 still fails the gate closed", () => {
  const root = fixtureRoot("spawn-error-zero-status");
  writeFixture(root);
  try {
    // Some platforms report both a spawn error and a zero child status. The
    // gate must never translate that combination into a pass: nothing was
    // measured, so exit code 0 would be the silent-pass outcome this module
    // documents as forbidden.
    const result = evaluateRun(root, join(root, "coverage", "lcov.info"), ["covered.ts"], {
      status: 0,
      error: new Error("spawn node ENOMEM"),
      stdout: "",
      stderr: "",
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr, /ENOMEM/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function spawnFileSync(command: string, args: readonly string[], opts: { cwd: string }): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(command, [...args], { ...opts, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

test("the docstring gate executable scans the real repository when run as main", () => {
  const run = spawnFileSync(process.execPath, [join(REPO_ROOT, "scripts", "docstring-gate.ts")], { cwd: REPO_ROOT });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /docstring-gate: \d+ file\(s\), \d+ declaration\(s\) documented\./);
});

test("the merge-driver preparer executable wires drivers when run as main with pm present", () => {
  const workDir = mkdtempSync(join(tmpdir(), "pmmerge-main-"));
  execFileSync("git", ["init", "-q", join(workDir, "repo")]);
  const bin = join(workDir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "pm"), "#!/bin/sh\nexit 0\n", "utf-8");
  chmodSync(join(bin, "pm"), 0o755);
  const savedPath = process.env.PATH ?? "";
  process.env.PATH = `${bin}:${savedPath}`;
  try {
    const run = spawnFileSync(
      process.execPath,
      [join(REPO_ROOT, "scripts", "prepare-merge-driver.ts")],
      { cwd: join(workDir, "repo") },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /wired pm merge drivers/);
  } finally {
    process.env.PATH = savedPath;
    rmSync(workDir, { recursive: true, force: true });
  }
});
