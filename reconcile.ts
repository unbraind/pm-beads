/** Three-way Beads reconciliation with durable, source-scoped acknowledgements. */
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  PmClient, commitWorkspaceTransaction, getHistoryPath, readHistorySnapshot,
  writeFileAtomic, normalizeItemId, readSettings, parseTags,
  type CommitWorkspaceTransactionOptions,
  type WorkspaceTransactionStep, type PmClientFullMutationOptions,
} from "@unbrained/pm-cli/sdk";
import type { ExtensionApi, CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import { CommandError, DIFF_FIELDS } from "./contracts.ts";
import {
  normalizeDiffField, extractBlockerIds, stripBeadIdMarker,
  pmItemToBead, decodeBeadId, encodeBeadId, isEncodableBeadId, validateBeadsText,
  optionString, readBoolOption, type BeadsItem, type PmItem,
} from "./index.ts";

/** Fields reconciled independently; annotation collections and timestamps stay local. */
export const RECONCILE_FIELDS = [...DIFF_FIELDS, "description", "sprint", "release"] as const;
/** A single supported Beads field. */
export type ReconcileField = typeof RECONCILE_FIELDS[number];
/** Canonical field values, retaining set boundaries instead of joining with commas. */
export type SnapshotFields = Record<ReconcileField, string>;
/** One canonical external record. Missing optional fields mean empty values in a full snapshot. */
export interface SnapshotRecord { id: string; fields: SnapshotFields }
/** Persisted external base; revision changes on every successful acknowledgement. */
export interface BeadsAcknowledgement {
  schema: 1; source: string; revision: string; previous: string | null; records: SnapshotRecord[];
}
/** A live record bound to its pm identity and core history version. */
export interface LiveSnapshotRecord extends SnapshotRecord { pmId: string; version: string; updatedAt: string }
/** Field conflict with all three canonical values; null denotes item absence. */
export interface BeadsFieldConflict {
  id: string; field: ReconcileField | "$item"; base: string | null; local: string | null; incoming: string | null;
}
/** One safe creation or field update proposed by the classifier. */
export interface BeadsChange { id: string; kind: "create" | "update"; fields: ReconcileField[] }
/** Immutable-by-convention plan; apply revalidates its digest and base. */
export interface BeadsReconcilePlan {
  schema: 1; source: string; baseRevision: string; trackerRevision: string; digest: string;
  live: LiveSnapshotRecord[]; incoming: SnapshotRecord[]; changes: BeadsChange[]; conflicts: BeadsFieldConflict[];
  deletions: Array<{ id: string; pmId: string; locallyChanged: boolean }>;
  unchanged: number; localOnly: number;
}
/** Stable refusal categories for callers that should re-read or resolve data. */
export type BeadsReconcileRefusalCode = "invalid_snapshot" | "missing_base" | "base_exists" | "stale_base" | "stale_tracker" | "conflicts" | "invalid_plan" | "ack_mismatch" | "recovery_required";
/** Expected refusal with an actionable remedy and clean CLI exit code. */
export class BeadsReconcileRefusal extends CommandError {
  /** Stable machine-readable reason. */
  readonly code: BeadsReconcileRefusalCode;
  /** Safe next action for the caller. */
  readonly remedy: string;
  /** Construct one refusal without exposing source file contents. */
  constructor(code: BeadsReconcileRefusalCode, remedy: string, cause?: unknown) {
    super(`${code}: ${remedy}`, 2);
    this.name = "BeadsReconcileRefusal";
    this.code = code;
    this.remedy = remedy;
    this.cause = cause;
  }
}

/** Hash deterministic canonical data for revisions and transaction identities. */
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/** Raise a typed refusal while keeping guard call sites compact. */
function refuse(code: BeadsReconcileRefusalCode, remedy: string): never {
  throw new BeadsReconcileRefusal(code, remedy);
}
/** Strip the core audit suffix appended for explicit field clearing. */
function historyMarker(message: string | undefined): string {
  return (message ?? "").split(" | ", 1)[0];
}
/** Normalize one record with the existing Beads alias and mapping rules. */
export function canonicalBeadsRecord(bead: BeadsItem): SnapshotRecord {
  const id = bead.id;
  if (typeof id !== "string" || !isEncodableBeadId(id)) refuse("invalid_snapshot", "Give every record a stable, unique, encodable Beads id.");
  const fields = {} as SnapshotFields;
  for (const field of RECONCILE_FIELDS) {
    if (field === "description") fields[field] = stripBeadIdMarker(bead.description);
    else if (field === "sprint" || field === "release") fields[field] = String(bead[field] ?? "");
    else if (field === "dependencies") fields[field] = JSON.stringify([...new Set(extractBlockerIds(bead))].sort());
    else if (field === "tags") fields[field] = JSON.stringify(parseTags(JSON.stringify(bead.labels ?? bead.tags ?? [])));
    else fields[field] = normalizeDiffField(bead, field);
  }
  return { id, fields };
}
/** Validate a complete JSONL snapshot before any acknowledgement or mutation. */
export function parseBeadsSnapshot(text: string): SnapshotRecord[] {
  const report = validateBeadsText(text);
  if (!report.valid || report.issues.some(issue => issue.code === "unknown_status")) refuse("invalid_snapshot", "Run beads validate and fix structural errors before reconciling a full snapshot.");
  const records = text.split("\n").filter(line => line.trim()).map(line => canonicalBeadsRecord(JSON.parse(line) as BeadsItem));
  assertRecords(records);
  return records.sort((a, b) => a.id.localeCompare(b.id, "en"));
}
/** Reject malformed or duplicate canonical records, including forged persisted bases. */
function assertRecords(records: SnapshotRecord[]): void {
  if (!Array.isArray(records)) refuse("invalid_snapshot", "Supply a canonical full snapshot array.");
  const ids = new Set<string>();
  for (const row of records) {
    if (!row || typeof row.id !== "string" || !isEncodableBeadId(row.id) || ids.has(row.id) ||
        !row.fields || RECONCILE_FIELDS.some(field => typeof row.fields[field] !== "string")) {
      refuse("invalid_snapshot", "Repair duplicate identities or malformed canonical fields; then preview again.");
    }
    ids.add(row.id);
  }
}
/** Build a deterministic three-way plan without writing tracker data. */
export function reconcileBeadsSnapshots(base: BeadsAcknowledgement, incoming: SnapshotRecord[], live: LiveSnapshotRecord[]): BeadsReconcilePlan {
  assertRecords(base.records); assertRecords(incoming); assertRecords(live);
  incoming = structuredClone(incoming).sort((a, b) => a.id.localeCompare(b.id, "en"));
  live = [...live].sort((a, b) => a.id.localeCompare(b.id, "en"));
  const old = new Map(base.records.map(row => [row.id, row]));
  const next = new Map(incoming.map(row => [row.id, row]));
  const local = new Map(live.map(row => [row.id, row]));
  const plan: BeadsReconcilePlan = {
    schema: 1, source: base.source, baseRevision: base.revision, trackerRevision: digest(live), digest: "",
    live: structuredClone(live), incoming, changes: [], conflicts: [], deletions: [], unchanged: 0, localOnly: 0,
  };
  for (const id of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    const b = old.get(id), n = next.get(id), l = local.get(id);
    if (!n) {
      if (l) plan.deletions.push({ id, pmId: l.pmId, locallyChanged: RECONCILE_FIELDS.some(field => b!.fields[field] !== l.fields[field]) });
      continue;
    }
    if (!l) {
      if (!b) plan.changes.push({ id, kind: "create", fields: [...RECONCILE_FIELDS] });
      else if (RECONCILE_FIELDS.some(field => b.fields[field] !== n.fields[field])) plan.conflicts.push({ id, field: "$item", base: "present", local: null, incoming: "changed" });
      else plan.localOnly++;
      continue;
    }
    const changed: ReconcileField[] = [];
    let localChanges = false;
    for (const field of RECONCILE_FIELDS) {
      const before = b?.fields[field] ?? null, after = n.fields[field], current = l.fields[field];
      if (current === after) continue;
      if (after === before) { localChanges = true; continue; }
      if (current === before) changed.push(field);
      else plan.conflicts.push({ id, field, base: before, local: current, incoming: after });
    }
    if (changed.length) plan.changes.push({ id, kind: "update", fields: changed });
    else if (localChanges) plan.localOnly++;
    else if (!plan.conflicts.some(conflict => conflict.id === id)) plan.unchanged++;
  }
  plan.digest = digest({ ...plan, digest: "" });
  return plan;
}
/** Resolve one source-owned state file without interpolating external ids into paths. */
function statePath(pmRoot: string, source: string): string {
  if (!source.trim()) refuse("invalid_snapshot", "Choose a nonempty source name and reuse it for the same external tracker.");
  return join(pmRoot, "beads", `${digest(source)}.json`);
}
/** Read and verify the acknowledged base, refusing corrupt state instead of resetting it. */
export async function readBeadsAcknowledgement(pmRoot: string, source: string): Promise<BeadsAcknowledgement | null> {
  let raw: string;
  try { raw = await readFile(statePath(pmRoot, source), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  let state: BeadsAcknowledgement;
  try { state = JSON.parse(raw) as BeadsAcknowledgement; }
  catch { return refuse("invalid_snapshot", "Restore a valid acknowledged base; do not silently reset source history."); }
  if (!state || state.schema !== 1 || state.source !== source ||
      state.revision !== digest({ source, previous: state.previous, records: state.records })) {
    refuse("invalid_snapshot", "Restore a valid acknowledged base; its revision or source does not match.");
  }
  assertRecords(state.records);
  return state;
}
/** Read the certified corpus and bind every identity to the core history version. */
export async function readLiveBeadsSnapshot(pmRoot: string): Promise<LiveSnapshotRecord[]> {
  const client = new PmClient({ pmRoot });
  const { items } = await client.listAllComplete();
  const translated = new Map(items.map(item => [item.id, decodeBeadId(item as PmItem) ?? item.id]));
  const live: LiveSnapshotRecord[] = [];
  for (const item of items) {
    const history = await readHistorySnapshot(getHistoryPath(pmRoot, item.id), item.id);
    const version = history.entries.at(-1)?.after_hash;
    if (typeof version !== "string") refuse("invalid_snapshot", "Repair missing core history versions before reconciling this tracker.");
    live.push({ ...canonicalBeadsRecord(pmItemToBead(item as PmItem, translated, true)), pmId: item.id, version, updatedAt: String(item.updated_at) });
  }
  live.sort((a, b) => a.id.localeCompare(b.id, "en"));
  assertRecords(live);
  return live;
}
/** Persist a source base atomically; omitted records stay pending until separately resolved. */
async function saveBase(pmRoot: string, source: string, previous: string | null, records: SnapshotRecord[]): Promise<BeadsAcknowledgement> {
  const state: BeadsAcknowledgement = { schema: 1, source, previous, records, revision: digest({ source, previous, records }) };
  await mkdir(join(pmRoot, "beads"), { recursive: true });
  await writeFileAtomic(statePath(pmRoot, source), JSON.stringify(state) + "\n");
  return state;
}
/** Bootstrap only from a snapshot that agrees with the live tracker; never reset an existing base. */
export async function acknowledgeBeadsSnapshot(pmRoot: string, source: string, records: SnapshotRecord[], author: string, options: BeadsApplyOptions = {}): Promise<BeadsAcknowledgement> {
  assertRecords(records);
  if (await readBeadsAcknowledgement(pmRoot, source)) refuse("base_exists", "Use reconcile against the existing base; choose another source only for a different tracker.");
  let acknowledged: BeadsAcknowledgement | undefined;
  await commitWorkspaceTransaction({ pmRoot, author, transactionId: `beads-ack-${randomUUID()}`, onTransition: options.onTransition, steps: [{
    id: "acknowledge",
    async inspect() {
      if (await readBeadsAcknowledgement(pmRoot, source)) refuse("base_exists", "Use reconcile against the existing base; choose another source only for a different tracker.");
      const live = new Map((await readLiveBeadsSnapshot(pmRoot)).map(row => [row.id, row.fields]));
      if (records.some(row => {
        const current = live.get(row.id);
        return !current || RECONCILE_FIELDS.some(field => row.fields[field] !== current[field]);
      })) refuse("ack_mismatch", "Import or resolve the snapshot first, then acknowledge a matching live baseline.");
      return { state: "pending" };
    },
    async apply() { acknowledged = await saveBase(pmRoot, source, null, records); return acknowledged.revision; },
    async compensate() { await rm(statePath(pmRoot, source), { force: true }); },
  }] });
  return acknowledged!;
}
/** Read a source base and produce a plan against a certified live snapshot. */
export async function planBeadsReconciliation(pmRoot: string, source: string, incoming: SnapshotRecord[]): Promise<BeadsReconcilePlan> {
  const base = await readBeadsAcknowledgement(pmRoot, source);
  if (!base) refuse("missing_base", "Acknowledge a matching baseline with beads reconcile --acknowledge before previewing changes.");
  return reconcileBeadsSnapshots(base, incoming, await readLiveBeadsSnapshot(pmRoot));
}
/** Translate canonical field deltas into public SDK mutation options. */
function mutationOptions(row: SnapshotRecord, fields: ReconcileField[], ids: Map<string, string>): PmClientFullMutationOptions {
  const options: PmClientFullMutationOptions = {};
  for (const field of fields) {
    const value = row.fields[field];
    if (field === "description") options.description = encodeBeadId(value, row.id);
    else if (field === "dependencies") {
      const dependencies = JSON.parse(value) as string[];
      if (dependencies.length) { options.replaceDeps = true; options.dep = dependencies.map(id => `id=${ids.get(id) ?? id},kind=blocked_by`); }
      else options.clearDeps = true;
    }
    else if (field === "tags") options.tags = value;
    else if (["assignee", "parent", "deadline", "sprint", "release"].includes(field) && value === "") {
      options.unset = [...(options.unset as string[] | undefined ?? []), field];
    } else if (field === "parent") options.parent = ids.get(value) ?? value;
    else options[field] = value;
  }
  if (options.status === "closed") options.closeReason = `Closed in acknowledged Beads source (${row.id})`;
  return options;
}
/** Transaction observations for diagnostics and deterministic interruption checks. */
export interface BeadsApplyOptions { onTransition?: CommitWorkspaceTransactionOptions["onTransition"] }
/** Apply a reviewed plan through core transactions, refusing drift before writes. Never delete omissions. */
export async function applyBeadsReconciliation(pmRoot: string, plan: BeadsReconcilePlan, author: string, options: BeadsApplyOptions = {}): Promise<{ applied: number; baseRevision: string; deletionProposals: number }> {
  if (plan.digest !== digest({ ...plan, digest: "" })) refuse("invalid_plan", "Generate a fresh plan; do not edit plan files.");
  if (plan.conflicts.length) refuse("conflicts", "Resolve reported field conflicts in the source or tracker and preview again.");
  const base = await readBeadsAcknowledgement(pmRoot, plan.source);
  if (!base || base.revision !== plan.baseRevision) refuse("stale_base", "The acknowledged base advanced; preview again against the current base.");
  const live = plan.live;
  assertRecords(live);
  const currentLive = await readLiveBeadsSnapshot(pmRoot);
  const transactionId = `beads-reconcile-${plan.digest}`;
  // A crashed attempt may already own some forward writes. Only exact latest
  // journal markers permit replay; unrelated edits still invalidate the plan.
  const comparable: LiveSnapshotRecord[] = [];
  for (const record of currentLive) {
    const history = await readHistorySnapshot(getHistoryPath(pmRoot, record.pmId), record.pmId);
    const message = historyMarker(history.entries.at(-1)?.message);
    if (plan.changes.some(change => change.id === record.id) &&
        message.startsWith(`${transactionId}:`) && /^\d+$/.test(message.slice(transactionId.length + 1))) {
      const original = live.find(row => row.id === record.id);
      if (original) comparable.push(original);
    } else comparable.push(record);
  }
  if (digest(comparable) !== plan.trackerRevision) refuse("stale_tracker", "The tracker changed since preview; generate a fresh reconciliation plan.");
  const fresh = reconcileBeadsSnapshots(base, plan.incoming, live);
  if (fresh.digest !== plan.digest) refuse("invalid_plan", "Generate a fresh plan from the original incoming snapshot.");
  const settings = await readSettings(pmRoot);
  const ids = new Map(live.map(row => [row.id, row.pmId]));
  for (const change of plan.changes) if (change.kind === "create") ids.set(change.id, normalizeItemId(`beads-${digest([plan.source, change.id]).slice(0, 24)}`, settings.id_prefix));
  const rows = new Map(plan.incoming.map(row => [row.id, row]));
  const client = new PmClient({ pmRoot, author });
  // Create identities first, then update scalar fields, then link relationships.
  const operations = [
    ...plan.changes.filter(change => change.kind === "create").map(change => ({ ...change, fields: change.fields.filter(field => field !== "parent" && field !== "dependencies"), phase: "create" })),
    ...plan.changes.filter(change => change.kind === "update").map(change => ({ ...change, fields: change.fields.filter(field => field !== "parent" && field !== "dependencies"), phase: "update" })),
    ...plan.changes.map(change => ({ ...change, kind: "update" as const, fields: change.fields.filter(field => field === "parent" || field === "dependencies"), phase: "links" })).filter(change => change.fields.length > 0),
  ].filter(change => change.fields.length > 0);
  const steps: WorkspaceTransactionStep[] = operations.map((change, index) => {
    const id = ids.get(change.id)!;
    const original = live.find(row => row.id === change.id);
    const marker = `${transactionId}:${index}`;
    return {
      id: `item-${index}`,
      async inspect() {
        const history = await readHistorySnapshot(getHistoryPath(pmRoot, id), id);
        const last = history.entries.at(-1);
        if (historyMarker(history.entries.filter(entry => historyMarker(entry.message) === marker || historyMarker(entry.message) === `${marker}:compensated`).at(-1)?.message) === marker) return { state: "applied" };
        if ((last?.after_hash ?? null) !== (original?.version ?? null) &&
            !(change.phase === "links" && last?.message?.startsWith(`${transactionId}:`))) refuse("stale_tracker", "An item changed before application; preview again.");
        return { state: "pending" };
      },
      async prepareCompensation() {
        const history = await readHistorySnapshot(getHistoryPath(pmRoot, id), id);
        const last = history.entries.at(-1);
        if (!last) return undefined;
        const snapshot = await client.get(id, { at: last.ts });
        if (typeof snapshot.as_of_version !== "number") refuse("recovery_required", "This history has no exact version mapping. Recover its version mapping before applying a reversible reconciliation.");
        return String(snapshot.as_of_version);
      },
      async apply() {
        const options: PmClientFullMutationOptions = { ...mutationOptions(rows.get(change.id)!, change.fields, ids), message: marker };
        if (change.kind === "create") {
          // New identities always carry provenance even when the source has no description.
          options.description = encodeBeadId(rows.get(change.id)!.fields.description, change.id);
          delete options.unset;
          await client.create({ ...options, id });
        } else await client.update(id, options);
        return id;
      },
      async compensate(target) {
        const history = await readHistorySnapshot(getHistoryPath(pmRoot, id), id);
        if (!history.entries.some(entry => historyMarker(entry.message) === marker)) refuse("invalid_snapshot", "Transaction history is missing; restore valid history and inspect recovery before retrying.");
        if (!history.entries.at(-1)?.message?.startsWith(`${transactionId}:`)) refuse("stale_tracker", "A later writer changed a transaction item; preserve that edit and replan recovery.");
        if ((original || change.phase === "links") && typeof target === "string") await client.restore(id, target, { message: `${marker}:compensated` });
        else await client.close(id, "Compensated interrupted Beads reconciliation", { message: `${marker}:compensated` });
      },
    };
  });
  const retained = base.records.filter(row => !rows.has(row.id));
  const records = [...plan.incoming, ...retained].sort((a, b) => a.id.localeCompare(b.id, "en"));
  const expected = digest({ source: plan.source, previous: base.revision, records });
  steps.push({ id: "acknowledge", async inspect() {
    const current = await readBeadsAcknowledgement(pmRoot, plan.source);
    if (current?.revision !== base.revision) refuse("stale_base", "The acknowledged source advanced; preview again.");
    return { state: "pending" };
  }, async apply() { await saveBase(pmRoot, plan.source, base.revision, records); return expected; },
  async compensate() {
    if ((await readBeadsAcknowledgement(pmRoot, plan.source))?.revision !== expected) refuse("stale_base", "A later source acknowledgement exists; preserve it and replan recovery.");
    await writeFileAtomic(statePath(pmRoot, plan.source), JSON.stringify(base) + "\n");
  } });
  try {
    await commitWorkspaceTransaction({ pmRoot, author, transactionId, steps,
    async onTransition(context) {
      await options.onTransition?.(context);
      if (context.transition === "prepared") {
        const current = await readBeadsAcknowledgement(pmRoot, plan.source);
        if (current?.revision !== base.revision) refuse("stale_base", "The base advanced while waiting for the writer lock; preview again.");
        if (digest(await readLiveBeadsSnapshot(pmRoot)) !== plan.trackerRevision) refuse("stale_tracker", "The tracker changed while waiting for the writer lock; preview again.");
      }
    },
  });
  } catch (error) {
    if (error instanceof AggregateError) throw new BeadsReconcileRefusal("recovery_required", "Application and compensation could not finish. Inspect the core transaction journal and item history, preserve later edits, then replan recovery.", error);
    throw error;
  }
  return { applied: plan.changes.length, baseRevision: expected, deletionProposals: plan.deletions.length };
}
/** Return bounded agent output while preserving totals and an explicit omission receipt. */
export function summarizeBeadsReconciliation(plan: BeadsReconcilePlan, limit = 20) {
  const rows = [
    ...plan.conflicts.map(row => ({ id: row.id, kind: "conflict", fields: [row.field] })),
    ...plan.changes.map(row => ({ id: row.id, kind: row.kind, fields: row.fields })),
    ...plan.deletions.map(row => ({ id: row.id, kind: "deletion_proposal", fields: [] })),
  ];
  return { source: plan.source, baseRevision: plan.baseRevision, trackerRevision: plan.trackerRevision,
    counts: { incoming: plan.incoming.length, changes: plan.changes.length, conflicts: plan.conflicts.length, deletionProposals: plan.deletions.length, unchanged: plan.unchanged, localOnly: plan.localOnly },
    rows: rows.slice(0, limit), omitted: Math.max(0, rows.length - limit), remedy: "Use --plan-out to retain full values and apply the reviewed plan with --apply-plan." };
}
/** Run the CLI workflow; host rendering supplies TOON or JSON for the returned object. */
async function runReconcile(ctx: CommandHandlerContext) {
  const source = optionString(ctx.options, "source");
  if (!source) refuse("invalid_snapshot", "Pass --source with a stable external tracker name.");
  const author = ctx.global.author ?? process.env.PM_AUTHOR ?? "pm-beads";
  const applyFile = optionString(ctx.options, "apply-plan", "applyPlan");
  if (applyFile) {
    let plan: BeadsReconcilePlan;
    try { plan = JSON.parse(await readFile(applyFile, "utf8")) as BeadsReconcilePlan; }
    catch { return refuse("invalid_plan", "Read a valid plan saved by --plan-out and retry."); }
    if (!plan || plan.source !== source) refuse("invalid_plan", "Select the same source that owns the saved reconciliation plan.");
    return applyBeadsReconciliation(ctx.pm_root, plan, author);
  }
  const file = ctx.args[0];
  if (!file) refuse("invalid_snapshot", "Pass a full Beads JSONL snapshot or --apply-plan with a reviewed plan.");
  const records = parseBeadsSnapshot(await readFile(file, "utf8"));
  if (readBoolOption(ctx.options, "acknowledge")) {
    const base = await acknowledgeBeadsSnapshot(ctx.pm_root, source, records, author);
    return { acknowledged: records.length, source, baseRevision: base.revision };
  }
  const plan = await planBeadsReconciliation(ctx.pm_root, source, records);
  const output = optionString(ctx.options, "plan-out", "planOut");
  if (output) await writeFileAtomic(output, JSON.stringify(plan) + "\n");
  return summarizeBeadsReconciliation(plan);
}
/** Register the canonical command and rich-help alias with one typed handler. */
export function registerReconcileCommands(api: ExtensionApi): void {
  for (const name of ["beads reconcile", "beads-reconcile"]) api.registerCommand({
    name, description: "Preview three-way Beads changes against an acknowledged source base; apply reviewed plans with stale-base protection.",
    arguments: [{ name: "file", required: false, description: "Full incoming Beads JSONL snapshot." }],
    flags: [
      { long: "--source", value_type: "string", value_name: "name", description: "Stable external tracker identity." },
      { long: "--acknowledge", value_type: "boolean", description: "Initialize a matching acknowledged baseline once." },
      { long: "--plan-out", value_type: "string", value_name: "file", description: "Save the full reviewable plan including conflict values." },
      { long: "--apply-plan", value_type: "string", value_name: "file", description: "Apply a reviewed plan, refusing stale bases, tracker drift and conflicts." },
    ],
    examples: ["pm beads reconcile base.jsonl --source team --acknowledge", "pm beads reconcile incoming.jsonl --source team --plan-out review.json", "pm beads reconcile --source team --apply-plan review.json --json"],
    run: runReconcile,
  });
}
