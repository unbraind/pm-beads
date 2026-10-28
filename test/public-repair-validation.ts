/** Measure repair packets on a frozen public tracker copy with no git or source writes. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { pmItemToBead, type PmItem } from "../index.ts";
import { explainBeadsDependencies, previewBeadsDependencyRepair } from "../repair.ts";
const root = resolve(import.meta.dirname, ".."), repository = "unbraind/pm-beads";
assert.equal(JSON.parse(execFileSync("gh", ["api", `repos/${repository}`], { encoding: "utf8" })).private, false);
const sourceHead = execFileSync("git", ["-C", root, "rev-parse", "origin/main"], { encoding: "utf8" }).trim();
const trackerTree = execFileSync("git", ["-C", root, "rev-parse", `${sourceHead}:.agents/pm`], { encoding: "utf8" }).trim();
const scratch = await mkdtemp(join(tmpdir(), "beads-repair-public-")), pmRoot = join(scratch, ".agents", "pm");
/** Fingerprint only the bounded disposable public tree. */
async function fingerprint(dir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(entry.name); hash.update(entry.isDirectory() ? await fingerprint(join(dir, entry.name)) : await readFile(join(dir, entry.name)));
  }
  return hash.digest("hex");
}
/** Restore exact scratch permissions in finally; the source checkout is never chmodded. */
async function permissions(dir: string, readonly: boolean): Promise<void> {
  if (!readonly) await chmod(dir, 0o700);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await permissions(join(dir, entry.name), readonly);
    else await chmod(join(dir, entry.name), readonly ? 0o400 : 0o600);
  }
  if (readonly) await chmod(dir, 0o500);
}
try {
  await mkdir(scratch, { recursive: true });
  execFileSync("tar", ["-x", "-C", scratch], { input: execFileSync("git", ["-C", root, "archive", sourceHead, ".agents/pm"], { maxBuffer: 64 * 1024 * 1024 }) });
  const client = new PmClient({ pmRoot, noExtensions: true, author: "public-validation" });
  await client.listAllComplete(); // Warm existing SDK caches before freezing; item/history bytes stay unchanged.
  await permissions(pmRoot, true); const before = await fingerprint(pmRoot);
  const previousPath = process.env.PATH, previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  try {
    process.env.PATH = ""; process.env.GIT_CEILING_DIRECTORIES = tmpdir();
    const native = (await client.listAllComplete()).items;
    const ids = new Map(native.map(item => [item.id, item.id]));
    const rows = native.map(item => pmItemToBead(item as PmItem, ids, false));
    const text = rows.map(row => JSON.stringify(row)).join("\n");
    const started = performance.now(), baseline = explainBeadsDependencies(text);
    const baselineMs = Number((performance.now() - started).toFixed(2));
    assert.equal(baseline.valid, true);
    // Inject a synthetic cycle only into in-memory exported JSONL; keep real tracker data read-only.
    const changed = structuredClone(rows); assert(changed.length >= 3);
    for (let index = 0; index < 3; index++) changed[index].dependencies = [...(changed[index].dependencies ?? []), changed[(index + 1) % 3].id!];
    const broken = changed.map(row => JSON.stringify(row)).join("\r\n"), brokenStarted = performance.now();
    const packet = explainBeadsDependencies(broken), elapsedMs = Number((performance.now() - brokenStarted).toFixed(2));
    assert.equal(packet.candidates.length, 1); const fixed = previewBeadsDependencyRepair(broken, packet.candidates[0]);
    assert.equal(explainBeadsDependencies(fixed).valid, true);
    assert.equal(await fingerprint(pmRoot), before); assert.deepEqual((await client.listAllComplete()).items, native);
    console.log(JSON.stringify({ repository, sourceHead, trackerTree, records: rows.length, sourceJsonlBytes: Buffer.byteLength(text),
      nativeEdges: baseline.counts.edges, nativeGaps: baseline.counts.gaps, nativeCycles: baseline.counts.cycles, baselineMs,
      syntheticCycleRows: packet.cycles.flatMap(cycle => cycle.rows).length, cycleEdges: packet.cycles.flatMap(cycle => cycle.edges).length,
      candidateEdits: packet.candidates[0].remove.length, analyses: packet.counts.analyses, packetJsonBytes: Buffer.byteLength(JSON.stringify(packet)), elapsedMs,
      candidateRevalidated: true, readOnly: true, nonGit: true, gitAbsentFromPath: true, trackerUnchanged: true, trackerFingerprint: before }, null, 2));
  } finally { process.env.PATH = previousPath; if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling; }
} finally { await permissions(scratch, false); await rm(scratch, { recursive: true, force: true }); }
