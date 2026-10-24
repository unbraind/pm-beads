/** Dependency-closed, resumable Beads creation using the host's durable transaction journals. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  PmClient, commitWorkspaceTransaction, getHistoryPath, readHistorySnapshot,
  locateItem, normalizeItemId, readSettings, writeFileAtomic,
  type CommitWorkspaceTransactionOptions, type PmClientFullMutationOptions,
  type WorkspaceTransactionStep,
} from "@unbrained/pm-cli/sdk";
import type { CommandHandlerContext, ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { CommandError } from "./contracts.ts";
import { encodeBeadId, optionString, resolveImportInputFile, type BeadsItem } from "./index.ts";
import { parseBeadsSnapshot, type SnapshotRecord } from "./reconcile.ts";
import { distinctOutput } from "./sidecar.ts";

/** Hard ceilings keep saved plans and individual coordinator attempts bounded. */
export const BEADS_TRANSFER_LIMITS = { maxRows: 1000, maxEdges: 4000, maxBytes: 4_194_304, chunkSize: 25 } as const;
/** Caller-selected closure and chunk bounds, never silently truncated. */
export interface BeadsTransferLimits { maxRows: number; maxEdges: number; maxBytes: number; chunkSize: number }
/** Portable immutable input; the digest identifies one exact exchange, including source and bounds. */
export interface BeadsTransferPlan {
  schema: 1; source: string; selected: string[]; limits: BeadsTransferLimits;
  records: SnapshotRecord[]; digest: string;
}
/** Categories callers can handle without parsing prose. */
export type BeadsTransferRefusalCode = "invalid_input" | "closure_limit" | "missing_selection" | "invalid_plan" | "busy";
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
  reason: "owned_creation" | "foreign_record" | "dependency_unavailable";
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
  /** Observe create boundaries under the SDK writer lease; interruption leaves resumable progress. */
  onRowTransition?(context: { phase: "before_create" | "after_create"; id: string; pmId: string }): void | Promise<void>;
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
function buildPlan(records: SnapshotRecord[], selected: readonly string[], source: string, limits: BeadsTransferLimits): BeadsTransferPlan {
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
  const plan: BeadsTransferPlan = { schema: 1, source, selected: seeds, limits, records: ordered, digest: "" };
  plan.digest = hash({ ...plan, digest: "" });
  return plan;
}
/** Parse with the existing Beads structural validator, then plan a complete creation-only exchange. */
export function planBeadsTransfer(text: string, selected: readonly string[], source: string, options: Partial<BeadsTransferLimits> = {}): BeadsTransferPlan {
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
  return buildPlan(records, selected, source, limits);
}
/** Reconstitute supported Beads fields so a loaded plan passes through the original parser again. */
function toBead(row: SnapshotRecord): BeadsItem {
  const f = row.fields;
  return { ...f, id: row.id, tags: JSON.parse(f.tags) as string[], dependencies: JSON.parse(f.dependencies) as string[] };
}
/** Validate untrusted saved plans, including canonical fields, topology, limits and the digest. */
function validatePlan(value: BeadsTransferPlan): BeadsTransferPlan {
  try {
    if (value.schema !== 1 || !Array.isArray(value.records)) throw new Error("shape");
    const text = value.records.map(row => JSON.stringify(toBead(row))).join("\n");
    const fresh = planBeadsTransfer(text, value.selected, value.source, value.limits);
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
/** Inspect only the selected deterministic identity; foreign or missing history never confers ownership. */
async function ownership(pmRoot: string, plan: BeadsTransferPlan, id: string, pmId: string): Promise<"missing" | "owned" | "foreign"> {
  try {
    const item = await locateItem(pmRoot, pmId);
    const history = await readHistorySnapshot(getHistoryPath(pmRoot, pmId), pmId);
    if (!item) return history.entries.length ? "foreign" : "missing";
    const creation = history.entries.filter(entry => entry.op === "create").at(-1);
    return creation?.message === ownershipMarker(plan, id) ? "owned" : "foreign";
  } catch { return "foreign"; }
}
/** Convert canonical fields to SDK lifecycle options; edges point only to earlier owned creations. */
function createOptions(row: SnapshotRecord, plan: BeadsTransferPlan, ids: Map<string, string>): PmClientFullMutationOptions {
  const f = row.fields;
  const options: PmClientFullMutationOptions = {
    title: f.title, type: f.type, status: f.status, description: encodeBeadId(f.description, row.id),
    message: ownershipMarker(plan, row.id), tags: f.tags,
    dep: (JSON.parse(f.dependencies) as string[]).map(id => `id=${JSON.stringify(ids.get(id)!)},kind=blocked_by`),
  };
  for (const field of ["priority", "assignee", "deadline", "sprint", "release"] as const) if (f[field]) options[field] = f[field];
  if (f.parent) options.parent = ids.get(f.parent)!;
  if (f.status === "closed") options.closeReason = "Closed in transferred Beads snapshot";
  return options;
}
/** Build ownership-aware domain steps; the SDK owns leasing, journaling, interruption and replay. */
function transferSteps(pmRoot: string, plan: BeadsTransferPlan, rows: SnapshotRecord[], ids: Map<string, string>, client: PmClient, options: BeadsTransferApplyOptions): WorkspaceTransactionStep[] {
  return rows.map(row => {
    const pmId = ids.get(row.id)!;
    /** Read the state this step will modify while the coordinator holds its writer lease. */
    const inspect = async () => {
      const state = await ownership(pmRoot, plan, row.id, pmId);
      const receipt: BeadsTransferRowReceipt = { id: row.id, pmId, outcome: "transferred", reason: "owned_creation" };
      if (state === "owned") return { state: "applied" as const, result: { ...receipt } };
      if (state === "foreign") return { state: "applied" as const, result: { ...receipt, outcome: "skipped", reason: "foreign_record" } };
      return { state: "pending" as const };
    };
    return { id: `row-${hash(row.id)}`, inspect,
      async apply() {
        // Earlier rows in this chunk have now run; check their ownership before publishing edges.
        for (const ref of references(row)) {
          if (await ownership(pmRoot, plan, ref, ids.get(ref)!) !== "owned") {
            return { id: row.id, pmId, outcome: "skipped", reason: "dependency_unavailable" };
          }
        }
        await options.onRowTransition?.({ phase: "before_create", id: row.id, pmId });
        try { await client.create({ ...createOptions(row, plan, ids), id: pmId }); }
        catch (error) {
          const after = await inspect();
          if (after.state === "applied") return after.result;
          throw error;
        }
        await options.onRowTransition?.({ phase: "after_create", id: row.id, pmId });
        return (await inspect()).result;
      },
      // A transfer intentionally preserves completed creations as resumable progress.
      // Compensation never deletes, closes or restores an item another writer may have edited.
      async compensate() {},
    };
  });
}
/** Drain a bounded number of chunks and return recorded completion, including another drainer's success. */
export async function applyBeadsTransfer(pmRoot: string, input: BeadsTransferPlan, author: string, options: BeadsTransferApplyOptions = {}): Promise<BeadsTransferReceipt> {
  const plan = validatePlan(input);
  const maxChunks = boundedInteger(options.maxChunks ?? 1, 10_000);
  const lockWaitMs = boundedInteger(options.lockWaitMs ?? 3000, 60_000);
  const settings = await readSettings(pmRoot);
  const ids = new Map(plan.records.map(row => [row.id, beadsTransferItemId(plan, row.id, settings.id_prefix)]));
  const client = new PmClient({ pmRoot, author });
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
      steps: transferSteps(pmRoot, plan, rows, ids, client, options),
      async onTransition(context) { worked = true; await options.onTransition?.(context); },
      lockWaitMs,
    }); } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "lock_conflict") refuse("busy", "Another workspace writer holds the lease. Retry the same saved plan after it finishes or the SDK crash lease expires.");
      throw error;
    }
    if (worked) freshChunks++; else receipt.replayedChunks++;
    receipt.completedChunks++;
    for (const value of Object.values(result.results)) {
      const row = value as unknown as BeadsTransferRowReceipt;
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
      return await applyBeadsTransfer(ctx.pm_root, plan, ctx.global.author ?? process.env.PM_AUTHOR ?? "pm-beads", {
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
    const plan = planBeadsTransfer(await inputFile(file), (optionString(ctx.options, "select") ?? "").split(",").filter(Boolean), optionString(ctx.options, "source") ?? "", bounds);
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
