/** Compare immutable baseline and candidate builds on read-only public tracker copies without git. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { pmItemToBead, type PmItem } from "../index.ts";

const root = resolve(import.meta.dirname, "..");
const [sourceDirectory = root, repository = "unbraind/pm-beads", baselineRef = "5563525"] = process.argv.slice(2);
const scratch = await mkdtemp(join(tmpdir(), "beads-sdk-differential-"));
/** Read exact commit and tree identities without modifying a checkout. */
const git = (directory: string, args: string[]): string => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" }).trim();
const sourceHead = git(sourceDirectory, ["rev-parse", "origin/main"]);
const trackerTree = git(sourceDirectory, ["rev-parse", `${sourceHead}:.agents/pm`]);
const baselineHead = git(root, ["rev-parse", baselineRef]);

/** Recursively fingerprint this bounded scratch tracker, including file names and bytes. */
async function digest(directory: string): Promise<string> {
  const hash = createHash("sha256");
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(entry.name);
    hash.update(entry.isDirectory() ? await digest(join(directory, entry.name)) : await readFile(join(directory, entry.name)));
  }
  return hash.digest("hex");
}

/** Set or lift read-only permissions only in the disposable validation tree. */
async function permissions(directory: string, readonly: boolean): Promise<void> {
  if (!readonly) await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await permissions(join(directory, entry.name), readonly);
    else if (!entry.isSymbolicLink()) await chmod(join(directory, entry.name), readonly ? 0o400 : 0o600);
  }
  if (readonly) await chmod(directory, 0o500);
}

try {
  assert.equal(JSON.parse(execFileSync("gh", ["api", `repos/${repository}`], { encoding: "utf8" })).private, false);
  const baseline = join(scratch, "baseline"); await mkdir(baseline);
  execFileSync("tar", ["-x", "-C", baseline], { input: execFileSync("git", ["-C", root, "archive", baselineHead], { maxBuffer: 64 * 1024 * 1024 }) });
  await symlink(join(root, "node_modules"), join(baseline, "node_modules"));
  execFileSync(join(root, "node_modules", ".bin", "tsc"), [], { cwd: baseline });
  await cp(join(root, "test", "fixtures", "sdk-differential-read.ts"), join(baseline, "test", "fixtures", "sdk-differential-read.ts"));
  const source = join(scratch, "public"); await mkdir(source);
  execFileSync("tar", ["-x", "-C", source], { input: execFileSync("git", ["-C", sourceDirectory, "archive", sourceHead, ".agents/pm"], { maxBuffer: 64 * 1024 * 1024 }) });
  const pmRoot = join(source, ".agents", "pm");
  const client = new PmClient({ pmRoot, noExtensions: true });
  // SDK 2026.10.20 initializes derived caches on cold reads (pm-beads-w90u).
  // Warm them before the immutable snapshot; never change item/history bytes.
  const full = await client.listAllComplete();
  const ids = new Map(full.items.map(item => [item.id, item.id]));
  const input = join(scratch, "snapshot.jsonl");
  await writeFile(input, full.items.map(item => JSON.stringify(pmItemToBead(item as PmItem, ids, false))).join("\n") + "\n");
  const mutations: Record<string, (value: Record<string, unknown>) => void> = {
    complete: () => {},
    missingScope: value => { delete value.filters; },
    unknownFilter: value => { value.filters = { ...full.filters, assignee: "subset" }; },
    runtimeFilter: value => { value.filters = { ...full.filters, runtime_filters: { tags: ["subset"] } }; },
    excludedTerminal: value => { value.filters = { ...full.filters, exclude_terminal: true }; },
    uncheckedSource: value => { value.filters = { ...full.filters, strict_read: false }; },
    rowCeiling: value => { value.filters = { ...full.filters, no_truncate: false }; },
    appliedLimit: value => { value.applied_limit = 1; },
    fieldSubset: value => { value.projection = { mode: "full", fields: ["title"] }; },
    missingFieldsReceipt: value => { value.projection = { mode: "full" }; },
    readSession: value => { value.read_session = {}; },
    trimmedDuplicate: value => { value.items = [{ id: "one" }, { id: " one " }]; value.count = 2; value.total = 2; },
    truncated: value => { value.truncated = true; },
    omitted: value => { value.omission_receipt = { has_omissions: true, omitted_field_group_count: 1, omitted_field_groups: ["body"] }; },
    // Preserve the package's original rejection of informational disclosures;
    // the SDK has no strict-disclosure-presence option.
    informationalBudgetReceipt: value => { value.output_budget_exceeded = { omitted_result: false }; },
  };
  const cases: Record<string, unknown> = {};
  for (const [name, mutate] of Object.entries(mutations)) { const value = structuredClone(full) as unknown as Record<string, unknown>; mutate(value); cases[name] = value; }
  await writeFile(input + ".receipts.json", JSON.stringify(cases));
  const bin = join(scratch, "bin"); await mkdir(bin);
  await symlink(process.execPath, join(bin, "node"));
  await symlink(join(root, "node_modules", ".bin", "pm"), join(bin, "pm"));
  const env = { ...process.env, PATH: bin, GIT_CEILING_DIRECTORIES: scratch, PM_NO_EXTENSIONS: "1" };
  execFileSync(process.execPath, [join(root, "node_modules", "@unbrained", "pm-cli", "dist", "cli.js"), "--path", pmRoot, "--no-extensions", "list", "--all", "--full", "--strict-read", "--no-truncate", "--json"], { cwd: source, env, maxBuffer: 64 * 1024 * 1024 });
  await permissions(pmRoot, true);
  const before = await digest(pmRoot);
  /** Run a build in a distinct process with no git available or discoverable. */
  function run(build: string): Record<string, unknown> {
    const output = execFileSync(process.execPath, [join(build, "test", "fixtures", "sdk-differential-read.ts"), pmRoot, input], { cwd: source, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(output.trim().split("\n").at(-1)!);
  }
  const original = run(baseline), candidate = run(root);
  const originalReceipts = original.receipts as Record<string, { accepted: boolean; message?: string }>;
  const candidateReceipts = candidate.receipts as typeof originalReceipts;
  delete original.receipts; delete candidate.receipts;
  assert.deepEqual(candidate, original);
  const intentionalDifferences = [];
  for (const name of Object.keys(cases)) {
    const old = originalReceipts[name], current = candidateReceipts[name];
    if (old.accepted !== current.accepted) intentionalDifferences.push({ name, before: old.accepted, after: current.accepted });
    else if (!old.accepted) assert.match(current.message!, /Refusing unverifiable `pm list --all` answer/);
  }
  assert.deepEqual(intentionalDifferences.map(value => value.name), ["missingScope", "unknownFilter", "runtimeFilter", "excludedTerminal", "uncheckedSource", "rowCeiling", "appliedLimit", "fieldSubset", "missingFieldsReceipt", "readSession", "trimmedDuplicate"]);
  assert.equal(await digest(pmRoot), before);
  assert.equal(git(sourceDirectory, ["rev-parse", `${sourceHead}:.agents/pm`]), trackerTree);
  console.log(JSON.stringify({ repository, sourceHead, trackerTree, baselineHead, items: full.items.length, equalOutputs: Object.keys(candidate), receipts: Object.keys(cases).length, intentionalDifferences, refusedDiagnosticsUseSdkFindings: true, nonGit: true, gitAbsentFromPath: true, readOnly: true, trackerDigest: before, unchanged: true }, null, 2));
} finally {
  await permissions(scratch, false); await rm(scratch, { recursive: true, force: true });
}
