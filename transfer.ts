/** Dependency-closed, resumable Beads creation using the host's durable transaction journals. */
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  PmClient, commitWorkspaceTransaction, getHistoryPath, readHistorySnapshot,
  locateItem, readLocatedItem, verifyHistoryEntries, normalizeItemId, readSettings, writeFileAtomic,
  type CommitWorkspaceTransactionOptions, type PmClientFullMutationOptions,
  type WorkspaceTransactionStep,
} from "@unbrained/pm-cli/sdk";
import type { CommandHandlerContext, ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { CommandError } from "./contracts.ts";
import { encodeBeadId, optionString, resolveImportInputFile, type BeadsItem } from "./index.ts";
import { parseBeadsSnapshot, type SnapshotRecord } from "./reconcile.ts";
import { distinctOutput } from "./sidecar.ts";
import { beadsMutationAuthor, sourceCreateOptions, sourceDependency } from "./mutation.ts";

/** Hard ceilings keep saved plans and individual coordinator attempts bounded. */
export const BEADS_TRANSFER_LIMITS = { maxRows: 1000, maxEdges: 4000, maxBytes: 4_194_304, chunkSize: 25 } as const;
/** Caller-selected closure and chunk bounds, never silently truncated. */
export interface BeadsTransferLimits { maxRows: number; maxEdges: number; maxBytes: number; chunkSize: number }
/** Portable immutable input; the digest identifies one exact exchange, including source and bounds. */
export interface BeadsTransferPlan {
  schema: 1; source: string; selected: string[]; limits: BeadsTransferLimits;
  records: SnapshotRecord[]; settings: BeadsTransferSettings; digest: string;
}
/** Non-secret creation configuration plus hashes of optional ambient inputs. */
export interface BeadsTransferSettings {
  idPrefix: string; configuration: string; templates: string; focus: string;
}
/** Exact identity intent and immutable creation hash retained independently of chunk completion. */
interface TransferIdentity { pmId: string; itemHash: string | null }
/** One durable exchange ledger; the SDK writer lease protects all reads and writes during mutation. */
interface TransferJournal { schema: 1; digest: string; rows: Record<string, TransferIdentity> }
/** Categories callers can handle without parsing prose. */
export type BeadsTransferRefusalCode = "invalid_input" | "closure_limit" | "missing_selection" | "invalid_plan" | "plan_settings_changed" | "invalid_journal" | "busy";
/** Bounded evidence accompanying a refusal; a refused plan never transfers a partial closure. */
export interface BeadsTransferOmission { included: 0; required: number; limit: number; dimension: string }
/** Expected refusal with a stable reason, remedy and optional measured limit receipt. */
export class BeadsTransferRefusal extends CommandError {
  /** Machine-readable failure category. */
  readonly code: BeadsTransferRefusalCode;
  /** Action needed before retrying. */
  readonly remedy: string;
  /** Measured refusal rather than an apparently successful truncated closure. */
  readonly omission?: BeadsTransferOmission;
  /** Construct a clean CLI failure without including source contents or paths. */
  constructor(code: BeadsTransferRefusalCode, remedy: string, omission?: BeadsTransferOmission) {
    super(`${code}: ${remedy}`, 2);
    this.name = "BeadsTransferRefusal"; this.code = code; this.remedy = remedy; this.omission = omission;
  }
}
/** Durable row outcome saved by the SDK coordinator, including explicit foreign-record skips. */
export interface BeadsTransferRowReceipt {
  id: string; pmId: string; outcome: "transferred" | "skipped";
  reason: "owned_creation" | "foreign_record" | "dependency_unavailable" | "item_changed";
}
/** Compact invocation result; counts describe durable completed chunks, including peer completions. */
export interface BeadsTransferReceipt {
  digest: string; totalRows: number; totalChunks: number; completedChunks: number;
  replayedChunks: number; transferred: number; skipped: number; complete: boolean;
  rows: BeadsTransferRowReceipt[]; omitted: number; remedy: string;
}
/** Bounded drainer controls and the SDK's deterministic interruption observer. */
export interface BeadsTransferApplyOptions {
  maxChunks?: number;
  lockWaitMs?: number;
  onTransition?: CommitWorkspaceTransactionOptions["onTransition"];
  /** Observe identity-ledger bootstrap independently of row chunk transitions. */
  onIdentityTransition?: CommitWorkspaceTransactionOptions["onTransition"];
  /** Observe create boundaries under the SDK writer lease; interruption leaves resumable progress. */
  onRowTransition?(context: { phase: "before_create" | "created_unrecorded" | "after_create"; id: string; pmId: string }): void | Promise<void>;
}

/** Hash canonical JSON to bind journals to the exact plan. */
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
/** Raise an actionable refusal at SDK and CLI boundaries. */
function refuse(code: BeadsTransferRefusalCode, remedy: string): never { throw new BeadsTransferRefusal(code, remedy); }
/** Validate finite integer controls instead of interpreting zero, NaN or fractions as defaults. */
function boundedInteger(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) refuse("invalid_input", `Choose an integer between 1 and ${maximum}.`);
  return value;
}
/** Enforce a measured closure limit with no partial plan or mutation. */
function enforce(required: number, limit: number, dimension: string): void {
  if (required > limit) throw new BeadsTransferRefusal("closure_limit", `Closure exceeds ${dimension}; narrow the selection or raise that bound within the hard ceiling. No rows were included.`, { included: 0, required, limit, dimension });
}
/** Blocker and parent identities must both exist before a dependent row is published. */
function references(row: SnapshotRecord): string[] {
  return [...new Set([...(JSON.parse(row.fields.dependencies) as string[]), ...(row.fields.parent ? [row.fields.parent] : [])])];
}
/** Build the bounded transitive closure and deterministic dependency-first ordering. */
function buildPlan(records: SnapshotRecord[], selected: readonly string[], source: string, limits: BeadsTransferLimits, settings: BeadsTransferSettings): BeadsTransferPlan {
  if (typeof source !== "string" || !source.trim() || source.length > 128 || !Array.isArray(selected) || !selected.length ||
      selected.some(id => typeof id !== "string" || !id.trim())) refuse("invalid_input", "Choose a stable source name (up to 128 characters) and at least one exact Beads id.");
  const seeds = [...new Set(selected)].sort();
  if (seeds.some(id => id.length > 128) || records.some(row => row.id.length > 128)) refuse("invalid_input", "Keep Beads ids at or below 128 characters for bounded agent receipts.");
  const byId = new Map(records.map(row => [row.id, row]));
  const closure = new Map<string, SnapshotRecord>();
  const pending = [...seeds];
  let edges = 0;
  for (let cursor = 0; cursor < pending.length; cursor++) {
    const id = pending[cursor];
    if (closure.has(id)) continue;
    const row = byId.get(id);
    if (!row) refuse("missing_selection", "Supply every selected row, blocker and parent in the input snapshot; no external edges are assumed satisfied.");
    closure.set(id, row);
    enforce(closure.size, limits.maxRows, "maxRows");
    const refs = references(row);
    edges += refs.length; enforce(edges, limits.maxEdges, "maxEdges");
    pending.push(...refs);
  }
  // Kahn ordering also catches cycles involving parent edges, beyond the existing blocker parser.
  const remaining = new Map([...closure].map(([id, row]) => [id, new Set(references(row))]));
  const ordered: SnapshotRecord[] = [];
  while (remaining.size) {
    const ready = [...remaining].filter(([, refs]) => !refs.size).map(([id]) => id).sort();
    if (!ready.length) refuse("invalid_input", "Remove cyclic parent/dependency relationships before planning the transfer.");
    for (const id of ready) {
      ordered.push(closure.get(id)!); remaining.delete(id);
      for (const refs of remaining.values()) refs.delete(id);
    }
  }
  enforce(Buffer.byteLength(JSON.stringify(ordered)), limits.maxBytes, "maxBytes");
  const plan: BeadsTransferPlan = { schema: 1, source, selected: seeds, limits, records: ordered, settings, digest: "" };
  plan.digest = hash({ ...plan, digest: "" });
  return plan;
}
/** Parse with the existing Beads structural validator, then plan a complete creation-only exchange. */
export function planBeadsTransfer(text: string, selected: readonly string[], source: string, settings: BeadsTransferSettings, options: Partial<BeadsTransferLimits> = {}): BeadsTransferPlan {
  if (!settings || Object.keys(settings).sort().join() !== "configuration,focus,idPrefix,templates" ||
      Object.values(settings).some(field => typeof field !== "string")) refuse("invalid_input", "Snapshot the receiving tracker settings before planning this transfer.");
  const limits: BeadsTransferLimits = {
    maxRows: boundedInteger(options.maxRows ?? BEADS_TRANSFER_LIMITS.maxRows, 10_000),
    maxEdges: boundedInteger(options.maxEdges ?? BEADS_TRANSFER_LIMITS.maxEdges, 40_000),
    maxBytes: boundedInteger(options.maxBytes ?? BEADS_TRANSFER_LIMITS.maxBytes, 16_777_216),
    chunkSize: boundedInteger(options.chunkSize ?? BEADS_TRANSFER_LIMITS.chunkSize, 100),
  };
  enforce(Buffer.byteLength(text), 16_777_216, "inputBytes");
  let records: SnapshotRecord[];
  try { records = parseBeadsSnapshot(text); }
  catch { return refuse("invalid_input", "Run beads validate and repair invalid JSONL, duplicate ids, unsupported statuses or dangling dependencies before planning."); }
  return buildPlan(records, selected, source, limits, settings);
}
/** Reconstitute supported Beads fields so a loaded plan passes through the original parser again. */
function toBead(row: SnapshotRecord): BeadsItem {
  const f = row.fields;
  return { ...f, description: "", id: row.id, tags: JSON.parse(f.tags) as string[], dependencies: JSON.parse(f.dependencies) as string[] };
}
/** Validate untrusted saved plans, including canonical fields, topology, limits and the digest. */
export function validateBeadsTransferPlan(value: BeadsTransferPlan): BeadsTransferPlan {
  try {
    if (value.schema !== 1 || !Array.isArray(value.records)) throw new Error("shape");
    const text = value.records.map(row => JSON.stringify(toBead(row))).join("\n");
    const parsed = planBeadsTransfer(text, value.selected, value.source, value.settings, value.limits);
    // Descriptions are already normalized at the JSONL boundary. Validate their type,
    // then carry them verbatim rather than destructively stripping another marker.
    for (const row of value.records) if (typeof row.fields.description !== "string") throw new Error("description");
    const descriptions = new Map(value.records.map(row => [row.id, row.fields.description]));
    const fresh = buildPlan(parsed.records.map(row => ({ ...row, fields: { ...row.fields, description: descriptions.get(row.id)! } })),
      parsed.selected, parsed.source, parsed.limits, value.settings);
    if (JSON.stringify(fresh) !== JSON.stringify(value)) throw new Error("digest");
    return fresh;
  } catch { return refuse("invalid_plan", "Generate a fresh plan with --plan-out; preserve the original plan to resume its existing checkpoints."); }
}
/** Bind deterministic core ids to an exact source/selection/payload, without trusting description markers. */
export function beadsTransferItemId(plan: BeadsTransferPlan, id: string, prefix: string): string {
  return normalizeItemId(`beads-transfer-${hash([plan.digest, id]).slice(0, 32)}`, prefix);
}
/** A create-history message proves ownership; mutable Beads provenance alone never does. */
function ownershipMarker(plan: BeadsTransferPlan, id: string): string { return `beads-transfer:${plan.digest}:${hash(id)}`; }
/** Canonicalize configuration keys without changing user text or array order. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, field: unknown) => field && typeof field === "object" && !Array.isArray(field)
    ? Object.fromEntries(Object.entries(field).sort(([a], [b]) => a.localeCompare(b, "en"))) : field);
}
/** Read an optional local file, refusing unreadable inputs instead of treating them as missing. */
async function optionalFile(file: string): Promise<string> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}
/** Hash the template tree without following directory symlinks or exposing template contents. */
async function templateSnapshot(dir: string): Promise<string> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return hash([]); throw error; }
  const files: [string, string][] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    if (entry.isDirectory()) files.push([entry.name, await templateSnapshot(join(dir, entry.name))]);
    else if (entry.isFile()) files.push([entry.name, hash(await readFile(join(dir, entry.name), "utf8"))]);
    else refuse("invalid_input", "Use regular files and directories for transfer templates.");
  }
  return hash(files);
}
/** Snapshot only non-secret settings relevant to creation; focus and templates are conservative guards. */
export async function snapshotBeadsTransferSettings(pmRoot: string): Promise<BeadsTransferSettings> {
  const s = await readSettings(pmRoot);
  const session = JSON.parse(await optionalFile(join(pmRoot, "runtime", "session.json")) || "{}") as { focused_item?: string };
  return { idPrefix: s.id_prefix,
    configuration: stable({ ids: s.ids, item_format: s.item_format, item_types: s.item_types, schema: s.schema, governance: s.governance, validation: s.validation }),
    templates: await templateSnapshot(join(pmRoot, "templates")), focus: session.focused_item ?? "" };
}
/** Locate the package-owned ledger; SDK chunk journals remain owned by the public coordinator. */
function journalPath(pmRoot: string, plan: BeadsTransferPlan): string { return join(pmRoot, "transactions", "beads-transfer", `${plan.digest}.json`); }
/** Refuse corrupt or incomplete identity records rather than deriving replacements. */
async function readJournal(pmRoot: string, plan: BeadsTransferPlan): Promise<TransferJournal | undefined> {
  const text = await optionalFile(journalPath(pmRoot, plan));
  if (!text) return undefined;
  try {
    const journal = JSON.parse(text) as TransferJournal;
    if (journal.schema !== 1 || journal.digest !== plan.digest || Object.keys(journal.rows).length !== plan.records.length ||
        plan.records.some(row => { const pin = journal.rows[row.id]; return !pin || typeof pin.pmId !== "string" || !pin.pmId ||
          !(pin.itemHash === null || typeof pin.itemHash === "string" && /^[a-f0-9]{64}$/.test(pin.itemHash)); }) ||
        new Set(Object.values(journal.rows).map(pin => pin.pmId)).size !== plan.records.length) throw new Error("identity");
    return journal;
  } catch { return refuse("invalid_journal", "Restore the original transfer identity journal from a trusted backup; do not retry with a new identity or discard progress."); }
}
/** Persist identity intents and created hashes atomically while holding the workspace writer lease. */
async function saveJournal(pmRoot: string, plan: BeadsTransferPlan, journal: TransferJournal): Promise<void> {
  await mkdir(join(pmRoot, "transactions", "beads-transfer"), { recursive: true });
  await writeFileAtomic(journalPath(pmRoot, plan), JSON.stringify(journal) + "\n");
}
/** Settings drift can only replay exchanges whose every creation is already pinned. */
async function checkSettings(pmRoot: string, plan: BeadsTransferPlan, journal: TransferJournal | undefined): Promise<void> {
  if (stable(await snapshotBeadsTransferSettings(pmRoot)) !== stable(plan.settings) &&
      !plan.records.every(row => journal?.rows[row.id].itemHash)) {
    refuse("plan_settings_changed", "Restore the plan's creation settings, templates and focus before resuming this exact plan; preserve its identity journal and completed items.");
  }
}
/** Inspect only a recorded identity, requiring both provenance and the pinned current item hash. */
async function ownership(pmRoot: string, plan: BeadsTransferPlan, id: string, pin: TransferIdentity): Promise<"missing" | "owned" | "foreign" | "changed"> {
  try {
    const item = await locateItem(pmRoot, pin.pmId, plan.settings.idPrefix);
    const history = await readHistorySnapshot(getHistoryPath(pmRoot, pin.pmId), pin.pmId);
    if (!item) return pin.itemHash ? "changed" : history.entries.length ? "foreign" : "missing";
    const creation = history.entries.filter(entry => entry.op === "create").at(-1);
    if (creation?.message?.split(" | ", 1)[0] !== ownershipMarker(plan, id)) return "foreign";
    const document = (await readLocatedItem(item)).document;
    if (!verifyHistoryEntries(history.entries, document).ok) return "changed";
    const itemHash = hash(document);
    if (pin.itemHash && pin.itemHash !== itemHash) return "changed";
    // An intent written before create recovers the narrow create-to-ledger crash gap.
    // Only an unchanged initial creation can complete that intent.
    if (!pin.itemHash && history.entries.length !== 1) return "changed";
    pin.itemHash = itemHash;
    return "owned";
  } catch { return "foreign"; }
}
/** Convert canonical fields to SDK lifecycle options; edges point only to earlier owned creations. */
function createOptions(row: SnapshotRecord, plan: BeadsTransferPlan, ids: Map<string, string>, author: string): PmClientFullMutationOptions {
  const f = row.fields;
  const options: PmClientFullMutationOptions = {
    title: f.title, type: f.type, status: f.status, description: encodeBeadId(f.description, row.id),
    message: ownershipMarker(plan, row.id), tags: f.tags,
    dep: (JSON.parse(f.dependencies) as string[]).map(id => sourceDependency(ids.get(id)!, author)),
  };
  for (const field of ["priority", "assignee", "deadline", "sprint", "release"] as const) if (f[field]) options[field] = f[field];
  if (f.parent) options.parent = ids.get(f.parent)!;
  if (f.status === "closed") options.closeReason = "Closed in transferred Beads snapshot";
  return sourceCreateOptions(options, author);
}
/** Compensation preserves durable items and pins for an explicit retry. */
async function preserveCreations(): Promise<void> {}
/** Build ownership-aware domain steps; the SDK owns leasing, journaling, interruption and replay. */
function transferSteps(pmRoot: string, plan: BeadsTransferPlan, rows: SnapshotRecord[], client: PmClient, options: BeadsTransferApplyOptions, author: string): WorkspaceTransactionStep[] {
  let journal: TransferJournal;
  /** Refresh identity pins under the lease, before any create or retry. */
  const prepare = async () => {
    const recorded = await readJournal(pmRoot, plan);
    await checkSettings(pmRoot, plan, recorded);
    if (!recorded) refuse("invalid_journal", "Restore the original identity journal; existing exchanges never reconstruct identities from tracker settings.");
    journal = recorded;
  };
  return rows.map(row => {
    /** Inspect only the exact durable pin, never an identity derived from live settings. */
    const inspect = async () => {
      await prepare();
      const pin = journal.rows[row.id];
      const state = await ownership(pmRoot, plan, row.id, pin);
      const receipt: BeadsTransferRowReceipt = { id: row.id, pmId: pin.pmId, outcome: "transferred", reason: "owned_creation" };
      if (state === "owned") { await saveJournal(pmRoot, plan, journal); return { state: "applied" as const, result: { ...receipt } }; }
      if (state !== "missing") return { state: "applied" as const, result: { ...receipt, outcome: "skipped", reason: state === "changed" ? "item_changed" : "foreign_record" } };
      return { state: "pending" as const };
    };
    return { id: `row-${hash(row.id)}`, inspect,
      async apply() {
        await prepare();
        const pin = journal.rows[row.id], pmId = pin.pmId;
        const ids = new Map(Object.entries(journal.rows).map(([id, identity]) => [id, identity.pmId]));
        for (const ref of references(row)) {
          if (await ownership(pmRoot, plan, ref, journal.rows[ref]) !== "owned") {
            return { id: row.id, pmId, outcome: "skipped", reason: "dependency_unavailable" };
          }
        }
        await options.onRowTransition?.({ phase: "before_create", id: row.id, pmId });
        await checkSettings(pmRoot, plan, journal);
        try { await client.create({ ...createOptions(row, plan, ids, author), id: pmId }); }
        catch (error) {
          const after = await inspect();
          if (after.state === "applied") return after.result;
          throw error;
        }
        await options.onRowTransition?.({ phase: "created_unrecorded", id: row.id, pmId });
        if (await ownership(pmRoot, plan, row.id, pin) !== "owned") refuse("invalid_journal", "Inspect the created item and its history before resuming; its exact creation could not be verified.");
        await saveJournal(pmRoot, plan, journal);
        await options.onRowTransition?.({ phase: "after_create", id: row.id, pmId });
        return (await inspect()).result;
      },
      /** Preserve durable creations and their pins through ordinary compensation. */
      compensate: preserveCreations,
    };
  });
}
/** Translate coordinator lease conflicts without disguising unexpected SDK failures. */
function transactionFailure(error: unknown): never {
  if (error && typeof error === "object" && "code" in error && error.code === "lock_conflict") refuse("busy", "Another workspace writer holds the lease. Retry the same saved plan after it finishes or the SDK crash lease expires.");
  throw error;
}
/** Drain a bounded number of chunks and return recorded completion, including another drainer's success. */
export async function applyBeadsTransfer(pmRoot: string, input: BeadsTransferPlan, author: string, options: BeadsTransferApplyOptions = {}): Promise<BeadsTransferReceipt> {
  const plan = validateBeadsTransferPlan(input);
  const maxChunks = boundedInteger(options.maxChunks ?? 1, 10_000);
  const lockWaitMs = boundedInteger(options.lockWaitMs ?? 3000, 60_000);
  await checkSettings(pmRoot, plan, await readJournal(pmRoot, plan));
  const client = new PmClient({ pmRoot, author, noExtensions: true });
  // A distinct committed bootstrap prevents a missing identity ledger from being
  // silently regenerated on replay. The bootstrap and chunks use the same lease.
  try {
    await commitWorkspaceTransaction({ pmRoot, author, transactionId: `beads-transfer-${plan.digest}-identity`, lockWaitMs,
      steps: [{ id: "identity", async inspect() {
        return { state: await readJournal(pmRoot, plan) ? "applied" : "pending" };
      }, async apply() {
        await checkSettings(pmRoot, plan, undefined);
        await saveJournal(pmRoot, plan, { schema: 1, digest: plan.digest, rows: Object.fromEntries(plan.records.map(row =>
          [row.id, { pmId: beadsTransferItemId(plan, row.id, plan.settings.idPrefix), itemHash: null }])) });
      }, compensate: preserveCreations }],
      onTransition: options.onIdentityTransition,
    });
  } catch (error) { return transactionFailure(error); }
  if (!await readJournal(pmRoot, plan)) refuse("invalid_journal", "Restore the original identity journal before resuming; do not regenerate or discard recorded identities.");
  const receipt: BeadsTransferReceipt = { digest: plan.digest, totalRows: plan.records.length,
    totalChunks: Math.ceil(plan.records.length / plan.limits.chunkSize), completedChunks: 0, replayedChunks: 0,
    transferred: 0, skipped: 0, complete: false, rows: [], omitted: 0, remedy: "Repeat --apply-plan with the same saved plan to resume; inspect skipped rows before starting a new exchange." };
  let freshChunks = 0;
  for (let chunk = 0; chunk < receipt.totalChunks; chunk++) {
    if (freshChunks >= maxChunks) break;
    const rows = plan.records.slice(chunk * plan.limits.chunkSize, (chunk + 1) * plan.limits.chunkSize);
    let worked = false;
    let result;
    try { result = await commitWorkspaceTransaction({ pmRoot, author,
      transactionId: `beads-transfer-${plan.digest}-${chunk}`,
      steps: transferSteps(pmRoot, plan, rows, client, options, author),
      async onTransition(context) { worked = true; await options.onTransition?.(context); },
      lockWaitMs,
    }); } catch (error) {
      return transactionFailure(error);
    }
    if (worked) freshChunks++; else receipt.replayedChunks++;
    receipt.completedChunks++;
    for (const value of Object.values(result.results)) {
      let row = value as unknown as BeadsTransferRowReceipt;
      const journal = await readJournal(pmRoot, plan);
      if (!journal) refuse("invalid_journal", "Restore the exact transfer identity journal before replaying this exchange.");
      const pin = journal.rows[row.id];
      if (!pin || pin.pmId !== row.pmId) refuse("invalid_journal", "Restore matching transfer and chunk journals before replaying this exchange.");
      if (row.outcome === "transferred" && await ownership(pmRoot, plan, row.id, pin) !== "owned") {
        row = { ...row, outcome: "skipped", reason: "item_changed" };
      }
      if (row.outcome === "transferred") receipt.transferred++; else receipt.skipped++;
      if (receipt.rows.length < 20) receipt.rows.push(row); else receipt.omitted++;
    }
  }
  receipt.complete = receipt.completedChunks === receipt.totalChunks;
  return receipt;
}
/** Describe the full plan without returning row prose; counts and omissions remain explicit. */
export function summarizeBeadsTransfer(plan: BeadsTransferPlan) {
  return { digest: plan.digest, source: plan.source, selected: plan.selected.slice(0, 20), selectedOmitted: Math.max(0, plan.selected.length - 20),
    rows: plan.records.length, addedDependencies: plan.records.length - plan.selected.length,
    chunks: Math.ceil(plan.records.length / plan.limits.chunkSize), limits: plan.limits,
    remedy: "Save with --plan-out, then repeat --apply-plan with that file to drain durable chunks." };
}
/** Read an accessible JSONL or saved-plan file while keeping paths out of error receipts. */
async function inputFile(file: string): Promise<string> {
  try { return await readFile(file, "utf8"); }
  catch { return refuse("invalid_input", "Choose an accessible input file and retry."); }
}
/** Run the transfer command; normal host rendering supplies compact TOON or JSON. */
async function runTransfer(ctx: CommandHandlerContext) {
  try {
    const applyFile = optionString(ctx.options, "apply-plan", "applyPlan");
    if (applyFile) {
      let plan: BeadsTransferPlan;
      try { plan = JSON.parse(await inputFile(applyFile)) as BeadsTransferPlan; }
      catch { return refuse("invalid_plan", "Read an accessible JSON plan saved by --plan-out."); }
      return await applyBeadsTransfer(ctx.pm_root, plan, beadsMutationAuthor(ctx.global.author), {
        maxChunks: Number(optionString(ctx.options, "chunks") ?? 1),
      });
    }
    const file = resolveImportInputFile(ctx.args, ["--source", "--select", "--plan-out", "--apply-plan", "--chunks", "--max-rows", "--max-edges", "--max-bytes", "--chunk-size"]);
    if (!file) refuse("invalid_input", "Pass a Beads JSONL file with --select and --source, or resume with --apply-plan.");
    const bounds: Partial<BeadsTransferLimits> = {};
    for (const [key, flag] of [["maxRows", "max-rows"], ["maxEdges", "max-edges"], ["maxBytes", "max-bytes"], ["chunkSize", "chunk-size"]] as const) {
      const value = optionString(ctx.options, flag, key);
      if (value !== undefined) bounds[key] = Number(value);
    }
    const plan = planBeadsTransfer(await inputFile(file), (optionString(ctx.options, "select") ?? "").split(",").filter(Boolean), optionString(ctx.options, "source") ?? "", await snapshotBeadsTransferSettings(ctx.pm_root), bounds);
    const output = optionString(ctx.options, "plan-out", "planOut");
    if (output) {
      try { await writeFileAtomic(await distinctOutput(output, [file]), JSON.stringify(plan) + "\n"); }
      catch { return refuse("invalid_input", "Choose a writable plan output file and retry."); }
    }
    return summarizeBeadsTransfer(plan);
  } catch (error) {
    if (!(error instanceof BeadsTransferRefusal)) throw error;
    // Returned fields survive both TOON and JSON rendering; the host propagates exitCode.
    process.exitCode = error.exitCode;
    return { refused: true, code: error.code, remedy: error.remedy, ...(error.omission ? { omission: error.omission } : {}) };
  }
}
/** Register canonical and rich-help aliases over the same typed SDK workflow. */
export function registerTransferCommands(api: ExtensionApi): void {
  for (const name of ["beads transfer", "beads-transfer"]) api.registerCommand({
    name, description: "Plan a bounded dependency-closed Beads exchange and resume durable creation chunks.",
    arguments: [{ name: "file", required: false, description: "Complete Beads JSONL input." }],
    flags: [
      ...[ ["--source", "Stable external exchange name."], ["--select", "Comma-separated exact Beads ids; include transitive blockers and parents."],
        ["--plan-out", "Save the full immutable plan; it contains selected descriptions and should use tracker access controls."],
        ["--apply-plan", "Resume the exact saved plan; existing foreign records are preserved and skipped."],
        ["--chunks", "Maximum new chunks this invocation (default 1)."], ["--chunk-size", "Rows per chunk (default 25, ceiling 100)."],
        ["--max-rows", "Closure row limit (default 1000, ceiling 10000)."], ["--max-edges", "Closure edge limit (default 4000, ceiling 40000)."],
        ["--max-bytes", "Canonical closure byte limit (default 4194304, ceiling 16777216)."],
      ].map(([long, description]) => ({ long, description, value_type: "string" as const, value_name: "value" })),
    ],
    examples: ["pm beads transfer snapshot.jsonl --source team --select bd-root --plan-out exchange.json", "pm beads transfer --apply-plan exchange.json --chunks 2 --json"],
    run: runTransfer,
  });
}
