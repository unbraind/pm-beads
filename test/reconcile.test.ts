/** Behavioral reconciliation checks using real SDK trackers outside git. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { PmClient, WorkspaceTransactionInterruptedError, getHistoryPath } from "@unbrained/pm-cli/sdk";
import {
  canonicalBeadsRecord, parseBeadsSnapshot, reconcileBeadsSnapshots, summarizeBeadsReconciliation,
  acknowledgeBeadsSnapshot, readBeadsAcknowledgement, readLiveBeadsSnapshot,
  planBeadsReconciliation, applyBeadsReconciliation, BeadsReconcileRefusal,
  type BeadsAcknowledgement, type LiveSnapshotRecord, type SnapshotRecord,
} from "../reconcile.ts";
import { encodeBeadId } from "../index.ts";
import { harness, runCommand } from "./helpers.ts";

/** Canonical synthetic full snapshot row. */
function row(id = "bd-one", title = "Initial"): SnapshotRecord { return canonicalBeadsRecord({ id, title }); }
/** Bind synthetic rows to core-like identities for the pure classifier only. */
function local(...rows: SnapshotRecord[]): LiveSnapshotRecord[] { return rows.map(record => ({ ...record, pmId: `pm-${record.id}`, version: "hash", updatedAt: "2026-01-01T00:00:00.000Z" })); }
/** Acknowledged pure fixture; persistence is exercised separately with real SDK state. */
function base(...records: SnapshotRecord[]): BeadsAcknowledgement { return { schema: 1, source: "team", revision: "r1", previous: null, records }; }
/** Assert the public typed refusal and remedy, without relying on exact prose. */
function refusal(code: string) { return (error: unknown) => error instanceof BeadsReconcileRefusal && error.code === code && error.remedy.length > 10 && error.exitCode === 2; }
/** Make one isolated real tracker; neither init nor reconciliation requires git. */
async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "beads-reconcile-"));
  const pmRoot = join(dir, "tracker");
  const client = new PmClient({ pmRoot, author: "reconcile-test", noExtensions: true });
  await client.init("sample");
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, pmRoot, client };
}
/** Seed one exact external identity in a real tracker. */
async function seed(client: PmClient, id = "bd-one", title = "Initial") {
  return (await client.create({ title, type: "Task", description: encodeBeadId("", id) })).item.id as string;
}

test("three-way truth table is deterministic and never proposes deleting untracked local items", () => {
  const b = row(), incoming = row("bd-one", "External"), current = row("bd-one", "Local");
  assert.equal(reconcileBeadsSnapshots(base(b), [b], local(b)).unchanged, 1);
  assert.deepEqual(reconcileBeadsSnapshots(base(b), [incoming], local(b)).changes[0].fields, ["title"]);
  assert.equal(reconcileBeadsSnapshots(base(b), [b], local(current)).localOnly, 1);
  assert.equal(reconcileBeadsSnapshots(base(b), [incoming], local(incoming)).unchanged, 1);
  const p = reconcileBeadsSnapshots(base(b), [incoming], local(current, row("only-local")));
  assert.deepEqual(p.conflicts, [{ id: b.id, field: "title", base: "Initial", local: "Local", incoming: "External" }]);
  assert.deepEqual(p, reconcileBeadsSnapshots(base(b), [incoming], local(current, row("only-local"))));
  assert.equal(p.deletions.length, 0);
  const omission = reconcileBeadsSnapshots(base(b), [], local(current));
  assert.deepEqual(omission.deletions, [{ id: b.id, pmId: "pm-bd-one", locallyChanged: true }]);
  assert.equal(reconcileBeadsSnapshots(base(b), [], local(b)).deletions[0].locallyChanged, false);
  assert.equal(reconcileBeadsSnapshots(base(b), [], []).deletions.length, 0);
  assert.equal(reconcileBeadsSnapshots(base(b), [b], []).localOnly, 1);
  assert.equal(reconcileBeadsSnapshots(base(b), [incoming], []).conflicts[0].field, "$item");
  assert.equal(reconcileBeadsSnapshots(base(), [b], []).changes[0].kind, "create");
  assert.equal(reconcileBeadsSnapshots(base(), [b], local(b)).unchanged, 1);
  assert.equal(reconcileBeadsSnapshots(base(), [b], local(current)).conflicts[0].base, null);
  const merged = structuredClone(b); merged.fields.priority = "1";
  const external = structuredClone(b); external.fields.title = "External";
  const disjoint = reconcileBeadsSnapshots(base(b), [external], local(merged));
  assert.equal(disjoint.conflicts.length, 0);
  assert.deepEqual(disjoint.changes[0].fields, ["title"]);
});

test("canonical snapshots preserve boundaries, aliases, prose, sets and empty data", () => {
  const r = canonicalBeadsRecord({ id: "bd", name: " Alias ", status: "done", type: "Task", labels: ["b", "a", "a"], dependencies: ["two", "one", "two"], description: "text", sprint: "s", release: "r" });
  assert.equal(r.fields.title, "Alias"); assert.equal(r.fields.status, "closed");
  assert.equal(r.fields.tags, '["a","b"]'); assert.equal(r.fields.dependencies, '["one","two"]');
  assert.equal(r.fields.description, "text"); assert.equal(r.fields.sprint, "s"); assert.equal(r.fields.release, "r");
  assert.notEqual(canonicalBeadsRecord({ id: "x", title: "x", tags: ["a,b"] }).fields.tags, canonicalBeadsRecord({ id: "x", title: "x", tags: ["a", "b"] }).fields.tags);
  assert.deepEqual(parseBeadsSnapshot("\n"), []);
  assert.deepEqual(parseBeadsSnapshot('{"id":"z","title":"Z"}\n{"id":"a","title":"A"}\n').map(r => r.id), ["a", "z"]);
  assert.throws(() => canonicalBeadsRecord({ title: "No id" }), refusal("invalid_snapshot"));
  assert.throws(() => parseBeadsSnapshot("broken"), refusal("invalid_snapshot"));
  assert.throws(() => reconcileBeadsSnapshots(base(), [row(), row()], []), refusal("invalid_snapshot"));
  assert.throws(() => reconcileBeadsSnapshots(base(), [{ id: "", fields: row().fields }], []), refusal("invalid_snapshot"));
  assert.throws(() => reconcileBeadsSnapshots(base(), null as unknown as SnapshotRecord[], []), refusal("invalid_snapshot"));
  const malformed = row(); delete (malformed.fields as Partial<typeof malformed.fields>).title;
  assert.throws(() => reconcileBeadsSnapshots(base(), [malformed], []), refusal("invalid_snapshot"));
});

test("agent summary bounds rows and reports omissions with exact totals", () => {
  const records = Array.from({ length: 30 }, (_, i) => row(`bd-${i}`));
  const plan = reconcileBeadsSnapshots(base(), records, []);
  assert.equal(summarizeBeadsReconciliation(plan).rows.length, 20);
  assert.equal(summarizeBeadsReconciliation(plan).omitted, 10);
  assert.equal(summarizeBeadsReconciliation(plan, 40).omitted, 0);
  assert.equal(summarizeBeadsReconciliation(reconcileBeadsSnapshots(base(row()), [], local(row()))).rows[0].kind, "deletion_proposal");
  assert.equal(summarizeBeadsReconciliation(reconcileBeadsSnapshots(base(row()), [row("bd-one", "External")], local(row("bd-one", "Local")))).rows[0].kind, "conflict");
});

test("real non-git tracker: acknowledge, merge disjoint edits, keep omissions, refuse stale plans", async t => {
  const { pmRoot, client } = await fixture(t);
  const id = await seed(client);
  await seed(client, "bd-omitted", "Omitted");
  const initial = (await readLiveBeadsSnapshot(pmRoot)).map(({ id, fields }) => ({ id, fields }));
  assert.equal(await readBeadsAcknowledgement(pmRoot, "team"), null);
  await assert.rejects(planBeadsReconciliation(pmRoot, "team", initial), refusal("missing_base"));
  const acknowledged = await acknowledgeBeadsSnapshot(pmRoot, "team", initial, "reconcile-test");
  assert.equal(acknowledged.records.length, 2);
  await client.update(id, { priority: 1 });
  const incoming = initial.filter(r => r.id === "bd-one"); incoming[0].fields.title = "External";
  const plan = await planBeadsReconciliation(pmRoot, "team", incoming);
  assert.equal(plan.conflicts.length, 0); assert.equal(plan.deletions.length, 1);
  const applied = await applyBeadsReconciliation(pmRoot, plan, "reconcile-test");
  assert.equal(applied.applied, 1); assert.equal(applied.deletionProposals, 1);
  const item = (await client.get(id)).item;
  assert.equal(item.title, "External"); assert.equal(item.priority, 1);
  assert.equal((await readLiveBeadsSnapshot(pmRoot)).length, 2);
  const next = await planBeadsReconciliation(pmRoot, "team", incoming);
  assert.equal(next.deletions.length, 1, "omissions remain proposals after acknowledgement");
  await assert.rejects(applyBeadsReconciliation(pmRoot, plan, "reconcile-test"), refusal("stale_base"));
  await client.update(id, { title: "New local" });
  await assert.rejects(applyBeadsReconciliation(pmRoot, next, "reconcile-test"), refusal("stale_tracker"));
  incoming[0].fields.title = "New external";
  const conflicted = await planBeadsReconciliation(pmRoot, "team", incoming);
  await assert.rejects(applyBeadsReconciliation(pmRoot, conflicted, "reconcile-test"), refusal("conflicts"));
  const edited = structuredClone(next); edited.unchanged++;
  await assert.rejects(applyBeadsReconciliation(pmRoot, edited, "reconcile-test"), refusal("invalid_plan"));
});

test("real tracker refuses bootstrap mismatch and corrupt bases without resetting them", async t => {
  const { pmRoot, client } = await fixture(t);
  await seed(client);
  await assert.rejects(acknowledgeBeadsSnapshot(pmRoot, "team", [row("bd-one", "Wrong")], "reconcile-test"), refusal("ack_mismatch"));
  await acknowledgeBeadsSnapshot(pmRoot, "team", [row()], "reconcile-test");
  await assert.rejects(acknowledgeBeadsSnapshot(pmRoot, "team", [], "reconcile-test"), refusal("base_exists"));
  const name = createHash("sha256").update(JSON.stringify("team")).digest("hex");
  const path = join(pmRoot, "beads", `${name}.json`);
  await writeFile(path, "bad json");
  await assert.rejects(readBeadsAcknowledgement(pmRoot, "team"), refusal("invalid_snapshot"));
  await writeFile(path, '{}');
  await assert.rejects(readBeadsAcknowledgement(pmRoot, "team"), refusal("invalid_snapshot"));
  await assert.rejects(readBeadsAcknowledgement(pmRoot, " "), refusal("invalid_snapshot"));
  await rm(path); await mkdir(path);
  await assert.rejects(readBeadsAcknowledgement(pmRoot, "team"), { code: "EISDIR" });
});

test("real tracker creates new identities and applies field options and relationships", async t => {
  const { pmRoot, client } = await fixture(t);
  await seed(client);
  const original = await readLiveBeadsSnapshot(pmRoot);
  await acknowledgeBeadsSnapshot(pmRoot, "team", original, "reconcile-test");
  const incoming = parseBeadsSnapshot([
    { id: "bd-one", title: "Changed", description: "External prose", priority: 0, tags: ["test"], assignee: "worker", sprint: "sprint-1", release: "release-1", deadline: "2027-01-01T00:00:00.000Z", dependencies: ["bd-new"] },
    { id: "bd-new", title: "New", description: "New prose", parent: "bd-one" },
  ].map(r => JSON.stringify(r)).join("\n"));
  const plan = await planBeadsReconciliation(pmRoot, "team", incoming);
  assert.equal(plan.changes.length, 2);
  await applyBeadsReconciliation(pmRoot, plan, "reconcile-test");
  const live = await readLiveBeadsSnapshot(pmRoot);
  assert.equal(live.length, 2);
  assert.equal(live.find(r => r.id === "bd-one")!.fields.dependencies, '["bd-new"]');
  assert.equal(live.find(r => r.id === "bd-new")!.fields.parent, "bd-one");
});

test("CLI handlers expose compact preview, acknowledgement, full plans and typed failures", async t => {
  const { dir, pmRoot, client } = await fixture(t);
  await seed(client);
  const ext = await harness();
  const run = (options: Record<string, unknown>, args: string[] = []) => runCommand(ext, { command: "beads reconcile", options, args, pmRoot, global: { author: "reconcile-test" } });
  await assert.rejects(run({}), refusal("invalid_snapshot"));
  await assert.rejects(run({ source: "team" }), refusal("invalid_snapshot"));
  const file = join(dir, "base.jsonl"), output = join(dir, "review.json");
  await writeFile(file, '{"id":"bd-one","title":"Initial"}\n');
  assert.equal((await run({ source: "team", acknowledge: true }, [file]) as { acknowledged: number }).acknowledged, 1);
  await writeFile(file, '{"id":"bd-one","title":"Next"}\n');
  const preview = await run({ source: "team", planOut: output }, [file]) as { counts: { changes: number } };
  assert.equal(preview.counts.changes, 1);
  assert.equal(JSON.parse(await readFile(output, "utf8")).changes.length, 1);
  assert.equal((await run({ source: "team", applyPlan: output }) as { applied: number }).applied, 1);
  assert.equal((await run({ source: "team" }, [file]) as { counts: { unchanged: number } }).counts.unchanged, 1);
});

test("application clears fields and dependencies through the public SDK without git on PATH", async t => {
  const { pmRoot, client } = await fixture(t);
  const id = await seed(client);
  const parent = await seed(client, "bd-parent");
  await client.update(id, { tags: '["a,b","Mixed"]', assignee: "worker", sprint: "s", release: "r", deadline: "2027-01-01", parent, dep: [`id=${parent},kind=blocked_by`] });
  const initial = await readLiveBeadsSnapshot(pmRoot);
  await acknowledgeBeadsSnapshot(pmRoot, "team", initial, "reconcile-test");
  const incoming = initial.map(({ id, fields }) => ({ id, fields: { ...fields } }));
  const fields = incoming.find(r => r.id === "bd-one")!.fields;
  fields.tags = "[]"; fields.dependencies = "[]";
  fields.assignee = ""; fields.parent = ""; fields.deadline = ""; fields.sprint = ""; fields.release = "";
  const originalPath = process.env.PATH, originalCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.PATH = ""; process.env.GIT_CEILING_DIRECTORIES = tmpdir();
  try {
    const plan = await planBeadsReconciliation(pmRoot, "team", incoming);
    await applyBeadsReconciliation(pmRoot, plan, "reconcile-test");
    const actual = (await readLiveBeadsSnapshot(pmRoot)).find(r => r.id === "bd-one")!;
    assert.deepEqual(actual.fields, fields);
    const noOp = await planBeadsReconciliation(pmRoot, "team", incoming);
    assert.equal((await applyBeadsReconciliation(pmRoot, noOp, "reconcile-test")).applied, 0);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = originalCeiling;
  }
});

test("a late core validation failure compensates earlier changes and does not acknowledge", async t => {
  const { pmRoot, client } = await fixture(t);
  const first = await seed(client, "bd-a");
  await seed(client, "bd-z");
  const before = await readLiveBeadsSnapshot(pmRoot);
  const acknowledged = await acknowledgeBeadsSnapshot(pmRoot, "team", before, "reconcile-test");
  const incoming = before.map(({ id, fields }) => ({ id, fields: { ...fields } }));
  incoming[0].fields.title = "Changed first"; incoming[1].fields.type = "unsupported-schema-type";
  const plan = await planBeadsReconciliation(pmRoot, "team", incoming);
  await assert.rejects(applyBeadsReconciliation(pmRoot, plan, "reconcile-test"));
  assert.equal((await client.get(first)).item.title, "Initial");
  assert.equal((await readBeadsAcknowledgement(pmRoot, "team"))!.revision, acknowledged.revision);
});

test("writer-lock revalidation refuses item drift after preview but before applying", async t => {
  const { pmRoot, client } = await fixture(t);
  const id = await seed(client);
  await acknowledgeBeadsSnapshot(pmRoot, "team", [row()], "reconcile-test");
  const plan = await planBeadsReconciliation(pmRoot, "team", [row("bd-one", "External")]);
  await assert.rejects(applyBeadsReconciliation(pmRoot, plan, "reconcile-test", { async onTransition({ transition }) {
    if (transition === "prepared") await client.update(id, { title: "Late local" });
  } }), refusal("stale_tracker"));
  assert.equal((await client.get(id)).item.title, "Late local");
});

test("CLI rejects invalid plan bytes and source mismatches with a typed remedy", async t => {
  const { dir, pmRoot } = await fixture(t);
  const ext = await harness(), path = join(dir, "bad.json");
  await writeFile(path, "broken");
  await assert.rejects(runCommand(ext, { command: "beads-reconcile", options: { source: "team", applyPlan: path }, pmRoot }), refusal("invalid_plan"));
  await writeFile(path, '{}');
  await assert.rejects(runCommand(ext, { command: "beads-reconcile", options: { source: "team", applyPlan: path }, pmRoot }), refusal("invalid_plan"));
});


test("interrupted core transactions resume exact owned writes without replaying later local changes", async t => {
  const { pmRoot, client } = await fixture(t);
  const id = await seed(client);
  await acknowledgeBeadsSnapshot(pmRoot, "team", [row()], "reconcile-test");
  const plan = await planBeadsReconciliation(pmRoot, "team", [row("bd-one", "External"), row("bd-new", "New")]);
  await assert.rejects(applyBeadsReconciliation(pmRoot, plan, "reconcile-test", { onTransition({ transition, stepId }) {
    if (transition === "step_applied" && stepId === "item-1") throw new WorkspaceTransactionInterruptedError("test interruption");
  } }), WorkspaceTransactionInterruptedError);
  assert.equal((await client.get(id)).item.title, "External");
  const result = await applyBeadsReconciliation(pmRoot, plan, "reconcile-test");
  assert.equal(result.applied, 2);
  assert.equal((await readLiveBeadsSnapshot(pmRoot)).length, 2);
});

test("rollback closes new identities and restores acknowledgement after a late observer failure", async t => {
  const { pmRoot } = await fixture(t);
  const acknowledged = await acknowledgeBeadsSnapshot(pmRoot, "team", [], "reconcile-test");
  const plan = await planBeadsReconciliation(pmRoot, "team", [row("bd-new", "New")]);
  await assert.rejects(applyBeadsReconciliation(pmRoot, plan, "reconcile-test", { onTransition({ transition, stepId }) {
    if (transition === "step_applied" && stepId === "acknowledge") throw new Error("test late failure");
  } }), /test late failure/);
  assert.equal((await readBeadsAcknowledgement(pmRoot, "team"))!.revision, acknowledged.revision);
  assert.equal((await readLiveBeadsSnapshot(pmRoot))[0].fields.status, "closed");
});

test("bootstrap failures remove only their own uncommitted acknowledgement", async t => {
  const { pmRoot } = await fixture(t);
  await assert.rejects(acknowledgeBeadsSnapshot(pmRoot, "team", [], "reconcile-test", { onTransition({ transition }) {
    if (transition === "step_applied") throw new Error("bootstrap failure");
  } }), /bootstrap failure/);
  assert.equal(await readBeadsAcknowledgement(pmRoot, "team"), null);
});


/** Recompute a plan digest to prove apply independently reclassifies its payload. */
function rehash<T extends { digest: string }>(plan: T): T {
  plan.digest = createHash("sha256").update(JSON.stringify({ ...plan, digest: "" })).digest("hex");
  return plan;
}
/** Simulate another acknowledged source revision without touching item history. */
async function advanceBase(pmRoot: string) {
  const current = (await readBeadsAcknowledgement(pmRoot, "team"))!;
  const path = join(pmRoot, "beads", `${createHash("sha256").update(JSON.stringify("team")).digest("hex")}.json`);
  const previous = current.revision;
  const revision = createHash("sha256").update(JSON.stringify({ source: "team", previous, records: current.records })).digest("hex");
  await writeFile(path, JSON.stringify({ ...current, previous, revision }));
  return revision;
}

test("strict snapshot validation rejects unknown statuses and duplicate ids", () => {
  assert.throws(() => parseBeadsSnapshot('{"id":"x","title":"X","status":"surprise"}'), refusal("invalid_snapshot"));
  assert.throws(() => parseBeadsSnapshot('{"id":"x","title":"X"}\n{"id":"x","title":"X"}'), refusal("invalid_snapshot"));
});

test("core history revisions are mandatory and native pm ids work without markers", async t => {
  const { pmRoot, client } = await fixture(t);
  const id = (await client.create({ title: "Native identity" })).item.id as string;
  const live = await readLiveBeadsSnapshot(pmRoot);
  assert.equal(live[0].id, id);
  await writeFile(getHistoryPath(pmRoot, id), "");
  await assert.rejects(readLiveBeadsSnapshot(pmRoot), refusal("invalid_snapshot"));
});

test("apply reclassifies tampered plans even when their caller recomputes the digest", async t => {
  const { pmRoot, client } = await fixture(t);
  await seed(client);
  await acknowledgeBeadsSnapshot(pmRoot, "team", [row()], "reconcile-test");
  const plan = await planBeadsReconciliation(pmRoot, "team", [row("bd-one", "External")]);
  plan.changes = [];
  await assert.rejects(applyBeadsReconciliation(pmRoot, rehash(plan), "reconcile-test"), refusal("invalid_plan"));
  const missing = reconcileBeadsSnapshots(base(row()), [row()], local(row()));
  await assert.rejects(applyBeadsReconciliation(pmRoot, missing, "reconcile-test"), refusal("stale_base"));
});

test("external closure and an unresolved relationship use native SDK validation", async t => {
  const { pmRoot, client } = await fixture(t);
  const id = await seed(client);
  await acknowledgeBeadsSnapshot(pmRoot, "team", [row()], "reconcile-test");
  const closed = row(); closed.fields.status = "closed";
  await applyBeadsReconciliation(pmRoot, await planBeadsReconciliation(pmRoot, "team", [closed]), "reconcile-test");
  assert.equal((await client.get(id)).item.status, "closed");
  const incoming = structuredClone(closed); incoming.fields.parent = "missing-external-parent";
  await assert.rejects(applyBeadsReconciliation(pmRoot, await planBeadsReconciliation(pmRoot, "team", [incoming]), "reconcile-test"));
  incoming.fields.parent = ""; incoming.fields.dependencies = '["missing-external-dependency"]';
  await assert.rejects(applyBeadsReconciliation(pmRoot, await planBeadsReconciliation(pmRoot, "team", [incoming]), "reconcile-test"));
});

test("source changes during writer-lock acquisition refuse without overwriting acknowledgement", async t => {
  const { pmRoot, client } = await fixture(t);
  await seed(client);
  await acknowledgeBeadsSnapshot(pmRoot, "team", [row()], "reconcile-test");
  const plan = await planBeadsReconciliation(pmRoot, "team", [row("bd-one", "External")]);
  let newer = "";
  await assert.rejects(applyBeadsReconciliation(pmRoot, plan, "reconcile-test", { async onTransition({ transition }) {
    if (transition === "prepared") newer = await advanceBase(pmRoot);
  } }), refusal("stale_base"));
  assert.equal((await readBeadsAcknowledgement(pmRoot, "team"))!.revision, newer);
});

test("per-item drift and compensation both preserve later writers", async t => {
  const { pmRoot, client } = await fixture(t);
  const first = await seed(client, "bd-a"), second = await seed(client, "bd-z");
  const initial = await readLiveBeadsSnapshot(pmRoot);
  await acknowledgeBeadsSnapshot(pmRoot, "team", initial, "reconcile-test");
  const changed = initial.map(({ id, fields }) => ({ id, fields: { ...fields, title: "External" } }));
  const plan = await planBeadsReconciliation(pmRoot, "team", changed);
  await assert.rejects(applyBeadsReconciliation(pmRoot, plan, "reconcile-test", { async onTransition({ transition, stepId }) {
    if (transition === "step_recorded" && stepId === "item-0") await client.update(second, { title: "Later writer" });
  } }), refusal("stale_tracker"));
  assert.equal((await client.get(first)).item.title, "Initial");
  assert.equal((await client.get(second)).item.title, "Later writer");
  const next = await planBeadsReconciliation(pmRoot, "team", initial);
  await assert.rejects(applyBeadsReconciliation(pmRoot, next, "reconcile-test", { async onTransition({ transition, stepId }) {
    if (transition === "step_applied" && stepId === "acknowledge") { await advanceBase(pmRoot); throw new Error("late source advance"); }
  } }));
  const finalIncoming = initial.map(({ id, fields }, index) => ({ id, fields: { ...fields, title: index === 0 ? "Another external" : "Later writer" } }));
  const safe = await planBeadsReconciliation(pmRoot, "team", finalIncoming);
  await assert.rejects(applyBeadsReconciliation(pmRoot, safe, "reconcile-test", { async onTransition({ transition, stepId }) {
    if (transition === "step_applied" && stepId === "item-0") { await client.update(first, { title: "Concurrent local" }); throw new Error("late local write"); }
  } }));
  assert.equal((await client.get(first)).item.title, "Concurrent local");
});

test("source drift immediately before acknowledgement compensates item changes", async t => {
  const { pmRoot, client } = await fixture(t);
  const id = await seed(client);
  await acknowledgeBeadsSnapshot(pmRoot, "team", [row()], "reconcile-test");
  const plan = await planBeadsReconciliation(pmRoot, "team", [row("bd-one", "External")]);
  await assert.rejects(applyBeadsReconciliation(pmRoot, plan, "reconcile-test", { async onTransition({ transition, stepId }) {
    if (transition === "step_recorded" && stepId === "item-0") await advanceBase(pmRoot);
  } }), refusal("stale_base"));
  assert.equal((await client.get(id)).item.title, "Initial");
});

test("missing compensation provenance never causes a blind restore", async t => {
  const { pmRoot, client } = await fixture(t);
  const id = await seed(client);
  await acknowledgeBeadsSnapshot(pmRoot, "team", [row()], "reconcile-test");
  const plan = await planBeadsReconciliation(pmRoot, "team", [row("bd-one", "External")]);
  await assert.rejects(applyBeadsReconciliation(pmRoot, plan, "reconcile-test", { async onTransition({ transition, stepId }) {
    if (transition === "step_applied" && stepId === "item-0") throw new Error("injected failure");
    // Simulate lost history in this disposable tracker, after core inspection.
    if (transition === "step_compensating" && stepId === "item-0") await rm(getHistoryPath(pmRoot, id));
  } }), refusal("recovery_required"));
  assert.equal((await client.get(id)).item.title, "External");
});


test("compensation uses exact core versions when multiple mutations share a timestamp", async t => {
  const { pmRoot, client } = await fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2027-01-01T00:00:00Z") });
  const id = await seed(client, "bd-a");
  await seed(client, "bd-z");
  const initial = await readLiveBeadsSnapshot(pmRoot);
  await acknowledgeBeadsSnapshot(pmRoot, "team", initial, "reconcile-test");
  const incoming = initial.map(({ id, fields }) => ({ id, fields: { ...fields } }));
  incoming[0].fields.title = "External"; incoming[1].fields.type = "invalid-schema-type";
  await assert.rejects(applyBeadsReconciliation(pmRoot, await planBeadsReconciliation(pmRoot, "team", incoming), "reconcile-test"));
  assert.equal((await client.get(id)).item.title, "Initial");
});

test("ambiguous legacy checkpoints refuse before the first reversible write", async t => {
  const { pmRoot, client } = await fixture(t);
  const id = await seed(client);
  await client.update(id, { title: "Current" });
  await client.historyCompact(id, { before: "2", force: true });
  const path = getHistoryPath(pmRoot, id);
  const entries = (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  const first = entries[0];
  assert.equal(first.op, "history_compact_baseline");
  // Model a legacy checkpoint in the disposable tracker, without inventing a mapping.
  delete first.record_hash; delete first.record_hash_version;
  const context = first.context as { history_compaction: Record<string, unknown> };
  delete context.history_compaction.version_offset;
  await writeFile(path, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
  const live = await readLiveBeadsSnapshot(pmRoot);
  await acknowledgeBeadsSnapshot(pmRoot, "team", live, "reconcile-test");
  const incoming = [{ id: live[0].id, fields: { ...live[0].fields, title: "External" } }];
  const plan = await planBeadsReconciliation(pmRoot, "team", incoming);
  await assert.rejects(applyBeadsReconciliation(pmRoot, plan, "reconcile-test"), refusal("recovery_required"));
  assert.equal((await client.get(id)).item.title, "Current");
});
