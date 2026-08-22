/**
 * Shared test scaffolding: the real-host extension harness and the scripted
 * `pm` workspace (see ./fixtures/stub-pm.ts for the child side).
 */

import assert from "node:assert/strict";
import { createExtensionTestHarness, type ExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import type { GlobalOptions } from "@unbrained/pm-cli/sdk";

import extension, { type ListAllEnvelope } from "../index.ts";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTypeScriptTypes } from "node:module";

export const STUB_PM = fileURLToPath(import.meta.resolve("./fixtures/stub-pm.ts"));

/** Activate pm-beads through pm's real host engine. */
export async function harness(): Promise<ExtensionTestHarness> {
  const ext = await createExtensionTestHarness(extension, {
    name: "pm-beads",
    capabilities: ["commands", "schema", "importers"],
  });
  assert.deepEqual(ext.activation.failed, [], "activation must not fail");
  return ext;
}

export interface ImportResult {
  dryRun?: boolean;
  wouldImport?: number;
  imported?: number;
  updated?: number;
  skipped?: number;
  dependencies?: number;
  parents?: number;
  timestamped?: number;
  filtered?: number;
  batches?: number;
}

/** Run the registered `beads import` handler through the real host engine. */
export async function runImport(
  ext: ExtensionTestHarness,
  opts: { args?: readonly string[]; options?: Record<string, unknown>; pmRoot?: string; global?: Partial<GlobalOptions> },
): Promise<ImportResult> {
  const { result } = await ext.runImporter({
    importer: "beads",
    ...opts,
    global: opts.global ?? ({ json: false } as Partial<GlobalOptions>),
  });
  return result as ImportResult;
}

/** Run the registered `beads export` handler through the real host engine. */
export async function runExport(
  ext: ExtensionTestHarness,
  opts: { args?: readonly string[]; options?: Record<string, unknown>; pmRoot?: string; global?: Partial<GlobalOptions> },
): Promise<unknown> {
  const { result } = await ext.runExporter({
    exporter: "beads",
    ...opts,
    global: opts.global ?? ({ json: false } as Partial<GlobalOptions>),
  });
  return result;
}

/** Run a registered command (e.g. `beads validate`, `beads diff`). */
export async function runCommand(
  ext: ExtensionTestHarness,
  opts: { command: string; args?: readonly string[]; options?: Record<string, unknown>; pmRoot?: string; global?: Partial<GlobalOptions> },
): Promise<unknown> {
  const { result } = await ext.runCommand({
    ...opts,
    global: opts.global ?? ({ json: false } as Partial<GlobalOptions>),
  });
  return result;
}

/** A complete list envelope carrying exactly these items. */
export function envelope(items: Array<Record<string, unknown>>): ListAllEnvelope {
  const env: ListAllEnvelope = {
    items,
    count: items.length,
    total: items.length,
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
  };
  return env;
}

/** JSON form of {@link envelope}, for callers that need the raw string. */
export function envelopeWith(items: Array<Record<string, unknown>>): string {
  return JSON.stringify(envelope(items));
}

export const EXISTING_MARKER_ITEM = {
  id: "pm-existing-1",
  title: "Existing",
  status: "open",
  description: "[bead_id: bd-1]",
};

/**
 * Skip reason for tests that force a failure by revoking permission bits
 * (`chmod 0o000`). A root process ignores mode bits, so the injected failure
 * never occurs and the test would fail for an environment reason rather than
 * assert anything. Such tests declare `{ skip: CHMOD_ROOT_SKIP }`; on a
 * non-root host this is `false` and the test runs.
 */
export const CHMOD_ROOT_SKIP: string | false =
  process.getuid?.() === 0
    ? "chmod 0o000 does not force a read failure for a root process (root ignores mode bits)"
    : false;

export interface StubScenario {
  dir: string;
  jsonlPath: (name: string) => string;
  logLines: () => string[][];
  restorePath: () => void;
}

/** One scripted-pm scenario: a temp dir, a scenario file, PATH wiring. */
export function stubScenario(scenario: Record<string, unknown>, files: Record<string, string> = {}): StubScenario {
  const dir = mkdtempSync(join(tmpdir(), "beads-import-"));
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), content, "utf-8");
  }
  const scenarioFile = join(dir, "stub-scenario.json");
  const logFile = join(dir, "stub-calls.jsonl");
  writeFileSync(scenarioFile, JSON.stringify(scenario), "utf-8");
  writeFileSync(logFile, "", "utf-8");
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  // The kernel hands the extensionless executable path to node, which type-strips
  // by EXTENSION — so the installed bin must be the type-stripped JavaScript, not
  // the TypeScript source (an extensionless .ts copy would fail to parse).
  const stubLink = join(binDir, "pm");
  // The stripped output keeps its leading shebang line.
  writeFileSync(stubLink, stripTypeScriptTypes(readFileSync(STUB_PM, "utf8"), { mode: "strip" }), "utf-8");
  chmodSync(stubLink, 0o755);
  const originalPath = process.env.PATH ?? "";
  // Captured so overlapping scenarios nest correctly: the inner teardown
  // restores what the outer scenario had, rather than deleting it.
  const originalScenario = process.env.PM_STUB_SCENARIO;
  const originalLog = process.env.STUB_PM_LOG;
  process.env.PATH = `${binDir}${delimiter}${originalPath}`;
  process.env.PM_STUB_SCENARIO = scenarioFile;
  process.env.STUB_PM_LOG = logFile;
  return {
    dir,
    jsonlPath: (name: string) => join(dir, name),
    logLines: () => readFileSync(logFile, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]),
    restorePath: () => {
      process.env.PATH = originalPath;
      // Restore (not delete) the two stub variables the same way PATH is
      // restored, so an outer scenario's wiring survives a nested teardown.
      if (originalScenario === undefined) delete process.env.PM_STUB_SCENARIO;
      else process.env.PM_STUB_SCENARIO = originalScenario;
      if (originalLog === undefined) delete process.env.STUB_PM_LOG;
      else process.env.STUB_PM_LOG = originalLog;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function jsonl(records: Array<Record<string, unknown>>): string {
  return records.map((r) => `${JSON.stringify(r)}\n`).join("");
}

/** Capture console.error across an ASYNC handler: restoration waits for the promise. */
export async function captureStderrAsync<T>(fn: () => Promise<T>): Promise<{ lines: string[]; result: T }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const result = await fn();
    return { lines, result };
  } finally {
    console.error = original;
  }
}
