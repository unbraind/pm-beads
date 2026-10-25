/** Public SDK item access preserves missing streams and supports compacted history addressing. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PmClient, getHistoryPath, locateItem, runWithReproducibleProcessEnvironment } from "@unbrained/pm-cli/sdk";
import { allocateBeadsItemId, readBeadsItemDocument, readBeadsItemHistory } from "../item-access.ts";

/** Create a disposable non-git tracker for real history operations. */
async function fixture(t: test.TestContext) {
  const pmRoot = await mkdtemp(join(tmpdir(), "beads-access-"));
  t.after(() => rm(pmRoot, { recursive: true, force: true }));
  const client = new PmClient({ pmRoot, author: "item-access-test", noExtensions: true });
  await client.init("sample");
  return { pmRoot, client };
}

test("SDK item access never initializes an absent foreign history stream", async t => {
  const { pmRoot, client } = await fixture(t);
  const { item } = await client.create({ title: "Foreign" });
  const historyPath = getHistoryPath(pmRoot, item.id);
  await rm(historyPath);
  assert.deepEqual((await readBeadsItemHistory(pmRoot, item.id)).entries, []);
  await assert.rejects(readBeadsItemDocument(pmRoot, item.id), /does not verify/);
  await assert.rejects(readFile(historyPath), { code: "ENOENT" });
});

test("SDK item access resolves compacted durable versions and refuses current document drift", async t => {
  const { pmRoot, client } = await fixture(t);
  const { item } = await client.create({ title: "Original" });
  await client.update(item.id, { title: "Second" });
  await client.update(item.id, { title: "Latest" });
  const compacted = await client.historyCompact(item.id, { before: "3", force: true });
  assert.equal(compacted.changed, true);
  const history = await readBeadsItemHistory(pmRoot, item.id);
  assert.equal(history.verification?.ok, true);
  assert.equal(history.entries[0].op, "history_compact_baseline");
  assert.equal((await readBeadsItemDocument(pmRoot, item.id)).metadata.title, "Latest");
  const located = (await locateItem(pmRoot, item.id))!;
  const original = await readFile(located.itemPath, "utf8");
  const historyBefore = await readFile(getHistoryPath(pmRoot, item.id));
  await writeFile(located.itemPath, original.replace(/^title:.*$/m, 'title: "Unrecorded edit"'));
  await assert.rejects(readBeadsItemDocument(pmRoot, item.id), /does not verify/);
  assert.deepEqual(await readFile(getHistoryPath(pmRoot, item.id)), historyBefore);
});


test("SDK identity allocation retries unpublished batch collisions and refuses exhaustion", async t => {
  const { pmRoot } = await fixture(t);
  const environment = { PM_SEED: "batch-reservations", PM_CLOCK: "2026-01-01T00:00:00.000Z" };
  const reserved = new Set<string>();
  const first = await runWithReproducibleProcessEnvironment(environment, () => allocateBeadsItemId(pmRoot, reserved));
  const second = await runWithReproducibleProcessEnvironment(environment, () => allocateBeadsItemId(pmRoot, reserved));
  assert.notEqual(second, first); assert.equal(reserved.size, 2);
  const full = new Set<string>();
  await runWithReproducibleProcessEnvironment(environment, async () => {
    for (let i = 0; i < 32; i++) full.add(await allocateBeadsItemId(pmRoot));
  });
  assert.equal(full.size, 32);
  await assert.rejects(runWithReproducibleProcessEnvironment(environment, () => allocateBeadsItemId(pmRoot, full)), /repeatedly collided/);
});
