/** Real compiled-extension acceptance with no git executable available. */
import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { PmClient } from "@unbrained/pm-cli/sdk";

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
  const acknowledged = invoke("--json", "beads", "reconcile", "--source", "team", file, "--acknowledge");
  assert.equal(acknowledged.status, 0, acknowledged.stderr);
  assert.equal(JSON.parse(acknowledged.stdout).acknowledged, 1);
  await writeFile(file, '{"id":"bd-one","title":"External"}\n');
  const preview = invoke("--json", "beads", "reconcile", "--source", "team", file, "--plan-out", output);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).counts.changes, 1);
  assert.equal(JSON.parse(await readFile(output, "utf8")).conflicts.length, 0);
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
