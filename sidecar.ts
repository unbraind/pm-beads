/** Opt-in, portable Beads extension sidecars; native import/export remains the mapping authority. */
import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { writeFileAtomic } from "@unbrained/pm-cli/sdk";
import type { CommandHandlerContext, ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { CommandError } from "./contracts.ts";
import { isEncodableBeadId, optionString, resolveImportInputFile, validateBeadsText } from "./index.ts";

/** Hard ceilings apply equally to SDK calls, capture, and restore; callers cannot disable them. */
export const BEADS_SIDECAR_LIMITS = { bytes: 8 * 1024 * 1024, recordBytes: 16 * 1024, records: 10_000, fields: 128, depth: 16 } as const;
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
/** Validate the opaque JSON tree before retaining it; this baseline is intentionally conservative. */
function safeValue(value: unknown, depth = 0): asserts value is BeadsExtensionValue {
  if (depth > BEADS_SIDECAR_LIMITS.depth) refuse("size_limit", "Reduce extension nesting to at most 16 levels.");
  if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) refuse("invalid_input", "Use finite numbers and safe integers in extensions; encode larger integers as strings in the source tool.");
  if (typeof value === "string" && privateText(value)) {
    refuse("privacy_limit", "Remove credentials, private identity data and local home paths from opted-in extensions before capture or restore.");
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > BEADS_SIDECAR_LIMITS.fields) refuse("size_limit", "Reduce each extension object or array to at most 128 entries.");
    for (const [key, child] of entries) {
      if (privateKey(key)) refuse("privacy_limit", "Remove sensitive or prototype-related extension keys before capture or restore.");
      safeValue(child, depth + 1);
    }
  }
}
/** Validate explicit top-level extension selectors; selecting a native field always refuses. */
function selectors(fields: readonly string[]): string[] {
  if (!Array.isArray(fields) || fields.length > BEADS_SIDECAR_LIMITS.fields || fields.some(field => typeof field !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(field))) {
    refuse("invalid_input", "Choose at most 128 top-level extension names using letters, digits, underscores or hyphens.");
  }
  if (fields.some(field => BEADS_NATIVE_FIELDS.includes(field))) refuse("native_conflict", "Remove native fields and aliases from --fields; use ordinary Beads mappings for them.");
  if (fields.some(privateKey)) refuse("privacy_limit", "Select only non-sensitive extension keys; sensitive and prototype-related keys cannot be retained.");
  return [...new Set(fields)].sort();
}
/** Parse a bounded, structurally valid JSONL snapshot with exact unique ids. */
function parseRecords(text: string): Array<Record<string, unknown> & { id: string }> {
  bounded(text);
  const lines = text.split("\n").filter(line => line.trim());
  if (lines.length > BEADS_SIDECAR_LIMITS.records) refuse("size_limit", "Split the snapshot into at most 10000 records per sidecar.");
  if (!validateBeadsText(text).valid) refuse("invalid_input", "Run beads validate and repair the JSONL snapshot before capture or restore.");
  const ids = new Set<string>();
  return lines.map(line => {
    const row = JSON.parse(line) as Record<string, unknown>;
    if (typeof row.id !== "string" || !isEncodableBeadId(row.id) || ids.has(row.id)) refuse("invalid_input", "Give every record a unique, encodable external id and preserve ids during import/export.");
    safeValue(row.id);
    ids.add(row.id);
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
  sidecar.digest = digest(sidecar);
  bounded(JSON.stringify(sidecar));
  return sidecar;
}
/** Read an untrusted envelope and reapply version, shape, privacy, size and integrity checks. */
export function parseBeadsExtensionSidecar(text: string): BeadsExtensionSidecar {
  bounded(text);
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return refuse("invalid_sidecar", "Use a valid JSON sidecar produced by beads sidecar --capture."); }
  return validateSidecar(parsed);
}
/** Validate JSON and typed SDK envelopes before serialization can coerce non-finite values. */
function validateSidecar(parsed: unknown): BeadsExtensionSidecar {
  if (!object(parsed) || parsed.schema !== "pm-beads/extensions") refuse("invalid_sidecar", "Use a pm-beads/extensions envelope produced by capture.");
  if (parsed.version !== 1) refuse("unsupported_version", "Use a compatible pm-beads version; never rewrite an unknown sidecar version.");
  if (Object.keys(parsed).sort().join(",") !== "digest,fields,loss,records,schema,version" || !Array.isArray(parsed.fields) || !Array.isArray(parsed.records) || !object(parsed.loss) || typeof parsed.digest !== "string") refuse("invalid_sidecar", "Restore a complete sidecar envelope from capture.");
  const selected = selectors(parsed.fields);
  const rows: Record<string, unknown>[] = [];
  for (const entry of parsed.records) {
    if (!object(entry) || Object.keys(entry).sort().join(",") !== "fields,id" || typeof entry.id !== "string" || !object(entry.fields) || Object.keys(entry.fields).some(key => !selected.includes(key))) refuse("invalid_sidecar", "Repair malformed records or fields outside the explicit opt-in set by recapturing.");
    for (const value of Object.values(entry.fields)) safeValue(value);
    rows.push({ ...entry.fields, id: entry.id, title: "Sidecar identity validation" });
  }
  const rebuilt = captureBeadsExtensions(rows.map(row => JSON.stringify(row)).join("\n"), selected);
  const loss = parsed.loss;
  if (Object.keys(loss).sort().join(",") !== "droppedFields,extensionFields,preservedFields,records" || ["records", "extensionFields", "preservedFields", "droppedFields"].some(key => !Number.isSafeInteger(loss[key]) || Number(loss[key]) < 0) ||
      loss.records !== rebuilt.loss.records || loss.preservedFields !== rebuilt.loss.preservedFields ||
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
  const restored = records.map(row => JSON.stringify(row)).join("\n") + (records.length ? "\n" : "");
  bounded(restored);
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
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    } finally { await handle.close(); }
  }
  catch (error) {
    if (error instanceof BeadsSidecarRefusal) throw error;
    return refuse("io_error", "Choose an accessible UTF-8 input file and retry.");
  }
}
/** Resolve the output's existing parent and refuse aliases of either input before any write. */
async function distinctOutput(destination: string, sources: string[]): Promise<string> {
  try {
    const output = resolve(await realpath(dirname(destination)), basename(destination));
    const target = await realpath(output).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return output;
    });
    const inputs = await Promise.all(sources.map(source => realpath(source)));
    if (inputs.includes(output) || inputs.includes(target)) refuse("invalid_input", "Choose an output different from both input files; capture and restore preserve their sources.");
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
  const content = capture ? JSON.stringify(sidecar) + "\n" : restored!.text;
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
