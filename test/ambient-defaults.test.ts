/** Full-document importer regressions against configured real trackers outside git. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  PmClient, getHistoryPath, loadCreateTemplateOptions, locateItem, readLocatedItem,
  readSettings, runTemplatesSave, type ItemDocument,
} from "@unbrained/pm-cli/sdk";
import { applyBeadsTransfer, beadsTransferItemId, planBeadsTransfer, snapshotBeadsTransferSettings } from "../transfer.ts";
import { acknowledgeBeadsSnapshot, applyBeadsReconciliation, parseBeadsSnapshot, planBeadsReconciliation } from "../reconcile.ts";
import { encodeBeadId } from "../index.ts";
import { beadsMutationAuthor, sourceCreateOptions } from "../mutation.ts";
import { harness, runCommand, runImport } from "./helpers.ts";

/** Configure supported defaults, including a stored template carrying default tags and assignee. */
async function receiver(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "beads-ambient-")), pmRoot = join(dir, "tracker");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const client = new PmClient({ pmRoot, author: "fixture-agent", noExtensions: true });
  await client.init("sample");
  const focus = (await client.create({ title: "Receiver focus", type: "Feature" })).item.id;
  await client.focus(focus);
  const settings = await readSettings(pmRoot);
  settings.author_default = "ambient-author";
  settings.governance.create_default_type = "Issue";
  settings.governance.create_mode_default = "strict";
  await writeFile(join(pmRoot, "settings.json"), JSON.stringify(settings));
  await writeFile(join(pmRoot, "schema", "types.json"), JSON.stringify({ definitions: [{ name: "Task", default_status: "blocked" }] }));
  await runTemplatesSave("ambient", {
    type: "Issue", status: "blocked", priority: "0", tags: "ambient-tag",
    assignee: "ambient-assignee", parent: focus, description: "Ambient description",
  }, { path: pmRoot });
  // Positive controls prove the ambient configuration is live, using real SDK operations.
  const implicit = await client.create({ title: "Default control", createMode: "progressive" });
  assert.equal(implicit.item.type, "Issue");
  assert.equal(implicit.item.parent, focus);
  assert.equal(implicit.parent_source, "focus");
  const workflow = await client.create({ title: "Workflow control", type: "Task", createMode: "progressive", unset: ["parent"] });
  assert.equal(workflow.item.status, "blocked");
  const template = await client.create({ ...await loadCreateTemplateOptions(pmRoot, "ambient"), title: "Template control", createMode: "progressive" });
  assert.deepEqual(template.item.tags, ["ambient-tag"]);
  assert.equal(template.item.assignee, "ambient-assignee");
  const extension = join(pmRoot, "extensions", "ambient-defaults");
  await mkdir(extension, { recursive: true });
  await writeFile(join(extension, "manifest.json"), JSON.stringify({
    name: "ambient-defaults", version: "1.0.0", entry: "./index.mjs", manifest_version: 1, capabilities: ["schema"],
  }));
  await writeFile(join(extension, "index.mjs"), 'export default { activate(api) { api.registerItemFields([{ name: "ambient_marker", type: "string", default: "receiver-only" }]); } };');
  const extensible = new PmClient({ pmRoot, author: "fixture-agent" });
  const extended = await extensible.create({ title: "Extension control", createMode: "progressive" });
  assert.equal(extended.item.ambient_marker, "receiver-only");
  const previous = process.env.PM_AUTHOR;
  process.env.PM_AUTHOR = "ambient-session-author";
  t.after(() => { if (previous === undefined) delete process.env.PM_AUTHOR; else process.env.PM_AUTHOR = previous; });
  return { dir, pmRoot, client, prefix: settings.id_prefix, focus };
}

/** Normalize only generated timestamps, retaining every metadata key and relationship field. */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, field]) => {
    if (["created_at", "updated_at", "closed_at", "completed_at"].includes(key)) {
      assert.equal(typeof field, "string");
      assert.ok(Number.isFinite(Date.parse(field as string)));
      return [key, "<time>"];
    }
    return [key, stable(field)];
  }));
  return value;
}

/** Read the entire persisted document rather than a projected SDK get envelope. */
async function document(pmRoot: string, id: string): Promise<ItemDocument> {
  const located = await locateItem(pmRoot, id);
  assert.ok(located);
  return (await readLocatedItem(located)).document;
}

/** Expected minimal source-owned document, including the package's explicit provenance. */
function expected(id: string, beadId: string, title: string, extra: Record<string, unknown> = {}): unknown {
  return { metadata: {
    id, title, description: encodeBeadId("", beadId), type: "Task", status: "open", priority: 2,
    tags: [], created_at: "<time>", updated_at: "<time>", author: "source-agent", ...extra,
  }, body: "" };
}

test("mutation authors resolve explicit invocation, environment and package fallback in order", () => {
  const previous = process.env.PM_AUTHOR;
  try {
    process.env.PM_AUTHOR = "environment-agent";
    assert.equal(beadsMutationAuthor("explicit-agent"), "explicit-agent");
    assert.equal(beadsMutationAuthor(undefined), "environment-agent");
    delete process.env.PM_AUTHOR;
    assert.equal(beadsMutationAuthor(undefined), "pm-beads");
  } finally { if (previous === undefined) delete process.env.PM_AUTHOR; else process.env.PM_AUTHOR = previous; }
});

test("source creation policy explicitly replaces every supported receiver fallback", async t => {
  const { pmRoot, client } = await receiver(t);
  const item = (await client.create(sourceCreateOptions({ title: "Policy", description: "[bead_id: policy]" }, "source-agent"))).item;
  assert.deepEqual(stable(await document(pmRoot, item.id)), expected(item.id, "policy", "Policy"));
});

test("transfer ignores active focus, template tags/assignee and workflow defaults with exact full documents", async t => {
  const { pmRoot, prefix } = await receiver(t);
  const text = [
    { id: "a", title: "A" },
    { id: "b", title: "B", parent: "a", dependencies: ["a"], tags: ["source-tag"], priority: 0,
      assignee: "source-assignee", type: "Feature", status: "blocked", deadline: "2027-01-01", sprint: "s", release: "r" },
    { id: "c", title: "C", status: "closed" },
  ].map(row => JSON.stringify(row)).join("\n");
  const plan = planBeadsTransfer(text, ["a", "b", "c"], "ambient-transfer", await snapshotBeadsTransferSettings(pmRoot));
  const result = await applyBeadsTransfer(pmRoot, plan, "source-agent");
  assert.equal(result.complete, true); assert.equal(result.transferred, 3); assert.equal(result.skipped, 0);
  const ids = Object.fromEntries(["a", "b", "c"].map(id => [id, beadsTransferItemId(plan, id, prefix)]));
  assert.deepEqual(stable(await document(pmRoot, ids.a)), expected(ids.a, "a", "A"));
  assert.deepEqual(stable(await document(pmRoot, ids.b)), expected(ids.b, "b", "B", {
    type: "Feature", status: "blocked", priority: 0, tags: ["source-tag"], assignee: "source-assignee",
    parent: ids.a, dependencies: [{ id: ids.a, kind: "blocked_by", author: "source-agent", created_at: "<time>", author_source: "asserted", source_kind: "cli:create:dep" }],
    deadline: "2027-01-01T00:00:00.000Z", sprint: "s", release: "r",
  }));
  assert.deepEqual(stable(await document(pmRoot, ids.c)), expected(ids.c, "c", "C", {
    status: "closed", close_reason: "Closed in transferred Beads snapshot", closed_at: "<time>", completed_at: "<time>",
  }));
  const history = await readFile(getHistoryPath(pmRoot, ids.a), "utf8");
  assert.equal((await applyBeadsTransfer(pmRoot, plan, "another-agent")).transferred, 3);
  assert.equal(await readFile(getHistoryPath(pmRoot, ids.a), "utf8"), history);
});

test("reconciliation create, update and links retain only source fields under ambient defaults", async t => {
  const { pmRoot, client } = await receiver(t);
  await acknowledgeBeadsSnapshot(pmRoot, "ambient-reconcile", [], "source-agent");
  const rows = parseBeadsSnapshot('{"id":"a","title":"A"}\n{"id":"b","title":"B","parent":"a","dependencies":["a"]}');
  await applyBeadsReconciliation(pmRoot, await planBeadsReconciliation(pmRoot, "ambient-reconcile", rows), "source-agent", {
    async onTransition({ transition, stepId }) {
      if (transition === "step_applied" && stepId === "item-0") {
        const created = (await client.listAllComplete()).items.find(item => item.description === "[bead_id: a]")!;
        assert.deepEqual(stable(await document(pmRoot, created.id)), expected(created.id, "a", "A"));
      }
    },
  });
  const all = (await client.listAllComplete()).items;
  const a = all.find(item => item.description === "[bead_id: a]")!, b = all.find(item => item.description === "[bead_id: b]")!;
  assert.deepEqual(stable(await document(pmRoot, a.id)), expected(a.id, "a", "A"));
  const links = { parent: a.id, dependencies: [{ id: a.id, kind: "blocked_by", author: "source-agent", created_at: "<time>", author_source: "asserted", source_kind: "cli:update:dep" }] };
  assert.deepEqual(stable(await document(pmRoot, b.id)), expected(b.id, "b", "B", links));
  const updated = parseBeadsSnapshot('{"id":"a","title":"Updated"}\n{"id":"b","title":"B","parent":"a","dependencies":["a"]}');
  await applyBeadsReconciliation(pmRoot, await planBeadsReconciliation(pmRoot, "ambient-reconcile", updated), "source-agent");
  assert.deepEqual(stable(await document(pmRoot, a.id)), expected(a.id, "a", "Updated"));
  assert.deepEqual(stable(await document(pmRoot, b.id)), expected(b.id, "b", "B", links));
});

test("legacy importer and alias pin author for create, upsert, links and close under receiver defaults", async t => {
  const { pmRoot, dir, client } = await receiver(t);
  // Child mutations execute the pinned real host, with no git executable available.
  const bin = join(dir, "bin"); await mkdir(bin);
  await symlink(process.execPath, join(bin, "node"));
  await symlink(resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), join(bin, "pm"));
  const previous = process.env.PATH; process.env.PATH = bin;
  t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; });
  const ext = await harness(); t.after(() => ext.deactivate());
  const file = join(dir, "source.jsonl");
  await writeFile(file, '{"id":"a","title":"A"}\n{"id":"b","title":"B","parent":"a","dependencies":["a"],"status":"closed"}');
  assert.equal((await runImport(ext, { args: [file], options: { preserveTimestamps: false }, pmRoot, global: { author: "source-agent" } })).imported, 2);
  const all = (await client.listAllComplete()).items;
  const a = all.find(item => item.description === "A\n\n[bead_id: a]")!, b = all.find(item => item.description === "B\n\n[bead_id: b]")!;
  assert.deepEqual(stable(await document(pmRoot, a.id)), expected(a.id, "a", "A", { description: "A\n\n[bead_id: a]" }));
  const before = stable(await document(pmRoot, b.id));
  assert.deepEqual(before, expected(b.id, "b", "B", {
    description: "B\n\n[bead_id: b]", status: "closed", close_reason: "Imported from Beads record b (source status: closed)",
    closed_at: "<time>", completed_at: "<time>", parent: a.id,
    dependencies: [{ id: a.id, kind: "blocked_by", author: "source-agent", created_at: "<time>", author_source: "asserted", source_kind: "cli:update:dep" }],
  }));
  await runCommand(ext, { command: "beads-import", args: [file], options: { upsert: true, preserveTimestamps: false }, pmRoot, global: { author: "source-agent" } });
  assert.deepEqual(stable(await document(pmRoot, a.id)), expected(a.id, "a", "A", { description: "A\n\n[bead_id: a]" }));
  assert.deepEqual(stable(await document(pmRoot, b.id)), before);
  for (const id of [a.id, b.id]) {
    const history = (await readFile(getHistoryPath(pmRoot, id), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { author: string });
    assert.ok(history.every(entry => entry.author === "source-agent"));
  }
});

test("reconciliation compensation restores and closes with explicit author under ambient defaults", async t => {
  const { pmRoot, client } = await receiver(t);
  const a = (await client.create(sourceCreateOptions({ title: "A", description: "[bead_id: a]" }, "source-agent"))).item.id;
  await acknowledgeBeadsSnapshot(pmRoot, "compensation", parseBeadsSnapshot('{"id":"a","title":"A"}'), "source-agent");
  const incoming = parseBeadsSnapshot('{"id":"a","title":"Changed"}\n{"id":"b","title":"B"}');
  const plan = await planBeadsReconciliation(pmRoot, "compensation", incoming);
  await assert.rejects(applyBeadsReconciliation(pmRoot, plan, "source-agent", { onTransition({ transition, stepId }) {
    if (transition === "step_applied" && stepId === "acknowledge") throw new Error("deliberate compensation");
  } }), /deliberate compensation/);
  assert.deepEqual(stable(await document(pmRoot, a)), expected(a, "a", "A"));
  const b = (await client.listAllComplete()).items.find(item => item.description === "[bead_id: b]")!;
  assert.deepEqual(stable(await document(pmRoot, b.id)), expected(b.id, "b", "B", {
    status: "closed", close_reason: "Compensated interrupted Beads reconciliation", closed_at: "<time>", completed_at: "<time>",
  }));
  for (const id of [a, b.id]) {
    const entries = (await readFile(getHistoryPath(pmRoot, id), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { author: string });
    assert.ok(entries.every(entry => entry.author === "source-agent"));
  }
});
