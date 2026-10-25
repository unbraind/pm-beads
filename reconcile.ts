/** Three-way Beads reconciliation with durable, source-scoped acknowledgements. */
import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  PmClient, preserveMutationStdinTokenFields, commitWorkspaceTransaction,
  writeFileAtomic, parseTags, resolveTypeSynonym,
  type CommitWorkspaceTransactionOptions,
  type WorkspaceTransactionStep, type PmClientFullMutationOptions, type Dependency,
} from "@unbrained/pm-cli/sdk";
import type { ExtensionApi, CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import { allocateBeadsItemId, readBeadsItemHistory } from "./item-access.ts";
import { beadsMutationAuthor, sourceCreateOptions, sourceDependency, preserveBeadsProgress } from "./mutation.ts";
import { ensureBeadIdentityField, reportLegacyBeadIdentities, legacyBeadIdentity } from "./identity.ts";
import { CommandError, DIFF_FIELDS } from "./contracts.ts";
import {
  normalizeDiffField, extractBlockerIds,
  pmItemToBead, decodeBeadId, isEncodableBeadId, validateBeadsText,
  optionString, readBoolOption, resolveImportInputFile, type BeadsItem, type PmItem,
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
  /** Durable external-to-core identities owned by this source; absent in legacy bases. */
  bindings?: Record<string, string>;
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
export type BeadsReconcileRefusalCode = "invalid_snapshot" | "missing_base" | "base_exists" | "stale_base" | "stale_tracker" | "conflicts" | "invalid_plan" | "ack_mismatch" | "recovery_required" | "identity_migration_required";
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
/** Compare Beads aliases and persisted legacy values using the host's canonical type and date forms. */
function normalizeSnapshotFields(fields: SnapshotFields): SnapshotFields {
  const raw = fields.deadline;
  if (raw && !Number.isFinite(Date.parse(raw))) refuse("invalid_snapshot", "Use an ISO date or timestamp for every nonempty deadline.");
  return { ...fields, type: (resolveTypeSynonym(fields.type) ?? fields.type).toLowerCase(), deadline: raw ? new Date(raw).toISOString() : "" };
}
/** Normalize one record with the existing Beads alias and mapping rules. */
export function canonicalBeadsRecord(bead: BeadsItem): SnapshotRecord {
  const id = bead.id;
  if (typeof id !== "string" || !isEncodableBeadId(id)) refuse("invalid_snapshot", "Give every record a stable, unique, encodable Beads id.");
  const fields = {} as SnapshotFields;
  for (const field of RECONCILE_FIELDS) {
    if (field === "description") fields[field] = bead.description ?? "";
    else if (field === "sprint" || field === "release") fields[field] = String(bead[field] ?? "");
    else if (field === "dependencies") fields[field] = JSON.stringify([...new Set(extractBlockerIds(bead))].sort());
    else if (field === "tags") fields[field] = JSON.stringify(parseTags(JSON.stringify(bead.labels ?? bead.tags ?? [])));
    else fields[field] = normalizeDiffField(bead, field);
  }
  return { id, fields: normalizeSnapshotFields(fields) };
}
/** Validate a complete JSONL snapshot before any acknowledgement or mutation. */
export function parseBeadsSnapshot(text: string): SnapshotRecord[] {
  const report = validateBeadsText(text);
  if (!report.valid || report.issues.some(issue => issue.code === "unknown_status")) refuse("invalid_snapshot", "Run beads validate and fix structural errors before reconciling a full snapshot.");
  const records = text.split("\n").filter(line => line.trim()).map(line => canonicalBeadsRecord(JSON.parse(line) as BeadsItem));
  assertRecords(records);
  return records.sort((a, b) => a.id.localeCompare(b.id, "en"));
}
/** Check the JSON representation of a canonical tag or dependency collection. */
function isJsonStringArray(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item: unknown) => typeof item === "string");
  } catch {
    return false;
  }
}
/** Reject malformed or duplicate canonical records, including forged persisted bases. */
function assertRecords(records: SnapshotRecord[]): void {
  if (!Array.isArray(records)) refuse("invalid_snapshot", "Supply a canonical full snapshot array.");
  const ids = new Set<string>();
  for (const row of records) {
    if (!row || typeof row.id !== "string" || !isEncodableBeadId(row.id) || ids.has(row.id) ||
        !row.fields || RECONCILE_FIELDS.some(field => typeof row.fields[field] !== "string") ||
        !isJsonStringArray(row.fields.tags) || !isJsonStringArray(row.fields.dependencies)) {
      refuse("invalid_snapshot", "Repair duplicate identities or malformed canonical fields, including JSON string arrays for tags and dependencies; then preview again.");
    }
    ids.add(row.id);
  }
}
/** Build a deterministic three-way plan without writing tracker data. */
export function reconcileBeadsSnapshots(base: BeadsAcknowledgement, incoming: SnapshotRecord[], live: LiveSnapshotRecord[]): BeadsReconcilePlan {
  assertRecords(base.records); assertRecords(incoming); assertRecords(live);
  base = { ...base, records: base.records.map(row => ({ ...row, fields: normalizeSnapshotFields(row.fields) })) };
  incoming = structuredClone(incoming).map(row => ({ ...row, fields: normalizeSnapshotFields(row.fields) })).sort((a, b) => a.id.localeCompare(b.id, "en"));
  live = live.map(row => ({ ...row, fields: normalizeSnapshotFields(row.fields) })).sort((a, b) => a.id.localeCompare(b.id, "en"));
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
/** Validate persisted or caller-selected source identity bindings before resolving aliases. */
function assertBindings(value: unknown): asserts value is Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.entries(value).some(([id, pmId]) => !isEncodableBeadId(id) || typeof pmId !== "string" || !pmId.trim())) {
    refuse("invalid_snapshot", "Supply a bindings object mapping stable external ids to nonempty core item ids.");
  }
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
      state.revision !== digest({ source, previous: state.previous, records: state.records, ...(state.bindings ? { bindings: state.bindings } : {}) })) {
    refuse("invalid_snapshot", "Restore a valid acknowledged base; its revision or source does not match.");
  }
  assertRecords(state.records);
  if (state.bindings !== undefined) assertBindings(state.bindings);
  return state;
}
/** Resolve source-owned aliases without letting copied or foreign markers select an item. */
async function sourceIdentities(pmRoot: string, source: string, records: readonly SnapshotRecord[], bindings: Readonly<Record<string, string>>, items: readonly PmItem[]): Promise<Map<string, string>> {
  assertBindings(bindings);
  const selected = new Map<string, string>();
  const claimed = new Set<string>();
  let files: string[];
  try { files = await readdir(join(pmRoot, "beads")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") refuse("invalid_snapshot", "Restore a readable source acknowledgement directory before reconciling."); files = []; }
  for (const file of files.filter(file => /^[a-f0-9]{64}\.json$/.test(file))) {
    let stored: BeadsAcknowledgement;
    try { stored = JSON.parse(await readFile(join(pmRoot, "beads", file), "utf8")) as BeadsAcknowledgement; }
    catch { return refuse("invalid_snapshot", "Repair unreadable or invalid source acknowledgement files before reconciling."); }
    if (!stored || typeof stored.source !== "string") refuse("invalid_snapshot", "Repair source acknowledgement files with missing source identities.");
    if (stored.source === source) continue;
    const other = await readBeadsAcknowledgement(pmRoot, stored.source);
    if (!other) refuse("invalid_snapshot", "Restore a matching source acknowledgement file before reconciling.");
    const owned = other.bindings ? Object.values(other.bindings)
      : items.filter(item => other.records.some(record => (decodeBeadId(item) ?? item.id) === record.id)).map(item => item.id!);
    for (const pmId of owned) claimed.add(pmId);
  }
  for (const [externalId, pmId] of Object.entries(bindings)) {
    if (selected.has(pmId) || claimed.has(pmId)) refuse("invalid_snapshot", "Use unique core item ids not already bound to another source.");
    selected.set(pmId, externalId);
  }
  for (const record of records) {
    if (Object.hasOwn(bindings, record.id)) continue;
    const matches = items.filter(item => !claimed.has(item.id!) && !selected.has(item.id!) && (decodeBeadId(item) ?? item.id) === record.id);
    if (matches.length > 1) refuse("invalid_snapshot", `Ambiguous Beads id ${JSON.stringify(record.id)} matches core ids ${matches.map(item => JSON.stringify(item.id)).join(", ")}. Acknowledge with an explicit bindings map in the SDK.`);
    if (matches.length === 1) selected.set(matches[0].id!, record.id);
  }
  const occupied = new Set([...records.map(record => record.id), ...Object.keys(bindings), ...selected.values()]);
  const translated = new Map<string, string>();
  for (const item of items) {
    const bound = selected.get(item.id!);
    let id = bound ?? item.id!;
    if (bound === undefined) while (occupied.has(id)) id = `local:${id}`;
    occupied.add(id);
    translated.set(item.id!, id);
  }
  return translated;
}
/** Read the certified corpus and bind source aliases to core identities and history versions. */
export async function readLiveBeadsSnapshot(pmRoot: string, source?: string, records: readonly SnapshotRecord[] = [], bindings: Readonly<Record<string, string>> = {}, author?: string): Promise<LiveSnapshotRecord[]> {
  const client = new PmClient({ pmRoot, noExtensions: true, author: beadsMutationAuthor(author) });
  const { items } = await client.listAllComplete();
  reportLegacyBeadIdentities(items);
  const translated = source === undefined
    ? new Map(items.map(item => [item.id, decodeBeadId(item as PmItem) ?? item.id]))
    : await sourceIdentities(pmRoot, source, records, bindings, items as PmItem[]);
  const live: LiveSnapshotRecord[] = [];
  for (const item of items) {
    const history = await readBeadsItemHistory(pmRoot, item.id);
    const version = history.entries.at(-1)?.after_hash;
    if (typeof version !== "string") refuse("invalid_snapshot", "Repair missing core history versions before reconciling this tracker.");
    const bead = pmItemToBead(item as PmItem, translated, true);
    bead.id = translated.get(item.id)!;
    live.push({ ...canonicalBeadsRecord(bead), pmId: item.id, version, updatedAt: String(item.updated_at) });
  }
  live.sort((a, b) => a.id.localeCompare(b.id, "en"));
  assertRecords(live);
  return live;
}
/** Persist a source base atomically; omitted records stay pending until separately resolved. */
async function saveBase(pmRoot: string, source: string, previous: string | null, records: SnapshotRecord[], bindings: Record<string, string>): Promise<BeadsAcknowledgement> {
  const state: BeadsAcknowledgement = { schema: 1, source, previous, records, bindings, revision: digest({ source, previous, records, bindings }) };
  await mkdir(join(pmRoot, "beads"), { recursive: true });
  await writeFileAtomic(statePath(pmRoot, source), JSON.stringify(state) + "\n");
  return state;
}
/** Acknowledge matching live data or add explicit bindings to an unchanged legacy base; never reset it. */
export async function acknowledgeBeadsSnapshot(pmRoot: string, source: string, records: SnapshotRecord[], author: string, options: BeadsAcknowledgeOptions = {}): Promise<BeadsAcknowledgement> {
  assertRecords(records);
  records = records.map(row => ({ ...row, fields: normalizeSnapshotFields(row.fields) }));
  const existing = await readBeadsAcknowledgement(pmRoot, source);
  const migrating = existing !== null && existing.bindings === undefined && options.bindings !== undefined;
  if (existing && !migrating) refuse("base_exists", "Use reconcile against the existing base; choose another source only for a different tracker.");
  if (migrating) {
    const previous = new Map(existing.records.map(row => [row.id, normalizeSnapshotFields(row.fields)]));
    if (records.length !== previous.size || records.some(row => {
      const before = previous.get(row.id);
      return !before || RECONCILE_FIELDS.some(field => row.fields[field] !== before[field]);
    })) refuse("ack_mismatch", "Preserve every acknowledged field value when adding legacy source bindings; do not reset the baseline.");
  }
  let acknowledged: BeadsAcknowledgement | undefined;
  let bindings: Record<string, string> = {};
  try {
    await commitWorkspaceTransaction({ pmRoot, author, transactionId: `beads-ack-${randomUUID()}`, onTransition: options.onTransition, steps: [{
    id: "acknowledge",
    async inspect() {
      const currentBase = await readBeadsAcknowledgement(pmRoot, source);
      if (migrating) {
        if (currentBase?.revision !== existing.revision) refuse("stale_base", "The legacy source advanced; re-read its baseline before adding bindings.");
      } else if (currentBase) refuse("base_exists", "Use reconcile against the existing base; choose another source only for a different tracker.");
      const snapshot = await readLiveBeadsSnapshot(pmRoot, source, records, options.bindings, author);
      const live = new Map(snapshot.map(row => [row.id, row.fields]));
      bindings = Object.fromEntries(snapshot.filter(row => records.some(record => record.id === row.id)).map(row => [row.id, row.pmId]));
      if (records.some(row => {
        const current = live.get(row.id);
        return !current || (!migrating && RECONCILE_FIELDS.some(field => row.fields[field] !== current[field]));
      })) refuse("ack_mismatch", "Import or resolve every record, then export the tracker and acknowledge that matching live baseline.");
      return { state: "pending" };
    },
    async apply() { acknowledged = await saveBase(pmRoot, source, existing?.revision ?? null, records, bindings); return acknowledged.revision; },
    async compensate() {
      if (existing) {
        const expected = digest({ source, previous: existing.revision, records, bindings });
        if ((await readBeadsAcknowledgement(pmRoot, source))?.revision !== expected) refuse("stale_base", "A later source acknowledgement exists; preserve it and replan binding recovery.");
        await writeFileAtomic(statePath(pmRoot, source), JSON.stringify(existing) + "\n");
      }
      else await rm(statePath(pmRoot, source), { force: true });
    },
  }] });
  } catch (error) {
    if (error instanceof AggregateError) throw new BeadsReconcileRefusal("recovery_required", "Binding migration could not compensate safely. Preserve later source revisions and inspect the transaction journal before retrying.", error);
    throw error;
  }
  return acknowledged!;
}
/** Read a source base and produce a plan against a certified live snapshot. */
export async function planBeadsReconciliation(pmRoot: string, source: string, incoming: SnapshotRecord[]): Promise<BeadsReconcilePlan> {
  const base = await readBeadsAcknowledgement(pmRoot, source);
  if (!base) refuse("missing_base", "Acknowledge a matching baseline with beads reconcile --acknowledge before previewing changes.");
  return reconcileBeadsSnapshots(base, incoming, await readLiveBeadsSnapshot(pmRoot, source, [...base.records, ...incoming], base.bindings));
}
/** Translate canonical field deltas into public SDK mutation options. */
function mutationOptions(row: SnapshotRecord, fields: ReconcileField[], ids: Map<string, string>, currentDependencies: readonly Dependency[], author: string): PmClientFullMutationOptions {
  const options: PmClientFullMutationOptions = {};
  for (const field of fields) {
    const value = row.fields[field];
    if (field === "description") options.description = value;
    else if (field === "dependencies") {
      const incoming = new Set((JSON.parse(value) as string[]).map(id => ids.get(id) ?? id));
      // Kind-scoped deltas retain local edge records and their original provenance.
      const current = new Set(currentDependencies.filter(edge => edge.kind.toLowerCase() === "blocked_by").map(edge => edge.id));
      const additions = [...incoming].filter(id => !current.has(id));
      const removals = [...current].filter(id => !incoming.has(id));
      if (additions.length) options.dep = additions.map(id => sourceDependency(id, author));
      if (removals.length) options.depRemove = removals.map(id => `id=${JSON.stringify(id)},kind=blocked_by`);
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
/** Explicit identity selection for first acknowledgements and legacy binding migration. */
export interface BeadsAcknowledgeOptions extends BeadsApplyOptions { bindings?: Readonly<Record<string, string>> }
/** Transaction observations for diagnostics and deterministic interruption checks. */
export interface BeadsApplyOptions { onTransition?: CommitWorkspaceTransactionOptions["onTransition"] }
/** Apply a reviewed plan with workspace transactions and per-item history checks. Never delete omissions. */
export async function applyBeadsReconciliation(pmRoot: string, plan: BeadsReconcilePlan, author: string, options: BeadsApplyOptions = {}): Promise<{ applied: number; baseRevision: string; deletionProposals: number }> {
  if (plan.digest !== digest({ ...plan, digest: "" })) refuse("invalid_plan", "Generate a fresh plan; do not edit plan files.");
  if (plan.conflicts.length) refuse("conflicts", "Resolve reported field conflicts in the source or tracker and preview again.");
  const base = await readBeadsAcknowledgement(pmRoot, plan.source);
  if (!base || base.revision !== plan.baseRevision) refuse("stale_base", "The acknowledged base advanced; preview again against the current base.");
  const live = plan.live;
  assertRecords(live);
  const currentLive = await readLiveBeadsSnapshot(pmRoot, plan.source, [...base.records, ...plan.incoming], base.bindings, author);
  const transactionId = `beads-reconcile-${plan.digest}`;
  // A crashed attempt may already own some forward writes. Only exact latest
  // journal markers permit replay; unrelated edits still invalidate the plan.
  const comparable: LiveSnapshotRecord[] = [];
  for (const record of currentLive) {
    const history = await readBeadsItemHistory(pmRoot, record.pmId);
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
  const ids = new Map([...Object.entries(base.bindings ?? {}), ...live.map(row => [row.id, row.pmId] as const)]);
  // A separate SDK transaction durably pins generated identities before any row
  // mutation. Its ledger is package state, never a tracker item storage path.
  const identityPath = join(pmRoot, "beads", `${plan.digest}.identities.json`);
  const creates = plan.changes.filter(change => change.kind === "create");
  /** Validate retained reservations on fresh and committed-bootstrap replay alike. */
  const readReserved = async (): Promise<Record<string, string>> => {
    const saved = JSON.parse(await readFile(identityPath, "utf8")) as Record<string, string>;
    if (!saved || typeof saved !== "object" || Array.isArray(saved) || Object.keys(saved).length !== creates.length ||
        creates.some(change => typeof saved[change.id] !== "string" || !saved[change.id]) ||
        new Set(Object.values(saved)).size !== creates.length) refuse("invalid_snapshot", "Restore the reconciliation identity ledger before resuming.");
    return saved;
  };
  await commitWorkspaceTransaction({ pmRoot, author, transactionId: `${transactionId}-identity`, steps: [{
    id: "identities", async inspect() {
      try { await readReserved(); return { state: "applied" }; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return { state: "pending" };
      }
    }, async apply() {
      const saved: Record<string, string> = Object.create(null) as Record<string, string>;
      const allocated = new Set<string>();
      for (const change of plan.changes) if (change.kind === "create") {
        saved[change.id] = await allocateBeadsItemId(pmRoot, allocated); ids.set(change.id, saved[change.id]);
      }
      await mkdir(join(pmRoot, "beads"), { recursive: true });
      await writeFileAtomic(identityPath, JSON.stringify(saved) + "\n");
    }, compensate: preserveBeadsProgress,
  }] });
  const reserved = await readReserved();
  for (const change of plan.changes) if (change.kind === "create") ids.set(change.id, reserved[change.id]);
  const rows = new Map(plan.incoming.map(row => [row.id, row]));
  const client = new PmClient({ pmRoot, author, noExtensions: true });
  for (const change of plan.changes) {
    if (change.kind !== "update" || !change.fields.includes("description")) continue;
    const item = (await client.get(ids.get(change.id)!)).item;
    if (item.bead_id === undefined && legacyBeadIdentity(item.description)) refuse("identity_migration_required", "Run pm beads migrate-identities --apply, then preview again before replacing a legacy description.");
  }
  await ensureBeadIdentityField(client);
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
        const history = await readBeadsItemHistory(pmRoot, id);
        const last = history.entries.at(-1);
        if (historyMarker(history.entries.filter(entry => historyMarker(entry.message) === marker || historyMarker(entry.message) === `${marker}:compensated`).at(-1)?.message) === marker) return { state: "applied" };
        if ((last?.after_hash ?? null) !== (original?.version ?? null) &&
            !(change.phase === "links" && last?.message?.startsWith(`${transactionId}:`))) refuse("stale_tracker", "An item changed before application; preview again.");
        return { state: "pending" };
      },
      async prepareCompensation() {
        const history = await readBeadsItemHistory(pmRoot, id);
        const last = history.entries.at(-1);
        if (!last) return undefined;
        const snapshot = await client.get(id, { at: last.ts });
        if (typeof snapshot.as_of_version !== "number") refuse("recovery_required", "This history has no exact version mapping. Recover its version mapping before applying a reversible reconciliation.");
        return String(snapshot.as_of_version);
      },
      async apply() {
        const fields: ReconcileField[] = change.fields;
        const current = fields.includes("dependencies") ? await client.get(id) : undefined;
        const dependencies = (current?.item.dependencies ?? []) as Dependency[];
        const options: PmClientFullMutationOptions = { ...mutationOptions(rows.get(change.id)!, fields, ids, dependencies, author), message: marker, author };
        if (change.kind === "create") {
          // New identities always carry provenance even when the source has no description.
          options.description = rows.get(change.id)!.fields.description;
          options.beadId = change.id;
          delete options.unset;
          await client.create(preserveMutationStdinTokenFields(sourceCreateOptions({ ...options, id }, author), ["description"]));
        } else await client.update(id, preserveMutationStdinTokenFields(options, ["description"]));
        return id;
      },
      async compensate(target) {
        const history = await readBeadsItemHistory(pmRoot, id);
        if (!history.entries.some(entry => historyMarker(entry.message) === marker)) refuse("invalid_snapshot", "Transaction history is missing; restore valid history and inspect recovery before retrying.");
        if (!history.entries.at(-1)?.message?.startsWith(`${transactionId}:`)) refuse("stale_tracker", "A later writer changed a transaction item; preserve that edit and replan recovery.");
        if ((original || change.phase === "links") && typeof target === "string") await client.restore(id, target, { message: `${marker}:compensated`, author });
        else await client.close(id, "Compensated interrupted Beads reconciliation", { message: `${marker}:compensated`, force: true, author });
      },
    };
  });
  const retained = base.records.filter(row => !rows.has(row.id));
  const records = [...plan.incoming, ...retained].map(row => ({ ...row, fields: normalizeSnapshotFields(row.fields) })).sort((a, b) => a.id.localeCompare(b.id, "en"));
  const bindings = Object.fromEntries(records.filter(row => ids.has(row.id)).map(row => [row.id, ids.get(row.id)!]));
  const expected = digest({ source: plan.source, previous: base.revision, records, bindings });
  steps.push({ id: "acknowledge", async inspect() {
    const current = await readBeadsAcknowledgement(pmRoot, plan.source);
    if (current?.revision !== base.revision) refuse("stale_base", "The acknowledged source advanced; preview again.");
    return { state: "pending" };
  }, async apply() { await saveBase(pmRoot, plan.source, base.revision, records, bindings); return expected; },
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
        if (digest(await readLiveBeadsSnapshot(pmRoot, plan.source, [...base.records, ...plan.incoming], base.bindings, author)) !== plan.trackerRevision) refuse("stale_tracker", "The tracker changed while waiting for the writer lock; preview again.");
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
  const author = beadsMutationAuthor(ctx.global.author);
  const applyFile = optionString(ctx.options, "apply-plan", "applyPlan");
  if (applyFile) {
    let plan: BeadsReconcilePlan;
    try { plan = JSON.parse(await readFile(applyFile, "utf8")) as BeadsReconcilePlan; }
    catch { return refuse("invalid_plan", "Read a valid plan saved by --plan-out and retry."); }
    if (!plan || plan.source !== source) refuse("invalid_plan", "Select the same source that owns the saved reconciliation plan.");
    return applyBeadsReconciliation(ctx.pm_root, plan, author);
  }
  const file = resolveImportInputFile(ctx.args, ["--source", "--plan-out", "--apply-plan"]);
  if (!file) refuse("invalid_snapshot", "Pass a full Beads JSONL snapshot or --apply-plan with a reviewed plan.");
  let raw: string;
  try { raw = await readFile(file, "utf8"); }
  catch { return refuse("invalid_snapshot", "Read an accessible full Beads JSONL snapshot and retry."); }
  const records = parseBeadsSnapshot(raw);
  if (readBoolOption(ctx.options, "acknowledge")) {
    const base = await acknowledgeBeadsSnapshot(ctx.pm_root, source, records, author);
    return { acknowledged: records.length, source, baseRevision: base.revision };
  }
  const plan = await planBeadsReconciliation(ctx.pm_root, source, records);
  const output = optionString(ctx.options, "plan-out", "planOut");
  if (output) {
    try { await writeFileAtomic(output, JSON.stringify(plan) + "\n"); }
    catch { return refuse("invalid_plan", "Save the reviewed plan to a writable file and retry."); }
  }
  return summarizeBeadsReconciliation(plan);
}
/** Register the canonical command and rich-help alias with one typed handler. */
export function registerReconcileCommands(api: ExtensionApi): void {
  for (const name of ["beads reconcile", "beads-reconcile"]) api.registerCommand({
    name, description: "Preview three-way Beads changes against an acknowledged source base; apply reviewed plans with stale-base protection.",
    arguments: [{ name: "file", required: false, description: "Full incoming Beads JSONL snapshot." }],
    flags: [
      { long: "--source", value_type: "string", value_name: "name", description: "Stable external tracker identity." },
      { long: "--acknowledge", value_type: "boolean", description: "Initialize a matching baseline once; after import, acknowledge a live export." },
      { long: "--plan-out", value_type: "string", value_name: "file", description: "Save conflict values and every live tracker record, including local descriptions; use tracker access controls and retention." },
      { long: "--apply-plan", value_type: "string", value_name: "file", description: "Apply a reviewed plan, refusing stale bases, tracker drift and conflicts." },
    ],
    examples: ["pm beads reconcile acknowledged.jsonl --source team --acknowledge", "pm beads reconcile incoming.jsonl --source team --plan-out review.json", "pm beads reconcile --source team --apply-plan review.json --json"],
    run: runReconcile,
  });
}
