// pm-beads — Beads JSONL importer/exporter for pm-cli
//
// Capabilities (see manifest.json):
//   commands  — `pm beads-import` / `pm beads-export` / `pm beads-validate`
//               (rich-help aliases of the import/export/validate pipelines)
//   importers — `pm beads import` (native import pipeline, with `--upsert`)
//   exporters — `pm beads export` (serialize pm items back to Beads JSONL)
//   schema    — declares the `bead_id` item field
//   preflight — fail-fast Beads-JSONL schema gate that validates the import
//               input BEFORE the importer touches the pm store (import path only)
//
// Idempotent re-import: `pm beads import <file> --upsert` keys on the original
// Beads id (recovered from the `[bead_id: <id>]` provenance marker, NOT from
// tags, which pm case-folds on storage) so re-importing the same file updates
// the matched items in place instead of creating duplicates, and replaces their
// dependency edges atomically (`--replace-deps`) so edges do not accumulate.
//
// Round-trip guarantee: the original Beads `id` and the dependency/blocker edges
// survive a `pm beads import` → `pm beads export` cycle. pm's `create` command has
// no generic custom-field setter for standalone extensions, so the original bead
// id is persisted in the item description behind a parseable marker
// (`[bead_id: <id>]`); the exporter reads it back and re-emits the native bead id.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

import type { defineExtension as defineExtensionType } from "@unbrained/pm-cli/sdk";

const defineExtension: typeof defineExtensionType = ((extension: any) => extension) as any;

// ---------------------------------------------------------------------------
// Error contract
// ---------------------------------------------------------------------------

// pm's extension command runtime only treats a thrown error as a cleanly
// handled non-zero exit when the error carries a numeric `exitCode` property
// (see @unbrained/pm-cli runCommandHandler). A plain `Error` makes the runtime
// fall through to its "unhandled" path, which RE-INVOKES the command handler a
// second time and exits with a generic code. We mirror the SDK's EXIT_CODE
// contract here rather than importing it: standalone-installed extensions load
// only their own `dist/`, so `@unbrained/pm-cli` is not resolvable at runtime.
export const EXIT_CODE = {
  GENERIC_FAILURE: 1,
  USAGE: 2,
  NOT_FOUND: 3,
} as const;

export class CommandError extends Error {
  exitCode: number;
  constructor(message: string, exitCode: number = EXIT_CODE.GENERIC_FAILURE) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// A "dependency" or "blocker" edge in a Beads record. Beads variants spell these
// a few different ways; we accept all of them on import and emit the canonical
// `dependencies`/`blocked_by` form on export.
interface BeadsItem {
  id?: string;
  title?: string;
  name?: string;
  description?: string;
  status?: string;
  type?: string;
  priority?: number | string;
  tags?: string[];
  assignee?: string;
  parent?: string;
  deadline?: string;
  due_date?: string;
  sprint?: string;
  release?: string;
  created_at?: string;
  updated_at?: string;
  dependencies?: Array<string | { id?: string; kind?: string }>;
  blocked_by?: string | string[];
  blocks?: string | string[];
  [key: string]: unknown;
}

interface PmDependency {
  id?: string;
  kind?: string;
}

interface PmItem {
  id?: string;
  title?: string;
  status?: string;
  type?: string;
  priority?: number | string;
  body?: string;
  description?: string;
  tags?: string[];
  assignee?: string;
  parent?: string;
  deadline?: string;
  due_date?: string;
  sprint?: string;
  release?: string;
  created_at?: string;
  updated_at?: string;
  dependencies?: PmDependency[];
  blocked_by?: string;
  bead_id?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a boolean option honoring both the kebab-case long flag and the
 * camelCase key the runtime normalizes it to (e.g. `--dry-run` -> `dryRun`).
 * Without this, `ctx.options["dry-run"]` is silently `undefined`.
 */
export function readBoolOption(options: Record<string, unknown>, ...keys: string[]): boolean {
  for (const key of keys) {
    if (options[key] !== undefined) return Boolean(options[key]);
  }
  return false;
}

export function optionString(options: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = options[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/**
 * Resolve the tri-state of `--preserve-ids` / `--no-preserve-ids`.
 * Commander normalizes a `--no-foo` flag to `{ foo: false }`, but depending on
 * runtime it may surface as `preserveIds`, `preserve-ids`, or an explicit
 * `no-preserve-ids: true`. Default is ON (preserve) when nothing was passed.
 */
export function resolvePreserveIds(options: Record<string, unknown>): boolean {
  if (options["no-preserve-ids"] === true || options["noPreserveIds"] === true) return false;
  for (const k of ["preserveIds", "preserve-ids"]) {
    const v = options[k];
    if (v !== undefined) return v !== false && v !== "false" && v !== "0";
  }
  return true;
}

export function mapStatus(raw: string | undefined): string {
  if (!raw) return "open";
  const s = raw.trim().toLowerCase();
  const map: Record<string, string> = {
    open: "open", todo: "open", new: "open",
    "in_progress": "in_progress", wip: "in_progress", doing: "in_progress",
    blocked: "blocked", on_hold: "blocked",
    closed: "closed", done: "closed", complete: "closed",
    canceled: "canceled", cancelled: "canceled",
    draft: "draft",
  };
  return map[s] ?? "open";
}

// Inverse of mapStatus for export: pm status -> a stable Beads status string.
export function pmStatusToBeads(raw: string | undefined): string {
  switch ((raw || "").trim().toLowerCase()) {
    case "in_progress": return "in_progress";
    case "blocked": return "blocked";
    case "closed": return "closed";
    case "canceled": return "canceled";
    case "draft": return "draft";
    default: return "open";
  }
}

export function mapPriority(raw: number | string | undefined): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (isNaN(n)) return undefined;
  return String(Math.min(4, Math.max(0, n)));
}

// The marker we embed in the description to persist the native Beads id through
// `pm create` (which exposes no generic custom-field setter for extensions).
const BEAD_ID_MARKER = /\[bead_id:\s*([^\]]+)\]/;

export function encodeBeadId(description: string, beadId: string | undefined): string {
  if (!beadId) return description;
  // Avoid duplicating the marker if the description already carries one.
  if (BEAD_ID_MARKER.test(description)) return description;
  const trimmed = description.trim();
  const marker = `[bead_id: ${beadId}]`;
  return trimmed ? `${trimmed}\n\n${marker}` : marker;
}

export function decodeBeadId(item: PmItem): string | undefined {
  // Prefer a real schema field if the workspace populated it, else recover the
  // marker from the description we wrote on import.
  if (typeof item.bead_id === "string" && item.bead_id.trim()) return item.bead_id.trim();
  const source = `${item.description ?? ""}\n${item.body ?? ""}`;
  const m = source.match(BEAD_ID_MARKER);
  return m ? m[1].trim() : undefined;
}

// Strip our internal marker so exported descriptions stay clean.
export function stripBeadIdMarker(text: string | undefined): string {
  if (!text) return "";
  return text.replace(BEAD_ID_MARKER, "").trim();
}

// Known pm statuses a mapped Beads status can land on. Used by `beads validate`
// to flag records whose status maps to the `open` fallback only because it was
// unrecognized (vs. genuinely "open").
export const KNOWN_BEADS_STATUSES = new Set<string>([
  "open", "todo", "new",
  "in_progress", "wip", "doing",
  "blocked", "on_hold",
  "closed", "done", "complete",
  "canceled", "cancelled",
  "draft",
]);

// Normalize a Beads id to a stable key for dedup/upsert. Bead ids are
// case-sensitive identifiers; we trim but DO NOT lowercase them (unlike tags,
// which pm case-folds on storage). Keying off the case-preserving description
// marker — not tags — is what keeps re-import idempotent. See decision note.
export function normalizeBeadKey(id: string | undefined): string | undefined {
  if (typeof id !== "string") return undefined;
  const t = id.trim();
  return t.length ? t : undefined;
}

// Normalize the many ways a Beads record can express blocker edges into a flat
// list of upstream bead ids that block this item.
export function extractBlockerIds(item: BeadsItem): string[] {
  const ids = new Set<string>();
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim()) ids.add(v.trim());
  };
  if (Array.isArray(item.dependencies)) {
    for (const dep of item.dependencies) {
      if (typeof dep === "string") push(dep);
      else if (dep && typeof dep === "object") {
        const kind = (dep.kind || "blocked_by").toLowerCase();
        if (kind === "blocked_by" || kind === "depends_on" || kind === "blocks_me") push(dep.id);
      }
    }
  }
  if (Array.isArray(item.blocked_by)) item.blocked_by.forEach(push);
  else push(item.blocked_by);
  return [...ids];
}

// ---------------------------------------------------------------------------
// Timestamp fidelity — preserve bead created_at/updated_at on import
// ---------------------------------------------------------------------------

// pm's `create`/`update` expose no flag to set the canonical `created_at` /
// `updated_at` front-matter fields (they are managed by the runtime). To make
// the import side symmetric with the exporter — which already re-emits both
// timestamps — we patch the persisted item file in place after create/update.
// This is additive and degrades gracefully: an unparseable timestamp or an
// item file we cannot locate is skipped with a warning, never a hard failure.

// Accept only well-formed ISO-8601 instants so we never write garbage into the
// front matter. Returns the normalized (round-tripped) ISO string or undefined.
export function normalizeIsoTimestamp(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const t = Date.parse(trimmed);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

// Replace the value of a top-level front-matter timestamp key in a stored item
// file. Works for both supported formats (`toon` and `json_markdown`): each
// stores the field as a single `key: "<iso>"` line. Only the first matching
// line is rewritten and only when the key already exists, so we never invent
// fields or disturb the body. Returns the patched text, or null if no change.
export function patchTimestampLines(
  text: string,
  values: { created_at?: string; updated_at?: string },
): string | null {
  let changed = false;
  let out = text;
  for (const key of ["created_at", "updated_at"] as const) {
    const value = values[key];
    if (!value) continue;
    // Anchor at line start; tolerate quoted or bare existing values.
    const re = new RegExp(`^(\\s*${key}\\s*:\\s*).*$`, "m");
    if (re.test(out)) {
      out = out.replace(re, `$1"${value}"`);
      changed = true;
    }
  }
  return changed ? out : null;
}

// Locate the on-disk file for a pm item id under the pm root. Items live in
// per-type folders as `<id>.<ext>`; we scan shallowly (one level of type
// folders) for `<id>.toon` / `<id>.md`, skipping the history/ sidecar logs.
export function locateItemFile(pmRoot: string, pmId: string): string | undefined {
  const exts = [".toon", ".md"];
  let entries: string[];
  try {
    entries = readdirSync(pmRoot);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (entry === "history" || entry === "locks" || entry === "search") continue;
    const dir = join(pmRoot, entry);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `${pmId}${ext}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return undefined;
}

// Apply preserved bead timestamps to the persisted pm item. Returns true when a
// timestamp was written, false (with a console warning) when it had to degrade.
function applyTimestamps(
  pmRoot: string,
  pmId: string,
  bead: BeadsItem,
): boolean {
  const created_at = normalizeIsoTimestamp(bead.created_at);
  const updated_at = normalizeIsoTimestamp(bead.updated_at);
  if (!created_at && !updated_at) return false;
  const file = locateItemFile(pmRoot, pmId);
  if (!file) {
    console.error(`  timestamp skipped: could not locate item file for ${pmId}`);
    return false;
  }
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch (err: unknown) {
    console.error(`  timestamp skipped: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  const patched = patchTimestampLines(text, { created_at, updated_at });
  if (patched === null) return false;
  try {
    writeFileSync(file, patched, "utf-8");
  } catch (err: unknown) {
    console.error(`  timestamp skipped: cannot write ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
  return true;
}

function beadDeadline(item: BeadsItem): string | undefined {
  const raw = typeof item.deadline === "string" && item.deadline.trim()
    ? item.deadline
    : typeof item.due_date === "string" && item.due_date.trim()
      ? item.due_date
      : undefined;
  return raw?.trim();
}

function appendPlanningArgs(args: string[], item: BeadsItem): void {
  const deadline = beadDeadline(item);
  if (deadline) args.push("--deadline", deadline);
  if (item.assignee) args.push("--assignee", String(item.assignee));
  if (item.sprint) args.push("--sprint", String(item.sprint));
  if (item.release) args.push("--release", String(item.release));
}

function resolveParentId(parent: unknown, beadToPm: Map<string, string>): string | undefined {
  if (typeof parent !== "string" || !parent.trim()) return undefined;
  const raw = parent.trim();
  return beadToPm.get(raw) ?? raw;
}

// ---------------------------------------------------------------------------
// Row filters — selectively import/export a subset by status or type
// ---------------------------------------------------------------------------

export interface RowFilter {
  statuses?: Set<string>; // lower-cased mapped pm statuses
  types?: Set<string>;    // lower-cased item types
}

function parseFilterCsv(raw: string | undefined): Set<string> | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
  return parts.length ? new Set(parts) : undefined;
}

// Does a bead pass the import filter? Status is compared against the MAPPED pm
// status (so `--filter-status closed` matches beads whose `done`/`complete`
// status maps to `closed`); type is compared case-insensitively against the
// effective type (override or the bead's own type, default Task).
export function beadPassesFilter(
  bead: BeadsItem,
  typeOverride: string | undefined,
  filter: RowFilter,
): boolean {
  if (filter.statuses) {
    const status = mapStatus(bead.status as string);
    if (!filter.statuses.has(status.toLowerCase())) return false;
  }
  if (filter.types) {
    const type = (typeOverride || (bead.type as string) || "Task").toLowerCase();
    if (!filter.types.has(type)) return false;
  }
  return true;
}

// Does a pm item pass the export filter? Status compared against the BEADS form
// (the value the exporter emits) so the flag is symmetric with import.
export function pmItemPassesFilter(item: PmItem, filter: RowFilter): boolean {
  if (filter.statuses) {
    const status = pmStatusToBeads(item.status).toLowerCase();
    if (!filter.statuses.has(status)) return false;
  }
  if (filter.types) {
    const type = (item.type || "Task").toLowerCase();
    if (!filter.types.has(type)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Validate core — structural checks over a Beads JSONL file
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  line: number; // 1-based line number, or 0 for file-level issues
  severity: "error" | "warning";
  code: string;
  message: string;
}

export interface ValidationReport {
  file?: string;
  records: number;
  valid: boolean; // false when any "error"-severity issue is present
  issues: ValidationIssue[];
}

/**
 * Structurally validate the raw text of a Beads JSONL file.
 *
 * Pure (no I/O) so it can be unit-tested directly. Errors (nonzero exit):
 * invalid JSON, missing required `title`, dangling dependency references
 * (an edge that names a bead id not defined in the file). Warnings (exit 0):
 * unknown status strings, duplicate ids.
 *
 * When `workspaceBeadIds` is supplied (the bead ids already present in the
 * current pm workspace, recovered from each item's `[bead_id: <id>]` marker),
 * dangling references are cross-checked against the workspace: an edge that is
 * not defined in the file BUT exists in the workspace is downgraded from an
 * error to a `cross_workspace_dependency` warning (it resolves at import time),
 * while an edge present in neither stays a hard `dangling_dependency` error.
 * Omit the set to keep the original file-only behavior.
 */
/**
 * Detect directed cycles in the in-file "blocked-by" dependency graph.
 *
 * `adj` maps a bead id to the ids it is blocked by (each edge points at the
 * blocker). A directed cycle is a circular dependency — a deadlock that the
 * real `bd` tooling rejects and that produces an unschedulable graph once
 * imported into pm. Only in-file ids should be present in `adj` (cross-workspace
 * / dangling references are handled separately), so this never false-positives
 * on edges that leave the file.
 *
 * Returns one representative ordered path per distinct cycle (deduped by member
 * set), closed back to its start for readability, e.g. `["a","b","a"]`. A
 * self-dependency (`a` blocked by `a`) is reported as `["a","a"]`.
 */
export function detectDependencyCycles(adj: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const seenCycleKeys = new Set<string>();
  // 0 = unvisited, 1 = on the current DFS stack (gray), 2 = done (black)
  const color = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];

  const visit = (node: string): void => {
    color.set(node, 1);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      const c = color.get(next) ?? 0;
      if (c === 1) {
        // Back-edge: `next` is still on the stack → cycle from `next` to here.
        const idx = stack.indexOf(next);
        if (idx >= 0) {
          const cycle = stack.slice(idx);
          const key = [...cycle].sort().join("\u001f");
          if (!seenCycleKeys.has(key)) {
            seenCycleKeys.add(key);
            cycles.push([...cycle, next]); // close the loop for the message
          }
        }
      } else if (c === 0) {
        visit(next);
      }
    }
    stack.pop();
    color.set(node, 2);
  };

  for (const node of adj.keys()) {
    if ((color.get(node) ?? 0) === 0) visit(node);
  }
  return cycles;
}

export function validateBeadsText(
  text: string,
  file?: string,
  workspaceBeadIds?: Set<string>,
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const lines = text.split("\n");
  const parsed: Array<{ line: number; item: BeadsItem }> = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue; // blank lines are allowed/ignored
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      issues.push({ line: i + 1, severity: "error", code: "invalid_json", message: "line is not valid JSON" });
      continue;
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      issues.push({ line: i + 1, severity: "error", code: "not_object", message: "line is not a JSON object" });
      continue;
    }
    parsed.push({ line: i + 1, item: obj as BeadsItem });
  }

  // Collect known ids for dangling-reference detection.
  const knownIds = new Set<string>();
  const seenIds = new Map<string, number>();
  for (const { line, item } of parsed) {
    const id = normalizeBeadKey(item.id);
    if (id) {
      if (seenIds.has(id)) {
        issues.push({
          line,
          severity: "warning",
          code: "duplicate_id",
          message: `duplicate id "${id}" (first seen on line ${seenIds.get(id)})`,
        });
      } else {
        seenIds.set(id, line);
      }
      knownIds.add(id);
    }
  }

  for (const { line, item } of parsed) {
    const title = String(item.title || item.name || "").trim();
    if (!title) {
      issues.push({ line, severity: "error", code: "missing_title", message: "missing required field: title" });
    }
    if (typeof item.status === "string" && item.status.trim() &&
        !KNOWN_BEADS_STATUSES.has(item.status.trim().toLowerCase())) {
      issues.push({
        line,
        severity: "warning",
        code: "unknown_status",
        message: `unknown status "${item.status}" (will map to "open")`,
      });
    }
    for (const blockerId of extractBlockerIds(item)) {
      if (knownIds.has(blockerId)) continue;
      if (workspaceBeadIds?.has(blockerId)) {
        // Not in this file, but the dependency already exists in the workspace
        // (a prior import). It will resolve — flag informationally, do not fail.
        issues.push({
          line,
          severity: "warning",
          code: "cross_workspace_dependency",
          message: `dependency "${blockerId}" is not in this file but exists in the workspace`,
        });
      } else {
        issues.push({
          line,
          severity: "error",
          code: "dangling_dependency",
          message: workspaceBeadIds
            ? `dependency references bead id "${blockerId}" not found in file or workspace`
            : `dependency references unknown bead id "${blockerId}"`,
        });
      }
    }
  }

  // Circular-dependency detection over the in-file "blocked-by" graph. Build
  // adjacency from each item's id to the blockers that are also defined in this
  // file (cross-workspace / dangling blockers were reported above and are
  // excluded here, so a cycle can only be a genuine in-file deadlock). Reported
  // at the line of the cycle's entry id for locality.
  const idToLine = new Map<string, number>(seenIds);
  const adjacency = new Map<string, string[]>();
  for (const { item } of parsed) {
    const id = normalizeBeadKey(item.id);
    if (!id) continue;
    const blockers = extractBlockerIds(item).filter((b) => knownIds.has(b));
    const existing = adjacency.get(id);
    if (existing) existing.push(...blockers);
    else adjacency.set(id, [...blockers]);
  }
  for (const cycle of detectDependencyCycles(adjacency)) {
    const entry = cycle[0];
    issues.push({
      line: idToLine.get(entry) ?? 0,
      severity: "error",
      code: "dependency_cycle",
      message: `circular dependency: ${cycle.join(" → ")}`,
    });
  }

  const valid = !issues.some((iss) => iss.severity === "error");
  const report: ValidationReport = { records: parsed.length, valid, issues };
  if (file) report.file = file;
  return report;
}

// Collect the bead ids already present in the current pm workspace, keyed off
// the same `[bead_id: <id>]` provenance marker the importer writes. Used by
// `beads validate` to cross-check dependency references against the workspace.
//
// Prefers the SDK item-store (`listAllFrontMatter`) per the SDK contract, loaded
// via a dynamic import so a standalone install — which bundles only this
// extension's own dist and cannot resolve `@unbrained/pm-cli` at runtime — falls
// back to spawning `pm list-all` (the same data path the exporter uses). Either
// way a failure degrades to "no workspace data" so validation still runs.
async function readWorkspaceBeadIds(pmRoot: string): Promise<Set<string> | undefined> {
  let items: PmItem[] | undefined;
  try {
    const runtime: any = await import("@unbrained/pm-cli/sdk/runtime");
    if (typeof runtime?.listAllFrontMatter === "function") {
      items = (await runtime.listAllFrontMatter(pmRoot)) as PmItem[];
    }
  } catch {
    /* SDK not resolvable at runtime (standalone install) — fall back below. */
  }
  if (!items) {
    try {
      items = readPmItems(pmRoot);
    } catch {
      return undefined;
    }
  }
  const ids = new Set<string>();
  for (const item of items) {
    const beadId = normalizeBeadKey(decodeBeadId(item));
    if (beadId) ids.add(beadId);
  }
  return ids;
}

async function runValidate(
  filePath: string | undefined,
  opts: { json: boolean; workspace: boolean; pmRoot?: string },
) {
  if (!filePath) {
    throw new CommandError("Usage: pm beads validate <file> [--json] [--no-workspace]", EXIT_CODE.USAGE);
  }
  const absolutePath = resolve(filePath);
  let raw: string;
  try {
    raw = readFileSync(absolutePath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const exitCode = /ENOENT|no such file/i.test(msg) ? EXIT_CODE.NOT_FOUND : EXIT_CODE.GENERIC_FAILURE;
    throw new CommandError(`Failed to read file: ${msg}`, exitCode);
  }

  const workspaceBeadIds =
    opts.workspace && opts.pmRoot ? await readWorkspaceBeadIds(opts.pmRoot) : undefined;
  const report = validateBeadsText(raw, absolutePath, workspaceBeadIds);
  const errors = report.issues.filter((i) => i.severity === "error").length;

  if (opts.json) {
    // In JSON mode, return the report so the runtime serializes it (and it is
    // not discarded the way a thrown error would discard handler stdout). The
    // report carries `valid: false`; signal a nonzero process exit without
    // throwing so the structured report still reaches the caller.
    if (!report.valid) process.exitCode = EXIT_CODE.GENERIC_FAILURE;
    return report;
  }

  if (report.issues.length === 0) {
    console.error(`OK: ${report.records} record(s), no issues.`);
  } else {
    for (const iss of report.issues) {
      const where = iss.line ? `line ${iss.line}` : "file";
      console.error(`  ${iss.severity.toUpperCase()} [${iss.code}] ${where}: ${iss.message}`);
    }
    const warns = report.issues.length - errors;
    console.error(`${report.records} record(s): ${errors} error(s), ${warns} warning(s).`);
  }

  // Nonzero exit when structurally invalid (errors present). Warnings alone
  // keep a zero exit so a clean-but-imperfect file still passes CI gates.
  if (!report.valid) {
    throw new CommandError(
      `Validation failed: ${errors} structural error(s).`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  return report;
}

// ---------------------------------------------------------------------------
// Import core — shared by the legacy command and the native importer
// ---------------------------------------------------------------------------

interface ImportOptions {
  dryRun: boolean;
  preserveIds: boolean;
  preserveTimestamps: boolean;
  upsert: boolean;
  typeOverride?: string;
  priorityOverride?: string;
  tagsOverride?: string;
  filter: RowFilter;
}

function parseBeadsFile(filePath: string): BeadsItem[] {
  const absolutePath = resolve(filePath);
  let raw: string;
  try {
    raw = readFileSync(absolutePath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const exitCode = /ENOENT|no such file/i.test(msg) ? EXIT_CODE.NOT_FOUND : EXIT_CODE.GENERIC_FAILURE;
    throw new CommandError(`Failed to read file: ${msg}`, exitCode);
  }
  const lines = raw.split("\n").filter((l) => l.trim());
  const items: BeadsItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      items.push(JSON.parse(lines[i]));
    } catch {
      console.error(`Line ${i + 1}: invalid JSON — skipping`);
      items.push({ __invalid: true } as BeadsItem);
    }
  }
  return items;
}

// An existing item the upsert path may target, keyed by its bead id. We carry
// the current status so the update can omit `--status` when it is unchanged —
// re-sending a terminal status (e.g. `closed`) makes `pm update` demand
// `--force` ("already terminal; use --force to close again").
export interface ExistingBeadItem {
  pmId: string;
  status?: string;
}

// Build a bead-id → existing-item index from the current workspace so an
// `--upsert` import can update matched items instead of creating duplicates.
// Keys off the case-preserving `[bead_id: <id>]` description marker (the same
// provenance the exporter reads), NOT off tags (which pm case-folds).
export function buildBeadIndex(items: PmItem[]): Map<string, ExistingBeadItem> {
  const index = new Map<string, ExistingBeadItem>();
  for (const item of items) {
    if (!item.id) continue;
    const beadId = decodeBeadId(item);
    const key = normalizeBeadKey(beadId);
    // First write wins so the oldest matching item is the stable upsert target.
    if (key && !index.has(key)) index.set(key, { pmId: item.id, status: item.status });
  }
  return index;
}

// Run the import. Two passes so dependency edges can reference items created
// earlier in the same file: pass 1 creates (or, with --upsert, updates) every
// item and records bead-id → pm-id; pass 2 wires up the blocker edges via
// `pm update --dep` (with --replace-deps when upserting, so re-import does not
// accumulate duplicate edges).
function runImport(filePath: string | undefined, pmRoot: string, opts: ImportOptions) {
  if (!filePath) {
    throw new CommandError(
      "Usage: pm beads import <file> [--dry-run] [--upsert] [--no-preserve-ids] [--type <type>] [--priority <n>] [--tags <tags>]",
      EXIT_CODE.USAGE,
    );
  }
  if (opts.upsert && !opts.preserveIds) {
    throw new CommandError(
      "--upsert requires preserved Beads ids (it keys on them); do not combine with --no-preserve-ids.",
      EXIT_CODE.USAGE,
    );
  }

  const absolutePath = resolve(filePath);
  console.error(`Parsing Beads JSONL from: ${absolutePath}`);

  const parsed = parseBeadsFile(filePath);
  const records = parsed.filter((r) => !(r as any).__invalid);
  let skipped = parsed.length - records.length;

  if (parsed.length === 0) {
    console.error("File is empty.");
    return { imported: 0, skipped: 0 };
  }

  // With --upsert, look up existing items so a matching bead id updates the
  // prior item instead of creating a duplicate. Built once, up front (also in
  // dry-run, so the preview reports create vs. update accurately).
  const existingIndex = opts.upsert
    ? buildBeadIndex(readPmItems(pmRoot))
    : new Map<string, ExistingBeadItem>();

  // Map of original bead id -> the pm id we created/updated for it (wires deps).
  const beadToPm = new Map<string, string>();
  const touched: Array<{ beadId?: string; pmId: string; blockers: string[]; upserted: boolean; bead: BeadsItem }> = [];
  let imported = 0;
  let updated = 0;
  let timestamped = 0;

  const hasFilter = Boolean(opts.filter.statuses || opts.filter.types);
  let filtered = 0;

  for (let i = 0; i < records.length; i++) {
    const item = records[i];
    const title = String(item.title || item.name || "").trim();
    if (!title) {
      console.error(`Record ${i + 1}: missing title — skipping`);
      skipped++;
      continue;
    }

    if (hasFilter && !beadPassesFilter(item, opts.typeOverride, opts.filter)) {
      filtered++;
      continue;
    }

    const type = opts.typeOverride || (item.type as string) || "Task";
    const status = mapStatus(item.status as string);
    const priority = opts.priorityOverride || mapPriority(item.priority);
    const tags = opts.tagsOverride
      ? opts.tagsOverride
      : Array.isArray(item.tags)
        ? item.tags.join(",")
        : undefined;
    const beadId = opts.preserveIds && typeof item.id === "string" ? item.id.trim() : undefined;
    const baseDescription = (item.description as string) || title;
    const description = encodeBeadId(baseDescription, beadId);
    const blockers = extractBlockerIds(item);
    const key = normalizeBeadKey(beadId);
    const existing = opts.upsert && key ? existingIndex.get(key) : undefined;
    const existingPmId = existing?.pmId;

    if (opts.dryRun) {
      const action = opts.upsert && key && existingIndex.get(key) ? "update" : "create";
      console.error(
        `  [dry-run] ${action} ${title} (${type}, ${status}${beadId ? `, bead_id=${beadId}` : ""}` +
          `${blockers.length ? `, blocked_by=${blockers.join(",")}` : ""})`,
      );
      if (action === "update") updated++;
      else imported++;
      continue;
    }

    try {
      let pmId: string;
      if (existingPmId) {
        // UPSERT: update the matched item in place.
        const updArgs = [
          "--path", pmRoot, "--json", "update", existingPmId,
          "--title", title,
          "--type", type,
          "--description", description,
        ];
        // Only set status when it actually changes. Re-sending a terminal
        // status (closed/canceled) makes `pm update` require --force; omitting
        // it keeps re-import idempotent without forcing a spurious re-close.
        if (status !== existing?.status) updArgs.push("--status", status);
        if (priority) updArgs.push("--priority", priority);
        if (tags) updArgs.push("--tags", tags); // --tags replaces; idempotent re-import
        appendPlanningArgs(updArgs, item);
        const result = spawnSync("pm", updArgs, { encoding: "utf-8" });
        if (result.status !== 0) throw new Error(result.stderr || "pm update failed");
        pmId = existingPmId;
        updated++;
      } else {
        const spawnArgs = [
          "--path", pmRoot,
          "--json",
          "create",
          "--title", title,
          "--type", type,
          "--status", status,
          "--description", description,
        ];
        if (priority) spawnArgs.push("--priority", priority);
        if (tags) spawnArgs.push("--tags", tags);
        appendPlanningArgs(spawnArgs, item);

        const result = spawnSync("pm", spawnArgs, { encoding: "utf-8" });
        if (result.status !== 0) {
          throw new Error(result.stderr || "pm create failed");
        }
        const created = extractCreatedId(result.stdout);
        if (!created) throw new Error("could not determine created pm id");
        pmId = created;
        // Record so a later record in the same file can upsert onto it too.
        if (key) existingIndex.set(key, { pmId, status });
        imported++;
      }
      if (beadId) beadToPm.set(beadId, pmId);
      touched.push({ beadId, pmId, blockers, upserted: Boolean(existingPmId), bead: item });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Record ${i + 1}: ${existingPmId ? "update" : "create"} failed — ${msg}`);
      skipped++;
    }
  }

  // Pass 2: wire dependency/blocker edges now that every item exists. For
  // upserted items, gather all edges and --replace-deps in one call so a
  // re-import does not accumulate duplicate edges.
  let edges = 0;
  let parents = 0;
  if (!opts.dryRun) {
    for (const entry of touched) {
      const resolvedBlockers = entry.blockers
        .map((b) => ({ bead: b, pm: beadToPm.get(b) }))
        .filter((b) => {
          if (!b.pm) console.error(`  dep skipped: ${entry.pmId} blocked_by unknown bead ${b.bead}`);
          return Boolean(b.pm);
        });

      if (entry.upserted) {
        // Atomically replace deps so re-import is idempotent (no duplicates).
        const depArgs = ["--path", pmRoot, "update", entry.pmId, "--replace-deps"];
        for (const b of resolvedBlockers) depArgs.push("--dep", `id=${b.pm},kind=blocked_by`);
        // With no edges, --replace-deps + no --dep clears them; use --clear-deps.
        if (resolvedBlockers.length === 0) {
          depArgs.splice(depArgs.indexOf("--replace-deps"), 1, "--clear-deps");
        }
        const dep = spawnSync("pm", depArgs, { encoding: "utf-8" });
        if (dep.status === 0) edges += resolvedBlockers.length;
        else console.error(`  dep replace failed: ${entry.pmId}: ${dep.stderr?.trim()}`);
      } else {
        for (const b of resolvedBlockers) {
          const dep = spawnSync(
            "pm",
            ["--path", pmRoot, "update", entry.pmId, "--dep", `id=${b.pm},kind=blocked_by`],
            { encoding: "utf-8" },
          );
          if (dep.status === 0) edges++;
          else console.error(`  dep failed: ${entry.pmId} -> ${b.pm}: ${dep.stderr?.trim()}`);
        }
      }

      const parentId = resolveParentId(entry.bead.parent, beadToPm);
      if (parentId) {
        const parent = spawnSync(
          "pm",
          ["--path", pmRoot, "update", entry.pmId, "--parent", parentId],
          { encoding: "utf-8" },
        );
        if (parent.status === 0) parents++;
        else console.error(`  parent failed: ${entry.pmId} -> ${parentId}: ${parent.stderr?.trim()}`);
      }
    }

    // Pass 3: timestamp fidelity. Mirror the exporter by writing each bead's
    // created_at/updated_at back onto the persisted item (pm exposes no flag for
    // these). Run LAST — after dependency wiring, which issues `pm update` and
    // would otherwise re-bump updated_at — so the bead's own timestamps win and
    // the round-trip stays lossless.
    if (opts.preserveTimestamps) {
      for (const entry of touched) {
        if (applyTimestamps(pmRoot, entry.pmId, entry.bead)) timestamped++;
      }
    }
  }

  const filteredNote = hasFilter ? `, filtered ${filtered}` : "";

  if (opts.dryRun) {
    console.error(
      `[dry-run] Would create ${imported}, update ${updated}, skip ${skipped}${filteredNote}.`,
    );
    return {
      dryRun: true,
      wouldImport: imported,
      wouldUpdate: updated,
      wouldSkip: skipped,
      ...(hasFilter ? { filtered } : {}),
    };
  }

  if (imported === 0 && updated === 0 && skipped > 0 && filtered === 0) {
    throw new CommandError(`No items imported — all ${skipped} record(s) failed (malformed input?).`);
  }

  console.error(
    `Imported ${imported}, updated ${updated}, skipped ${skipped}${filteredNote}, ` +
      `linked ${edges} dependency edge(s), set ${parents} parent link(s)` +
      `${opts.preserveTimestamps ? `, timestamped ${timestamped}` : ""}.`,
  );
  return {
    imported,
    updated,
    skipped,
    dependencies: edges,
    parents,
    ...(opts.preserveTimestamps ? { timestamped } : {}),
    ...(hasFilter ? { filtered } : {}),
  };
}

// Pull the created item id out of `pm --json create` output (shape varies a bit
// across versions: top-level `id` or nested `item.id`).
export function extractCreatedId(stdout: string): string | undefined {
  try {
    const j = JSON.parse(stdout);
    return j?.id || j?.item?.id || j?.result?.id;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Export core — serialize pm items back to Beads JSONL
// ---------------------------------------------------------------------------

function readPmItems(pmRoot: string): PmItem[] {
  // `--full --include-body` so descriptions, tags and dependency edges survive
  // the export instead of the brief projection (which omits them).
  const result = spawnSync(
    "pm",
    ["--path", pmRoot, "--json", "list-all", "--full", "--include-body", "--limit", "10000"],
    { encoding: "utf-8" },
  );
  if (result.status !== 0) {
    throw new CommandError(result.stderr || "pm list failed");
  }
  try {
    const parsed = JSON.parse(result.stdout);
    const items = Array.isArray(parsed) ? parsed : parsed.items ?? parsed.results ?? [];
    return items as PmItem[];
  } catch {
    throw new CommandError("Could not parse `pm list-all --json` output.");
  }
}

// Turn one pm item into a Beads record, preserving the original bead id (when
// known) and re-emitting blocker edges as a Beads `dependencies` array.
export function pmItemToBead(item: PmItem, pmToBead: Map<string, string>, preserveIds: boolean): BeadsItem {
  const beadId = preserveIds ? decodeBeadId(item) : undefined;
  const id = beadId || item.id;

  const blockers: Array<{ id: string; kind: string }> = [];
  if (Array.isArray(item.dependencies)) {
    for (const dep of item.dependencies) {
      if (!dep?.id) continue;
      if ((dep.kind || "blocked_by").toLowerCase() !== "blocked_by") continue;
      // Translate the upstream pm id back to its bead id when we know it.
      const upstream = pmToBead.get(dep.id) || dep.id;
      blockers.push({ id: upstream, kind: "blocked_by" });
    }
  }

  const bead: BeadsItem = {
    id,
    title: item.title ?? "(untitled)",
    description: stripBeadIdMarker(item.description),
    status: pmStatusToBeads(item.status),
    type: item.type ?? "Task",
  };
  if (item.priority !== undefined && item.priority !== null) bead.priority = Number(item.priority);
  if (Array.isArray(item.tags) && item.tags.length) bead.tags = item.tags;
  if (item.assignee) bead.assignee = item.assignee;
  if (item.parent) bead.parent = pmToBead.get(item.parent) ?? item.parent;
  if (item.deadline ?? item.due_date) bead.deadline = item.deadline ?? item.due_date;
  if (item.sprint) bead.sprint = item.sprint;
  if (item.release) bead.release = item.release;
  if (item.created_at) bead.created_at = item.created_at;
  if (item.updated_at) bead.updated_at = item.updated_at;
  if (blockers.length) bead.dependencies = blockers;
  return bead;
}

// Serialize the current pm workspace into Beads records IN MEMORY, applying the
// same id-preservation, dependency translation and row filtering the on-disk
// exporter uses. Extracted from `runExport` so the diff command can compare a
// file against the live workspace without writing to stdout/a file or
// duplicating any mapping logic.
export function buildBeadsFromWorkspace(
  pmRoot: string,
  opts: { preserveIds: boolean; filter: RowFilter },
): BeadsItem[] {
  const allItems = readPmItems(pmRoot);
  const hasFilter = Boolean(opts.filter.statuses || opts.filter.types);
  const items = hasFilter ? allItems.filter((it) => pmItemPassesFilter(it, opts.filter)) : allItems;

  // First build the pm-id -> bead-id translation table so dependency edges that
  // reference another exported item resolve to its native bead id. Built from
  // the FILTERED set so an edge to an item excluded by the filter falls back to
  // the upstream id rather than dangling onto a not-emitted record.
  const pmToBead = new Map<string, string>();
  if (opts.preserveIds) {
    for (const item of items) {
      const beadId = decodeBeadId(item);
      if (item.id && beadId) pmToBead.set(item.id, beadId);
    }
  }

  return items.map((item) => pmItemToBead(item, pmToBead, opts.preserveIds));
}

function runExport(pmRoot: string, opts: { preserveIds: boolean; output?: string; filter: RowFilter }) {
  const beads = buildBeadsFromWorkspace(pmRoot, { preserveIds: opts.preserveIds, filter: opts.filter });
  const jsonl = beads.map((b) => JSON.stringify(b)).join("\n") + (beads.length ? "\n" : "");

  if (opts.output) {
    const absolute = resolve(opts.output);
    try {
      writeFileSync(absolute, jsonl, "utf-8");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new CommandError(`Failed to write ${absolute}: ${msg}`);
    }
    console.error(`Exported ${beads.length} item(s) to ${absolute}.`);
    return { exported: beads.length, output: absolute };
  }

  if (jsonl) process.stdout.write(jsonl);
  console.error(`Exported ${beads.length} item(s) as Beads JSONL.`);
  return { exported: beads.length };
}

// ---------------------------------------------------------------------------
// Diff core — audit round-trip fidelity between two Beads sources
// ---------------------------------------------------------------------------

// The set of bead fields the diff classifier compares, in display order. These
// are exactly the fields a `pm beads import` → `pm beads export` cycle is meant
// to preserve, so a drift in any of them flags a round-trip fidelity loss.
export const DIFF_FIELDS = [
  "title",
  "status",
  "type",
  "priority",
  "tags",
  "assignee",
  "parent",
  "deadline",
  "dependencies",
] as const;

export type DiffField = (typeof DIFF_FIELDS)[number];

export interface ChangedBead {
  id: string;
  fields: DiffField[]; // which compared fields differ between A and B
}

export interface BeadsDiff {
  added: string[];     // bead ids present only in B
  removed: string[];   // bead ids present only in A
  changed: ChangedBead[]; // ids in both whose compared fields differ
  unchanged: number;   // count of ids in both that are byte-for-byte equal (per compared fields)
  // Totals for the human summary / CI consumers.
  countA: number;
  countB: number;
  // True when ANY drift (added/removed/changed) was detected.
  drift: boolean;
}

// Normalize a single comparable field of a bead into a stable, order-insensitive
// scalar/string so two semantically equal values compare equal regardless of
// incidental formatting (e.g. tag/dependency ordering, numeric vs. string
// priority, the deadline/due_date alias).
export function normalizeDiffField(bead: BeadsItem, field: DiffField): string {
  switch (field) {
    case "title":
      return String(bead.title ?? bead.name ?? "").trim();
    case "status":
      // Compare on the canonical mapped Beads status so `done` vs `closed`
      // (same meaning) is NOT reported as drift — symmetric with import/export.
      return pmStatusToBeads(mapStatus(bead.status as string | undefined));
    case "type":
      return String(bead.type ?? "Task").trim().toLowerCase();
    case "priority": {
      const p = mapPriority(bead.priority);
      return p === undefined ? "" : p;
    }
    case "tags": {
      const tags = Array.isArray(bead.tags)
        ? bead.tags.map((t) => String(t).trim()).filter(Boolean)
        : [];
      // Order-insensitive: tag order is not semantically meaningful.
      return [...new Set(tags)].sort().join(",");
    }
    case "assignee":
      return String(bead.assignee ?? "").trim();
    case "parent":
      return String(bead.parent ?? "").trim();
    case "deadline":
      return beadDeadline(bead) ?? "";
    case "dependencies": {
      // Compare on the set of upstream blocker ids (order-insensitive). Reuses
      // the same edge-normalizer the importer/validator use, so the many Beads
      // edge spellings collapse to one canonical form.
      return [...new Set(extractBlockerIds(bead))].sort().join(",");
    }
  }
}

// Which of the compared fields differ between two beads?
export function changedFields(a: BeadsItem, b: BeadsItem): DiffField[] {
  const out: DiffField[] = [];
  for (const field of DIFF_FIELDS) {
    if (normalizeDiffField(a, field) !== normalizeDiffField(b, field)) out.push(field);
  }
  return out;
}

// Index a list of bead records by their stable bead id (first occurrence wins,
// mirroring the dedup convention buildBeadIndex uses). Records without an id are
// skipped — they cannot be matched across sources.
export function indexBeadsById(beads: BeadsItem[]): Map<string, BeadsItem> {
  const index = new Map<string, BeadsItem>();
  for (const bead of beads) {
    const id = normalizeBeadKey(bead.id);
    if (id && !index.has(id)) index.set(id, bead);
  }
  return index;
}

// Pure diff over two Beads record lists, keyed on bead id. Optionally pre-filter
// each side by the same RowFilter the import/export paths use, so a diff can be
// scoped to a status/type subset.
export function diffBeads(a: BeadsItem[], b: BeadsItem[], filter?: RowFilter): BeadsDiff {
  const apply = (list: BeadsItem[]): BeadsItem[] => {
    if (!filter || (!filter.statuses && !filter.types)) return list;
    return list.filter((bead) => beadPassesFilter(bead, undefined, filter));
  };
  const aFiltered = apply(a);
  const bFiltered = apply(b);

  const aIndex = indexBeadsById(aFiltered);
  const bIndex = indexBeadsById(bFiltered);

  const added: string[] = [];
  const removed: string[] = [];
  const changed: ChangedBead[] = [];
  let unchanged = 0;

  for (const [id, beadA] of aIndex) {
    const beadB = bIndex.get(id);
    if (!beadB) {
      removed.push(id);
      continue;
    }
    const fields = changedFields(beadA, beadB);
    if (fields.length) changed.push({ id, fields });
    else unchanged++;
  }
  for (const id of bIndex.keys()) {
    if (!aIndex.has(id)) added.push(id);
  }

  added.sort();
  removed.sort();
  changed.sort((x, y) => x.id.localeCompare(y.id));

  const drift = added.length > 0 || removed.length > 0 || changed.length > 0;
  return {
    added,
    removed,
    changed,
    unchanged,
    countA: aIndex.size,
    countB: bIndex.size,
    drift,
  };
}

// Parse a Beads JSONL file into bead records for diffing. Unlike the importer's
// parseBeadsFile (which substitutes a sentinel for bad lines so import can keep
// going), a diff over a malformed file is meaningless, so we hard-fail with a
// line-naming error.
function parseBeadsFileForDiff(filePath: string): BeadsItem[] {
  const absolutePath = resolve(filePath);
  let raw: string;
  try {
    raw = readFileSync(absolutePath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const exitCode = /ENOENT|no such file/i.test(msg) ? EXIT_CODE.NOT_FOUND : EXIT_CODE.GENERIC_FAILURE;
    throw new CommandError(`Failed to read file: ${msg}`, exitCode);
  }
  const lines = raw.split("\n");
  const beads: BeadsItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      throw new CommandError(`Line ${i + 1}: invalid JSON in ${absolutePath}`, EXIT_CODE.GENERIC_FAILURE);
    }
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      throw new CommandError(`Line ${i + 1}: not a JSON object in ${absolutePath}`, EXIT_CODE.GENERIC_FAILURE);
    }
    beads.push(obj as BeadsItem);
  }
  return beads;
}

interface DiffOptions {
  json: boolean;
  strict: boolean;
  againstWorkspace: boolean;
  preserveIds: boolean;
  filter: RowFilter;
  pmRoot?: string;
}

// Format the diff as a human-readable summary written to stderr (so stdout stays
// clean for piping). Lists each changed bead with the specific fields that drift.
function printDiffSummary(diff: BeadsDiff, labelA: string, labelB: string): void {
  console.error(`Beads diff: ${labelA} (A) → ${labelB} (B)`);
  console.error(`  A: ${diff.countA} bead(s), B: ${diff.countB} bead(s)`);
  if (!diff.drift) {
    console.error(`  No drift: all ${diff.unchanged} matched bead(s) are identical.`);
    return;
  }
  if (diff.added.length) {
    console.error(`  Added (only in B): ${diff.added.length}`);
    for (const id of diff.added) console.error(`    + ${id}`);
  }
  if (diff.removed.length) {
    console.error(`  Removed (only in A): ${diff.removed.length}`);
    for (const id of diff.removed) console.error(`    - ${id}`);
  }
  if (diff.changed.length) {
    console.error(`  Changed: ${diff.changed.length}`);
    for (const c of diff.changed) console.error(`    ~ ${c.id} (${c.fields.join(", ")})`);
  }
  console.error(`  Unchanged: ${diff.unchanged}`);
}

// Run the `beads diff` command. Two modes:
//   - two files:        compare <fileA> against <fileB>
//   - --against-workspace: compare <fileA> against the live pm workspace
//     (serialized to beads in memory via the shared export core).
// Pure read-only — never mutates the workspace or any file. Exits nonzero only
// under --strict when drift is found; otherwise always exits 0.
function runDiff(args: string[] | undefined, opts: DiffOptions) {
  // ctx.args can carry flag tokens (e.g. boolean flags like --against-workspace)
  // alongside the positional file paths, so extract the positionals explicitly
  // rather than indexing raw args — mirrors resolveImportInputFile.
  const files = (Array.isArray(args) ? args : []).filter(
    (a): a is string => typeof a === "string" && a.length > 0 && !a.startsWith("-"),
  );
  const fileA = files[0];
  if (!fileA) {
    throw new CommandError(
      "Usage: pm beads diff <fileA> <fileB> | pm beads diff <file> --against-workspace [--json] [--strict] [--filter-status <list>] [--filter-type <list>]",
      EXIT_CODE.USAGE,
    );
  }

  let beadsA: BeadsItem[];
  let beadsB: BeadsItem[];
  let labelA: string;
  let labelB: string;

  if (opts.againstWorkspace) {
    if (files[1]) {
      throw new CommandError(
        "Provide exactly one file with --against-workspace (the second source is the current workspace).",
        EXIT_CODE.USAGE,
      );
    }
    if (!opts.pmRoot) {
      throw new CommandError("Cannot resolve the pm workspace root for --against-workspace.", EXIT_CODE.GENERIC_FAILURE);
    }
    beadsA = parseBeadsFileForDiff(fileA);
    beadsB = buildBeadsFromWorkspace(opts.pmRoot, { preserveIds: opts.preserveIds, filter: opts.filter });
    labelA = resolve(fileA);
    labelB = "workspace";
  } else {
    const fileB = files[1];
    if (!fileB) {
      throw new CommandError(
        "Provide two files, or one file with --against-workspace. Usage: pm beads diff <fileA> <fileB>",
        EXIT_CODE.USAGE,
      );
    }
    beadsA = parseBeadsFileForDiff(fileA);
    beadsB = parseBeadsFileForDiff(fileB);
    labelA = resolve(fileA);
    labelB = resolve(fileB);
  }

  // The workspace side is already filtered by buildBeadsFromWorkspace; passing
  // the filter into diffBeads additionally scopes the FILE side(s) by the same
  // criteria so both sides are compared on equal footing.
  const diff = diffBeads(beadsA, beadsB, opts.filter);

  if (opts.json) {
    if (opts.strict && diff.drift) process.exitCode = EXIT_CODE.GENERIC_FAILURE;
    return { a: labelA, b: labelB, ...diff };
  }

  printDiffSummary(diff, labelA, labelB);

  if (opts.strict && diff.drift) {
    throw new CommandError(
      `Drift detected: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed.`,
      EXIT_CODE.GENERIC_FAILURE,
    );
  }
  return { a: labelA, b: labelB, ...diff };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

const IMPORT_FLAGS = [
  { long: "--dry-run", description: "Preview without writing" },
  { long: "--upsert", description: "Update existing items matched by their Beads id instead of creating duplicates" },
  { long: "--no-preserve-ids", description: "Do not persist the original Beads id (default: preserve)" },
  { long: "--no-preserve-timestamps", description: "Do not carry over bead created_at/updated_at (default: preserve)" },
  { long: "--type", value_name: "type", description: "Override item type for all imported items" },
  { long: "--priority", value_name: "n", description: "Override priority (0-4) for all items" },
  { long: "--tags", value_name: "tags", description: "Comma-separated tags to add to all items" },
  { long: "--filter-status", value_name: "list", description: "Only import beads whose mapped status is in this comma-separated list" },
  { long: "--filter-type", value_name: "list", description: "Only import beads whose type is in this comma-separated list" },
];

const EXPORT_FLAGS = [
  { long: "--output", short: "-o", value_name: "file", description: "Write JSONL to a file instead of stdout" },
  { long: "--no-preserve-ids", description: "Emit pm ids instead of the original Beads ids (default: preserve)" },
  { long: "--filter-status", value_name: "list", description: "Only export items whose Beads status is in this comma-separated list" },
  { long: "--filter-type", value_name: "list", description: "Only export items whose type is in this comma-separated list" },
];

const VALIDATE_FLAGS = [
  { long: "--json", description: "Emit the validation report as JSON" },
  { long: "--no-workspace", description: "Skip cross-checking dependency references against the current pm workspace" },
];

const DIFF_FLAGS = [
  { long: "--against-workspace", description: "Diff <file> against the current pm workspace (exported to Beads in-memory) instead of a second file" },
  { long: "--json", description: "Emit the structured diff object as JSON" },
  { long: "--strict", description: "Exit nonzero when any drift (added/removed/changed) is found — for CI fidelity gates" },
  { long: "--no-preserve-ids", description: "When diffing against the workspace, key on pm ids instead of the original Beads ids (default: preserve)" },
  { long: "--filter-status", value_name: "list", description: "Only compare beads whose mapped status is in this comma-separated list" },
  { long: "--filter-type", value_name: "list", description: "Only compare beads whose type is in this comma-separated list" },
];

// Read the --filter-status / --filter-type pair into a RowFilter, honoring both
// the kebab-case flag and the camelCase key the runtime normalizes it to.
export function parseRowFilter(options: Record<string, unknown>): RowFilter {
  return {
    statuses: parseFilterCsv(optionString(options, "filter-status", "filterStatus")),
    types: parseFilterCsv(optionString(options, "filter-type", "filterType")),
  };
}

// Resolve --preserve-timestamps / --no-preserve-timestamps (default ON).
export function resolvePreserveTimestamps(options: Record<string, unknown>): boolean {
  if (options["no-preserve-timestamps"] === true || options["noPreserveTimestamps"] === true) return false;
  for (const k of ["preserveTimestamps", "preserve-timestamps"]) {
    const v = options[k];
    if (v !== undefined) return v !== false && v !== "false" && v !== "0";
  }
  return true;
}

function parseImportOptions(options: Record<string, unknown>): ImportOptions {
  return {
    dryRun: readBoolOption(options, "dry-run", "dryRun"),
    upsert: readBoolOption(options, "upsert"),
    preserveIds: resolvePreserveIds(options),
    preserveTimestamps: resolvePreserveTimestamps(options),
    typeOverride: optionString(options, "type"),
    priorityOverride: optionString(options, "priority"),
    tagsOverride: optionString(options, "tags"),
    filter: parseRowFilter(options),
  };
}

export function parseDiffOptions(
  options: Record<string, unknown>,
  global: Record<string, unknown> = {},
  pmRoot?: string,
): DiffOptions {
  return {
    // `--json` may surface as a command option OR pm's global flag.
    json: readBoolOption(options, "json") || readBoolOption(global, "json"),
    strict: readBoolOption(options, "strict"),
    againstWorkspace: readBoolOption(options, "against-workspace", "againstWorkspace"),
    preserveIds: resolvePreserveIds(options),
    filter: parseRowFilter(options),
    pmRoot,
  };
}

// ---------------------------------------------------------------------------
// Preflight gate — validate the Beads JSONL schema BEFORE import touches the store
// ---------------------------------------------------------------------------

// The two command paths that run the import pipeline. `pm beads import` (the
// native importer) surfaces to the preflight context as the normalized command
// "beads import"; the legacy rich-help alias surfaces as "beads-import". Export
// ("beads export") and validate ("beads validate") are deliberately excluded so
// the gate never blocks them.
const IMPORT_PREFLIGHT_COMMANDS = new Set(["beads import", "beads-import"]);

// Resolve the import input file from the preflight args the same way the import
// handler does: the first positional (non-flag) argument. Flags (e.g.
// `--dry-run`, `--type Task`) may trail the path in the raw args array, so we
// skip anything beginning with "-".
export function resolveImportInputFile(args: unknown): string | undefined {
  if (!Array.isArray(args)) return undefined;
  for (const a of args) {
    if (typeof a !== "string") continue;
    if (a.startsWith("-")) continue;
    return a;
  }
  return undefined;
}

// Fail-fast preflight for the import path. Returns an (empty) preflight delta on
// success so the runtime proceeds unchanged. On a structurally invalid file it
// aborts the process with a non-zero exit BEFORE the importer can write anything.
//
// NOTE on the abort mechanism: the SDK's preflight runner wraps the override in
// a try/catch and downgrades any thrown error to a non-fatal warning (it does
// NOT propagate). A thrown CommandError would therefore be swallowed and import
// would proceed — defeating the gate. To guarantee a true fail-fast abort with a
// non-zero exit *before* any pm-store write, we print the actionable error and
// terminate via process.exit(). We still construct a CommandError to derive the
// canonical message + exit code, keeping the package's error contract intact.
async function runImportPreflight(ctx: any): Promise<Record<string, never>> {
  const command = typeof ctx?.command === "string" ? ctx.command.trim().toLowerCase() : "";
  if (!IMPORT_PREFLIGHT_COMMANDS.has(command)) {
    // Not an import command (export / validate / anything else) — never block.
    return {};
  }

  const filePath = resolveImportInputFile(ctx?.args);
  if (!filePath) {
    // No file given. Let the import handler emit its own usage error; the gate
    // has nothing to validate.
    return {};
  }

  let raw: string;
  try {
    raw = readFileSync(resolve(filePath), "utf-8");
  } catch {
    // Unreadable / missing file — defer to the import handler's own NOT_FOUND
    // error path rather than producing a second, divergent message here.
    return {};
  }

  // Cross-check dependency edges against bead ids already in the workspace so a
  // dependency that resolves at import time (a prior import) is a warning, not a
  // hard error — matching the import pipeline's own behavior and `beads validate`.
  let workspaceBeadIds: Set<string> | undefined;
  try {
    workspaceBeadIds = ctx?.pm_root ? await readWorkspaceBeadIds(ctx.pm_root) : undefined;
  } catch {
    workspaceBeadIds = undefined;
  }

  const report = validateBeadsText(raw, resolve(filePath), workspaceBeadIds);
  const errors = report.issues.filter((i) => i.severity === "error");
  if (errors.length === 0) {
    // Valid (warnings alone do not block) — silent pass-through.
    return {};
  }

  // Build an actionable, line-naming summary of the structural errors.
  const detail = errors
    .slice(0, 10)
    .map((iss) => `  - ${iss.line ? `line ${iss.line}` : "file"} [${iss.code}]: ${iss.message}`)
    .join("\n");
  const more = errors.length > 10 ? `\n  …and ${errors.length - 10} more error(s)` : "";
  const err = new CommandError(
    `Beads JSONL preflight failed for ${resolve(filePath)} — ${errors.length} structural error(s); ` +
      `nothing was imported. Fix the file (or run \`pm beads validate <file>\`) and retry:\n${detail}${more}`,
    EXIT_CODE.GENERIC_FAILURE,
  );

  // The SDK swallows thrown preflight errors, so abort the process directly to
  // guarantee no pm-store write happens. Print to stderr first for a clean
  // message instead of an unhandled stack trace.
  console.error(err.message);
  process.exit(err.exitCode);
}

export default defineExtension({
  name: "pm-beads",
  version: "2026.6.8",

  activate(api: any) {
    // -----------------------------------------------------------------------
    // schema — declare the bead_id provenance field
    // -----------------------------------------------------------------------
    api.registerItemFields([
      { name: "bead_id", type: "string", optional: true },
    ]);

    // -----------------------------------------------------------------------
    // preflight — fail-fast Beads-JSONL schema gate BEFORE import
    // -----------------------------------------------------------------------
    // Runs the existing structural validator (validateBeadsText) against the
    // import input file *before* the CLI lets the importer touch the pm store.
    // On a structurally invalid file it aborts immediately with a clear,
    // actionable message and a non-zero exit — so no partial/garbage items are
    // ever created. On a valid file it is a silent pass-through.
    //
    // Scope: fires ONLY for the import path (`pm beads import` and its legacy
    // `pm beads-import` alias). Export and validate are never blocked.
    api.registerPreflight((ctx: any) => runImportPreflight(ctx));

    // -----------------------------------------------------------------------
    // importer — `pm beads import <file>` (native import pipeline)
    // -----------------------------------------------------------------------
    api.registerImporter("beads", async (ctx: any) => {
      return runImport(ctx.args?.[0], ctx.pm_root, parseImportOptions(ctx.options || {}));
    });

    // -----------------------------------------------------------------------
    // exporter — `pm beads export` (serialize pm items back to Beads JSONL)
    // -----------------------------------------------------------------------
    api.registerExporter("beads", async (ctx: any) => {
      const options = ctx.options || {};
      return runExport(ctx.pm_root, {
        preserveIds: resolvePreserveIds(options),
        output: optionString(options, "output", "o"),
        filter: parseRowFilter(options),
      });
    });

    // -----------------------------------------------------------------------
    // command — legacy `pm beads-import <file>` alias (rich flag help).
    // Named distinctly from the `beads` importer so the two do not collide on
    // the auto-created `beads import` command handler. Delegates to the same
    // import core, so behavior is identical.
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "beads-import",
      description:
        "Import work items from a Beads JSONL file into pm (alias of `pm beads import`). " +
        "Each JSON line becomes a pm item; the original Beads id and blocker edges are preserved.",
      intent: "import Beads JSONL work items as pm items",
      examples: [
        "pm beads import items.jsonl",
        "pm beads import data.jsonl --dry-run",
        "pm beads import data.jsonl --upsert",
        "pm beads import data.jsonl --type Task --priority 2",
        "pm beads import data.jsonl --filter-status open,in_progress",
        "pm beads import data.jsonl --filter-type Bug",
        "pm beads import data.jsonl --no-preserve-ids",
        "pm beads import data.jsonl --no-preserve-timestamps",
      ],
      flags: IMPORT_FLAGS,
      async run(ctx: any) {
        return runImport(ctx.args[0], ctx.pm_root, parseImportOptions(ctx.options));
      },
    });

    // -----------------------------------------------------------------------
    // command — legacy `pm beads-export` alias (rich flag help).
    // -----------------------------------------------------------------------
    api.registerCommand({
      name: "beads-export",
      description:
        "Serialize pm items back to Beads JSONL (alias of `pm beads export`). " +
        "Preserves the original Beads id (when present) and emits dependency/blocker edges.",
      intent: "export pm items as Beads JSONL",
      examples: [
        "pm beads export",
        "pm beads export --output items.jsonl",
        "pm beads export --filter-status open,in_progress",
        "pm beads export --filter-type Bug",
        "pm beads export --no-preserve-ids",
      ],
      flags: EXPORT_FLAGS,
      async run(ctx: any) {
        const options = ctx.options || {};
        return runExport(ctx.pm_root, {
          preserveIds: resolvePreserveIds(options),
          output: optionString(options, "output", "o"),
          filter: parseRowFilter(options),
        });
      },
    });

    // -----------------------------------------------------------------------
    // command — validate a Beads JSONL file before import: structural lint of
    // malformed lines, missing required fields, unknown statuses, and dangling
    // dependency references. Exits nonzero on any structural error (warnings
    // alone keep a zero exit). Registered under BOTH the canonical
    // `pm beads validate` (the `beads` group only gets import/export from the
    // importer/exporter, so validate needs an explicit command) and the
    // hyphenated `pm beads-validate` alias. A single shared definition keeps
    // the two forms from drifting.
    // -----------------------------------------------------------------------
    const makeValidateCommand = (name: string) => ({
      name,
      description:
        "Validate a Beads JSONL file before import. Reports invalid JSON, missing titles, " +
        "unknown statuses, and dangling dependency references; exits nonzero on errors.",
      intent: "validate a Beads JSONL file before import",
      examples: [
        "pm beads validate items.jsonl",
        "pm beads validate items.jsonl --json",
        "pm beads validate items.jsonl --no-workspace",
      ],
      flags: VALIDATE_FLAGS,
      async run(ctx: any) {
        const options = ctx.options || {};
        // `--json` may arrive as a command option or as pm's global flag
        // (surfaced on ctx.global). Honor either so the structured report is
        // returned (and rendered by the runtime) instead of the human listing.
        const json = readBoolOption(options, "json") || readBoolOption(ctx.global || {}, "json");
        // Cross-workspace dependency check is ON by default; --no-workspace opts out.
        const workspace = !(options["no-workspace"] === true || options["noWorkspace"] === true);
        return runValidate(ctx.args?.[0], { json, workspace, pmRoot: ctx.pm_root });
      },
    });
    api.registerCommand(makeValidateCommand("beads validate"));
    api.registerCommand(makeValidateCommand("beads-validate"));

    // -----------------------------------------------------------------------
    // command — `pm beads diff` (and the `pm beads-diff` rich-help alias):
    // audit round-trip fidelity by comparing two Beads JSONL files, or a file
    // against the current pm workspace (`--against-workspace`, serialized to
    // beads in-memory via the shared export core). Pure read-only. Per-bead
    // classification (added/removed/changed-fields/unchanged) keyed on bead id;
    // human summary by default, structured object under `--json`. Exits nonzero
    // only under `--strict` when drift is found (a CI fidelity gate). A single
    // shared definition keeps the canonical and hyphenated forms from drifting
    // (`beads` group commands need an explicit registerCommand to exist).
    // -----------------------------------------------------------------------
    const makeDiffCommand = (name: string) => ({
      name,
      description:
        "Compare two Beads JSONL files (or a file against the current pm workspace) and report per-bead " +
        "drift — added, removed, changed (which fields), unchanged — to audit round-trip fidelity.",
      intent: "diff two Beads sources to audit round-trip fidelity",
      examples: [
        "pm beads diff before.jsonl after.jsonl",
        "pm beads diff exported.jsonl --against-workspace",
        "pm beads diff a.jsonl b.jsonl --json",
        "pm beads diff a.jsonl b.jsonl --strict",
        "pm beads diff a.jsonl b.jsonl --filter-status open,in_progress",
        "pm beads diff a.jsonl b.jsonl --filter-type Bug",
      ],
      flags: DIFF_FLAGS,
      async run(ctx: any) {
        return runDiff(ctx.args, parseDiffOptions(ctx.options || {}, ctx.global || {}, ctx.pm_root));
      },
    });
    api.registerCommand(makeDiffCommand("beads diff"));
    api.registerCommand(makeDiffCommand("beads-diff"));
  },
});
