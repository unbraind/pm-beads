/** Real compiled-extension acceptance with no git executable available. */
import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { PmClient } from "@unbrained/pm-cli/sdk";
import type { BeadsReconcilePlan } from "../reconcile.ts";

const root = resolve(import.meta.dirname, "..");

test("compiled CLI acknowledges, previews TOON/JSON, applies and refuses stale plans without git", async t => {
  const dir = await mkdtemp(join(tmpdir(), "beads-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pmRoot = join(dir, "tracker"), extension = join(pmRoot, "extensions", "pm-beads");
  const client = new PmClient({ pmRoot, author: "cli-test", noExtensions: true });
  await client.init("sample");
  await client.create({ title: "Initial", description: "[bead_id: bd-one]" });
  await mkdir(extension, { recursive: true });
  for (const entry of ["dist", "manifest.json", "package.json"]) await cp(join(root, entry), join(extension, entry), { recursive: true });
  await symlink(join(root, "node_modules"), join(extension, "node_modules"), "junction");
  const file = join(dir, "incoming.jsonl"), output = join(dir, "review.json");
  /** Invoke the real host with the installed compiled extension and no git on PATH. */
  const invoke = (...args: string[]) => spawnSync(process.execPath, [join(root, "node_modules", "@unbrained", "pm-cli", "dist", "cli.js"), "--path", pmRoot, "--author", "cli-test", ...args], {
    cwd: dir, encoding: "utf8", env: { ...process.env, PATH: "", GIT_CEILING_DIRECTORIES: tmpdir() },
  });
  await writeFile(file, '{"id":"bd-missing","title":"Missing"}\n');
  const missing = invoke("--json", "beads", "reconcile", "--source", "team", file, "--acknowledge");
  assert.equal(missing.status, 2, missing.stdout + missing.stderr);
  assert.match(missing.stdout + missing.stderr, /ack_mismatch/);
  await writeFile(file, '{"id":"bd-one","title":"Initial"}\n');
  const acknowledged = invoke("--json", "beads", "reconcile", "--acknowledge", file, "--source", "team");
  assert.equal(acknowledged.status, 0, acknowledged.stderr);
  assert.equal(JSON.parse(acknowledged.stdout).acknowledged, 1);
  const localDescription = "Synthetic private planning note";
  await client.create({ title: "Local only", description: localDescription });
  const unreadable = invoke("--json", "beads", "reconcile", "--acknowledge", join(dir, "missing.jsonl"), "--source", "team");
  assert.equal(unreadable.status, 2, unreadable.stdout + unreadable.stderr);
  assert.match(unreadable.stdout + unreadable.stderr, /invalid_snapshot/);
  await writeFile(file, '{"id":"bd-one","title":"External"}\n');
  const preview = invoke("--json", "beads", "reconcile", "--source", "team", file, "--plan-out", output);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).counts.changes, 1);
  const savedPlan = JSON.parse(await readFile(output, "utf8")) as BeadsReconcilePlan;
  assert.equal(savedPlan.conflicts.length, 0);
  const localOnly = savedPlan.live.find(record => record.fields.description === localDescription);
  assert.ok(localOnly, "saved plans embed descriptions even for local-only records");
  assert.ok(!savedPlan.changes.some(change => change.id === localOnly.id));
  assert.ok(!preview.stdout.includes(localDescription), "compact reports omit full local values");
  for (const document of ["README.md", "examples/snapshot-reconciliation.md"]) {
    const guidance = (await readFile(join(root, document), "utf8")).replace(/\s+/g, " ");
    assert.match(guidance, /full plan saved by `--plan-out` contains external field values and a copy of every live tracker record in `plan.live`, including local descriptions of items with no proposed changes\./, `${document}: disclose the demonstrated saved local data`);
    assert.match(guidance, /same access controls and retention policy as both the snapshots and the tracker\./, `${document}: preserve tracker protections for saved plans`);
  }
  const help = invoke("beads-reconcile", "--help");
  assert.equal(help.status, 0, help.stdout + help.stderr);
  assert.match(help.stdout.replace(/\s+/g, " "), /every live tracker record, including local descriptions; use tracker access controls and retention/);
  const toon = invoke("beads-reconcile", file, "--source", "team");
  assert.equal(toon.status, 0, toon.stderr);
  assert.match(toon.stdout, /baseRevision:/);
  const applied = invoke("--json", "beads", "reconcile", "--source", "team", "--apply-plan", output);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).applied, 1);
  const stale = invoke("--json", "beads", "reconcile", "--source", "team", "--apply-plan", output);
  assert.equal(stale.status, 2);
  assert.match(stale.stdout + stale.stderr, /stale_base/);
});

test("documented import-export-acknowledge workflows accept title-only records without git", async t => {
  const example = await readFile(join(root, "examples/snapshot-reconciliation.md"), "utf8");
  const baseline = example.match(/If `baseline\.jsonl` contains `([^`]+)`/)?.[1];
  assert.ok(baseline, "the worked example supplies a concrete baseline record");
  for (const document of ["README.md", "examples/snapshot-reconciliation.md"]) {
    const text = await readFile(join(root, document), "utf8");
    const section = document === "README.md" ? text.split("## Three-way snapshot reconciliation\n")[1] : text;
    const block = section.match(/```sh\n([\s\S]*?)```/)?.[1];
    assert.ok(block, `${document}: reconciliation shell example exists`);
    const commands = block.split("\n").filter(line => line.startsWith("pm beads "));
    const dir = await mkdtemp(join(tmpdir(), "beads-doc-workflow-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const pmRoot = join(dir, "tracker"), extension = join(pmRoot, "extensions", "pm-beads"), bin = join(dir, "bin");
    const client = new PmClient({ pmRoot, author: "cli-test", noExtensions: true });
    await client.init("demo");
    await mkdir(extension, { recursive: true }); await mkdir(bin);
    for (const entry of ["dist", "manifest.json", "package.json"]) await cp(join(root, entry), join(extension, entry), { recursive: true });
    await symlink(join(root, "node_modules"), join(extension, "node_modules"), "junction");
    await symlink(process.execPath, join(bin, "node"));
    await symlink(join(root, "node_modules", "@unbrained", "pm-cli", "dist", "cli.js"), join(bin, "pm"));
    /** Run the documented commands with only the real pinned node and pm available. */
    const invoke = (...args: string[]) => spawnSync(process.execPath, [join(bin, "pm"), "--path", pmRoot, "--author", "cli-test", "--json", ...args], {
      cwd: dir, encoding: "utf8", env: { ...process.env, PATH: bin, GIT_CEILING_DIRECTORIES: tmpdir() },
    });
    await writeFile(join(dir, "baseline.jsonl"), baseline + "\n");
    // A standalone acknowledgement example assumes a prior import.
    if (!commands.some(line => line.startsWith("pm beads import "))) {
      const imported = invoke("beads", "import", "baseline.jsonl");
      assert.equal(imported.status, 0, imported.stdout + imported.stderr);
    }
    let acknowledged = false;
    for (const command of commands) {
      const result = invoke(...command.split(/\s+/).slice(1));
      assert.equal(result.status, 0, `${document}: ${command}\n${result.stdout}${result.stderr}`);
      if (command.includes("--acknowledge")) {
        assert.equal(JSON.parse(result.stdout).acknowledged, 1);
        acknowledged = true;
        break;
      }
    }
    assert.ok(acknowledged, `${document}: workflow acknowledges its imported baseline`);
    const records = (await client.listAllComplete()).items;
    assert.equal(records.length, 1);
    assert.match(String(records[0].description), /^Original/);
  }
});

/** Install the real compiled extension and pinned CLI in a non-git tracker. */
async function rawCliFixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "beads-raw-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pmRoot = join(dir, "tracker"), extension = join(pmRoot, "extensions", "pm-beads"), bin = join(dir, "bin");
  const client = new PmClient({ pmRoot, author: "raw-cli-test", noExtensions: true });
  await client.init("raw");
  await mkdir(extension, { recursive: true }); await mkdir(bin);
  for (const entry of ["dist", "manifest.json", "package.json"]) await cp(join(root, entry), join(extension, entry), { recursive: true });
  await symlink(join(root, "node_modules"), join(extension, "node_modules"), "junction");
  await symlink(process.execPath, join(bin, "node"));
  await symlink(join(root, "node_modules", "@unbrained", "pm-cli", "dist", "cli.js"), join(bin, "pm"));
  /** Invoke the pinned CLI, allowing its importer to invoke the same pinned CLI. */
  const invoke = (...args: string[]) => {
    const result = spawnSync(process.execPath, [join(bin, "pm"), "--path", pmRoot, "--author", "raw-cli-test", "--json", ...args], {
      cwd: dir, encoding: "utf8", env: { ...process.env, PATH: bin, GIT_CEILING_DIRECTORIES: tmpdir() },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  };
  return { dir, pmRoot, client, invoke };
}

test("RAW Beads bug and story types converge after import-export-acknowledge with missing descriptions", async t => {
  const { dir, client, invoke } = await rawCliFixture(t);
  const file = join(dir, "raw.jsonl"), exported = join(dir, "exported.jsonl"), planFile = join(dir, "plan.json");
  await writeFile(file, '{"id":"bd-raw","title":"Raw bug","issue_type":"bug","due_at":"2026-10-01T00:00:00Z"}\n');
  invoke("beads", "import", file);
  invoke("beads", "export", "--output", exported);
  const baseline = JSON.parse((await readFile(exported, "utf8")).trim());
  assert.equal(baseline.description, "Raw bug");
  invoke("beads", "reconcile", exported, "--source", "raw", "--acknowledge");
  for (const issueType of ["story", "bug"]) {
    await writeFile(file, JSON.stringify({ id: "bd-raw", title: "Raw bug", issue_type: issueType, due_at: "2026-10-01T00:00:00Z" }) + "\n");
    const preview = JSON.parse(invoke("beads", "reconcile", file, "--source", "raw", "--plan-out", planFile));
    assert.equal(preview.counts.conflicts, 0);
    invoke("beads", "reconcile", "--source", "raw", "--apply-plan", planFile);
    const stored = (await client.listAllComplete()).items[0];
    assert.equal(String(stored.type).toLowerCase(), issueType === "bug" ? "issue" : "feature");
    const repeated = JSON.parse(invoke("beads", "reconcile", file, "--source", "raw"));
    assert.equal(repeated.counts.unchanged, 1);
    assert.equal(repeated.counts.conflicts, 0);
  }
});

test("RAW Beads plain UTC deadline changes converge across consecutive saved bases", async t => {
  const { dir, pmRoot, client, invoke } = await rawCliFixture(t);
  const file = join(dir, "raw.jsonl"), exported = join(dir, "exported.jsonl"), planFile = join(dir, "plan.json");
  await writeFile(file, '{"id":"bd-due","title":"Raw story","issue_type":"story","due_at":"2026-10-01T00:00:00Z"}\n');
  invoke("beads", "import", file);
  invoke("beads", "export", "--output", exported);
  invoke("beads", "reconcile", exported, "--source", "raw", "--acknowledge");
  for (const dueAt of ["2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"]) {
    await writeFile(file, JSON.stringify({ id: "bd-due", title: "Raw story", issue_type: "story", due_at: dueAt }) + "\n");
    const preview = JSON.parse(invoke("beads", "reconcile", file, "--source", "raw", "--plan-out", planFile));
    assert.equal(preview.counts.conflicts, 0);
    invoke("beads", "reconcile", "--source", "raw", "--apply-plan", planFile);
    assert.equal((await client.listAllComplete()).items[0].deadline, new Date(dueAt).toISOString());
    const baseFiles = await readdir(join(pmRoot, "beads"));
    const base = JSON.parse(await readFile(join(pmRoot, "beads", baseFiles[0]), "utf8"));
    assert.equal(base.records[0].fields.deadline, new Date(dueAt).toISOString());
    const repeated = JSON.parse(invoke("beads", "reconcile", file, "--source", "raw"));
    assert.equal(repeated.counts.unchanged, 1);
    assert.equal(repeated.counts.conflicts, 0);
  }
});
