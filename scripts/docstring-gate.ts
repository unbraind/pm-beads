#!/usr/bin/env node
/**
 * Enforce meaningful docstrings across pm-beads source declarations.
 *
 * The analyzer comes from pm-ops so the fleet shares one lexer-backed policy:
 * every exported declaration, every public member of an exported class, and
 * every substantial private function needs JSDoc that contributes information
 * beyond its identifier. The analyzer has no ignore list and treats unknown
 * declaration forms as violations, so a new syntax form fails closed.
 *
 * The main-invocation guard is shared with the other executable scripts in
 * `scripts/main-invocation.ts` (one measured implementation, re-exported here
 * for API compatibility); the result contract lives here.
 */

import { join } from "node:path";

import { analyzeDocstringCoverage } from "pm-ops/docstrings";
import { isMainInvocation } from "./main-invocation.ts";

export { isMainInvocation };

const repoRoot = join(import.meta.dirname, "..");

/**
 * Outcome of one gate run, held as plain strings so a test can inspect it.
 *
 * The exit code and the newline-free stdout/stderr content are captured here
 * rather than written directly, so a test can assert on them without touching
 * the process streams. The strings are deliberately not the exact bytes the CLI
 * emits: {@link main} appends the trailing newline as it writes each non-empty
 * stream, so an assertion here can compare whole strings without a trailing
 * newline getting in the way.
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
 * Run the docstring gate against a repository root and return what it would write.
 *
 * Pure by design: it touches neither the process streams nor `process.exit`, so
 * a test imports this and asserts on the returned strings, while the thin
 * {@link main} entry point writes them and sets the exit code.
 *
 * @param root - Absolute repository root to scan.
 * @returns The exit code and the newline-free stdout/stderr content; {@link main}
 *          appends the trailing newline when it writes them.
 */
export function runGate(root: string): GateResult {
  const report = analyzeDocstringCoverage({ root });
  if (report.violations.length > 0) {
    let message = `docstring-gate: ${report.violations.length} violation(s) across ${report.files_scanned} file(s):\n`;
    for (const violation of report.violations) {
      message += `${violation.file}:${violation.line} ${violation.symbol}: ${violation.reason}\n`;
    }
    return { exitCode: 1, stdout: "", stderr: message.trimEnd() };
  }
  return {
    exitCode: 0,
    stdout: `docstring-gate: ${report.files_scanned} file(s), ${report.declarations_checked} declaration(s) documented.`,
    stderr: "",
  };
}

/**
 * CLI entry point: run the gate and emit its result.
 *
 * Writes the exact stdout/stderr bytes {@link runGate} produced and appends a
 * trailing newline to each non-empty stream so the next `release:check` step
 * starts on its own line rather than butting against this gate's output.
 * {@link runGate}'s returned strings stay newline-free so a test can assert on
 * them exactly. Sets `process.exitCode` rather than calling `process.exit`, so
 * a test can invoke this in-process, observe the streams, and restore the exit
 * code.
 *
 * @param root - Absolute repository root to scan.
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
  main(repoRoot);
}
