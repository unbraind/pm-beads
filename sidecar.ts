/** Opt-in, portable Beads extension sidecars; native import/export remains the mapping authority. */
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { writeFileAtomic } from "@unbrained/pm-cli/sdk";
import type { CommandHandlerContext, ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { CommandError } from "./contracts.ts";
import { isEncodableBeadId, optionString, resolveImportInputFile, validateBeadsText } from "./index.ts";

/** Hard ceilings apply equally to SDK calls, capture, and restore; callers cannot disable them. */
export const BEADS_SIDECAR_LIMITS = { bytes: 8 * 1024 * 1024, recordBytes: 16 * 1024, records: 10_000, fields: 128, depth: 16, nodes: 100_000 } as const;
/** Fields consumed by native Beads mapping, including aliases and closure provenance. */
export const BEADS_NATIVE_FIELDS: readonly string[] = [
  "id", "title", "name", "description", "status", "type", "issue_type", "priority", "tags", "labels", "assignee", "owner",
  "parent", "deadline", "due_date", "due_at", "sprint", "release", "created_at", "updated_at", "closed_at", "completed_at",
  "close_reason", "resolution", "state_reason", "dependencies", "blocked_by", "blocks",
];
/** Stable refusal categories; messages never include extension payloads or field names. */
export type BeadsSidecarRefusalCode = "invalid_input" | "invalid_sidecar" | "unsupported_version" | "native_conflict" | "field_conflict" | "identity_mismatch" | "size_limit" | "privacy_limit" | "io_error";
/** Expected refusal with a safe remedy and semantic usage exit code. */
export class BeadsSidecarRefusal extends CommandError {
  /** Stable machine-readable category. */
  readonly code: BeadsSidecarRefusalCode;
  /** Safe corrective action without source payloads. */
  readonly remedy: string;
  /** Construct a payload-free refusal suitable for agent output. */
  constructor(code: BeadsSidecarRefusalCode, remedy: string) {
    super(`${code}: ${remedy}`, 2);
    this.name = "BeadsSidecarRefusal";
    this.code = code;
    this.remedy = remedy;
  }
}
/** Bounded counts report extension loss, not native mapping fidelity. No extension values are rendered. */
export interface BeadsExtensionLossReport {
  records: number; extensionFields: number; preservedFields: number; droppedFields: number;
}
/** JSON values retained recursively, without flattening or coercion. */
export type BeadsExtensionValue = null | boolean | number | string | BeadsExtensionValue[] | { [key: string]: BeadsExtensionValue };
/** Version 1 envelope. Digest detects accidental changes; it is not authentication. */
export interface BeadsExtensionSidecar {
  schema: "pm-beads/extensions"; version: 1; fields: string[];
  records: Array<{ id: string; fields: Record<string, BeadsExtensionValue> }>;
  loss: BeadsExtensionLossReport; digest: string;
}

/** Throw an expected refusal without reflecting untrusted input. */
function refuse(code: BeadsSidecarRefusalCode, remedy: string): never {
  throw new BeadsSidecarRefusal(code, remedy);
}
/** Recognize JSON objects without treating null or arrays as records. */
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Enforce byte ceilings before parsing or writing strings. */
function bounded(text: string, limit = BEADS_SIDECAR_LIMITS.bytes): void {
  if (typeof text !== "string") refuse("invalid_input", "Supply snapshot and sidecar text as UTF-8 strings.");
  if (Buffer.byteLength(text) > limit) refuse("size_limit", "Reduce snapshot or extension payload size and retry; limits cannot be disabled.");
}
/** Reject prototype-sensitive keys, obvious credentials and private identity data recursively. */
function privateKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return /(?:__proto__|^prototype$|^constructor$)/i.test(key) ||
    /(?:apikey|password|secret|token|authorization|cookie|credential|private.?key|email)/.test(normalized);
}
/** Detect obvious private text with linear scans, including repeated incomplete PEM headers. */
function privateText(value: string): boolean {
  const lower = value.toLowerCase();
  return (lower.includes("-----begin ") && lower.includes("private key-----")) ||
    /(?:Bearer\s+\S+|gh[pousr]_[A-Za-z0-9]+|[/](?:home|Users)[/])/i.test(value) ||
    value.split("@").slice(1).some(part => /^[\w.-]+\.[a-z]{2,}/i.test(part));
}
/** Enforce structural, byte and privacy limits together on every key and value before recursive consumers. */
function preflight(value: unknown, maxDepth: number, maxEntries: number = BEADS_SIDECAR_LIMITS.nodes): void {
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  let rawBytes = 0;
  while (stack.length) {
    const current = stack.pop()!;
    nodes++;
    if (current.depth > maxDepth) refuse("size_limit", "Reduce JSON nesting or node count before capture or restore.");
    const item = current.value;
    if (typeof item === "string") rawBytes += Buffer.byteLength(item);
    if (rawBytes > BEADS_SIDECAR_LIMITS.bytes) refuse("size_limit", "Reduce JSON text bytes before capture or restore.");
    if (typeof item === "string" && privateText(item)) refuse("privacy_limit", "Remove credentials, private identity data and local home paths before capture or restore.");
    if (typeof item === "string" && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(item)) refuse("invalid_input", "Use well-formed Unicode strings and keys.");
    if (typeof item === "number" && (!Number.isFinite(item) || Object.is(item, -0) || (Number.isInteger(item) && !Number.isSafeInteger(item)))) refuse("invalid_input", "Use finite numbers and safe integers; encode negative zero or larger integers as strings.");
    if (item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean") continue;
    if (typeof item !== "object" || (Array.isArray(item) ? Object.getPrototypeOf(item) !== Array.prototype : Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) refuse("invalid_input", "Use only plain JSON objects, arrays and scalar values.");
    const keys = Object.keys(item);
    if (keys.length > maxEntries) refuse("size_limit", "Reduce each extension object or array to at most 128 entries.");
    if (keys.length > BEADS_SIDECAR_LIMITS.nodes - nodes - stack.length) refuse("size_limit", "Reduce JSON object keys or total node count.");
    if (Reflect.ownKeys(item).length !== keys.length + (Array.isArray(item) ? 1 : 0) || (Array.isArray(item) && (keys.length !== item.length || keys.some((key, index) => key !== String(index))))) refuse("invalid_input", "Use enumerable JSON data properties and dense arrays without custom or symbol properties.");
    for (const key of keys) {
      if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(key)) refuse("invalid_input", "Use well-formed Unicode strings and keys.");
      rawBytes += Buffer.byteLength(key);
      if (rawBytes > BEADS_SIDECAR_LIMITS.bytes) refuse("size_limit", "Reduce JSON key bytes before capture or restore.");
      if (privateKey(key) || privateText(key)) refuse("privacy_limit", "Remove sensitive, private or prototype-related JSON keys before capture or restore.");
      const property = Object.getOwnPropertyDescriptor(item, key)!;
      if (!("value" in property)) refuse("invalid_input", "Use JSON data properties without accessors.");
      stack.push({ value: property.value, depth: current.depth + 1 });
    }
  }
}
/** Parse JSON without silently discarding duplicate keys, including escaped aliases. */
function parseJson(text: string, code: BeadsSidecarRefusalCode): unknown {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return refuse(code, "Use complete, valid JSON without a byte-order mark."); }
  const stack: Array<Set<string> | null> = [];
  let key = "";
  // JSON.parse has validated syntax. Consume each string once, skipping escaped
  // code units explicitly; no regex engine can retry at escaped quote positions.
  for (let offset = 0; offset < text.length; offset++) {
    const part = text[offset];
    if (part === '"') {
      const start = offset++;
      while (text[offset] !== '"') {
        if (text[offset] === "\\") offset++;
        offset++;
      }
      key = JSON.parse(text.slice(start, offset + 1)) as string;
    } else if (part === "{") stack.push(new Set());
    else if (part === "[") stack.push(null);
    else if (part === "}" || part === "]") stack.pop();
    else if (part === ":") {
      const keys = stack[stack.length - 1]!;
      if (keys.has(key)) refuse(code, "Remove duplicate JSON keys before capture or restore.");
      keys.add(key);
    }
  }
  return parsed;
}
/** Apply the shared traversal with the tighter extension width and depth budgets. */
function safeValue(value: unknown): asserts value is BeadsExtensionValue {
  preflight(value, BEADS_SIDECAR_LIMITS.depth, BEADS_SIDECAR_LIMITS.fields);
}
/** Validate explicit top-level extension selectors; selecting a native field always refuses. */
function selectors(fields: readonly string[]): string[] {
  preflight(fields, 1);
  if (!Array.isArray(fields) || fields.length > BEADS_SIDECAR_LIMITS.fields || fields.some(field => typeof field !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(field))) {
    refuse("invalid_input", "Choose at most 128 top-level extension names using letters, digits, underscores or hyphens.");
  }
  if (fields.some(field => BEADS_NATIVE_FIELDS.includes(field))) refuse("native_conflict", "Remove native fields and aliases from --fields; use ordinary Beads mappings for them.");
  if (fields.some(privateKey)) refuse("privacy_limit", "Select only non-sensitive extension keys; sensitive and prototype-related keys cannot be retained.");
  return [...new Set(fields)].sort();
}
/** Enforce the same exact, unique external identities in snapshots and envelopes. */
function validateIdentity(id: unknown, ids: Set<string>): asserts id is string {
  if (typeof id !== "string" || !isEncodableBeadId(id) || ids.has(id)) refuse("invalid_input", "Give every record a unique, encodable external id and preserve ids during import/export.");
  safeValue(id);
  ids.add(id);
}
/** Serialize and bound the actual JSONL output, including its terminal newline. */
function serializeRecords(records: readonly Record<string, unknown>[]): string {
  preflight(records, BEADS_SIDECAR_LIMITS.depth + 2);
  const text = records.map(row => JSON.stringify(row)).join("\n") + (records.length ? "\n" : "");
  bounded(text);
  return text;
}
/** Validate every native slot before mapping helpers can coerce it; null denotes an absent optional value. */
function validateNativeFields(row: unknown): asserts row is Record<string, unknown> {
  if (!object(row)) refuse("invalid_input", "Use JSON objects with correctly typed native Beads fields.");
  if (typeof row.id !== "string") refuse("invalid_input", "Give every record a string external id.");
  for (const field of BEADS_NATIVE_FIELDS) {
    const value = row[field];
    if (value === undefined || value === null) continue;
    let valid: boolean;
    if (field === "priority") valid = typeof value === "string" || typeof value === "number";
    else if (field === "tags" || field === "labels") valid = Array.isArray(value) && value.every(entry => typeof entry === "string");
    else if (field === "blocked_by" || field === "blocks") valid = typeof value === "string" || (Array.isArray(value) && value.every(entry => typeof entry === "string"));
    else if (field === "dependencies") {
      valid = Array.isArray(value) && value.every(entry => typeof entry === "string" || (object(entry) &&
        ["id", "kind", "issue_id", "depends_on_id", "type"].every(key => entry[key] === undefined || entry[key] === null || typeof entry[key] === "string")));
    } else valid = typeof value === "string";
    if (!valid) refuse("invalid_input", "Use strings for native text fields, string or numeric priority, string label arrays and typed dependency edges.");
  }
}
/** Parse a bounded, structurally valid JSONL snapshot with exact unique ids. */
function parseRecords(text: string): Array<Record<string, unknown> & { id: string }> {
  bounded(text);
  const lines = text.split("\n").filter(line => /[^\t\r ]/.test(line));
  if (lines.length > BEADS_SIDECAR_LIMITS.records) refuse("size_limit", "Split the snapshot into at most 10000 records per sidecar.");
  const rows = lines.map(line => {
    const row = parseJson(line, "invalid_input");
    preflight(row, BEADS_SIDECAR_LIMITS.depth + 1);
    validateNativeFields(row);
    return row;
  });
  preflight(rows, BEADS_SIDECAR_LIMITS.depth + 2);
  if (!validateBeadsText(text).valid) refuse("invalid_input", "Run beads validate and repair the JSONL snapshot before capture or restore.");
  const ids = new Set<string>();
  return rows.map(parsed => {
    const row = parsed as Record<string, unknown>;
    validateIdentity(row.id, ids);
    return row as Record<string, unknown> & { id: string };
  });
}
/** Canonical JSON makes object key order immaterial to integrity and collision checks. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Compute the envelope integrity digest, excluding its own digest property. */
function digest(sidecar: BeadsExtensionSidecar): string {
  return createHash("sha256").update(canonical({ ...sidecar, digest: "" })).digest("hex");
}
/** Capture opted-in unknown top-level fields, retaining all their nested JSON values. No tracker writes. */
export function captureBeadsExtensions(text: string, fields: readonly string[]): BeadsExtensionSidecar {
  const selected = selectors(fields);
  const rows = parseRecords(text);
  serializeRecords(rows);
  const loss: BeadsExtensionLossReport = { records: rows.length, extensionFields: 0, preservedFields: 0, droppedFields: 0 };
  const records = rows.map(row => {
    const extensions: Record<string, BeadsExtensionValue> = {};
    for (const [key, value] of Object.entries(row)) {
      if (BEADS_NATIVE_FIELDS.includes(key)) continue;
      loss.extensionFields++;
      if (!selected.includes(key)) { loss.droppedFields++; continue; }
      safeValue(value);
      extensions[key] = value;
      loss.preservedFields++;
    }
    bounded(JSON.stringify(extensions), BEADS_SIDECAR_LIMITS.recordBytes);
    return { id: row.id, fields: extensions };
  });
  const sidecar: BeadsExtensionSidecar = { schema: "pm-beads/extensions", version: 1, fields: selected, records, loss, digest: "" };
  preflight(sidecar, BEADS_SIDECAR_LIMITS.depth + 5);
  sidecar.digest = digest(sidecar);
  bounded(JSON.stringify(sidecar));
  return sidecar;
}
/** Read an untrusted envelope and reapply version, shape, privacy, size and integrity checks. */
export function parseBeadsExtensionSidecar(text: string): BeadsExtensionSidecar {
  bounded(text);
  return validateSidecar(parseJson(text, "invalid_sidecar"));
}
/** Validate JSON and typed SDK envelopes before serialization can coerce non-finite values. */
function validateSidecar(parsed: unknown): BeadsExtensionSidecar {
  preflight(parsed, BEADS_SIDECAR_LIMITS.depth + 5);
  if (!object(parsed) || parsed.schema !== "pm-beads/extensions") refuse("invalid_sidecar", "Use a pm-beads/extensions envelope produced by capture.");
  if (parsed.version !== 1) refuse("unsupported_version", "Use a compatible pm-beads version; never rewrite an unknown sidecar version.");
  if (Object.keys(parsed).sort().join(",") !== "digest,fields,loss,records,schema,version" || !Array.isArray(parsed.fields) || !Array.isArray(parsed.records) || !object(parsed.loss) || typeof parsed.digest !== "string") refuse("invalid_sidecar", "Restore a complete sidecar envelope from capture.");
  const selected = selectors(parsed.fields);
  if (parsed.records.length > BEADS_SIDECAR_LIMITS.records) refuse("size_limit", "Split the snapshot into at most 10000 records per sidecar.");
  const ids = new Set<string>();
  let preservedFields = 0;
  for (const entry of parsed.records) {
    if (!object(entry) || Object.keys(entry).sort().join(",") !== "fields,id" || typeof entry.id !== "string" || !object(entry.fields) || Object.keys(entry.fields).some(key => !selected.includes(key))) refuse("invalid_sidecar", "Repair malformed records or fields outside the explicit opt-in set by recapturing.");
    validateIdentity(entry.id, ids);
    for (const value of Object.values(entry.fields)) safeValue(value);
    bounded(JSON.stringify(entry.fields), BEADS_SIDECAR_LIMITS.recordBytes);
    preservedFields += Object.keys(entry.fields).length;
  }
  const loss = parsed.loss;
  if (Object.keys(loss).sort().join(",") !== "droppedFields,extensionFields,preservedFields,records" || ["records", "extensionFields", "preservedFields", "droppedFields"].some(key => !Number.isSafeInteger(loss[key]) || Number(loss[key]) < 0) ||
      loss.records !== parsed.records.length || loss.preservedFields !== preservedFields ||
      loss.extensionFields !== Number(loss.preservedFields) + Number(loss.droppedFields)) refuse("invalid_sidecar", "Recapture a sidecar with consistent nonnegative loss counts.");
  const sidecar = parsed as unknown as BeadsExtensionSidecar;
  bounded(JSON.stringify(sidecar));
  if (sidecar.digest !== digest(sidecar)) refuse("invalid_sidecar", "Restore the original sidecar or recapture it; its integrity digest does not match.");
  return sidecar;
}
/** Restore extensions by exact id after ordinary export; refuse omissions and conflicting overlays. */
export function restoreBeadsExtensions(text: string, envelope: BeadsExtensionSidecar): { text: string; loss: BeadsExtensionLossReport } {
  const sidecar = validateSidecar(envelope);
  const records = parseRecords(text);
  const extensions = new Map(sidecar.records.map(row => [row.id, row.fields]));
  if (records.length !== extensions.size || records.some(row => !extensions.has(row.id))) refuse("identity_mismatch", "Export the same complete record set with preserved ids; use a separate sidecar for each filtered snapshot.");
  for (const row of records) {
    for (const [key, value] of Object.entries(extensions.get(row.id)!)) {
      if (Object.hasOwn(row, key)) safeValue(row[key]);
      if (Object.hasOwn(row, key) && canonical(row[key]) !== canonical(value)) refuse("field_conflict", "Resolve the conflicting extension values explicitly and recapture; restore never overwrites differing values.");
      row[key] = value;
    }
  }
  const restored = serializeRecords(records);
  return { text: restored, loss: sidecar.loss };
}
/** Read one bounded input with a sanitized filesystem refusal. */
async function input(file: string): Promise<string> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) refuse("io_error", "Choose a regular UTF-8 input file and retry.");
      const buffer = Buffer.alloc(BEADS_SIDECAR_LIMITS.bytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > BEADS_SIDECAR_LIMITS.bytes) refuse("size_limit", "Reduce input files to at most 8 MiB before retrying.");
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
    } finally { await handle.close(); }
  }
  catch (error) {
    if (error instanceof BeadsSidecarRefusal) throw error;
    return refuse("io_error", "Choose an accessible UTF-8 input file and retry.");
  }
}
/** Resolve the output's existing parent and refuse aliases of either input before any write. */
export async function distinctOutput(destination: string, sources: string[]): Promise<string> {
  try {
    const output = resolve(await realpath(dirname(destination)), basename(destination));
    const existing = await lstat(output).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    const target = existing ? await realpath(output) : output;
    const inputs = await Promise.all(sources.map(source => realpath(source)));
    if (inputs.includes(output) || inputs.includes(target)) refuse("invalid_input", "Choose an output different from both input files; capture and restore preserve their sources.");
    if (existing && !existing.isFile()) refuse("io_error", "Choose a regular output file or a new file name; links and special files cannot be replaced.");
    return output;
  } catch (error) {
    if (error instanceof BeadsSidecarRefusal) throw error;
    return refuse("io_error", "Choose accessible input files and an output with an accessible existing parent directory.");
  }
}
/** Emit only a compact receipt; sidecar values and JSONL always go to explicitly selected files. */
async function runSidecar(ctx: CommandHandlerContext) {
  const capture = optionString(ctx.options, "capture");
  const restore = optionString(ctx.options, "restore");
  const file = resolveImportInputFile(ctx.args, ["--capture", "--restore", "--fields", "--output"]);
  const output = optionString(ctx.options, "output");
  const fields = optionString(ctx.options, "fields");
  if (!file || Boolean(capture) === Boolean(restore) || (capture && (!fields || output)) || (restore && (!output || fields))) refuse("invalid_input", "Use beads sidecar <input> --capture <sidecar> --fields <names>, or --restore <sidecar> --output <jsonl>.");
  const destination = await distinctOutput((capture ?? output)!, restore ? [file, restore] : [file]);
  const raw = await input(file);
  const sidecar = capture ? captureBeadsExtensions(raw, fields!.split(",").map(field => field.trim())) : parseBeadsExtensionSidecar(await input(restore!));
  const restored = capture ? undefined : restoreBeadsExtensions(raw, sidecar);
  const content = capture ? JSON.stringify(sidecar) : restored!.text;
  try { await writeFileAtomic(destination, content); }
  catch { return refuse("io_error", "Choose a writable output file and retry; no tracker items were changed."); }
  return { schema: sidecar.schema, version: sidecar.version, action: capture ? "capture" : "restore", bytes: Buffer.byteLength(content), loss: sidecar.loss,
    remedy: sidecar.loss.droppedFields ? "Unselected extension fields were omitted; review opt-in fields and recapture if needed." : "Keep the sidecar with this snapshot; native mapping fidelity is audited separately with beads diff." };
}
/** Register a portable command that uses no git or tracker mutations and lets the host render TOON/JSON. */
export function registerSidecarCommands(api: ExtensionApi): void {
  api.registerCommand({
    name: "beads sidecar", description: "Capture opted-in opaque Beads extensions before import, or restore them after export with a versioned loss report.",
    arguments: [{ name: "file", required: true, description: "Original or exported Beads JSONL snapshot." }],
    flags: [
      { long: "--capture", value_type: "string", value_name: "file", description: "Write a versioned extension sidecar before import." },
      { long: "--fields", value_type: "string", value_name: "names", description: "Comma-separated top-level unknown fields to retain recursively; native names refuse." },
      { long: "--restore", value_type: "string", value_name: "file", description: "Read the matching versioned sidecar after export." },
      { long: "--output", value_type: "string", value_name: "file", description: "Write fully restored JSONL only after all checks pass." },
    ],
    examples: ["pm beads sidecar incoming.jsonl --capture extensions.json --fields vendor --json", "pm beads sidecar exported.jsonl --restore extensions.json --output restored.jsonl"],
    run: runSidecar,
  });
}
