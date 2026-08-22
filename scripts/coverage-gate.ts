/**
 * Coverage gate for the package test suite.
 *
 * Runs `node --test` with the runtime's built-in V8 coverage against the
 * TypeScript sources directly (Node executes `.ts` natively, so the reported
 * line numbers are the ones an author edits, not compiled output), enforces a
 * per-dimension threshold, and reconciles the reported file list against the
 * files actually on disk.
 *
 * That last step is the reason this script exists rather than a bare
 * `node --test --test-coverage-lines=...` invocation. Node only reports files
 * that were loaded during the run: a source module with no test at all is
 * omitted from the report entirely rather than reported at zero. The published
 * percentage is therefore computed over the tested subset, and a package can
 * satisfy a 100% threshold while an entire module goes unexercised. Comparing
 * the report against a directory walk turns that silent omission into a failure
 * naming the missing files, so the threshold cannot be passed by narrowing what
 * the suite touches.
 *
 * Configuration lives in `package.json` under `coverageGate` so the numbers the
 * gate enforces are visible in the same file that declares the scripts, and a
 * threshold change shows up in review as a deliberate diff.
 *
 * Like the sibling docstring gate, the logic lives in the pure {@link runGate}
 * (it touches neither the process streams nor `process.exit`, so a test imports
 * it against a fixture repository and asserts on the returned outcome), while
 * the thin {@link main} entry point writes the streams and sets the exit code.
 * The gate is measured by its own suite: `coverageGate.sources` includes
 * `scripts/`, so this file must itself be exercised to 100% — the fixture-based
 * {@link runGate} tests are that exercise.
 *
 * @example
 * ```bash
 * node scripts/coverage-gate.ts
 * ```
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { isMainInvocation } from "./main-invocation.ts";

export { isMainInvocation };

/**
 * Minimum acceptable percentage for each coverage dimension Node reports.
 *
 * Statement coverage is not listed because V8 reports statements as lines; the
 * line figure IS the statement figure for this runtime, so a `lines` threshold
 * of 100 is simultaneously the statements and lines requirement the release
 * contract demands.
 */
interface CoverageThresholds {
  /** Minimum percentage of executable lines (V8 statements) that must be covered. */
  readonly lines: number;
  /** Minimum percentage of branch arms that must be taken. */
  readonly branches: number;
  /** Minimum percentage of declared functions that must be invoked. */
  readonly functions: number;
}

/** The `coverageGate` block read from `package.json`. */
interface CoverageGateConfig {
  /**
   * Source locations the gate requires to appear in the report. Each entry is
   * either a directory, walked recursively for `.ts` files, or a single file.
   *
   * Prefer a directory — including `"."` for a package whose entrypoint sits at
   * the repository root. A directory is enumerated at run time, so a source file
   * added later is required automatically. An explicit file list freezes the
   * required set at the moment it was written, and a new untested module simply
   * never enters it, which is the same blind spot this gate exists to close.
   */
  readonly sources: readonly string[];
  /**
   * Directory names skipped while walking, on top of {@link DEFAULT_SKIP_DIRS}.
   * Needed only for a source tree with a non-standard non-source directory.
   */
  readonly skipDirs?: readonly string[];
  /** Test file arguments handed to `node --test`. */
  readonly tests: readonly string[];
  /** Threshold enforced on the aggregate report. */
  readonly thresholds: CoverageThresholds;
  /**
   * Source files exempt from the presence check, each of which must be
   * type-only. A module that erases to nothing emits no coverage counters, so
   * requiring it in the report would make the gate unsatisfiable.
   */
  readonly ignore?: readonly string[];
}

/** Shape of the `package.json` fields this script reads. */
interface PackageManifest {
  /** The `coverageGate` block, when the manifest declares one. */
  readonly coverageGate?: CoverageGateConfig;
}

/** Compiler paths used to locate a source file's emitted output. */
interface TsConfig {
  /** The compiler's effective output directory (`dist` when unset). */
  readonly compilerOptions?: { readonly outDir?: string; readonly rootDir?: string };
}

/**
 * Outcome of one gate run, held as plain strings so a test can inspect it.
 *
 * The exit code and the newline-trimmed stdout/stderr content are captured here
 * rather than written directly, mirroring the docstring gate's result contract:
 * {@link main} appends the trailing newline as it writes each non-empty stream,
 * so an assertion can compare whole strings without a trailing newline getting
 * in the way. The child test runner's output is captured (not streamed) so it
 * can be passed through in the outcome; `main` preserves the original ordering
 * well enough for a release log while keeping {@link runGate} pure.
 */
export interface GateResult {
  /** Process exit code the run would produce (0 on success; non-zero on failure). */
  readonly exitCode: number;
  /** Content the run would write to stdout, without a trailing newline. */
  readonly stdout: string;
  /** Content the run would write to stderr, without a trailing newline. */
  readonly stderr: string;
}

/**
 * Resolves the compiler's effective output paths.
 *
 * Asks `tsc --showConfig` rather than parsing `tsconfig.json` directly: the file
 * may be JSONC and may inherit `outDir`/`rootDir` through an `extends` chain, so
 * a raw `JSON.parse` can either throw on a valid config or silently read the
 * wrong paths.
 *
 * Returns `undefined` when the compiler cannot be reached. This feeds the check
 * that decides whether an exempted module is genuinely type-only, and guessing
 * the emit layout there could clear an executable module by looking at the wrong
 * file — the one outcome this gate must never produce. A package that cannot run
 * its own compiler has a problem worth stopping for.
 *
 * @param repoRoot - Absolute repository root whose `tsconfig.json` is resolved.
 * @returns The effective `outDir`/`rootDir`, or `undefined` when the compiler
 *          cannot be consulted.
 */
function resolveEmitPaths(repoRoot: string): { outDir: string; rootDir: string } | undefined {
  const shown = spawnSync("npx", ["--no-install", "tsc", "--showConfig", "-p", "tsconfig.json"], {
    cwd: repoRoot,
    encoding: "utf8",
    // `--no-install` disables npx's implicit registry fetch: a repository
    // without a local `typescript` install now fails the probe (the fail-closed
    // outcome this function documents) instead of blocking on a network
    // download. The timeout bounds a hung compiler so the gate cannot stall a
    // release check indefinitely.
    timeout: 60_000,
    shell: process.platform === "win32",
  });
  if (shown.status !== 0 || !shown.stdout) return undefined;
  try {
    const parsed = JSON.parse(shown.stdout) as TsConfig;
    return {
      outDir: parsed.compilerOptions?.outDir ?? "dist",
      rootDir: parsed.compilerOptions?.rootDir ?? ".",
    };
  } catch {
    return undefined;
  }
}

/**
 * Directories never treated as source, so that `sources: ["."]` works for a
 * package whose entrypoint sits at the repository root.
 *
 * These hold tests, build output, tooling and installed dependencies. None of
 * them contain shipped source, and several would otherwise make the required
 * set unsatisfiable — a test file cannot appear in its own coverage report.
 * Executable gate tooling that IS shipped source lives in `scripts/` and is
 * measured by listing `scripts` as an explicit `coverageGate.sources` entry,
 * which bypasses the skip list for that entry only.
 */
const DEFAULT_SKIP_DIRS: readonly string[] = [
  "node_modules",
  "dist",
  "dist-test",
  "coverage",
  "test",
  "tests",
  "scripts",
  "public",
  ".agents",
  ".git",
  ".github",
];

/**
 * Collects every TypeScript source file at a configured location.
 *
 * A file entry resolves to itself; a directory entry is walked recursively with
 * the skip list (the {@link DEFAULT_SKIP_DIRS} union of the config's) pruned.
 * Declaration files are skipped either way: they carry no runtime code and so
 * can never appear in a coverage report.
 *
 * @param target - Absolute path to a source file or directory.
 * @param repoRoot - Repository root the returned paths are relative to.
 * @param skipDirs - Directory names pruned during the walk.
 * @returns A failure message when the target is unusable (checked by the
 *          caller), else repository-relative POSIX paths in directory order.
 */
function collectSources(target: string, repoRoot: string, skipDirs: Set<string>): string[] | string {
  if (!existsSync(target)) {
    return `coverage-gate: \`coverageGate.sources\` names ${relative(repoRoot, target)}, which does not exist.`;
  }
  if (!statSync(target).isDirectory()) {
    if (!target.endsWith(".ts") || target.endsWith(".d.ts")) {
      return `coverage-gate: \`coverageGate.sources\` names ${relative(repoRoot, target)}, which is not a TypeScript source file. A declaration file or non-TypeScript entry can never appear in a coverage report, so requiring it would make the gate unsatisfiable.`;
    }
    return [relative(repoRoot, target).split(sep).join("/")];
  }
  // Nested targets are recursed without re-checking existence: they were listed
  // from a live readdir moments earlier, so a miss would mean a concurrent
  // mutation, which readdirSync/statSync then surface as a loud throw — the
  // fail-closed outcome — rather than a silently pruned subtree.
  return walkDirectory(target, repoRoot, skipDirs);
}

/**
 * Recurse a known directory for `.ts` source files.
 *
 * @param dir - Absolute directory already verified to exist.
 * @param repoRoot - Repository root the returned paths are relative to.
 * @param skipDirs - Directory names pruned during the walk.
 * @returns Repository-relative POSIX paths in directory order.
 */
function walkDirectory(dir: string, repoRoot: string, skipDirs: Set<string>): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) {
        found.push(...walkDirectory(join(dir, entry.name), repoRoot, skipDirs));
      }
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      found.push(relative(repoRoot, join(dir, entry.name)).split(sep).join("/"));
    }
  }
  return found;
}

/**
 * Rejects an `ignore` entry that still carries runtime code, or whose emit
 * layout cannot be verified.
 *
 * The exemption exists for type-only modules, which erase to nothing and so can
 * never appear in a coverage report. Left untested, it is also the one way to
 * remove an executable module from both the measured set and the required set —
 * exactly the escape this gate exists to prevent. TypeScript emits `export {};`
 * and nothing else for a module that erases completely, so the compiled output
 * settles the question rather than the author's say-so.
 *
 * @param file - Repository-relative source file listed in `coverageGate.ignore`.
 * @param expected - The full walked source inventory (the entry must be under it).
 * @param emitPaths - Effective compiler paths, or `undefined` when the compiler
 *                    could not be consulted.
 * @param repoRoot - Absolute repository root paths resolve against.
 * @returns A failure message when the entry is not provably type-only, else
 *          `undefined`.
 */
function verifyIgnoredFile(
  file: string,
  expected: readonly string[],
  emitPaths: { outDir: string; rootDir: string } | undefined,
  repoRoot: string,
): string | undefined {
  if (!expected.includes(file)) {
    return `coverage-gate: \`coverageGate.ignore\` names ${file}, which is not under \`sources\`.`;
  }
  if (!emitPaths) {
    return [
      "coverage-gate: could not resolve the effective tsconfig via `tsc --showConfig`,",
      "so the emit layout is unknown and `coverageGate.ignore` entries cannot be verified",
      "as type-only. Refusing to guess.",
    ].join("\n");
  }
  const emitted = join(
    repoRoot,
    emitPaths.outDir,
    relative(join(repoRoot, emitPaths.rootDir), join(repoRoot, file)),
  ).replace(/\.ts$/, ".js");
  if (!existsSync(emitted)) {
    return `coverage-gate: cannot verify that ignored file ${file} is type-only — no compiled output at ${relative(repoRoot, emitted)}. Build before running the gate, or correct \`outDir\`/\`rootDir\`.`;
  }
  // Block comments are stripped as well as line comments: tsc carries a
  // file-leading JSDoc into the emit, so a documented type-only module would
  // otherwise read as runtime code and be rejected for having a comment.
  const body = readFileSync(emitted, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/export\s*\{\s*\}\s*;?/g, "")
    .trim();
  if (body.length > 0) {
    return `coverage-gate: \`coverageGate.ignore\` names ${file}, but it emits runtime code to ${relative(repoRoot, emitted)}. Only type-only modules may be exempt; anything executable must be covered.`;
  }
  return undefined;
}

/**
 * Run the coverage gate against a repository root and return what it would write.
 *
 * Pure by design: it touches neither the process streams nor `process.exit`, so
 * a test imports this and asserts on the returned outcome, while the thin
 * {@link main} entry point writes them and sets the exit code. The child test
 * runner inherits the caller's stdout/stderr only through the returned strings
 * (captured, then passed through by {@link main}).
 *
 * @param repoRoot - Absolute repository root whose `package.json` declares the
 *                   `coverageGate` block and whose sources/tests are measured.
 * @returns The exit code and the newline-free stdout/stderr content.
 */
export function runGate(repoRoot: string): GateResult {
  let manifest: PackageManifest;
  try {
    manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as PackageManifest;
  } catch (err: unknown) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `coverage-gate: could not read package.json in ${repoRoot}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const config = manifest.coverageGate;
  if (!config) {
    return { exitCode: 1, stdout: "", stderr: "coverage-gate: package.json has no `coverageGate` block." };
  }

  const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...(config.skipDirs ?? [])]);
  const expected: string[] = [];
  for (const source of config.sources) {
    const collected = collectSources(join(repoRoot, source), repoRoot, skipDirs);
    if (typeof collected === "string") return { exitCode: 1, stdout: "", stderr: collected };
    expected.push(...collected);
  }
  const exempt = new Set(config.ignore ?? []);
  const required = expected.filter((file) => !exempt.has(file));

  // Resolved once for the whole ignore list, not once per entry: every entry
  // needs the same effective tsconfig, and each probe spawns the compiler, so
  // probing per iteration made gate time grow linearly with the exemption
  // count for no benefit. The length guard lives here (outside the loop) so an
  // ignore-free config never pays for the probe at all.
  const ignore = config.ignore ?? [];
  const emitPaths = ignore.length > 0 ? resolveEmitPaths(repoRoot) : undefined;
  for (const file of ignore) {
    const problem = verifyIgnoredFile(file, expected, emitPaths, repoRoot);
    if (problem) return { exitCode: 1, stdout: "", stderr: problem };
  }

  if (required.length === 0) {
    return { exitCode: 1, stdout: "", stderr: "coverage-gate: source walk found no files; check `coverageGate.sources`." };
  }

  const lcovPath = join(repoRoot, "coverage", "lcov.info");
  mkdirSync(join(repoRoot, "coverage"), { recursive: true });
  // Delete any previous report first. If this run writes none, a leftover file
  // from an earlier, broader run would satisfy the presence check on stale data —
  // the gate would pass by reading history rather than by measuring anything.
  rmSync(lcovPath, { force: true });

  const result = spawnSync(
    process.execPath,
    [
      "--test",
      "--experimental-test-coverage",
      // Scope the report to exactly the files the presence check requires. Passing
      // the enumerated paths rather than a directory glob keeps the two in step by
      // construction, and keeps test files and tooling out of the percentages even
      // when the source root is the repository root.
      ...required.map((file) => `--test-coverage-include=${file}`),
      `--test-coverage-lines=${config.thresholds.lines}`,
      `--test-coverage-branches=${config.thresholds.branches}`,
      `--test-coverage-functions=${config.thresholds.functions}`,
      "--test-reporter=spec",
      "--test-reporter-destination=stdout",
      "--test-reporter=lcov",
      `--test-reporter-destination=${lcovPath}`,
      ...config.tests,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      // The runner's spec output is captured, not streamed, so it must fit the
      // spawn buffer: the 1 MiB default has been seen to overflow (ENOBUFS) on
      // large suites, which would surface as a spawn error instead of a result.
      // The timeout bounds a hung test process so a release check cannot block
      // forever; a timed-out run is a spawn failure and fails closed (see
      // {@link evaluateRun}).
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15 * 60_000,
      // Pin the timezone so the measurement is reproducible on any machine.
      // Code that branches on a timestamp's UTC offset takes different paths under
      // a local offset than under UTC, which moves the reported percentage between
      // a contributor's machine and CI. A threshold pinned to one machine's number
      // then fails on the other for reasons unrelated to the change under review.
      //
      // The runner-context variables are stripped deliberately: when this gate
      // itself runs inside a test-runner process (its own suite measures it),
      // NODE_TEST_CONTEXT marks this child as a nested runner and silently
      // changes which reporters it starts — the lcov report this gate reads back
      // is then never written. The measured child must always run standalone.
      env: Object.fromEntries(
        Object.entries({ ...process.env, TZ: "UTC" }).filter(
          ([key]) => key !== "NODE_TEST_CONTEXT" && key !== "NODE_V8_COVERAGE",
        ),
      ),
    },
  );

  return evaluateRun(repoRoot, lcovPath, required, {
    status: result.status,
    error: result.error ?? undefined,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

/**
 * What the spawned test-runner child reported back.
 *
 * Mirrors the subset of `spawnSync`'s result the gate reasons about, held as a
 * plain object so {@link evaluateRun} can be driven directly by tests for the
 * outcomes a real child rarely produces (a green run that wrote no report).
 */
export interface RunnerOutcome {
  /** Child exit status; `null` when the child could not start or was killed. */
  readonly status: number | null;
  /** Spawn error (ENOENT, ENOBUFS and friends), when one occurred. */
  readonly error?: Error;
  /** Decoded child stdout. */
  readonly stdout: string;
  /** Decoded child stderr. */
  readonly stderr: string;
}

/**
 * Reconcile a finished runner outcome against the lcov report it should have
 * written and the source inventory the walk required.
 *
 * The order of the checks is the diagnostic order: a failed or unstarted runner
 * is surfaced before the report is read (its absence would otherwise be
 * misdescribed as a configuration problem), then a missing report is refused,
 * then files the run never loaded are named, and only a fully accounted run
 * passes.
 *
 * @param repoRoot - Absolute repository root paths resolve against.
 * @param lcovPath - Absolute path the child was told to write its lcov report to.
 * @param required - Repository-relative source files the presence check requires.
 * @param runner - What the spawned child reported.
 * @returns The gate outcome for this run.
 */
export function evaluateRun(
  repoRoot: string,
  lcovPath: string,
  required: readonly string[],
  runner: RunnerOutcome,
): GateResult {
  // Surface a runner failure before touching the report at all. A runner that
  // could not start, a failing suite, an unmet threshold, or a test file that
  // will not load can each leave the lcov output absent or incomplete, and every
  // diagnostic below would then describe a coverage-configuration problem the
  // author does not have — burying the failure they need to act on. A spawn
  // error surfaces its own message because status alone is null and stderr empty.
  //
  // The exit code is forced non-zero whenever a spawn error is present even if
  // the child reported status 0: a gate that could exit 0 without measuring is
  // exactly the silent-pass outcome this module forbids, and some platforms
  // have been observed to report both an error object and a zero status.
  if (runner.error || runner.status !== 0) {
    return {
      exitCode: runner.error ? runner.status || 1 : runner.status ?? 1,
      stdout: runner.stdout,
      stderr: runner.stderr || runner.error?.message || "",
    };
  }

  // Source files the run actually reported on, read back from the lcov output
  // (see {@link collectReportedFiles} for the normalisation rules).
  const reported = collectReportedFiles(lcovPath, repoRoot);
  if (reported === undefined) {
    return {
      exitCode: 1,
      stdout: runner.stdout,
      stderr: `coverage-gate: no coverage report was written to ${relative(repoRoot, lcovPath)}.`,
    };
  }

  const missing = required.filter((file) => !reported.has(file));

  if (missing.length > 0) {
    return {
      exitCode: 1,
      stdout: runner.stdout,
      stderr: [
        "",
        `coverage-gate: ${missing.length} source file(s) never loaded during the run and were`,
        "omitted from the coverage report, so the reported percentages exclude them entirely:",
        ...missing.map((file) => `  - ${file}`),
        "",
        "Import each file from a test (or exercise it through the CLI entrypoint under test).",
        "A file that is genuinely type-only belongs in `coverageGate.ignore` in package.json.",
        "",
      ].join("\n"),
    };
  }

  return {
    exitCode: 0,
    stdout: `${runner.stdout}\ncoverage-gate: ${required.length} source file(s) reported, thresholds met.`,
    stderr: runner.stderr,
  };
}

/**
 * Source files the run actually reported on, read back from the lcov output.
 *
 * `SF:` paths are normalised to repository-relative POSIX form so they can be
 * compared against the walk. The lcov reporter emits them relative to the
 * working directory on Linux, but that is not contractual and Windows runners
 * have been seen to emit absolute paths; without normalising, the presence
 * check would invert into a permanently red build that blames every source file
 * for never loading.
 *
 * Returns `undefined` when the report cannot be read at all (absent, deleted,
 * unreadable) so the caller can distinguish "ran and wrote nothing measurable"
 * from any specific set of files.
 *
 * @param lcovPath - Absolute path of the lcov report the child was told to write.
 * @param repoRoot - Repository root the SF paths are relativised against.
 * @returns Repository-relative POSIX paths reported on, or `undefined`.
 */
export function collectReportedFiles(lcovPath: string, repoRoot: string): Set<string> | undefined {
  let text: string;
  try {
    statSync(lcovPath);
    text = readFileSync(lcovPath, "utf8");
  } catch {
    return undefined;
  }
  const reported = new Set<string>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("SF:")) continue;
    const raw = line.slice(3).trim();
    const abs = isAbsolute(raw) ? raw : join(repoRoot, raw);
    reported.add(relative(repoRoot, abs).split(sep).join("/"));
  }
  return reported;
}

/**
 * CLI entry point: run the gate and emit its result.
 *
 * Writes the exact stdout/stderr bytes {@link runGate} produced and appends a
 * trailing newline to each non-empty stream so the next `release:check` step
 * starts on its own line rather than butting against this gate's output. Sets
 * `process.exitCode` rather than calling `process.exit`, so a test can invoke
 * this in-process and restore the exit code.
 *
 * @param root - Absolute repository root to measure.
 */
export function main(root: string): void {
  const result = runGate(root);
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  process.exitCode = result.exitCode;
}

// Run the gate only as main; see scripts/main-invocation.ts for the guard's
// rationale.
if (isMainInvocation(process.argv, import.meta.url)) {
  // An optional argv[2] overrides the measured root (the sibling fleet gate's
  // contract): the measured root is REQUIRED so the script can never silently
  // measure the wrong checkout, and so its own suite can execute it as main
  // against a fast fixture instead of recursing into the package's full suite.
  const rootArg = process.argv[2];
  if (rootArg === undefined) {
    throw new Error(
      "coverage-gate: pass the repository root to measure as the first argument (the npm `coverage` script does).",
    );
  }
  main(resolve(rootArg));
}
