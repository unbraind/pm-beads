/** Storage-independent item access across real non-git tracker configurations and workflows. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PmClient, WorkspaceTransactionInterruptedError, readSettings } from "@unbrained/pm-cli/sdk";
import { applyBeadsTransfer, planBeadsTransfer, snapshotBeadsTransferSettings } from "../transfer.ts";
import { migrateBeadIdentities } from "../identity.ts";
import { readBeadsItemHistory } from "../item-access.ts";
import { acknowledgeBeadsSnapshot, applyBeadsReconciliation, parseBeadsSnapshot, planBeadsReconciliation, readLiveBeadsSnapshot } from "../reconcile.ts";
import { harness, runExport } from "./helpers.ts";

const configurations = ["default", "custom type folders", "custom types", "custom id prefix/generation"] as const;
const operations = ["plan", "apply", "interrupt+resume", "export", "migrate"] as const;
for (const configuration of configurations) for (const operation of operations) {
  test(`SDK tracker matrix: ${configuration} x ${operation}`, async t => {
    const dir = await mkdtemp(join(tmpdir(), "beads-config-")), pmRoot = join(dir, "tracker");
    t.after(() => rm(dir, { recursive: true, force: true }));
    const client = new PmClient({ pmRoot, author: "configuration-test", noExtensions: true });
    await client.init("sample");
    let type = "Task";
    if (configuration === "custom type folders") {
      const settings = await readSettings(pmRoot);
      settings.item_types.definitions = [{ name: "Task", folder: "work" }];
      await writeFile(join(pmRoot, "settings.json"), JSON.stringify(settings));
    }
    if (configuration === "custom types") {
      type = "WorkCard";
      await client.schemaAddType(type, { folder: "custom/cards" });
    }
    if (configuration === "custom id prefix/generation") {
      await client.config("project", "set", "id_prefix", "custom-prefix-");
      await client.config("project", "set", "ids.token_length", "8");
    }
    const text = [
      { id: "root", title: "Dependent", type, dependencies: ["blocker"], parent: "parent" },
      { id: "blocker", title: "Blocker", type },
      { id: "parent", title: "Parent", type },
    ].map(row => JSON.stringify(row)).join("\n");
    const settings = await snapshotBeadsTransferSettings(pmRoot);
    const plan = planBeadsTransfer(text, ["root"], "configuration-matrix", settings, { chunkSize: 1 });
    assert.deepEqual(plan.records.map(row => row.id), ["blocker", "parent", "root"]);
    assert.equal((await client.listAllComplete()).items.length, 0, "planning never creates items");
    if (operation === "plan") return;
    if (operation === "migrate") {
      const item = (await client.create({ title: "Legacy", type, description: "Body\n\n[bead_id: legacy]" })).item;
      const preview = await migrateBeadIdentities(pmRoot, "configuration-test");
      assert.deepEqual(preview.pending, [item.id]);
      assert.deepEqual(preview.skipped, []);
      const applied = await migrateBeadIdentities(pmRoot, "configuration-test", { apply: true });
      assert.deepEqual(applied.migrated, [item.id]); assert.deepEqual(applied.skipped, []);
      assert.equal((await client.get(item.id)).item.bead_id, "legacy");
      assert.equal((await client.get(item.id)).item.description, "Body");
      assert.equal((await readBeadsItemHistory(pmRoot, item.id)).verification?.ok, true);
      assert.deepEqual((await migrateBeadIdentities(pmRoot, "configuration-test", { apply: true })).migrated, []);
      return;
    }
    if (operation === "interrupt+resume") {
      await assert.rejects(applyBeadsTransfer(pmRoot, plan, "configuration-test", { maxChunks: 3, onRowTransition(c) {
        if (c.phase === "created_unrecorded" && c.id === "blocker") throw new WorkspaceTransactionInterruptedError("create-to-ledger interruption");
      } }), WorkspaceTransactionInterruptedError);
      assert.equal((await client.listAllComplete()).items.length, 1);
    }
    const result = await applyBeadsTransfer(pmRoot, plan, "configuration-test", { maxChunks: 3 });
    assert.equal(result.complete, true); assert.equal(result.transferred, 3); assert.equal(result.skipped, 0);
    const replay = await applyBeadsTransfer(pmRoot, plan, "configuration-peer", { maxChunks: 3 });
    assert.equal(replay.transferred, 3); assert.equal(replay.skipped, 0); assert.equal(replay.replayedChunks, 3);
    const items = (await client.listAllComplete()).items;
    assert.equal(items.length, 3); assert.equal(new Set(items.map(item => item.id)).size, 3);
    const ids = new Map(items.map(item => [item.bead_id, item.id]));
    const root = items.find(item => item.bead_id === "root")!;
    assert.equal(root.parent, ids.get("parent")); assert.equal(root.dependencies![0].id, ids.get("blocker"));
    for (const item of items) {
      assert.equal(item.type, type);
      assert.equal((await readBeadsItemHistory(pmRoot, item.id)).verification?.ok, true);
      if (configuration === "custom id prefix/generation") assert.match(item.id, /^custom-prefix-[a-z0-9]{8}$/);
    }
    if (operation === "export") {
      const ext = await harness(); t.after(() => ext.deactivate());
      const output = join(dir, "export.jsonl");
      assert.equal((await runExport(ext, { pmRoot, options: { output } }) as { exported: number }).exported, 3);
      const exported = parseBeadsSnapshot(await readFile(output, "utf8"));
      assert.deepEqual(exported.map(row => row.id).sort(), ["blocker", "parent", "root"]);
      assert.equal(exported.find(row => row.id === "root")!.fields.dependencies, '["blocker"]');
    }
    // Reconciliation also resolves history and allocates IDs through SDK APIs.
    const live = await readLiveBeadsSnapshot(pmRoot);
    await acknowledgeBeadsSnapshot(pmRoot, "configuration-reconcile", live, "configuration-test");
    const incoming = parseBeadsSnapshot(text + "\n" + JSON.stringify({ id: "new", title: "Reconciled", type, parent: "parent" }));
    await applyBeadsReconciliation(pmRoot, await planBeadsReconciliation(pmRoot, "configuration-reconcile", incoming), "configuration-test");
    const reconciled = (await client.listAllComplete()).items;
    assert.equal(reconciled.length, 4);
    assert.equal(reconciled.find(item => item.bead_id === "new")!.parent, ids.get("parent"));
    if (configuration === "custom id prefix/generation") assert(reconciled.every(item => /^custom-prefix-[a-z0-9]{8}$/.test(item.id)));
  });
}
