/** Read-only, byte-revision-bound repair context for Beads dependency errors. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createRequire } from "node:module";
import type * as PmGraphSdk from "@unbrained/pm-cli/sdk/graph";
import type { CommandHandlerContext, ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { CommandError } from "./contracts.ts";
import { jsonSourceEntries, replaceJsonField } from "./json-source.ts";
import { beadTitle, extractBlockerIds, normalizeBeadKey, validateBeadsText, type BeadsItem } from "./index.ts";

/** Default integer work and payload budgets; exceeding a bound never implies validity. */
export const BEADS_REPAIR_LIMITS = {
  maxRows: 10_000, maxEdges: 40_000, maxInputBytes: 4_194_304,
  maxOutputBytes: 32_768, maxWitnesses: 100, maxEdits: 32, maxAnalyses: 16,
} as const;
/** Explicit controls shared by the SDK and CLI boundary schema. */
export type BeadsRepairLimits = { -readonly [K in keyof typeof BEADS_REPAIR_LIMITS]: number };
const ceilings: BeadsRepairLimits = {
  maxRows: 100_000, maxEdges: 400_000, maxInputBytes: 33_554_432,
  maxOutputBytes: 1_048_576, maxWitnesses: 10_000, maxEdits: 256, maxAnalyses: 64,
};
/** Expected refusals distinguish input, work, payload, source drift and file access failures. */
export type BeadsRepairRefusalCode = "invalid_input" | "input_budget" | "work_budget" | "output_budget" | "source_changed" | "invalid_candidate" | "unreadable_input";
/** Stable refusal with an actionable remedy and no source contents or operator paths. */
export class BeadsRepairRefusal extends CommandError {
  /** Machine-readable failure category. */
  readonly code: BeadsRepairRefusalCode;
  /** Instructions explaining how to make a bounded retry. */
  readonly remedy: string;
  /** Construct an expected SDK error and clean CLI exit. */
  constructor(code: BeadsRepairRefusalCode, remedy: string) {
    super(`${code}: ${remedy}`, 2); this.name = "BeadsRepairRefusal"; this.code = code; this.remedy = remedy;
  }
}
/** A physical one-based JSONL line and its exact normalized external identity. */
export interface BeadsRepairRow { line: number; id: string }
/** An edge points from the dependent to its blocker, using case-sensitive Beads identities. */
export interface BeadsRepairEdge extends BeadsRepairRow { blocker: string; blockerLine: number }
/** Unresolved evidence is retained independently of usable rows and cycle witnesses. */
export interface BeadsRepairGap { line: number; code: string; id?: string; target?: string }
/** A proposal removes semantic blocker edges from all their accepted storage aliases. */
export interface BeadsRepairCandidate {
  sourceRevision: string; remove: BeadsRepairEdge[]; revalidated: true;
}
/** Compact packet contains no titles, bodies or unrelated row payloads. */
export interface BeadsDependencyRepairPacket {
  schema: 1; sourceRevision: string; valid: boolean; limits: BeadsRepairLimits;
  counts: { rows: number; edges: number; cycles: number; gaps: number; analyses: number };
  cycles: { rows: BeadsRepairRow[]; edges: BeadsRepairEdge[] }[];
  gaps: BeadsRepairGap[]; candidates: BeadsRepairCandidate[]; remedy: string;
}
interface Row extends BeadsRepairRow { item: BeadsItem }
interface Parsed { lines: string[]; rows: Row[]; edges: BeadsRepairEdge[]; gaps: BeadsRepairGap[] }
const require = createRequire(import.meta.url);
let graphSdk: typeof PmGraphSdk | undefined;

/** Raise a typed refusal without disclosing arbitrary input. */
function refuse(code: BeadsRepairRefusalCode, remedy: string): never { throw new BeadsRepairRefusal(code, remedy); }
/** Hash exact source bytes, including line endings and blank lines. */
function revision(text: string): string { return createHash("sha256").update(text).digest("hex"); }
/** One strict boundary schema for all supplied work and payload controls. */
function limitsOf(input: unknown): BeadsRepairLimits {
  if (!input || typeof input !== "object" || Array.isArray(input)) refuse("invalid_input", "Supply an object of documented integer budget controls.");
  const result = { ...BEADS_REPAIR_LIMITS } as BeadsRepairLimits;
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(ceilings, key)) refuse("invalid_input", "Use only the documented budget controls.");
    const name = key as keyof BeadsRepairLimits;
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > ceilings[name]) refuse("invalid_input", `Choose ${key} as an integer from 1 through ${ceilings[name]}.`);
    result[name] = value as number;
  }
  return result;
}
/** Keep dependency identity validation aligned with the producer's case-preserving normalizer. */
function identity(value: unknown): value is string {
  return typeof value === "string" && Boolean(normalizeBeadKey(value)) && value.length <= 4097;
}
/** Require an exact JSON object shape; functions and serialization hooks never become authority. */
function objectKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"));
}
/** Shared producer/consumer schema snapshots a dense, bounded proposal into canonical field order. */
function candidateOf(value: unknown, limits: BeadsRepairLimits): BeadsRepairCandidate {
  if (!objectKeys(value, ["sourceRevision", "remove", "revalidated"]) || typeof value.sourceRevision !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.sourceRevision) || value.revalidated !== true || !Array.isArray(value.remove) ||
      value.remove.length < 1 || value.remove.length > limits.maxEdits) refuse("invalid_candidate", "Use a complete candidate emitted for this source revision and these limits.");
  const remove: BeadsRepairEdge[] = [];
  for (let index = 0; index < value.remove.length; index++) {
    if (!Object.hasOwn(value.remove, index)) refuse("invalid_candidate", "Use dense candidate edit arrays without missing entries.");
    const edge: unknown = value.remove[index];
    if (!objectKeys(edge, ["line", "id", "blocker", "blockerLine"]) ||
        !identity(edge.id) || !identity(edge.blocker) ||
        ![edge.line, edge.blockerLine].every(line => Number.isSafeInteger(line) && (line as number) >= 1 && (line as number) <= limits.maxInputBytes)) refuse("invalid_candidate", "Keep exact source coordinates and external identities from the emitted candidate.");
    remove.push({ line: edge.line as number, id: edge.id, blocker: edge.blocker, blockerLine: edge.blockerLine as number });
  }
  return { sourceRevision: value.sourceRevision, remove, revalidated: true };
}
/** Validate dependency-bearing fields while retaining foreign fields and previously supported aliases. */
function dependencyShape(item: BeadsItem): boolean {
  if (item.id !== undefined && !identity(item.id)) return false;
  if (item.blocked_by !== undefined && !(identity(item.blocked_by) || (Array.isArray(item.blocked_by) && item.blocked_by.every(identity)))) return false;
  if (item.dependencies === undefined) return true;
  return Array.isArray(item.dependencies) && item.dependencies.every(dep => {
    if (identity(dep)) return true;
    if (!dep || typeof dep !== "object" || Array.isArray(dep)) return false;
    return [dep.id, dep.depends_on_id, dep.issue_id].some(identity) &&
      [dep.id, dep.depends_on_id, dep.issue_id, dep.kind, dep.type].every(value => value === undefined || identity(value));
  });
}
/** Bound nesting; opaque numeric lexemes are retained in source, while native numeric inputs must be finite. */
function finiteJson(value: unknown): boolean {
  const pending = [{ value, depth: 0 }];
  while (pending.length) {
    const entry = pending.pop()!;
    if (entry.depth > 64) return false;
    if (entry.value && typeof entry.value === "object") for (const child of Object.values(entry.value)) pending.push({ value: child, depth: entry.depth + 1 });
  }
  return true;
}
/** Parse each row independently and attach exact edge coordinates without title-based resolution. */
function parse(text: string, limits: BeadsRepairLimits): Parsed {
  if (typeof text !== "string") refuse("invalid_input", "Supply Beads JSONL text.");
  if (Buffer.byteLength(text) > limits.maxInputBytes) refuse("input_budget", "Narrow the JSONL input or raise maxInputBytes within its ceiling.");
  const lines = text.split("\n"), rows: Row[] = [], gaps: BeadsRepairGap[] = [];
  let nonblank = 0;
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    if (++nonblank > limits.maxRows) refuse("input_budget", "Narrow the JSONL input or raise maxRows within its ceiling.");
    let value: unknown;
    try { value = JSON.parse(lines[index]); }
    catch { gaps.push({ line: index + 1, code: "invalid_json" }); continue; }
    if (!value || typeof value !== "object" || Array.isArray(value) || !finiteJson(value)) { gaps.push({ line: index + 1, code: "invalid_record" }); continue; }
    const item = value as BeadsItem;
    if (typeof item.priority === "number" && !Number.isFinite(item.priority)) { gaps.push({ line: index + 1, code: "invalid_record" }); continue; }
    if ([item.title, item.name].some(title => title !== undefined && typeof title !== "string")) { gaps.push({ line: index + 1, code: "invalid_record" }); continue; }
    if (!dependencyShape(item)) { gaps.push({ line: index + 1, code: "malformed_dependency" }); continue; }
    const id = normalizeBeadKey(item.id);
    if (!id) { gaps.push({ line: index + 1, code: "missing_id" }); continue; }
    rows.push({ line: index + 1, id, item });
  }
  const byId = new Map<string, Row>(), duplicates = new Set<string>();
  for (const row of rows) {
    if (row.item.blocks !== undefined) gaps.push({ line: row.line, id: row.id, code: "unsupported_blocks" });
    for (const dep of row.item.dependencies ?? []) if (typeof dep === "object" && !extractBlockerIds({ dependencies: [dep] }).length) gaps.push({ line: row.line, id: row.id, code: "uninterpreted_dependency" });
    if (byId.has(row.id)) { duplicates.add(row.id); gaps.push({ line: row.line, code: "duplicate_id", id: row.id }); }
    else byId.set(row.id, row);
  }
  const edges: BeadsRepairEdge[] = [];
  let edgeCount = 0;
  for (const row of rows) {
    for (const blocker of extractBlockerIds(row.item)) {
      if (++edgeCount > limits.maxEdges) refuse("input_budget", "Narrow dependencies or raise maxEdges within its ceiling.");
      const target = byId.get(blocker);
      if (!target || duplicates.has(blocker) || duplicates.has(row.id)) gaps.push({ line: row.line, code: "unresolved_dependency", id: row.id, target: blocker });
      else edges.push({ line: row.line, id: row.id, blocker, blockerLine: target.line });
    }
  }
  // Share the producer's title rule without running legacy cycle enumeration on an invalid graph.
  for (const row of rows) if (!beadTitle(row.item)) gaps.push({ line: row.line, code: "missing_title" });
  return { lines, rows, edges, gaps };
}
/** Ask core for exact cycle components over opaque tokens, preserving external case and punctuation. */
function components(rows: Row[], edges: BeadsRepairEdge[]): string[][] {
  // The supported module loader resolves the public peer export lazily, never argv or executable symlinks.
  const sdk = graphSdk ??= require("@unbrained/pm-cli/sdk/graph") as typeof PmGraphSdk;
  // Diagnostic graphs must represent invalid self-edges that mutation APIs correctly refuse.
  const registry = new sdk.RelationshipKindRegistry(sdk.BUILTIN_RELATIONSHIP_KINDS.map(kind => ({ ...kind, allowSelf: true })));
  return sdk.analyzeRelationshipExecution(new sdk.RelationshipGraph(rows.map(row => `r${row.line}`), edges.map(edge => ({
    source: `r${edge.line}`, target: `r${edge.blockerLine}`, kind: "blocked_by",
  })), registry), { registry }).cycles;
}
/** Project core components back to physical source coordinates and every internal edge. */
function witnesses(parsed: Parsed, cycles: string[][]): BeadsDependencyRepairPacket["cycles"] {
  const result: BeadsDependencyRepairPacket["cycles"] = cycles.map(() => ({ rows: [], edges: [] }));
  const membership = new Map(cycles.flatMap((component, index) => component.map(id => [id, index] as const)));
  for (const { line, id } of parsed.rows) {
    const group = membership.get(`r${line}`); if (group !== undefined) result[group].rows.push({ line, id });
  }
  for (const edge of parsed.edges) {
    const group = membership.get(`r${edge.line}`);
    if (group !== undefined && group === membership.get(`r${edge.blockerLine}`)) result[group].edges.push(edge);
  }
  return result;
}
/** Remove a semantic blocker from all accepted aliases without normalizing unrelated native fields. */
function removeEdge(text: string, blocker: string): string {
  for (const field of ["dependencies", "blocked_by"]) {
    const member = jsonSourceEntries(text).filter(entry => entry.key === field).at(-1);
    if (!member) continue;
    if (text[member.valueStart] === "[") {
      const entries = jsonSourceEntries(text, member.valueStart);
      const kept = entries.filter(entry => {
        const value = JSON.parse(text.slice(entry.valueStart, entry.end)) as NonNullable<BeadsItem["dependencies"]>[number];
        return field === "dependencies" ? !extractBlockerIds({ dependencies: [value] }).includes(blocker) : normalizeBeadKey(value) !== blocker;
      });
      if (kept.length !== entries.length) text = replaceJsonField(text, field, `[${kept.map(entry => text.slice(entry.valueStart, entry.end)).join(",")}]`);
    } else if (normalizeBeadKey(JSON.parse(text.slice(member.valueStart, member.end))) === blocker) text = replaceJsonField(text, field, undefined);
  }
  return text;
}
/** Evaluate a proposal entirely in memory; each edited row preserves its other native fields. */
function editedText(parsed: Parsed, remove: BeadsRepairEdge[]): string {
  const lines = [...parsed.lines];
  for (const edge of remove) {
    lines[edge.line - 1] = removeEdge(lines[edge.line - 1], edge.blocker);
  }
  return lines.join("\n");
}
/** Produce a deterministic feedback-edge proposal, rechecking core topology after each edit round. */
function candidate(parsed: Parsed, initial: BeadsDependencyRepairPacket["cycles"], limits: BeadsRepairLimits, sourceRevision: string): { candidate?: BeadsRepairCandidate; analyses: number } {
  let cycles = initial, analyses = 1;
  const remove: BeadsRepairEdge[] = [];
  while (cycles.length) {
    if (analyses >= limits.maxAnalyses || remove.length + cycles.length > limits.maxEdits) return { analyses };
    for (const cycle of cycles) remove.push(cycle.edges[0]);
    const removed = new Set(remove.map(edge => `${edge.line}:${edge.blockerLine}`));
    const edges = parsed.edges.filter(edge => !removed.has(`${edge.line}:${edge.blockerLine}`));
    cycles = witnesses({ ...parsed, edges }, components(parsed.rows, edges)); analyses++;
  }
  const proposals: BeadsRepairCandidate[] = [{ sourceRevision, remove, revalidated: true }];
  return { candidate: proposals.find(() => validateBeadsText(editedText(parsed, remove)).valid), analyses };
}
/** Check emitted numeric domains before ok, including every physical source coordinate. */
export function assertBeadsRepairNumbers(input: unknown): void {
  const pending: unknown[] = [input];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) refuse("work_budget", "Retry with a smaller input; a result exceeded the integer domain.");
    if (Array.isArray(value)) for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) refuse("invalid_input", "Supply dense arrays; sparse result arrays are not portable.");
      pending.push(value[index]);
    }
    else if (value && typeof value === "object") pending.push(...Object.values(value));
  }
}
/** Enforce both the output numeric postcondition and serialized JSON payload bound. */
function checked(packet: BeadsDependencyRepairPacket): BeadsDependencyRepairPacket {
  assertBeadsRepairNumbers(packet);
  packet.candidates = packet.candidates.map(proposal => candidateOf(proposal, packet.limits));
  if (packet.cycles.reduce((count, cycle) => count + cycle.rows.length + cycle.edges.length, packet.gaps.length) > packet.limits.maxWitnesses || Buffer.byteLength(JSON.stringify(packet, null, 2) + "\n") > packet.limits.maxOutputBytes) refuse("output_budget", "Raise maxWitnesses or maxOutputBytes within their ceilings, or narrow the input. No partial packet was returned.");
  return packet;
}
/** Build bounded dependency witnesses and fully revalidated proposals without reading or writing a tracker. */
export function explainBeadsDependencies(text: string, input: Partial<BeadsRepairLimits> = {}): BeadsDependencyRepairPacket {
  const limits = limitsOf(input), parsed = parse(text, limits), sourceRevision = revision(text);
  const cycles = witnesses(parsed, components(parsed.rows, parsed.edges));
  const proposal = cycles.length && !parsed.gaps.length ? candidate(parsed, cycles, limits, sourceRevision) : { analyses: 1 };
  return checked({ schema: 1, sourceRevision, valid: !cycles.length && !parsed.gaps.length, limits,
    counts: { rows: parsed.rows.length, edges: parsed.edges.length, cycles: cycles.length, gaps: parsed.gaps.length, analyses: proposal.analyses },
    cycles, gaps: parsed.gaps, candidates: proposal.candidate ? [proposal.candidate] : [],
    remedy: parsed.gaps.length ? "Resolve the explicit gaps using exact source identities, then regenerate. No replacement identity was inferred." :
      cycles.length ? "Review the proposed edge removals. Revalidate against these exact source bytes before writing; if no candidate fits, raise maxEdits/maxAnalyses or repair manually." : "No dependency repair is needed.",
  });
}
/** Re-read exact source text and regenerate the producer's proposal before returning corrected JSONL in memory. */
export function previewBeadsDependencyRepair(text: string, proposal: BeadsRepairCandidate, input: Partial<BeadsRepairLimits> = {}): string {
  const limits = limitsOf(input), candidate = candidateOf(proposal, limits), packet = explainBeadsDependencies(text, limits);
  if (candidate.sourceRevision !== packet.sourceRevision) refuse("source_changed", "Read the current source and regenerate the packet; never replay a saved proposal against another revision.");
  if (JSON.stringify(candidate) !== JSON.stringify(packet.candidates[0])) refuse("invalid_candidate", "Use the complete unmodified candidate emitted for this source revision and these limits.");
  return editedText(parse(text, packet.limits), candidate.remove);
}
/** Read at most the declared byte budget plus one, including when a file grows during the read. */
async function readInput(file: string, limit: number): Promise<string> {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) refuse("unreadable_input", "Choose a regular readable JSONL file and retry.");
      const bytes = Buffer.alloc(limit + 1); let used = 0;
      while (used < bytes.length) { const read = await handle.read(bytes, used, bytes.length - used, null); if (!read.bytesRead) break; used += read.bytesRead; }
      if (used > limit) refuse("input_budget", "Narrow the JSONL input or raise maxInputBytes within its ceiling.");
      try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, used)); }
      catch { return refuse("invalid_input", "Encode the JSONL file as valid UTF-8 and retry."); }
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof BeadsRepairRefusal) throw error;
    return refuse("unreadable_input", "Choose a readable JSONL file and retry.");
  }
}
/** Convert only expected refusals to portable receipts; unexpected failures retain their original error. */
export function beadsRepairRefusalReceipt(error: unknown): { refused: true; code: BeadsRepairRefusalCode; remedy: string } {
  if (!(error instanceof BeadsRepairRefusal)) throw error;
  return { refused: true, code: error.code, remedy: error.remedy };
}
/** Shared handler returns native TOON/JSON objects and typed nonzero refusal receipts. */
async function runRepair(ctx: CommandHandlerContext): Promise<unknown> {
  try {
    const input: Partial<BeadsRepairLimits> = {};
    for (const key of Object.keys(BEADS_REPAIR_LIMITS) as (keyof BeadsRepairLimits)[]) {
      const flag = key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
      const value = ctx.options[flag] ?? ctx.options[key];
      if (value !== undefined) input[key] = typeof value === "string" && value.trim() ? Number(value) : NaN;
    }
    const limits = limitsOf(input), file = ctx.args[0];
    if (typeof file !== "string" || !file.trim()) refuse("invalid_input", "Pass a Beads JSONL file to beads repair.");
    const packet = explainBeadsDependencies(await readInput(file, limits.maxInputBytes), limits);
    if (!packet.valid) process.exitCode = 1;
    return packet;
  } catch (error) {
    const receipt = beadsRepairRefusalReceipt(error);
    process.exitCode = 2; return receipt;
  }
}
/** Register canonical and rich-help aliases over one read-only SDK implementation. */
export function registerRepairCommands(api: ExtensionApi): void {
  for (const name of ["beads repair", "beads-repair"]) api.registerCommand({
    name, description: "Explain invalid JSONL dependencies with bounded row witnesses and revalidated repair candidates; read-only.",
    arguments: [{ name: "file", required: false, description: "Beads JSONL source; never modified." }],
    flags: (Object.keys(BEADS_REPAIR_LIMITS) as (keyof BeadsRepairLimits)[]).map(key => ({
      long: `--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, value_type: "string", value_name: "integer",
      description: `${key}: default ${BEADS_REPAIR_LIMITS[key]}, ceiling ${ceilings[key]}.`,
    })),
    examples: ["pm beads repair snapshot.jsonl --json", "pm beads repair snapshot.jsonl --max-output-bytes 65536"], run: runRepair,
  });
}
