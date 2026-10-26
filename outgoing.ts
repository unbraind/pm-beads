/** Stateless acknowledged outbound transport; reconstruction never mutates a tracker or its acknowledgement. */
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { ExtensionApi, CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import { CommandError } from "./contracts.ts";
import { RECONCILE_FIELDS, beadsAcknowledgementDigest, type BeadsAcknowledgement, type SnapshotRecord, type ReconcileField } from "./reconcile.ts";
import { isEncodableBeadId, optionString } from "./index.ts";

import { BEADS_SNAPSHOT_LIMITS, BEADS_RECORD_SCHEMA, BEADS_RECORD_RECEIPT_SCHEMA, BEADS_RECORDS_SCHEMA,
  validateBeadsSchema, checkBeadsSchema, BEADS_ACKNOWLEDGEMENT_SCHEMA, compareBeadsIdentities, type BeadsRecordReceipt } from "./snapshot-schema.ts";

/** Transport limits apply equally to SDK values, input files and emitted envelopes. */
export const BEADS_OUTGOING_LIMITS = BEADS_SNAPSHOT_LIMITS;
/** One independent operation; unset clears a field, remove explicitly omits a source record. */
export type BeadsOutgoingOperation =
  | { op: "set"; id: string; field: ReconcileField; value: string }
  | { op: "unset"; id: string; field: ReconcileField }
  | { op: "add"; record: SnapshotRecord }
  | { op: "remove"; id: string };
/** Identity receipts are sufficient to verify the reconstructed acknowledgement, without unchanged records. */
interface OutgoingReceipt {
  schema: 1; source: string; sourceDigest: string; baseDigest: string | null; targetDigest: string;
  previous: string | null; bindings?: Record<string, string>; inheritBindings?: true; recordReceipts?: BeadsRecordReceipt[]; recordOrder?: string[];
}
/** Complete transport value. A missing sender base produces a full snapshot. */
export type BeadsOutgoingDelta = OutgoingReceipt & (
  | { mode: "delta"; operations: BeadsOutgoingOperation[] }
  | { mode: "snapshot"; records: SnapshotRecord[] }
);
/** Expected protocol refusals have stable codes, remedies and clean CLI exit status. */
export class BeadsOutgoingRefusal extends CommandError {
  /** Stable machine-readable refusal category. */
  readonly code: "invalid_input" | "source_mismatch" | "base_mismatch" | "target_mismatch";
  /** Safe action that can resolve the refusal. */
  readonly remedy: string;
  /** Construct an actionable refusal without including input data. */
  constructor(code: BeadsOutgoingRefusal["code"], remedy: string) {
    super(`${code}: ${remedy}`, 2);
    this.name = "BeadsOutgoingRefusal";
    this.code = code; this.remedy = remedy;
  }
}
/** Fail closed before returning data or changing caller-owned values. */
function refuse(code: BeadsOutgoingRefusal["code"], remedy: string): never { throw new BeadsOutgoingRefusal(code, remedy); }
/** Require one bounded, strict protocol shape at the trust boundary. */
function requireShape(valid: boolean): asserts valid {
  if (!valid) refuse("invalid_input", "Supply bounded canonical acknowledgement JSON or an unedited outgoing envelope; regenerate from acknowledged snapshots.");
}
/** Strict object shape: unknown properties, arrays and null cannot stand in for objects. */
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  requireShape(value !== null && typeof value === "object" && !Array.isArray(value));
  requireShape(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  requireShape(Reflect.ownKeys(value).length === Object.keys(value).length);
  requireShape(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}
/** Bounded dense arrays reject holes and extra properties before traversal. */
function array(value: unknown, max: number): asserts value is unknown[] {
  requireShape(Array.isArray(value) && value.length <= max && Object.keys(value).length === value.length);
  requireShape(Object.getPrototypeOf(value) === Array.prototype && Reflect.ownKeys(value).length === value.length + 1);
  for (let i = 0; i < value.length; i++) requireShape(Object.hasOwn(value, i));
}
/** Strings are the only field payloads; finite bounded numeric priority is encoded canonically. */
function string(value: unknown, max: number = BEADS_OUTGOING_LIMITS.string): asserts value is string {
  requireShape(typeof value === "string" && value.length <= max);
}
/** Validate hexadecimal SHA-256 receipts, including nullable genesis/base receipts. */
function hash(value: unknown, nullable = false): void { requireShape(nullable && value === null || typeof value === "string" && /^[a-f0-9]{64}$/.test(value)); }
/** Canonical identities use the package's existing identity domain. */
function identity(value: unknown): asserts value is string { requireShape(typeof value === "string" && isEncodableBeadId(value)); }
/** A single schema validates all acknowledgements and transport values at either boundary. */
function validate(value: unknown, kind: "ack" | "wire"): void {
  let payloadBytes = 0;
  /** Bound payload accumulation before hashing or serializing the complete value. */
  function spend(data: string): void {
    payloadBytes += Buffer.byteLength(JSON.stringify(data));
    requireShape(payloadBytes <= BEADS_OUTGOING_LIMITS.bytes);
  }
  /** Interpret the shared producer schema, mapping shape failures to transport refusals. */
  function shared(data: unknown, schema: Parameters<typeof validateBeadsSchema>[1]): void {
    requireShape(checkBeadsSchema(data, schema, spend));
  }
  /** Native fields use the same descriptor as record producers. */
  function field(name: ReconcileField, data: unknown): void { shared(data, BEADS_RECORD_SCHEMA.properties.fields.properties[name]); }
  if (kind === "ack") {
    shared(value, BEADS_ACKNOWLEDGEMENT_SCHEMA);
    requireShape((value as BeadsAcknowledgement).revision === beadsAcknowledgementDigest(value as BeadsAcknowledgement));
    requireShape(Buffer.byteLength(JSON.stringify(value)) <= BEADS_OUTGOING_LIMITS.bytes); return;
  }
  object(value, ["schema", "source", "sourceDigest", "baseDigest", "targetDigest", "previous", "mode"],
    ["bindings", "inheritBindings", "operations", "records", "recordReceipts", "recordOrder"]);
  requireShape(value.schema === 1); string(value.source, 256); spend(value.source); requireShape(value.source.trim().length > 0);
  hash(value.previous, true);
  if (value.bindings !== undefined) shared(value.bindings, BEADS_ACKNOWLEDGEMENT_SCHEMA.properties.bindings);
    hash(value.sourceDigest); hash(value.baseDigest, true); hash(value.targetDigest);
    if (value.inheritBindings !== undefined) requireShape(value.inheritBindings === true && value.mode === "delta" && !Object.hasOwn(value, "bindings"));
    requireShape(value.sourceDigest === sourceDigest(value.source));
    if (value.mode === "snapshot") { requireShape(!Object.hasOwn(value, "operations") && !Object.hasOwn(value, "recordReceipts") && !Object.hasOwn(value, "recordOrder") && value.baseDigest === null); shared(value.records, BEADS_RECORDS_SCHEMA); }
    else {
      requireShape(value.mode === "delta" && !Object.hasOwn(value, "records") && value.baseDigest !== null);
      array(value.operations, BEADS_OUTGOING_LIMITS.operations);
      const touched = new Map<string, Set<string>>();
      for (const operation of value.operations) {
        object(operation, ["op"], ["id", "field", "value", "record"]);
        if (operation.op === "add") { object(operation, ["op", "record"]); shared(operation.record, BEADS_RECORD_SCHEMA); }
        else {
          identity(operation.id); spend(operation.id);
          if (operation.op === "remove") object(operation, ["op", "id"]);
          else {
            requireShape(operation.op === "set" || operation.op === "unset");
            object(operation, ["op", "id", "field", ...(operation.op === "set" ? ["value"] : [])]);
            requireShape(RECONCILE_FIELDS.includes(operation.field as ReconcileField));
            field(operation.field as ReconcileField, operation.op === "set" ? operation.value : empty(operation.field as ReconcileField));
          }
        }
        const id = operation.op === "add" ? (operation.record as SnapshotRecord).id : operation.id as string;
        const key = operation.op === "set" || operation.op === "unset" ? operation.field as string : "$item";
        const keys = touched.get(id) ?? new Set<string>();
        requireShape(!keys.has(key) && !keys.has("$item") && (key !== "$item" || keys.size === 0));
        keys.add(key); touched.set(id, keys);
      }
    }
  if (value.recordReceipts !== undefined) {
    array(value.recordReceipts, BEADS_OUTGOING_LIMITS.records);
    const ids = new Set<string>();
    for (const receipt of value.recordReceipts) {
      shared(receipt, BEADS_RECORD_RECEIPT_SCHEMA);
      const row = receipt as BeadsRecordReceipt;
      const keys = Object.keys(row).filter(key => key !== "keys" && key !== "fieldKeys").concat("fields");
      requireShape(!ids.has(row.id) && row.keys.length === keys.length && new Set(row.keys).size === keys.length && keys.every(key => row.keys.includes(key as keyof SnapshotRecord)) &&
        row.fieldKeys.length === RECONCILE_FIELDS.length && new Set(row.fieldKeys).size === RECONCILE_FIELDS.length);
      ids.add(row.id);
    }
  }
  if (value.recordOrder !== undefined) { array(value.recordOrder, BEADS_OUTGOING_LIMITS.records); for (const id of value.recordOrder) { identity(id); spend(id); } requireShape(new Set(value.recordOrder).size === value.recordOrder.length); }
  // The shape has no untrusted numbers except schema=1; serialization is bounded too.
  requireShape(Buffer.byteLength(JSON.stringify(value)) <= BEADS_OUTGOING_LIMITS.bytes);
}
/** Source identity receipt is independent of record contents. */
function sourceDigest(source: string): string { return createHash("sha256").update(JSON.stringify(source)).digest("hex"); }
/** An explicit unset uses the canonical empty representation, including collection fields. */
function empty(field: ReconcileField): string { return field === "tags" || field === "dependencies" ? "[]" : ""; }
/** Preserve live history metadata and supported historical object key order without field duplication. */
function recordReceipt(row: SnapshotRecord): BeadsRecordReceipt {
  const { fields, ...metadata } = row;
  return { ...metadata, keys: Object.keys(row) as Array<keyof SnapshotRecord>, fieldKeys: Object.keys(fields) as ReconcileField[] };
}
/** Produce only changed fields, retaining identity receipts; null base explicitly requests full fallback. */
export function generateBeadsOutgoingDelta(base: BeadsAcknowledgement | null, target: BeadsAcknowledgement): BeadsOutgoingDelta {
  validate(target, "ack");
  if (base !== null) { validate(base, "ack"); if (base.source !== target.source) refuse("source_mismatch", "Select acknowledgements from the same external source."); }
  const receipt: OutgoingReceipt = { schema: 1, source: target.source, sourceDigest: sourceDigest(target.source), baseDigest: base?.revision ?? null,
    targetDigest: target.revision, previous: target.previous, ...(target.bindings ? base !== null && JSON.stringify(base.bindings) === JSON.stringify(target.bindings) ? { inheritBindings: true } : { bindings: structuredClone(target.bindings) } : {}) };
  let result: BeadsOutgoingDelta;
  if (base === null) result = { ...receipt, mode: "snapshot", records: structuredClone(target.records) };
  else {
    const old = new Map(base.records.map(row => [row.id, row]));
    const next = new Map(target.records.map(row => [row.id, row]));
    const operations: BeadsOutgoingOperation[] = [];
    for (const id of [...new Set([...old.keys(), ...next.keys()])].sort(compareBeadsIdentities)) {
      const before = old.get(id), after = next.get(id);
      if (!after) operations.push({ op: "remove", id });
      else if (!before) operations.push({ op: "add", record: structuredClone(after) });
      else for (const field of RECONCILE_FIELDS) if (before.fields[field] !== after.fields[field]) {
        operations.push(after.fields[field] === empty(field) ? { op: "unset", id, field } : { op: "set", id, field, value: after.fields[field] });
      }
    }
    const recordReceipts = target.records.filter(row => old.has(row.id) && JSON.stringify(recordReceipt(old.get(row.id)!)) !== JSON.stringify(recordReceipt(row))).map(recordReceipt);
    const recordOrder = target.records.map(row => row.id);
    const inheritedOrder = [...base.records.filter(row => next.has(row.id)).map(row => row.id), ...operations.filter(operation => operation.op === "add").map(operation => operation.record.id)];
    result = { ...receipt, mode: "delta", operations, ...(recordReceipts.length ? { recordReceipts } : {}),
      ...(JSON.stringify(recordOrder) !== JSON.stringify(inheritedOrder) ? { recordOrder } : {}) };
  }
  validate(result, "wire"); return result;
}
/** Reconstruct a verified snapshot without writing either side. Exact replay observes current revision. */
export function replayBeadsOutgoingDelta(current: BeadsAcknowledgement | null, delta: BeadsOutgoingDelta): { acknowledgement: BeadsAcknowledgement; unchanged: boolean } {
  validate(delta, "wire");
  if (current !== null) { validate(current, "ack"); if (current.source !== delta.source) refuse("source_mismatch", "Select the receiver snapshot belonging to this source."); }
  const replay = current?.revision === delta.targetDigest;
  if (delta.mode === "delta" && !replay && current?.revision !== delta.baseDigest) refuse("base_mismatch", "Keep both snapshots intact; supply the exact acknowledged base or request a full snapshot with no base.");
  if (replay) return { acknowledgement: structuredClone(current!), unchanged: true };
  const rows = new Map((current?.records ?? []).map(row => [row.id, structuredClone(row)]));
  if (delta.mode === "snapshot") { rows.clear(); for (const row of delta.records) rows.set(row.id, structuredClone(row)); }
  else for (const operation of delta.operations) {
    if (operation.op === "add") { requireShape(!rows.has(operation.record.id)); rows.set(operation.record.id, structuredClone(operation.record)); }
    else if (operation.op === "remove") requireShape(rows.delete(operation.id));
    else {
      const row = rows.get(operation.id); requireShape(row !== undefined);
      row.fields[operation.field] = operation.op === "set" ? operation.value : empty(operation.field);
    }
  }
  for (const receipt of delta.recordReceipts ?? []) {
    const row = rows.get(receipt.id); requireShape(row !== undefined);
    rows.set(receipt.id, Object.fromEntries(receipt.keys.map(key => [key, key === "fields" ? Object.fromEntries(receipt.fieldKeys.map(field => [field, row.fields[field]])) : receipt[key]])) as SnapshotRecord);
  }
  const order = delta.mode === "snapshot" ? delta.records.map(row => row.id) : delta.recordOrder ?? [...rows.keys()];
  requireShape(order.length === rows.size && order.every(id => rows.has(id)));
  const acknowledgement: BeadsAcknowledgement = { schema: 1, source: delta.source, revision: delta.targetDigest, previous: delta.previous,
    records: order.map(id => rows.get(id)!), ...((delta.inheritBindings ? current?.bindings : delta.bindings) ? { bindings: structuredClone((delta.inheritBindings ? current!.bindings : delta.bindings)!) } : {}) };
  if (beadsAcknowledgementDigest(acknowledgement) !== delta.targetDigest) refuse("target_mismatch", "Regenerate the outgoing envelope from the original acknowledged snapshots; reconstructed contents do not match the target receipt.");
  validate(acknowledgement, "ack"); return { acknowledgement, unchanged: false };
}
/** Read bounded JSON through one open file, with typed I/O and JSON remedies. */
async function readJson(file: string): Promise<unknown> {
  try {
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(BEADS_OUTGOING_LIMITS.bytes + 1);
      let length = 0;
      while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length); if (bytesRead === 0) break; length += bytesRead; }
      requireShape(length <= BEADS_OUTGOING_LIMITS.bytes);
      return JSON.parse(buffer.subarray(0, length).toString("utf8")) as unknown;
    } finally { await handle.close(); }
  } catch { return refuse("invalid_input", "Read an accessible JSON file within the documented size limit; supply valid acknowledged snapshot or envelope JSON."); }
}
/** One read-only CLI handler, rendered as TOON or JSON by the host. */
async function runOutgoing(ctx: CommandHandlerContext) {
  const target = optionString(ctx.options, "target"), base = optionString(ctx.options, "base"), replay = optionString(ctx.options, "replay");
  if (Boolean(target) === Boolean(replay)) refuse("invalid_input", "Pass exactly one of --target acknowledgement.json or --replay envelope.json; optionally pass --base acknowledgement.json.");
  const current = base ? await readJson(base) as BeadsAcknowledgement : null;
  return replay ? replayBeadsOutgoingDelta(current, await readJson(replay) as BeadsOutgoingDelta) : generateBeadsOutgoingDelta(current, await readJson(target!) as BeadsAcknowledgement);
}
/** Register one stateless outbound command and its discoverable alias. */
export function registerOutgoingCommands(api: ExtensionApi): void {
  for (const name of ["beads outgoing", "beads-outgoing"]) api.registerCommand({ name,
    description: "Emit acknowledged field deltas or reconstruct a verified snapshot without mutating either tracker.",
    flags: [
      { long: "--target", value_type: "string", value_name: "file", description: "Target acknowledgement JSON; absent base produces a full snapshot." },
      { long: "--base", value_type: "string", value_name: "file", description: "Exact acknowledged sender base or current receiver snapshot." },
      { long: "--replay", value_type: "string", value_name: "file", description: "Reconstruct a verified acknowledgement from an outgoing envelope." },
    ], examples: ["pm beads outgoing --base base.json --target target.json --json", "pm beads outgoing --target target.json", "pm beads outgoing --base base.json --replay delta.json --json"], run: runOutgoing });
}
