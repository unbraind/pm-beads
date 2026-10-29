/** Shared snapshot data schema: producers and transport derive validation and public types here. */
import { DIFF_FIELDS, isEncodableBeadId } from "./contracts.ts";

/** Fields supported by all canonical snapshot producers. */
export const RECONCILE_FIELDS = [...DIFF_FIELDS, "description", "sprint", "release"] as const;
/** One native snapshot field. */
export type ReconcileField = typeof RECONCILE_FIELDS[number];
/** Common input/output limits, checked before whole-value serialization. */
export const BEADS_SNAPSHOT_LIMITS = { bytes: 16_777_216, records: 20_000, operations: 240_000, string: 1_048_576 } as const;
/** String domains in the shared declarative schema. */
interface StringSchema { type: "string"; maxLength: number; format?: "identity" | "nonempty" | "priority" | "collection" | "hash" }
/** Object/array/literal schema vocabulary; interpretation is independent of snapshot shape. */
type Schema = StringSchema | { type: "object"; properties: Readonly<Record<string, Schema>>; required: readonly string[] }
  | { type: "array"; items: Schema; maxItems: number; uniqueIds?: true }
  | { type: "literal"; value: 1 | null } | { type: "nullable"; value: Schema }
  | { type: "dictionary"; keys: Schema; items: Schema; maxItems: number; uniqueValues: true }
  | { type: "enum"; values: readonly string[] };
/** Derive SDK types from the same descriptors the runtime interprets. */
type Infer<S extends Schema> = S extends StringSchema ? string : S extends { type: "enum"; values: infer V extends readonly string[] } ? V[number] :
  S extends { type: "dictionary"; items: infer I extends Schema } ? Record<string, Infer<I>> : S extends { type: "literal"; value: infer V } ? V :
  S extends { type: "nullable"; value: infer V extends Schema } ? Infer<V> | null :
  S extends { type: "array"; items: infer I extends Schema } ? Infer<I>[] :
  S extends { type: "object"; properties: infer P extends Readonly<Record<string, Schema>>; required: infer R extends readonly string[] } ?
    { -readonly [K in keyof P as K extends R[number] ? K : never]: Infer<P[K]> } & { -readonly [K in keyof P as K extends R[number] ? never : K]?: Infer<P[K]> } : never;
/** Derive package contract types from the shared strict descriptor interpreter. */
export type BeadsSchemaValue<S extends Schema> = Infer<S>;
const text = { type: "string", maxLength: BEADS_SNAPSHOT_LIMITS.string } as const;
const id = { type: "string", maxLength: 4097, format: "identity" } as const;
const hash = { type: "string", maxLength: 64, format: "hash" } as const;
const fields = { type: "object", required: RECONCILE_FIELDS,
  properties: Object.fromEntries(RECONCILE_FIELDS.map(name => [name, { ...text,
    ...(name === "priority" ? { format: "priority" } : name === "tags" || name === "dependencies" ? { format: "collection" } : name === "title" || name === "status" ? { format: "nonempty" } : {}) }])) as Record<ReconcileField, StringSchema> } as const;
/** One schema for both plain and SDK-live records, including optional history receipts. */
export const BEADS_RECORD_SCHEMA = { type: "object", required: ["id", "fields"],
  properties: { id, fields, pmId: text, version: text, updatedAt: text } } as const satisfies Schema;
/** Snapshot metadata keys, derived from the record schema rather than copied into transport. */
export const BEADS_RECORD_KEYS = Object.keys(BEADS_RECORD_SCHEMA.properties) as Array<keyof SnapshotRecord>;
const { fields: recordFields, ...receiptProperties } = BEADS_RECORD_SCHEMA.properties;
/** Metadata/layout receipts derive their allowed properties directly from the record schema. */
export const BEADS_RECORD_RECEIPT_SCHEMA = { type: "object", required: ["id", "keys", "fieldKeys"], properties: { ...receiptProperties,
  keys: { type: "array", items: { type: "enum", values: BEADS_RECORD_KEYS }, maxItems: BEADS_RECORD_KEYS.length },
  fieldKeys: { type: "array", items: { type: "enum", values: RECONCILE_FIELDS }, maxItems: RECONCILE_FIELDS.length } } } as const satisfies Schema;
/** A record receipt carries history metadata and property order, without duplicating field values. */
export type BeadsRecordReceipt = Infer<typeof BEADS_RECORD_RECEIPT_SCHEMA>;
/** Dense unique record arrays accept historical order; new producers sort with the shared comparator. */
export const BEADS_RECORDS_SCHEMA = { type: "array", items: BEADS_RECORD_SCHEMA, maxItems: BEADS_SNAPSHOT_LIMITS.records, uniqueIds: true } as const satisfies Schema;
/** Acknowledgement shape, including the supported schema-1 format without bindings. */
export const BEADS_ACKNOWLEDGEMENT_SCHEMA = { type: "object", required: ["schema", "source", "revision", "previous", "records"],
  properties: { schema: { type: "literal", value: 1 }, source: { type: "string", maxLength: 256, format: "nonempty" }, revision: hash,
    previous: { type: "nullable", value: hash }, records: BEADS_RECORDS_SCHEMA,
    bindings: { type: "dictionary", keys: id, items: id, maxItems: BEADS_SNAPSHOT_LIMITS.records, uniqueValues: true } } } as const satisfies Schema;
/** Canonical field values shared by every snapshot producer. */
export type SnapshotFields = Infer<typeof fields>;
/** One supported record; live metadata is preserved when present. */
export type SnapshotRecord = Infer<typeof BEADS_RECORD_SCHEMA>;
/** A live SDK observation requires every declared metadata property. */
export type LiveSnapshotRecord = Required<SnapshotRecord>;
/** Persisted acknowledgement type, derived from its schema with a typed identity dictionary. */
export type BeadsAcknowledgement = Infer<typeof BEADS_ACKNOWLEDGEMENT_SCHEMA>;
/** Shape errors are translated into the calling surface's existing typed refusal. */
export class BeadsSnapshotSchemaError extends Error {
  /** Construct a schema refusal without echoing tracker data. */
  constructor() { super("Supply a bounded snapshot matching the shared Beads schema."); }
}
/** Fail closed on a schema condition. */
function requireSchema(valid: boolean): asserts valid { if (!valid) throw new BeadsSnapshotSchemaError(); }
/** Total Unicode code-point order, including distinct combining forms and lone surrogate code points. */
export function compareBeadsIdentities(left: string, right: string): number {
  const a = Array.from(left, character => character.codePointAt(0)!);
  const b = Array.from(right, character => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index++) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}
/** Interpret the shared descriptors once, including aggregate payload and dense-array checks. */
export function validateBeadsSchema(value: unknown, schema: Schema, charge?: (text: string) => void): void {
  let bytes = 0;
  /** Bound each string before hashing or serializing the complete input. */
  function spend(data: string): void { bytes += Buffer.byteLength(JSON.stringify(data)); requireSchema(bytes <= BEADS_SNAPSHOT_LIMITS.bytes); charge?.(data); }
  /** Walk a descriptor, never a second hand-written snapshot shape. */
  function visit(data: unknown, rule: Schema): void {
    if (rule.type === "enum") { requireSchema(typeof data === "string" && rule.values.includes(data)); spend(data); return; }
    if (rule.type === "literal") { requireSchema(data === rule.value); return; }
    if (rule.type === "nullable") { if (data !== null) visit(data, rule.value); return; }
    if (rule.type === "string") {
      requireSchema(typeof data === "string" && data.length <= rule.maxLength); spend(data);
      if (rule.format === "identity") requireSchema(isEncodableBeadId(data));
      if (rule.format === "nonempty") requireSchema(data.trim().length > 0);
      if (rule.format === "hash") requireSchema(/^[a-f0-9]{64}$/.test(data));
      if (rule.format === "priority") requireSchema(/^[0-4]?$/.test(data));
      if (rule.format === "collection") {
        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch { requireSchema(false); }
        // The encoded collection is already charged once as a serialized field value.
        validateBeadsSchema(parsed, { type: "array", items: { ...text, maxLength: 4097 }, maxItems: BEADS_SNAPSHOT_LIMITS.records });
      }
      return;
    }
    if (rule.type === "array") {
      requireSchema(Array.isArray(data) && Object.getPrototypeOf(data) === Array.prototype && data.length <= rule.maxItems &&
        Object.keys(data).length === data.length && Reflect.ownKeys(data).length === data.length + 1);
      const ids = new Set<string>();
      for (let index = 0; index < data.length; index++) {
        requireSchema(Object.hasOwn(data, index)); visit(data[index], rule.items);
        if (rule.uniqueIds) { const key = (data[index] as SnapshotRecord).id; requireSchema(!ids.has(key)); ids.add(key); }
      }
      return;
    }
    requireSchema(data !== null && typeof data === "object" && !Array.isArray(data));
    requireSchema(Object.getPrototypeOf(data) === Object.prototype || Object.getPrototypeOf(data) === null);
    requireSchema(Reflect.ownKeys(data).length === Object.keys(data).length);
    const row = data as Record<string, unknown>;
    if (rule.type === "object") requireSchema(rule.required.every(key => Object.hasOwn(row, key)));
    requireSchema(Object.keys(row).length <= (rule.type === "dictionary" ? rule.maxItems : BEADS_SNAPSHOT_LIMITS.records));
    for (const key of Object.keys(row)) {
      if (rule.type === "dictionary") { visit(key, rule.keys); visit(row[key], rule.items); }
      else { requireSchema(Object.hasOwn(rule.properties, key)); visit(row[key], rule.properties[key]); }
    }
    if (rule.type === "dictionary") requireSchema(new Set(Object.values(row)).size === Object.keys(row).length);
  }
  visit(value, schema);
  requireSchema(Buffer.byteLength(JSON.stringify(value)) <= BEADS_SNAPSHOT_LIMITS.bytes);
}
/** Public producer/consumer validator for canonical or live records. */
export function validateBeadsRecords(value: unknown, charge?: (text: string) => void): asserts value is SnapshotRecord[] { validateBeadsSchema(value, BEADS_RECORDS_SCHEMA, charge); }
/** Validate an acknowledgement shape; revision integrity remains the existing digest contract. */
export function validateBeadsAcknowledgement(value: unknown, charge?: (text: string) => void): asserts value is BeadsAcknowledgement { validateBeadsSchema(value, BEADS_ACKNOWLEDGEMENT_SCHEMA, charge); }
/** Translate only expected shape errors, preserving unexpected runtime failures. */
export function checkBeadsSchema(value: unknown, schema: Schema, charge?: (text: string) => void): boolean {
  try { validateBeadsSchema(value, schema, charge); return true; }
  catch (error) { if (error instanceof BeadsSnapshotSchemaError) return false; throw error; }
}
