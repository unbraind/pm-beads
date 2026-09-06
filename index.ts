// pm-beads — Beads JSONL importer/exporter for pm-cli
//
// Capabilities (see manifest.json):
//   commands  — `pm beads-import` / `pm beads-export` / `pm beads-validate`
//               (rich-help aliases of the import/export/validate pipelines)
//   importers — `pm beads import` (native import pipeline, with `--upsert`)
//   exporters — `pm beads export` (serialize pm items back to Beads JSONL)
//   schema    — declares the `bead_id` item field
//
// Fail-fast import gate: the import core itself validates the whole JSONL file
// (same structural rules as `pm beads validate`) BEFORE any pm-store write and
// aborts with a nonzero exit on structural errors. The gate deliberately does
// NOT live on the preflight override surface: preflight overrides are
// single-winner, so a co-installed package (e.g. pm-todos) silently shadows
// them (`extension_preflight_override_collision`) and a gate registered there
// stops running entirely — letting a malformed file partially import.
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

import type {
  CommandDefinition,
  CommandHandlerContext,
  Exporter,
  ExtensionApi,
  ExtensionModule,
  FlagDefinition,
  ImportExportContext,
  Importer,
  SchemaFieldDefinition,
} from "@unbrained/pm-cli/sdk/authoring";
import { suppressHostOutput } from "@unbrained/pm-cli/sdk";
// Top-level SDK runtime import. This fleet once believed extensions could not
// resolve `@unbrained/pm-cli` at runtime and hid SDK access behind inline
// dynamic-import shims laundered through `any`; that premise was disproven (a
// populated node_modules is the only requirement), so the store read below
// imports its binding the same way every other fleet package does.
import { listAllItemMetadata } from "@unbrained/pm-cli/sdk/runtime";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";



// ---------------------------------------------------------------------------
// Error contract
// ---------------------------------------------------------------------------

// pm's extension command runtime only treats a thrown error as a cleanly
// handled non-zero exit when the error carries a numeric `exitCode` property
// (see @unbrained/pm-cli runCommandHandler). A plain `Error` makes the runtime
// fall through to its "unhandled" path, which RE-INVOKES the command handler a
// second time and exits with a generic code. We mirror the SDK's EXIT_CODE
// values here rather than re-exporting them: EXIT_CODE is part of this
// package's own public surface (imported by tests and downstream tooling), and
// the mirror keeps that surface byte-stable (same three members, same values)
// regardless of how the SDK's constant grows.
/**
 * Semantic exit codes pm's command runtime propagates to the shell.
 *
 * Mirrored here (not re-exported) because `EXIT_CODE` is part of this package's
 * own public surface — imported by tests and downstream tooling — and the mirror
 * keeps that surface byte-stable regardless of how the SDK's constant grows.
 * {@link CommandError} carries one of these so a handled failure exits cleanly
 * once instead of re-invoking the handler.
 */
export const EXIT_CODE = {
  GENERIC_FAILURE: 1,
  USAGE: 2,
  NOT_FOUND: 3,
} as const;

/**
 * Error that carries a semantic process exit code.
 *
 * pm's command runtime treats a thrown error as a cleanly handled non-zero exit
 * only when it exposes a numeric `exitCode`; a plain `Error` instead falls
 * through to the "unhandled" path, which re-invokes the handler a second time
 * and exits with a generic code. Throwing this routes a failure to a clean,
 * single exit at the chosen code.
 */
export class CommandError extends Error {
  /** Numeric exit code the runtime propagates to the shell (one of {@link EXIT_CODE}). */
  exitCode: number;
  constructor(message: string, exitCode: number = EXIT_CODE.GENERIC_FAILURE) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
  }
}

/**
 * Extract a human-readable message from an unknown thrown value.
 *
 * Spawn and fs failures surface as `Error` instances, but this package sits at
 * a process boundary where a thrown non-Error (a string from a shell snippet,
 * a rejected non-Error promise) must still render as text rather than
 * "[object Undefined]". Centralized so every call site reports both shapes
 * identically.
 *
 * @param err - The thrown value to render.
 * @returns `err.message` for Error instances, `String(err)` otherwise.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A workspace read that SUCCEEDED but cannot be trusted as the whole workspace.
 *
 * Distinct from every other read failure, because callers must treat the two
 * differently. "No workspace here" is a legitimate state that optional
 * cross-checks degrade around; "the workspace answered, and the answer is
 * provably partial" is not — degrading around it silently produces a wrong
 * answer computed from a fraction of the data. Callers that catch a read
 * failure to fall back must therefore let this one through.
 */
export class IncompleteWorkspaceReadError extends CommandError {
  constructor(message: string) {
    super(message);
    this.name = "IncompleteWorkspaceReadError";
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
  issue_type?: string;
  priority?: number | string;
  tags?: string[];
  labels?: string[];
  assignee?: unknown;
  owner?: unknown;
  parent?: string;
  deadline?: string;
  due_date?: string;
  due_at?: string;
  sprint?: string;
  release?: string;
  created_at?: string;
  updated_at?: string;
  // Closure provenance a source tracker may record on a closed record. Real
  // Beads (`bd`) writes `closed_at` and `close_reason`; foreign variants are
  // accepted (`resolution`, `state_reason`, `completed_at`) so the importer
  // can carry genuine closure evidence through to `pm close` instead of
  // inventing a reason (see beadCloseReason).
  closed_at?: string;
  completed_at?: string;
  close_reason?: string;
  resolution?: string;
  state_reason?: string;
  dependencies?: Array<string | {
    id?: string;
    kind?: string;
    issue_id?: string;
    depends_on_id?: string;
    type?: string;
  }>;
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

/**
 * Read the first non-empty trimmed string value under any of the given keys.
 *
 * Checks both the raw kebab-case key and the camelCase form the runtime may
 * normalize it to.
 *
 * @param options - The raw option object from the command handler.
 * @param keys - The keys to try, in priority order.
 * @returns The first non-empty trimmed value, or `undefined`.
 */
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

/**
 * Resolve the tri-state of `--workspace` / `--no-workspace` for validate.
 * Same normalization rules as resolvePreserveIds: the runtime may surface
 * `--no-workspace` as `{ workspace: false }`, `noWorkspace: true`, or a
 * literal `no-workspace: true`. Default is ON (cross-check the workspace).
 */
export function resolveWorkspaceCheck(options: Record<string, unknown>): boolean {
  if (options["no-workspace"] === true || options["noWorkspace"] === true) return false;
  for (const k of ["workspace"]) {
    const v = options[k];
    if (v !== undefined) return v !== false && v !== "false" && v !== "0";
  }
  return true;
}

/**
 * Map a raw Beads status string onto a canonical pm status.
 *
 * Accepts common aliases (todo/wip/done/cancelled/…) and falls back to `open`
 * for an unrecognized value so an import never invents a state.
 *
 * @param raw - The status value from a Beads record.
 * @returns The canonical pm status.
 */
export function mapStatus(raw: unknown): string {
  if (raw === undefined || raw === null) return "open";
  const s = String(raw).trim().toLowerCase();
  if (!s) return "open";
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

/**
 * Inverse of {@link mapStatus} for export: map a pm status back to a stable
 * Beads status string.
 *
 * @param raw - The canonical pm status.
 * @returns The Beads status string.
 */
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

/**
 * Clamp a raw Beads priority onto pm's 0–4 scale.
 *
 * String values go through `parseInt`, which reads the **leading numeric prefix**
 * rather than validating the whole string: `"3abc"` yields `3`, not `undefined`.
 * Only a missing value, or one with no numeric prefix at all, returns
 * `undefined` so the caller can omit `--priority`. Values outside the scale are
 * clamped to its ends rather than rejected, so an out-of-range import still
 * lands somewhere meaningful instead of failing the whole item.
 *
 * @param raw - The priority as a number, or a string whose numeric prefix is read.
 * @returns The clamped priority as a string, or `undefined` when none can be read.
 */
export function mapPriority(raw: number | string | undefined): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
  if (isNaN(n)) return undefined;
  return String(Math.min(4, Math.max(0, n)));
}

// The marker we embed in the description to persist the native Beads id through
// `pm create` (which exposes no generic custom-field setter for extensions).
//
// Both the separator `[ \t]{0,64}` and the capture tail `[^\]]{0,4096}` are
// BOUNDED, and the capture starts with a single (non-quantified) `\S`. CodeQL
// flags `js/polynomial-redos` for any regex with two unbounded quantifiers whose
// character classes overlap; bounding both quantifiers makes the worst case
// constant-bounded (O(64·4096) = linear) and is the documented CodeQL remedy.
// The tail bound of 4096 is ~200x the longest real Beads id (the test suite's ids
// are short slugs like `bd-42`), so no realistic id is rejected; the bound only
// excludes degenerate externally-authored markers with >4097-char ids.
// The earlier forms were all still flagged:
//   * `\s*([^\]]+)` — O(n²): `\s*` and `[^\]]+` both match a space (3900 ms at n=64000).
//   * `\s*([^\]\s]+` — runtime-linear, but CodeQL cannot prove `\s`/`[^\]\s]` disjoint.
//   * `[ \t]*(\S[^\]]*)`  — runtime-linear, but the unbounded `[^\]]*` tail matches a
//     space and CodeQL sees the unbounded separator/tail overlap.
//   * `[ \t]{0,64}(\S[^\]]*)` — separator bounded but the tail was still unbounded; still flagged.
// Bounding the tail too is what clears the static flag (measured 0.17 ms at n=64000).
//
// Accepted-language notes:
//  * The capture MAY contain spaces (e.g. `[bead_id: multi word]` decodes to
//    `"multi word"`), so a Beads id with internal whitespace round-trips
//    correctly (Greptile P1 / cubic P1 on the prior narrowing). `[bead_id: abc ]`
//    matches and decodes to `"abc"` via the existing `.trim()`. `encodeBeadId`
//    only ever writes single-token slug ids, so round-trip data is unaffected.
//  * A whitespace-only id (`[bead_id:   ]`) no longer matches (degenerate).
//  * More than 64 leading spaces after the colon, or an id longer than 4097
//    characters, no longer match — `encodeBeadId` writes one space and short slug
//    ids, so this only affects degenerate externally-authored markers. Pinned in
//    `test/smoke.test.ts`.
// 3. The separator is `\s{0,64}`, not `[ \t]{0,64}`. The original `\s*` accepted a
//    newline or a Unicode space, so a marker already written as
//    `[bead_id:\nbd-42]` decodes today; narrowing to space-and-tab would have
//    made those markers unreadable and lost the id they carry. Bounding it keeps
//    the expression linear, and the capture's leading `\S` keeps the separator
//    and the capture disjoint, which is what removed the overlap in the first
//    place.
const BEAD_ID_MARKER = /\[bead_id:\s{0,64}(\S[^\]]{0,4096})\]/;

/**
 * Whether an id survives a write through the marker and a read back out.
 *
 * The marker is the only record of a native id, so an id the reader rejects is
 * an id that vanishes on the next export - and a later `--upsert` then creates
 * a duplicate instead of matching. Checked by RUNNING the matcher rather than
 * by comparing a length to a second copy of its bound, so this cannot drift
 * away from the expression it protects.
 *
 * @param beadId - The native Beads id about to be persisted.
 * @returns True when {@link decodeBeadId} would recover exactly this id.
 */
export function isEncodableBeadId(beadId: string): boolean {
  return BEAD_ID_MARKER.exec(`[bead_id: ${beadId}]`)?.[1]?.trim() === beadId;
}

/**
 * Embed the native Beads id into an item description behind a parseable marker.
 *
 * Idempotent: if the description already carries a `[bead_id: …]` marker it is
 * returned unchanged. Used because pm `create` exposes no generic custom-field
 * setter for extensions.
 *
 * @param description - The current description text.
 * @param beadId - The native Beads id to persist.
 * @returns The description with the marker appended.
 */
export function encodeBeadId(description: string, beadId: string | undefined): string {
  if (!beadId) return description;
  // Avoid duplicating the marker if the description already carries one.
  if (BEAD_ID_MARKER.test(description)) return description;
  const trimmed = description.trim();
  const marker = `[bead_id: ${beadId}]`;
  // Refuse to persist an identity this module cannot read back. The marker is
  // the ONLY record of the native id, so writing one `decodeBeadId` rejects
  // loses the id silently - and a later `--upsert` then fails to match the
  // existing item and creates a duplicate instead. Failing loudly on a
  // degenerate id is recoverable; silently forking an item's identity is not.
  //
  // Derived from the matcher rather than from a second copy of its bound, so
  // the check cannot drift away from the regex it is protecting.
  if (!isEncodableBeadId(beadId)) {
    throw new CommandError(
      `bead id cannot be persisted: it is ${beadId.length} characters and the id marker cannot read it back, so the identity would be lost on export`,
      EXIT_CODE.USAGE,
    );
  }
  return trimmed ? `${trimmed}\n\n${marker}` : marker;
}

/**
 * Recover the native Beads id for a pm item.
 *
 * Prefers a real `bead_id` schema field when the workspace populated one, else
 * scans the description/body for the `[bead_id: …]` marker written on import.
 *
 * @param item - The pm item to read the bead id from.
 * @returns The bead id, or `undefined` when none is recorded.
 */
export function decodeBeadId(item: PmItem): string | undefined {
  // Prefer a real schema field if the workspace populated it, else recover the
  // marker from the description we wrote on import.
  if (typeof item.bead_id === "string" && item.bead_id.trim()) return item.bead_id.trim();
  const source = `${item.description ?? ""}\n${item.body ?? ""}`;
  const m = source.match(BEAD_ID_MARKER);
  return m ? m[1].trim() : undefined;
}

/**
 * Remove the `[bead_id: …]` marker from a text block.
 *
 * Keeps exported descriptions clean of internal provenance.
 *
 * @param text - The text to clean (typically a description/body).
 * @returns The text with the marker removed and trimmed.
 */
export function stripBeadIdMarker(text: string | undefined): string {
  if (!text) return "";
  return text.replace(BEAD_ID_MARKER, "").trim();
}

/**
 * Beads status spellings that map to a recognized pm status.
 *
 * Used by `beads validate` to flag a record whose status fell back to `open`
 * only because it was unrecognized, versus one that is genuinely `open`.
 */
export const KNOWN_BEADS_STATUSES = new Set<string>([
  "open", "todo", "new",
  "in_progress", "wip", "doing",
  "blocked", "on_hold",
  "closed", "done", "complete",
  "canceled", "cancelled",
  "draft",
]);

/**
 * Normalize a raw Beads id into a stable dedup/upsert key.
 *
 * Trims but does NOT lowercase the id: bead ids are case-sensitive, and keying
 * off the case-preserving marker (not pm's case-folding tags) is what keeps
 * re-import idempotent.
 *
 * @param id - The raw id value from a record.
 * @returns The trimmed id, or `undefined` when blank.
 */
export function normalizeBeadKey(id: unknown): string | undefined {
  if (id === undefined || id === null) return undefined;
  const t = String(id).trim();
  return t.length ? t : undefined;
}

/**
 * Resolve a Beads record's display title from either accepted spelling.
 *
 * The trailing `|| ""` is load-bearing, not stylistic: without it,
 * `String(undefined)` on a record missing both fields would yield the literal
 * string `"undefined"`, and a record reaching the import loop unvalidated
 * would be created under that title instead of an empty one. The fail-fast
 * gate (`assertBeadsImportable`) rejects blank titles using this same helper,
 * so the gate and the import loop cannot drift apart on the definition of a
 * usable title.
 *
 * @param item - The Beads record to read a title from.
 * @returns The trimmed title, or the empty string when both spellings are absent.
 */
export function beadTitle(item: BeadsItem): string {
  return String(item.title || item.name || "").trim();
}

/**
 * Flatten the many ways a Beads record can express blocker edges into one list.
 *
 * Reads `dependencies` (string or object form, honoring `depends_on_id` and the
 * `blocked_by`/`depends_on`/`blocks_me` kinds), `blocked_by`, and `blocks`,
 * returning the upstream bead ids that block this item, de-duplicated.
 *
 * @param item - The Beads record to read edges from.
 * @returns The upstream blocker bead ids.
 */
export function extractBlockerIds(item: BeadsItem): string[] {
  const ids = new Set<string>();
  const push = (v: unknown) => {
    const value = scalarString(v);
    if (value) ids.add(value);
  };
  if (Array.isArray(item.dependencies)) {
    for (const dep of item.dependencies) {
      if (typeof dep === "string") push(dep);
      else if (dep && typeof dep === "object") {
        const dependsOn = scalarString(dep.depends_on_id);
        if (dependsOn) {
          push(dependsOn);
          continue;
        }
        const kind = (scalarString(dep.kind) ?? scalarString(dep.type) ?? "blocked_by").toLowerCase();
        if (kind === "blocked_by" || kind === "depends_on" || kind === "blocks_me") push(dep.id);
      }
    }
  }
  if (Array.isArray(item.blocked_by)) item.blocked_by.forEach(push);
  else push(item.blocked_by);
  return [...ids];
}

/**
 * Resolve the item type from a Beads record.
 *
 * Prefers `issue_type` then `type`, returning `undefined` when neither carries a
 * usable string.
 *
 * @param item - The Beads record to read.
 * @returns The trimmed type, or `undefined`.
 */
function beadType(item: BeadsItem): string | undefined {
  const raw = typeof item.issue_type === "string" && item.issue_type.trim()
    ? item.issue_type
    : typeof item.type === "string" && item.type.trim()
      ? item.type
      : undefined;
  return raw?.trim();
}

function beadLabels(item: BeadsItem): string[] {
  const values = Array.isArray(item.labels) ? item.labels : Array.isArray(item.tags) ? item.tags : [];
  return values.map((tag) => scalarString(tag)).filter((tag): tag is string => Boolean(tag));
}

function scalarString(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim();
  return value ? value : undefined;
}

function beadAssignee(item: BeadsItem): string | undefined {
  return scalarString(item.assignee) ?? scalarString(item.owner);
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
//
// History consistency: a raw file patch desynchronizes the item's history
// chain (`pm health` flags it as history_drift / hash_mismatches → ok:false).
// After every successful patch we therefore run the CLI's own sanctioned
// re-anchor, `pm history-repair <id>`, which recomputes the hashes and records
// an audit marker so the store stays history-consistent. If the repair cannot
// run (e.g. an older CLI without `history-repair`), the patch is REVERTED and
// the timestamp is skipped with a warning — keeping `pm health` green is the
// default behavior; raw drift is never left behind.

/**
 * Validate and normalize an ISO-8601 timestamp.
 *
 * Accepts only well-formed instants so garbage is never written into item front
 * matter. Returns the round-tripped canonical ISO string, or `undefined`.
 *
 * @param raw - The raw timestamp value.
 * @returns The normalized ISO string, or `undefined` when unparseable.
 */
export function normalizeIsoTimestamp(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const t = Date.parse(trimmed);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

/**
 * Rewrite top-level `created_at`/`updated_at` lines in a stored item file.
 *
 * Works for both `toon` and `json_markdown` formats, which each store a field as
 * one `key: "<iso>"` line. Only the first matching line for an existing key is
 * rewritten, so no fields are invented and the body is left undisturbed.
 *
 * @param text - The raw item file contents.
 * @param values - Timestamps to write (only set keys are applied).
 * @returns The patched text, or `null` when nothing changed.
 */
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

/**
 * Locate the on-disk file for a pm item id under the pm root.
 *
 * Items live in per-type folders as `<id>.<ext>`; this scans one level of type
 * folders for `<id>.toon` / `<id>.md`, skipping the `history`/`locks`/`search`
 * sidecars. Returns `undefined` when the item file cannot be found or the root
 * is unreadable.
 *
 * @param pmRoot - The pm data directory.
 * @param pmId - The pm item id to locate.
 * @returns Absolute path to the item file, or `undefined`.
 */
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

/**
 * Apply preserved bead timestamps to the persisted pm item file.
 *
 * Patches the on-disk `created_at`/`updated_at` lines then re-anchors the item's
 * history chain with `pm history-repair` so the raw patch does not surface as
 * `history_drift` in `pm health`. On a repair failure the patch is reverted so a
 * missing timestamp stays recoverable. Returns `true` only when a timestamp was
 * written and history stayed consistent.
 */
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
    console.error(`  timestamp skipped: cannot read ${file}: ${errorMessage(err)}`);
    return false;
  }
  const patched = patchTimestampLines(text, { created_at, updated_at });
  if (patched === null) return false;
  try {
    writeFileSync(file, patched, "utf-8");
  } catch (err: unknown) {
    console.error(`  timestamp skipped: cannot write ${file}: ${errorMessage(err)}`);
    return false;
  }
  // Re-anchor the item's history chain so the raw patch does not surface as
  // history_drift in `pm health`. On failure, revert the patch entirely — a
  // missing timestamp is recoverable, a drifted history chain is not.
  const repair = spawnSync(
    "pm",
    [
      "--path", pmRoot,
      "history-repair", pmId,
      "--message", "pm-beads import: preserved source bead created_at/updated_at",
    ],
    { encoding: "utf-8" },
  );
  if (repair.error || repair.status !== 0) {
    const why = describeRepairFailure(repair);
    try {
      writeFileSync(file, text, "utf-8");
      console.error(
        `  timestamp skipped: pm history-repair failed for ${pmId} (${why}); ` +
          `patch reverted to keep pm health history-consistent`,
      );
    } catch (revertErr: unknown) {
      console.error(
        `  timestamp warning: pm history-repair failed for ${pmId} (${why}) and the patch could not be ` +
          `reverted (${errorMessage(revertErr)}); ` +
          `run \`pm history-repair ${pmId}\` manually`,
      );
    }
    return false;
  }
  return true;
}

/**
 * Resolve the deadline field from a Beads record.
 *
 * Reads `deadline`, then `due_date`, then `due_at`, returning the first
 * non-empty value.
 *
 * @param item - The Beads record to read.
 * @returns The trimmed deadline, or `undefined`.
 */
function beadDeadline(item: BeadsItem): string | undefined {
  const raw = typeof item.deadline === "string" && item.deadline.trim()
    ? item.deadline
    : typeof item.due_date === "string" && item.due_date.trim()
      ? item.due_date
      : typeof item.due_at === "string" && item.due_at.trim()
        ? item.due_at
        : undefined;
  return raw?.trim();
}

/**
 * Append the planning-related pm CLI args derived from a Beads record.
 *
 * Adds `--deadline`, `--assignee`, `--sprint`, and `--release` only when the
 * record carries a value for each, mutating `args` in place.
 *
 * @param args - The argv array being built (mutated).
 * @param item - The Beads record to source values from.
 */
function appendPlanningArgs(args: string[], item: BeadsItem): void {
  const deadline = beadDeadline(item);
  if (deadline) args.push("--deadline", deadline);
  const assignee = beadAssignee(item);
  if (assignee) args.push("--assignee", assignee);
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

/**
 * A status/type filter narrowing which records an import or export touches.
 *
 * An unset dimension means “no constraint on that dimension”; an empty filter
 * selects everything.
 */
export interface RowFilter {
  /** Lower-cased mapped pm statuses to keep (undefined = any). */
  statuses?: Set<string>;
  /** Lower-cased item types to keep (undefined = any). */
  types?: Set<string>;
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
    const status = mapStatus(bead.status);
    if (!filter.statuses.has(status.toLowerCase())) return false;
  }
  if (filter.types) {
    const type = (typeOverride || beadType(bead) || "Task").toLowerCase();
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

  for (const start of adj.keys()) {
    if ((color.get(start) ?? 0) !== 0) continue;

    // Use explicit frames instead of recursive DFS so agent-generated graphs
    // with tens of thousands of dependencies cannot exhaust the JS call stack.
    const path: string[] = [start];
    const pathIndex = new Map<string, number>([[start, 0]]);
    // start comes from adj.keys(), so its neighbor list always exists.
    const frames: Array<{ node: string; neighbors: string[]; nextIndex: number }> = [
      { node: start, neighbors: adj.get(start)!, nextIndex: 0 },
    ];
    color.set(start, 1);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame.nextIndex >= frame.neighbors.length) {
        frames.pop();
        const completed = path.pop()!;
        pathIndex.delete(completed);
        color.set(frame.node, 2);
        continue;
      }

      const next = frame.neighbors[frame.nextIndex++];
      const nextColor = color.get(next) ?? 0;
      if (nextColor === 1) {
        const idx = pathIndex.get(next);
        if (idx !== undefined) {
          const cycle = path.slice(idx);
          const key = [...cycle].sort().join("\u001f");
          if (!seenCycleKeys.has(key)) {
            seenCycleKeys.add(key);
            cycles.push([...cycle, next]);
          }
        }
        continue;
      }

      if (nextColor === 0) {
        color.set(next, 1);
        pathIndex.set(next, path.length);
        path.push(next);
        frames.push({ node: next, neighbors: adj.get(next) ?? [], nextIndex: 0 });
      }
    }
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
    const title = beadTitle(item);
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
// Prefers the SDK item-store (`listAllItemMetadata`) per the SDK contract and
// falls back to spawning canonical `pm list --all` (the exporter data path)
// when the store read fails. Either way a failure degrades to "no workspace
// data" so validation still runs.
//
// Historical note: this used to guard a `listAllFrontMatter` binding behind an
// inline dynamic import. That export no longer exists in the 2026.7.x SDK, so
// the guard was permanently false and every validate run already took the
// spawn fallback. The metadata projection below restores the intended SDK
// path: the marker is persisted in the item description (see encodeBeadId),
// which `ItemMetadata` always carries, so the projection is equivalent to the
// fallback for every item this extension writes. `bead_id`/`body` arrive via
// the ItemMetadata index signature as `unknown`, so they are narrowed with
// typeof guards rather than trusted blindly.
/**
 * Project SDK item metadata onto the minimal {@link PmItem} shape the bead-id
 * cross-check reads.
 *
 * `bead_id`/`body` arrive via the ItemMetadata index signature as `unknown`,
 * so they are narrowed with typeof guards rather than trusted blindly; a
 * non-string value degrades to "absent" and the description/body marker scan
 * still applies.
 *
 * @param metas - Metadata rows returned by the SDK item store.
 * @returns One narrowed item per row.
 */
export function metadataToPmItems(
  metas: Array<{ bead_id?: unknown; description?: unknown; body?: unknown }>,
): PmItem[] {
  return metas.map((meta) => ({
    bead_id: typeof meta.bead_id === "string" ? meta.bead_id : undefined,
    description: typeof meta.description === "string" ? meta.description : undefined,
    body: typeof meta.body === "string" ? meta.body : undefined,
  }));
}

/**
 * Name why a spawned `pm` child failed, preferring the most specific signal.
 *
 * A spawn error (the child never started) outranks captured stderr, which
 * outranks a bare exit status — the last being the only signal a killed child
 * leaves.
 *
 * @param repair - The finished spawn result to summarize.
 * @returns The most specific failure message available.
 */
export function describeRepairFailure(repair: {
  error?: Error | null;
  stderr?: string | null;
  status: number | null;
}): string {
  return repair.error?.message || repair.stderr?.trim() || `exit ${repair.status ?? "unknown"}`;
}

async function readWorkspaceBeadIds(pmRoot: string): Promise<Set<string> | undefined> {
  let items: PmItem[] | undefined;
  try {
    items = metadataToPmItems(await listAllItemMetadata(pmRoot));
  } catch {
    /* SDK store read failed — fall back to the CLI read path below. */
  }
  if (items === undefined) {
    // The SDK read failed. Absence is the ONE case that legitimately degrades --
    // the cross-check is optional and a caller may point at a path with no
    // tracker, which is exactly what `listAllItemMetadata` throws for ("Tracker
    // root does not exist"). Testing that here rather than inferring it from the
    // failure is what separates it from every other cause.
    if (!existsSync(pmRoot)) return undefined;
    // The workspace is there and the SDK could not read it, so fall back to the
    // CLI. Deliberately NOT wrapped in a catch: an ENOBUFS overrun on a large
    // workspace, a nonzero exit, malformed JSON and a truncated envelope are all
    // failures to read a workspace that EXISTS, and swallowing any of them left
    // the cross-check with an empty set. Validation then reported a dependency
    // that DOES exist as `dangling_dependency`, so the import gate rejected a
    // valid file and blamed the operator's input for a read failure they were
    // never told about.
    items = readPmItems(pmRoot);
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
  const raw = readFileOrThrow(absolutePath);

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
      console.error(`  ${iss.severity.toUpperCase()} [${iss.code}] line ${iss.line}: ${iss.message}`);
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

// How an `--upsert` import handles a bead whose id already maps to an existing
// pm item (a duplicate). Only consulted when `--upsert` is on.
//   update — replace the matched item in place (the original --upsert behavior)
//   skip   — leave the existing item untouched and move on (no create, no update)
//   fail   — abort the import with a nonzero exit on the first duplicate
export type MergeStrategy = "update" | "skip" | "fail";

/**
 * The recognized `--merge-strategy` values, in display order.
 *
 * Each controls how an `--upsert` import handles a bead whose id already maps to
 * an existing pm item: `update` (replace in place), `skip` (leave untouched),
 * or `fail` (abort on the first duplicate).
 */
export const MERGE_STRATEGIES: readonly MergeStrategy[] = ["update", "skip", "fail"];

interface ImportOptions {
  dryRun: boolean;
  validateOnly: boolean;
  preserveIds: boolean;
  preserveTimestamps: boolean;
  upsert: boolean;
  mergeStrategy: MergeStrategy;
  batchSize?: number;
  typeOverride?: string;
  priorityOverride?: string;
  tagsOverride?: string;
  filter: RowFilter;
}

/**
 * Read a file as UTF-8 text, mapping failures to a {@link CommandError}.
 *
 * A missing file (ENOENT) yields a NOT_FOUND exit code; any other read failure
 * yields GENERIC_FAILURE, so the caller gets a semantic exit rather than a bare
 * thrown Error.
 *
 * @param absolutePath - Absolute path to the file.
 * @returns The file contents.
 */
function readFileOrThrow(absolutePath: string): string {
  try {
    return readFileSync(absolutePath, "utf-8");
  } catch (err: unknown) {
    const msg = errorMessage(err);
    const code = typeof (err as NodeJS.ErrnoException)?.code === "string" ? (err as NodeJS.ErrnoException).code : "";
    const exitCode = code === "ENOENT" ? EXIT_CODE.NOT_FOUND : EXIT_CODE.GENERIC_FAILURE;
    throw new CommandError(`Failed to read file: ${msg}`, exitCode);
  }
}

/**
 * Detect pm's "Invalid type value" rejection in `pm update` stderr. `pm create`
 * resolves synonym types (bug -> Issue, story -> Feature, ...) through a fallback
 * table but `pm update` validates strictly; the upsert path uses this to retry an
 * update without `--type` instead of failing the record. Exported for tests.
 */
export function isInvalidTypeValueError(stderr: string | null | undefined): boolean {
  if (!stderr) return false;
  return stderr.includes("invalid_argument_value") && stderr.includes("Invalid type value");
}

// ---------------------------------------------------------------------------
// Terminal-status closure — route `closed` transitions through `pm close`
// ---------------------------------------------------------------------------

// pm-cli >= 2026.8.3 enforces governance.require_close_reason on EVERY
// programmatic transition into `closed`: both `pm create --status closed` and
// `pm update <id> --status closed` are hard close_reason_required errors (the
// 2026.7.29 auto-route-to-close bypass, which invented the reason "Closed via
// pm update", is gone). The import paths below therefore never send a mapped
// `closed` status to create/update; they create/update the item in a
// non-terminal state and then close it via `pm close --reason`, carrying the
// source record's own closure evidence. `canceled` is not gated by the policy
// and keeps flowing through create/update --status unchanged.

/**
 * Derive the `pm close --reason` text for an imported bead whose mapped status
 * is `closed`. The reason must be real provenance, never invented closure
 * evidence: prefer the source record's own closure fields (`close_reason`,
 * then the foreign `resolution` / `state_reason` spellings); only when the
 * source genuinely recorded none, state the import provenance factually
 * ("Imported from Beads record <id> (source status: <raw>)"), naming the
 * source status exactly as the file carried it (e.g. `done`, `complete`).
 */
export function beadCloseReason(bead: BeadsItem, beadId: string | undefined): string {
  const own =
    scalarString(bead.close_reason) ??
    scalarString(bead.resolution) ??
    scalarString(bead.state_reason);
  if (own) return own;
  const source = beadId ?? scalarString(bead.title) ?? scalarString(bead.name);
  const which = source ? ` record ${source}` : "";
  const status = scalarString(bead.status) ?? "closed";
  return `Imported from Beads${which} (source status: ${status})`;
}

/**
 * Close an item the import just created or updated, via `pm close` — the only
 * sanctioned terminal transition under governance.require_close_reason. The
 * reason comes from {@link beadCloseReason}; when the source record carries a
 * completion timestamp (`closed_at`, or the foreign `completed_at` spelling),
 * it is passed as `--completed-at` so the imported item keeps its real
 * completion time instead of the import time. Throws on failure so the caller
 * counts the record as failed exactly like a failed create/update.
 */
function closeImportedItem(
  pmRoot: string,
  pmId: string,
  bead: BeadsItem,
  beadId: string | undefined,
): void {
  const closeArgs = [
    "--path", pmRoot,
    "--json",
    "close", pmId,
    "--reason", beadCloseReason(bead, beadId),
  ];
  const completedAt = normalizeIsoTimestamp(bead.closed_at ?? bead.completed_at);
  if (completedAt) closeArgs.push("--completed-at", completedAt);
  const close = spawnSync("pm", closeArgs, { encoding: "utf-8" });
  if (close.status !== 0) {
    throw new Error(close.stderr?.trim() || close.error?.message || "pm close failed");
  }
}

/**
 * A parsed Beads JSONL record as produced by `parseBeadsFile`. Malformed lines
 * are not dropped at parse time: they are substituted with an `__invalid`
 * sentinel so the import loop can count them as skipped (and report the same
 * record total the validator does) instead of silently shrinking the file.
 * The marker lives on the record type itself so the import filter can narrow
 * on it directly instead of casting through `any`.
 */
type ParsedBeadsRecord = BeadsItem & { __invalid?: boolean };

/**
 * Parse a Beads JSONL file into records, preserving malformed lines.
 *
 * Each non-blank line is JSON-parsed; an unparseable line is substituted with an
 * `{ __invalid: true }` sentinel rather than dropped, so the import loop can
 * count it as skipped and report the same record total the validator does.
 *
 * @param filePath - Path to the JSONL file (resolved to absolute).
 * @returns The parsed records, including `__invalid` sentinels.
 *
 * The fail-fast gate (`assertBeadsImportable`) rejects any file with an
 * invalid line before this parser runs, so the sentinel path is unreachable
 * through the CLI import command; the export exists so tests can drive the
 * parser's defensive behavior directly instead of leaving it dead and
 * uncovered.
 */
export function parseBeadsFile(filePath: string): ParsedBeadsRecord[] {
  const absolutePath = resolve(filePath);
  const raw = readFileOrThrow(absolutePath);
  const lines = raw.split("\n").filter((l) => l.trim());
  const items: ParsedBeadsRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      items.push(JSON.parse(lines[i]));
    } catch {
      console.error(`Line ${i + 1}: invalid JSON — skipping`);
      items.push({ __invalid: true });
    }
  }
  return items;
}

/**
 * An existing pm item the upsert path may target, keyed by its bead id.
 *
 * Carries the current status so an update can omit `--status` when it is
 * unchanged — re-sending a terminal status is rejected by the host.
 */
export interface ExistingBeadItem {
  /** The pm item id matched to the bead. */
  pmId: string;
  /** The item's current pm status, so the update can skip a no-op status write. */
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

// Read a Beads JSONL file and run the structural validator over it,
// cross-checking dependency edges against the workspace when a pm root is
// supplied. Returns the full ValidationReport (does NOT throw on errors) so
// both the fail-fast import gate and `--validate-only` can share it.
export async function readAndValidateBeads(filePath: string, pmRoot?: string): Promise<ValidationReport> {
  const absolutePath = resolve(filePath);
  const raw = readFileOrThrow(absolutePath);

  // Cross-check dependency edges against bead ids already in the workspace so
  // a reference that resolves at import time (a prior import) stays a warning,
  // not a hard error — same semantics as `pm beads validate`.
  // No catch here on purpose. readWorkspaceBeadIds already returns `undefined`
  // for the one case that legitimately degrades (no workspace at the path), so a
  // throw that reaches here is a real failure to read a workspace that exists.
  // Swallowing it would feed the import gate an empty cross-check set and reject
  // a valid file with a false `dangling_dependency`.
  const workspaceBeadIds = pmRoot ? await readWorkspaceBeadIds(pmRoot) : undefined;

  return validateBeadsText(raw, absolutePath, workspaceBeadIds);
}

// Fail-fast import gate: structurally validate the whole file (same rules as
// `pm beads validate`, including the workspace cross-check for dependency
// edges) and throw a CommandError BEFORE the import core writes anything.
// Lives in the import path itself — NOT on the single-winner preflight
// override surface — so it holds even when another package owns preflight.
export async function assertBeadsImportable(filePath: string, pmRoot?: string): Promise<void> {
  const absolutePath = resolve(filePath);
  const report = await readAndValidateBeads(filePath, pmRoot);
  const errors = report.issues.filter((i) => i.severity === "error");
  if (errors.length === 0) return;

  const detail = errors
    .slice(0, 10)
    .map((iss) => `  - line ${iss.line} [${iss.code}]: ${iss.message}`)
    .join("\n");
  const more = errors.length > 10 ? `\n  …and ${errors.length - 10} more error(s)` : "";
  throw new CommandError(
    `Beads JSONL validation failed for ${absolutePath} — ${errors.length} structural error(s); ` +
      `nothing was imported. Fix the file (or run \`pm beads validate <file>\`) and retry:\n${detail}${more}`,
    EXIT_CODE.GENERIC_FAILURE,
  );
}

// Run the import. Two passes so dependency edges can reference items created
// earlier in the same file: pass 1 creates (or, with --upsert, updates) every
// item and records bead-id → pm-id; pass 2 wires up the blocker edges via
// `pm update --dep` (with --replace-deps when upserting, so re-import does not
// accumulate duplicate edges).
async function runImport(filePath: string | undefined, pmRoot: string, opts: ImportOptions) {
  if (!filePath) {
    throw new CommandError(
      "Usage: pm beads import <file> [--dry-run] [--validate-only] [--upsert] [--merge-strategy update|skip|fail] " +
        '[--batch-size <n>] [--filter "type:Bug;status:open"] [--no-preserve-ids] [--type <type>] [--priority <n>]',
      EXIT_CODE.USAGE,
    );
  }

  // --validate-only: run the fail-fast gate, surface the report, then stop —
  // no parsing, no create/update, no dependency wiring. Behaves like
  // `pm beads validate` but is scoped to the import path so a CI job can gate
  // an import on a single command.
  if (opts.validateOnly) {
    const report = await readAndValidateBeads(filePath, pmRoot);
    const errors = report.issues.filter((i) => i.severity === "error").length;
    if (report.issues.length === 0) {
      console.error(`OK (validate-only): ${report.records} record(s), no issues.`);
    } else {
      for (const iss of report.issues) {
        const where = iss.line ? `line ${iss.line}` : "file";
        console.error(`  ${iss.severity.toUpperCase()} [${iss.code}] ${where}: ${iss.message}`);
      }
      const warns = report.issues.length - errors;
      console.error(`${report.records} record(s): ${errors} error(s), ${warns} warning(s).`);
    }
    if (!report.valid) {
      throw new CommandError(`Validation failed: ${errors} structural error(s).`, EXIT_CODE.GENERIC_FAILURE);
    }
    return { validateOnly: true, records: report.records, valid: true, issues: report.issues };
  }

  if (opts.upsert && !opts.preserveIds) {
    throw new CommandError(
      "--upsert requires preserved Beads ids (it keys on them); do not combine with --no-preserve-ids.",
      EXIT_CODE.USAGE,
    );
  }
  if (opts.mergeStrategy !== "update" && !opts.upsert) {
    throw new CommandError(
      "--merge-strategy only applies with --upsert (duplicate handling needs a key to match on).",
      EXIT_CODE.USAGE,
    );
  }

  // Authoritative fail-fast gate: abort on structural errors before ANY write.
  await assertBeadsImportable(filePath, pmRoot);

  const absolutePath = resolve(filePath);
  console.error(`Parsing Beads JSONL from: ${absolutePath}`);

  const parsed = parseBeadsFile(filePath);
  const records = parsed.filter((r) => !r.__invalid);
  let skipped = parsed.length - records.length;
  let failed = skipped;

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

  // `fail` is an all-or-nothing policy. Detect collisions with both the
  // workspace and earlier input rows before the create/update loop can write.
  if (opts.upsert && opts.mergeStrategy === "fail") {
    const inputKeys = new Map<string, number>();
    for (let i = 0; i < records.length; i++) {
      const item = records[i];
      const title = beadTitle(item);
      if (!title || (hasFilter && !beadPassesFilter(item, opts.typeOverride, opts.filter))) continue;

      const beadId = opts.preserveIds ? normalizeBeadKey(item.id) : undefined;
      const key = beadId;
      if (!key) continue;

      const existing = existingIndex.get(key);
      if (existing) {
        throw new CommandError(
          `merge-strategy "fail": bead "${beadId}" is already imported as ${existing.pmId}; aborting before any writes.`,
          EXIT_CODE.GENERIC_FAILURE,
        );
      }

      const firstRecord = inputKeys.get(key);
      if (firstRecord !== undefined) {
        throw new CommandError(
          `merge-strategy "fail": bead "${beadId}" appears more than once in the input ` +
            `(records ${firstRecord + 1} and ${i + 1}); aborting before any writes.`,
          EXIT_CODE.GENERIC_FAILURE,
        );
      }
      inputKeys.set(key, i);
    }
  }

  // --batch-size chunks the create/update pass into fixed-size groups so very
  // large imports report progress per batch (and so a caller can throttle).
  // Writes remain per-record (pm exposes no batch create), so batching is a
  // progress/throughput concern, not a transactional one. Unset = one batch.
  // parsed.length >= 1 here: an empty file returned above. records (parsed
  // rows minus __invalid sentinel rows) can still be empty when every row was
  // a sentinel, so the fallback below floors the batch size at 1 to keep the
  // batch arithmetic total — batchSize 0 would make batchCount NaN.
  const batchSize = opts.batchSize && opts.batchSize > 0 ? opts.batchSize : Math.max(1, records.length);
  const batchCount = Math.max(1, Math.ceil(records.length / batchSize));
  const multiBatch = batchCount > 1;

  // Reject an unencodable id BEFORE the first write, not when the loop reaches
  // it. Throwing mid-loop would leave a partial import: every record before the
  // bad one already created or updated, with no record of where it stopped.
  // This mirrors the structural fail-fast gate above, which exists for the same
  // reason - a rejection that can only happen after some writes is not a gate.
  if (opts.preserveIds) {
    // Only records this import would actually WRITE. The write loop skips a
    // record the filter excludes, so validating one would abort an import over
    // an id that was never going to be persisted - a gate stricter than the
    // operation it guards, which is its own kind of false refusal.
    const unencodable = records
      .map((item, index) => ({ line: index + 1, item, id: normalizeBeadKey(item.id) }))
      .filter((row) => !hasFilter || beadPassesFilter(row.item, opts.typeOverride, opts.filter))
      // A record the skip strategy matches to an existing item is not written
      // either, so it must not be validated. The gate has to mirror what the
      // loop writes exactly: every record it checks that the loop would leave
      // alone is a refusal of an import that would have succeeded.
      .filter((row) => !(opts.upsert && opts.mergeStrategy === "skip" && row.id !== undefined && existingIndex.has(row.id)))
      .filter((row) => row.id !== undefined && !isEncodableBeadId(row.id));
    if (unencodable.length > 0) {
      const detail = unencodable
        .slice(0, 5)
        .map((row) => `  record ${row.line}: id is ${row.id!.length} characters`)
        .join("\n");
      const more = unencodable.length > 5 ? `\n  ... and ${unencodable.length - 5} more` : "";
      throw new CommandError(
        `refusing to import: ${unencodable.length} record(s) carry an id the bead-id marker cannot read back, so the identity would be lost on export:\n${detail}${more}`,
        EXIT_CODE.USAGE,
      );
    }
  }

  for (let batchIdx = 0; batchIdx < batchCount; batchIdx++) {
    const batchStart = batchIdx * batchSize;
    const batchEnd = Math.min(batchStart + batchSize, records.length);
    if (multiBatch) {
      console.error(`Batch ${batchIdx + 1}/${batchCount}: records ${batchStart + 1}..${batchEnd}`);
    }
    for (let i = batchStart; i < batchEnd; i++) {
      const item = records[i];
      // No per-record title check here: the fail-fast gate above rejects any
      // record whose title AND name are blank (via the same beadTitle helper
      // used below) before a single write, so every record reaching this loop
      // has a usable title. The empty-string fallback inside the helper is
      // still required as defense in depth: a record that somehow reached this
      // loop unvalidated must degrade to "", never to the literal "undefined".
      const title = beadTitle(item);

      if (hasFilter && !beadPassesFilter(item, opts.typeOverride, opts.filter)) {
        filtered++;
        continue;
      }

      const type = opts.typeOverride || beadType(item) || "Task";
      const status = mapStatus(item.status);
      const priority = opts.priorityOverride || mapPriority(item.priority);
      const labels = beadLabels(item);
      const tags = opts.tagsOverride
        ? opts.tagsOverride
        : labels.length
          ? labels.join(",")
          : undefined;
      const beadId = opts.preserveIds ? normalizeBeadKey(item.id) : undefined;
      const baseDescription = (item.description as string) || title;
      const blockers = extractBlockerIds(item);
      const key = beadId;
      const existing = opts.upsert && key ? existingIndex.get(key) : undefined;
      const existingPmId = existing?.pmId;
      const matched = Boolean(existingPmId);

      if (opts.dryRun) {
        let action: string;
        if (matched) {
          action = opts.mergeStrategy === "skip" ? "skip" : "update";
        } else {
          action = "create";
        }
        console.error(
          `  [dry-run] ${action} ${title} (${type}, ${status}${beadId ? `, bead_id=${beadId}` : ""}` +
            `${blockers.length ? `, blocked_by=${blockers.join(",")}` : ""})`,
        );
        if (action === "skip") {
          skipped++;
          if (beadId) beadToPm.set(beadId, existingPmId!);
        } else if (action === "update") updated++;
        else imported++;
        continue;
      }

      // --merge-strategy skip: leave the existing item untouched. We still
      // record its pm id so a later record in the same file (or the dependency
      // pass) referencing this bead id resolves to the right item.
      if (matched && opts.mergeStrategy === "skip") {
        if (beadId) beadToPm.set(beadId, existingPmId!);
        console.error(`  skip: bead "${beadId}" already imported as ${existingPmId} (merge-strategy skip)`);
        skipped++;
        continue;
      }

      // Encoded here rather than above, so a record this loop is about to skip
      // never encodes at all. `encodeBeadId` refuses an id the marker cannot
      // read back, and refusing on behalf of a record that is not being written
      // would abort an import that had nothing to lose - which is the same
      // scope mismatch the pre-write gate was corrected for.
      const description = encodeBeadId(baseDescription, beadId);

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
          // `closed` is gated by governance.require_close_reason (pm-cli
          // >= 2026.8.3): `pm update --status closed` hard-errors with
          // close_reason_required. Route it through `pm close` after the
          // update instead. `canceled` is not gated and still flows through
          // --status. For a non-closed status that differs, send --status;
          // when unchanged, omit it to keep re-import idempotent.
          const routeCloseUpdate = status === "closed";
          if (!routeCloseUpdate && status !== existing?.status) {
            updArgs.push("--status", status);
          }
          if (priority) updArgs.push("--priority", priority);
          if (tags) updArgs.push("--tags", tags); // --tags replaces; idempotent re-import
          appendPlanningArgs(updArgs, item);
          let result = spawnSync("pm", updArgs, { encoding: "utf-8" });
          // `pm create` maps synonym types (bug -> Issue, story -> Feature, ...)
          // through its fallback table, but `pm update` validates types strictly.
          // A bead whose issue_type is such a synonym imports fine on create yet
          // fails on upsert re-import. Retry once without --type: the matched
          // item already carries the canonical type the original create resolved,
          // so dropping the flag preserves it instead of failing the whole record.
          if (result.status !== 0 && isInvalidTypeValueError(result.stderr)) {
            const typeFlag = updArgs.indexOf("--type");
            const retryArgs = [...updArgs.slice(0, typeFlag), ...updArgs.slice(typeFlag + 2)];
            console.error(
              `  note: pm update rejected type "${type}" for ${existingPmId}; retrying without --type (existing type preserved)`,
            );
            result = spawnSync("pm", retryArgs, { encoding: "utf-8" });
          }
          if (result.status !== 0) {
            throw new Error(result.stderr?.trim() || result.error?.message || "pm update failed");
          }
          pmId = existingPmId;
          // Apply the terminal `closed` transition via `pm close` (the only
          // sanctioned path under require_close_reason). Skip it when the
          // item is already closed so a re-import stays idempotent and does
          // not append a second bogus close.
          if (routeCloseUpdate && existing?.status !== "closed") {
            closeImportedItem(pmRoot, pmId, item, beadId);
          }
          updated++;
          if (key) existingIndex.set(key, { pmId, status });
        } else {
          // `closed` cannot be sent to `pm create` (close_reason_required
          // under pm-cli >= 2026.8.3); create in the default non-terminal
          // `open` state and route the terminal transition through `pm close`.
          const routeCloseCreate = status === "closed";
          const spawnArgs = [
            "--path", pmRoot,
            "--json",
            "create",
            "--title", title,
            "--type", type,
            "--status", routeCloseCreate ? "open" : status,
            "--description", description,
          ];
          if (priority) spawnArgs.push("--priority", priority);
          if (tags) spawnArgs.push("--tags", tags);
          appendPlanningArgs(spawnArgs, item);

          const result = spawnSync("pm", spawnArgs, { encoding: "utf-8" });
          if (result.status !== 0) {
            throw new Error(result.stderr?.trim() || result.error?.message || "pm create failed");
          }
          const created = extractCreatedId(result.stdout);
          if (!created) throw new Error("could not determine created pm id");
          pmId = created;
          if (routeCloseCreate) {
            closeImportedItem(pmRoot, pmId, item, beadId);
          }
          // Record so a later record in the same file can upsert onto it too.
          if (key) existingIndex.set(key, { pmId, status });
          imported++;
        }
        if (beadId) beadToPm.set(beadId, pmId);
        touched.push({ beadId, pmId, blockers, upserted: Boolean(existingPmId), bead: item });
      } catch (err: unknown) {
        const msg = errorMessage(err);
        console.error(`Record ${i + 1}: ${existingPmId ? "update" : "create"} failed — ${msg}`);
        // A matched item still EXISTS even when its update failed. Record the
        // bead id -> pm id mapping anyway so other records' dependency edges to
        // it keep resolving — otherwise the --replace-deps pass would silently
        // strip every edge pointing at this bead from the updated items.
        if (existingPmId && beadId) beadToPm.set(beadId, existingPmId);
        skipped++;
        failed++;
      }
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
  const batchNote = opts.batchSize && opts.batchSize > 0 ? `, batches ${batchCount}` : "";

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
      ...(opts.batchSize && opts.batchSize > 0 ? { batches: batchCount } : {}),
    };
  }

  if (imported === 0 && updated === 0 && failed > 0) {
    throw new CommandError(`No items imported — all ${failed} attempted record(s) failed.`);
  }

  console.error(
    `Imported ${imported}, updated ${updated}, skipped ${skipped}${filteredNote}, ` +
      `linked ${edges} dependency edge(s), set ${parents} parent link(s)` +
      `${opts.preserveTimestamps ? `, timestamped ${timestamped}` : ""}${batchNote}.`,
  );
  return {
    imported,
    updated,
    skipped,
    dependencies: edges,
    parents,
    ...(opts.preserveTimestamps ? { timestamped } : {}),
    ...(hasFilter ? { filtered } : {}),
    ...(opts.batchSize && opts.batchSize > 0 ? { batches: batchCount } : {}),
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

// Node's spawnSync defaults to a 1 MiB stdout cap, which a mature tracker's JSON
// dump passes at a few hundred items. Past that the child is killed with ENOBUFS,
// status null and EMPTY stderr, so the failure surfaces with nothing to diagnose
// (and at larger sizes stdout is genuinely truncated mid-document).
// 64 MiB matches the cap the sibling pm packages settled on.
/** Read-buffer cap for `pm` output, in bytes. 64 MiB by default; override with the
 * `PM_JSON_MAX_BUFFER` env var. Resolved per call so the override takes effect
 * without an import-order dependency. Invalid or non-positive values fall back to
 * the default rather than silently disabling the guard. */
function pmJsonMaxBuffer(): number {
  // Number(), not parseInt(): parseInt("64MiB") silently yields 64, which would
  // impose a 64-BYTE cap and break every ordinary read while appearing to honor
  // the documented invalid-value fallback. Number() rejects the whole string.
  const raw = Number(process.env.PM_JSON_MAX_BUFFER);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 64 * 1024 * 1024;
}

/** Name the real cause of a failed `pm` read. A stdout overrun kills the child
 * with `status: null` and EMPTY stderr, so without this the failure surfaces as
 * an unexplained error (or, worse, as an empty result set). */
function describePmReadFailure(error: Error, limitBytes: number): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOBUFS") {
    return `pm output exceeded the ${limitBytes} byte read buffer. `
      + "The workspace is larger than this integration's read limit; narrow the "
      + "operation or raise PM_JSON_MAX_BUFFER.";
  }
  return `pm read failed: ${error.message}`;
}

/** Subset of the `pm list --all --json` envelope the completeness gate reads.
 *
 * `items` is typed as unknown rows because the subprocess boundary is untrusted;
 * the fields below it are canonical completeness receipts whose signals this
 * package refuses to consume silently. */
export interface ListAllEnvelope {
  /** Rows the CLI actually returned. Length can be less than {@link ListAllEnvelope.total}. */
  items?: unknown[];
  /** Number of rows in `items` as reported by the CLI. */
  count?: number;
  /** Number of rows that exist in the workspace. */
  total?: number;
  /** True when the row list was cut short (output budget, `--limit`, cursor). */
  truncated?: boolean;
  /** True when more rows exist past a cursor boundary. */
  has_more?: boolean;
  /** Continuation cursor; a complete unpaged response has none. */
  next_cursor?: unknown;
  /** Readability receipt for the directories/items backing the list. */
  completeness?: {
    status?: string;
    unreadable_item_count?: number;
    unreadable_directory_count?: number;
  };
  /** Receipt for field groups omitted from the projection. */
  omission_receipt?: {
    has_omissions?: boolean;
    omitted_field_group_count?: number;
    omitted_field_groups?: unknown[];
  };
  /** Projection receipt proving the requested complete row shape. */
  projection?: { mode?: unknown };
  /** Universal output receipt proving the host did not compact the response. */
  read_output?: {
    contract_version?: unknown;
    command?: unknown;
    requested_dimensions?: unknown;
    within_budget?: unknown;
    strings_compacted?: unknown;
    rows_compacted?: unknown;
    result_omitted?: unknown;
  };
  /** Budget truncation disclosure, which must be absent for this consumer. */
  output_budget_truncation?: unknown;
  /** Budget omission disclosure, which must be absent for this consumer. */
  output_budget_exceeded?: unknown;
}

/**
 * Refuse an incomplete `pm list --all` envelope instead of consuming it.
 *
 * Reads `.items` without consulting the envelope's completeness receipt is how
 * this package once shipped a 10-item "successful" export from a 682-item
 * workspace: pm 2026.8.14 defaulted to a truncated list and nothing here
 * checked. The envelope carries independent incompleteness
 * signals, and any one of them means the rows in `items` are NOT the whole
 * workspace — so this throws (never returns a partial list, never logs and
 * continues) naming the signal that tripped plus the `count`/`total` figures:
 *
 * - pagination and count receipts prove every row is present exactly once;
 * - completeness receipts prove no item or directory was unreadable;
 * - projection and omission receipts prove every requested field is present;
 * - output receipts prove the response was not budget-compacted or omitted.
 *
 * Thrown errors are {@link CommandError} so pm's runtime turns them into a
 * clean nonzero exit. Paging is deliberately NOT attempted: this package has
 * no legitimate use for a partial page, so refusing loudly is both simpler and
 * safer than a paging loop that could itself silently drop rows.
 *
 * @param envelope - Parsed `pm list --all --json` output (any shape; non-envelope
 *                  input trips the completeness signal).
 * @throws {@link CommandError} naming the first tripped signal and the counts.
 */
export function assertListAllComplete(envelope: unknown): void {
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    throw new IncompleteWorkspaceReadError(
      "Refusing unverifiable `pm list --all` answer: the response must be a top-level object with completeness receipts.",
    );
  }
  const env = envelope as ListAllEnvelope;
  const count = env.count;
  const total = env.total;
  const counts = `count ${count} of total ${total}`;
  if (env.truncated !== false) {
    throw new IncompleteWorkspaceReadError(
      `Refusing incomplete \`pm list --all\` answer: truncated=${JSON.stringify(env.truncated) ?? "(missing)"} (${counts}). `
      + "The item list was cut short (output budget or limit); a partial export "
      + "would report success while missing items. Narrow the operation or "
      + "raise the output budget, then retry.",
    );
  }
  if (env.has_more !== false) {
    throw new IncompleteWorkspaceReadError(
      `Refusing incomplete \`pm list --all\` answer: has_more=${JSON.stringify(env.has_more) ?? "(missing)"} (${counts}). `
      + "Rows exist beyond the returned page; consuming the page as the whole "
      + "workspace would silently drop them.",
    );
  }
  if (env.next_cursor !== null) {
    throw new IncompleteWorkspaceReadError(
      `Refusing unverifiable \`pm list --all\` answer: next_cursor must be exactly null; received ${JSON.stringify(env.next_cursor) ?? "(missing)"}.`,
    );
  }
  if (env.completeness?.status !== "complete") {
    const status = env.completeness?.status === undefined ? "(missing)" : JSON.stringify(env.completeness.status);
    const unreadable = `unreadable_item_count=${env.completeness?.unreadable_item_count ?? 0}`
      + `, unreadable_directory_count=${env.completeness?.unreadable_directory_count ?? 0}`;
    throw new IncompleteWorkspaceReadError(
      `Refusing incomplete \`pm list --all\` answer: completeness.status=${status} `
      + `(${unreadable}; ${counts}). Some workspace items could not be read, so `
      + "the returned list is not the whole workspace.",
    );
  }
  if (env.completeness.unreadable_item_count !== 0) {
    throw new IncompleteWorkspaceReadError(
      "Refusing unverifiable `pm list --all` answer: completeness.unreadable_item_count must be exactly 0.",
    );
  }
  if (env.completeness.unreadable_directory_count !== 0) {
    throw new IncompleteWorkspaceReadError(
      "Refusing unverifiable `pm list --all` answer: completeness.unreadable_directory_count must be exactly 0.",
    );
  }
  if (typeof env.omission_receipt !== "object" || env.omission_receipt === null) {
    throw new IncompleteWorkspaceReadError(
      `Refusing unverifiable \`pm list --all\` answer: omission_receipt must be an object (${counts}).`,
    );
  }
  if (env.omission_receipt.has_omissions !== false) {
    const groups = Array.isArray(env.omission_receipt.omitted_field_groups)
      ? env.omission_receipt.omitted_field_groups.map(String)
      : [];
    throw new IncompleteWorkspaceReadError(
      `Refusing unverifiable \`pm list --all\` answer: omission_receipt.has_omissions must be exactly false; `
      + `received ${JSON.stringify(env.omission_receipt.has_omissions) ?? "(missing)"}; `
      + `omitted_field_groups: ${groups.length ? groups.join(", ") : "(none listed)"} (${counts}). `
      + "Field groups were dropped from the projection, so the rows are present "
      + "but degraded; re-read without the field-omitting options.",
    );
  }
  if (env.omission_receipt.omitted_field_group_count !== 0) {
    throw new IncompleteWorkspaceReadError(
      "Refusing unverifiable `pm list --all` answer: omission_receipt.omitted_field_group_count must be exactly 0.",
    );
  }
  if (!Array.isArray(env.omission_receipt.omitted_field_groups)
    || env.omission_receipt.omitted_field_groups.length !== 0) {
    throw new IncompleteWorkspaceReadError(
      "Refusing unverifiable `pm list --all` answer: omission_receipt.omitted_field_groups must be an empty array.",
    );
  }
  if (env.projection?.mode !== "full") {
    throw new IncompleteWorkspaceReadError(
      `Refusing unverifiable \`pm list --all\` answer: projection.mode must be exactly full; received ${JSON.stringify(env.projection?.mode) ?? "(missing)"}.`,
    );
  }
  if (env.read_output?.contract_version !== 1) {
    throw new IncompleteWorkspaceReadError(
      "Refusing unverifiable `pm list --all` answer: read_output.contract_version must be exactly 1.",
    );
  }
  if (env.read_output.command !== "list") {
    throw new IncompleteWorkspaceReadError(
      "Refusing unverifiable `pm list --all` answer: read_output.command must be exactly list.",
    );
  }
  if (env.read_output.within_budget !== true) {
    throw new IncompleteWorkspaceReadError(
      "Refusing unverifiable `pm list --all` answer: read_output.within_budget must be exactly true.",
    );
  }
  for (const field of ["strings_compacted", "rows_compacted", "result_omitted"] as const) {
    if (env.read_output[field] !== false) {
      throw new IncompleteWorkspaceReadError(
        `Refusing unverifiable \`pm list --all\` answer: read_output.${field} must be exactly false.`,
      );
    }
  }
  const requestedDimensions = env.read_output.requested_dimensions;
  if (!Array.isArray(requestedDimensions)
    || !["include", "amount", "cost"].every((dimension) => requestedDimensions.includes(dimension))) {
    throw new IncompleteWorkspaceReadError(
      "Refusing unverifiable `pm list --all` answer: read_output.requested_dimensions must include include, amount, and cost.",
    );
  }
  if ("output_budget_truncation" in env || "output_budget_exceeded" in env) {
    throw new IncompleteWorkspaceReadError(
      "Refusing unverifiable `pm list --all` answer: a budget truncation or omission disclosure was present.",
    );
  }
  if (!Number.isSafeInteger(count) || (count as number) < 0) {
    throw new IncompleteWorkspaceReadError(
      `Refusing unverifiable \`pm list --all\` answer: count must be a non-negative safe integer; received ${JSON.stringify(count) ?? "(missing)"}.`,
    );
  }
  if (!Number.isSafeInteger(total) || (total as number) < 0) {
    throw new IncompleteWorkspaceReadError(
      `Refusing unverifiable \`pm list --all\` answer: total must be a non-negative safe integer; received ${JSON.stringify(total) ?? "(missing)"}.`,
    );
  }
  if (!Array.isArray(env.items)) {
    throw new IncompleteWorkspaceReadError(
      "Refusing unverifiable `pm list --all` answer: envelope `items` is not an array.",
    );
  }
  if (count !== total) {
    throw new IncompleteWorkspaceReadError(`Refusing incomplete \`pm list --all\` answer: count ${count} must equal total ${total}.`);
  }
  if (env.items.length !== count) {
    throw new IncompleteWorkspaceReadError(`Refusing unverifiable \`pm list --all\` answer: items.length ${env.items.length} must equal count ${count}.`);
  }
  const ids = new Set<string>();
  for (const [index, item] of env.items.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new IncompleteWorkspaceReadError(`Refusing unverifiable \`pm list --all\` answer: item ${index} must be an object.`);
    }
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new IncompleteWorkspaceReadError(`Refusing unverifiable \`pm list --all\` answer: item ${index} must have a non-empty id.`);
    }
    if (ids.has(id)) throw new IncompleteWorkspaceReadError(`Refusing unverifiable \`pm list --all\` answer: duplicate item id ${id}.`);
    ids.add(id);
  }
}

/** Minimal spawn result the list-all seam needs (subset of spawnSync's). */
export interface PmListAllSpawnResult {
  /** Child exit status; `null` when the child was killed (e.g. ENOBUFS). */
  status: number | null;
  /** Decoded stdout of the `pm` child; empty when the child wrote nothing or never started. */
  stdout: string;
  /** Decoded stderr of the `pm` child; empty when the child wrote nothing or never started. */
  stderr: string;
  /** Spawn error (ENOENT, ENOBUFS and friends), when one occurred. */
  error?: Error;
}

/**
 * Injectable seam over the `pm list --all` shell-out inside {@link readPmItems}.
 *
 * A parameter defaulting to the real {@link spawnPmListAll}, so production
 * callers are unchanged while tests can substitute a canned envelope —
 * captured from the real CLI and mutated — instead of mocking child_process.
 */
export type PmListAllSpawn = (args: string[], maxBuffer: number) => PmListAllSpawnResult;

/** Real {@link PmListAllSpawn} over `child_process.spawnSync`, forwarding the
 * read-buffer cap so a large workspace cannot die as an unattributable
 * null-status/empty-stderr spawn. Default seam for {@link readPmItems}.
 * Exported for tests: the ENOENT normalisation arms are unreachable through
 * the injected-seam tests, which never touch the real spawn. */
export function spawnPmListAll(args: string[], maxBuffer: number): PmListAllSpawnResult {
  const result = spawnSync("pm", args, { encoding: "utf-8", maxBuffer });
  // With `encoding: "utf-8"`, spawnSync reports stdout/stderr as decoded
  // strings — but a failed start (ENOENT and friends) leaves them `undefined`
  // at runtime even though TypeScript's overload types say `string`. The seam
  // normalises both to the empty string so its declared contract holds for
  // every spawn outcome; consumers already treat empty as no output.
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

/**
 * Read every pm item in a workspace via `pm list --all --json`.
 *
 * Returns the envelope's `items` ONLY after {@link assertListAllComplete}
 * verifies the completeness receipt, so a truncated, paged, partially-read or
 * field-omitted answer throws instead of yielding a silent partial list — the
 * exact 2026.8.14 failure mode this package refuses to reintroduce.
 *
 * @param pmRoot - Tracker storage path passed to `pm --path`.
 * @param spawn - Injectable shell-out seam (tests substitute a canned real
 *               envelope); defaults to the real {@link spawnPmListAll}.
 */
function readPmItems(pmRoot: string, spawn: PmListAllSpawn = spawnPmListAll): PmItem[] {
  const maxBuffer = pmJsonMaxBuffer();
  // A full projection preserves descriptions, tags and dependency edges.
  //
  // Both host bounds are explicitly unbounded. A ceiling would be self-defeating:
  // the completeness gate below refuses a
  // truncated envelope, so a hardcoded ceiling turns every workspace past that
  // size into a hard refusal of export, workspace diff and `--upsert` rather
  // than into a larger read. `opts.filter` is applied after this call, so the
  // ceiling would bound the rows read, not the rows kept.
  const result = spawn(
    ["--path", pmRoot, "list", "--all", "--json", "--output-budget", "unbounded", "--output-limit", "unbounded", "--output-include", "full"],
    maxBuffer,
  );
  if (result.error) {
    throw new CommandError(describePmReadFailure(result.error, maxBuffer));
  }
  if (result.status !== 0) {
    throw new CommandError(result.stderr || "pm list failed");
  }
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    assertListAllComplete(parsed);
    // A complete receipt with a missing/non-array `items` would otherwise flow
    // through as a successful zero-item export (or crash downstream with an
    // unclassified TypeError) — the same silent-partial failure this gate
    // exists to prevent, so classify and refuse it here.
    return (parsed as ListAllEnvelope).items as PmItem[];
  } catch (err) {
    if (err instanceof CommandError) throw err;
    throw new CommandError("Could not parse `pm list --all --json` output.");
  }
}

/**
 * Convert one pm item into a Beads record.
 *
 * Preserves the original bead id (when known and requested) and re-emits
 * blocker edges as a Beads `dependencies` array keyed on native bead ids.
 */
export function pmItemToBead(item: PmItem, pmToBead: Map<string, string>, preserveIds: boolean): BeadsItem {
  const beadId = preserveIds ? decodeBeadId(item) : undefined;
  const id = beadId || item.id;

  const blockers: Array<{ issue_id: string; depends_on_id: string; type: string }> = [];
  if (Array.isArray(item.dependencies)) {
    for (const dep of item.dependencies) {
      if (!dep?.id) continue;
      if ((dep.kind || "blocked_by").toLowerCase() !== "blocked_by") continue;
      // Translate the upstream pm id back to its bead id when we know it.
      const upstream = pmToBead.get(dep.id) || dep.id;
      if (id) blockers.push({ issue_id: id, depends_on_id: upstream, type: "blocks" });
    }
  }

  const bead: BeadsItem = {
    id,
    title: item.title ?? "(untitled)",
    description: stripBeadIdMarker(item.description),
    status: pmStatusToBeads(item.status),
    issue_type: String(item.type ?? "Task").trim().toLowerCase(),
  };
  if (item.priority !== undefined && item.priority !== null) bead.priority = Number(item.priority);
  if (Array.isArray(item.tags) && item.tags.length) bead.labels = item.tags;
  if (item.assignee) {
    bead.assignee = item.assignee;
    bead.owner = item.assignee;
  }
  if (item.parent) bead.parent = pmToBead.get(item.parent) ?? item.parent;
  if (item.deadline ?? item.due_date) bead.deadline = item.deadline ?? item.due_date;
  if (item.sprint) bead.sprint = item.sprint;
  if (item.release) bead.release = item.release;
  if (item.created_at) bead.created_at = item.created_at;
  if (item.updated_at) bead.updated_at = item.updated_at;
  if (blockers.length) bead.dependencies = blockers;
  return bead;
}

/**
 * Serialize the current pm workspace into Beads records IN MEMORY.
 *
 * Applies the same id-preservation, dependency translation and row filtering
 * the on-disk exporter uses. Extracted from `runExport` so the diff command
 * can compare a file against the live workspace without writing to stdout/a
 * file or duplicating any mapping logic.
 *
 * @param spawn - Injectable shell-out seam over the `pm list --all` read (tests
 *                substitute a canned real envelope); defaults to the real
 *                {@link spawnPmListAll}.
 */
export function buildBeadsFromWorkspace(
  pmRoot: string,
  opts: { preserveIds: boolean; filter: RowFilter },
  spawn: PmListAllSpawn = spawnPmListAll,
): BeadsItem[] {
  const allItems = readPmItems(pmRoot, spawn);
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

/**
 * Run the `beads export` pipeline: read the whole workspace, serialize it to
 * Beads JSONL, and emit to stdout or `--output` (or just report counts under
 * `--dry-run`). Delegates the workspace read to {@link buildBeadsFromWorkspace},
 * so an incomplete `list --all` answer refuses here before any bytes are written.
 */
function runExport(pmRoot: string, opts: { dryRun: boolean; preserveIds: boolean; output?: string; filter: RowFilter }) {
  const beads = buildBeadsFromWorkspace(pmRoot, { preserveIds: opts.preserveIds, filter: opts.filter });
  const jsonl = beads.map((b) => JSON.stringify(b)).join("\n") + (beads.length ? "\n" : "");

  // --dry-run: serialize the workspace to Beads in memory (so the filter and
  // id-preservation logic still run) but write NEITHER to a file NOR to stdout,
  // reporting the count that would be exported. Symmetric with import --dry-run.
  if (opts.dryRun) {
    console.error(`[dry-run] Would export ${beads.length} item(s) as Beads JSONL${opts.output ? ` to ${resolve(opts.output)}` : " to stdout"}.`);
    return { dryRun: true, wouldExport: beads.length, ...(opts.output ? { output: resolve(opts.output) } : {}) };
  }

  if (opts.output) {
    const absolute = resolve(opts.output);
    try {
      writeFileSync(absolute, jsonl, "utf-8");
    } catch (err: unknown) {
      const msg = errorMessage(err);
      throw new CommandError(`Failed to write ${absolute}: ${msg}`);
    }
    console.error(`Exported ${beads.length} item(s) to ${absolute}.`);
    return { exported: beads.length, output: absolute };
  }

  if (jsonl) process.stdout.write(jsonl);
  console.error(`Exported ${beads.length} item(s) as Beads JSONL.`);
  // Direct stdout is already the command's machine-readable result. Tell the
  // host not to render a second payload after the JSONL stream.
  return suppressHostOutput();
}

// ---------------------------------------------------------------------------
// Diff core — audit round-trip fidelity between two Beads sources
// ---------------------------------------------------------------------------

/**
 * The set of bead fields the diff classifier compares, in display order.
 *
 * These are exactly the fields a `pm beads import` → `pm beads export` cycle
 * is meant to preserve, so a drift in any of them flags a round-trip
 * fidelity loss.
 */
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

/** A Beads record field that the diff compares between two files. */
export type DiffField = (typeof DIFF_FIELDS)[number];

/**
 * One bead id whose compared fields differ between two files.
 */
export interface ChangedBead {
  /** The differing bead id. */
  id: string;
  /** Which compared fields differ between A and B. */
  fields: DiffField[];
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
      return pmStatusToBeads(mapStatus(bead.status));
    case "type":
      return String(beadType(bead) ?? "Task").trim().toLowerCase();
    case "priority": {
      const p = mapPriority(bead.priority);
      return p === undefined ? "2" : p;
    }
    case "tags": {
      const tags = beadLabels(bead);
      // Order-insensitive: tag order is not semantically meaningful.
      return [...new Set(tags)].sort().join(",");
    }
    case "assignee":
      return beadAssignee(bead) ?? "";
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
    default: {
      const exhaustive: never = field;
      return exhaustive;
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
  const raw = readFileOrThrow(absolutePath);
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
function runDiff(args: string[], opts: DiffOptions) {
  // ctx.args can carry flag tokens (e.g. boolean flags like --against-workspace)
  // alongside the positional file paths, so extract the positionals explicitly
  // rather than indexing raw args — mirrors resolveImportInputFile.
  const files = args.filter((a) => a.length > 0 && !a.startsWith("-"));
  const fileA = files[0];
  if (!fileA) {
    throw new CommandError(
      'Usage: pm beads diff <fileA> <fileB> | pm beads diff <file> --against-workspace [--json] [--strict] [--filter "type:Bug;status:open"] [--filter-status <list>] [--filter-type <list>]',
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

// Flag contracts. `value_type` is the canonical FlagDefinition coercion kind
// (SDK 2026.6.10 unified `type`/`value_type`; older hosts read either).
// `--priority` deliberately stays a string flag: the override is forwarded
// verbatim to `pm create/update --priority`, which does its own validation.
const IMPORT_FLAGS: FlagDefinition[] = [
  { long: "--dry-run", value_type: "boolean", description: "Preview create/update/skip counts without writing" },
  { long: "--validate-only", value_type: "boolean", description: "Validate the input file then exit without importing (like `pm beads validate`, scoped to import)" },
  { long: "--upsert", value_type: "boolean", description: "Update existing items matched by their Beads id instead of creating duplicates" },
  { long: "--merge-strategy", value_name: "strategy", value_type: "string", description: "How --upsert handles a duplicate bead id: update (default) | skip | fail" },
  { long: "--batch-size", value_name: "n", value_type: "string", description: "Process the create/update pass in batches of n records (progress reporting)" },
  { long: "--filter", value_name: "expr", value_type: "string", description: "Combined row filter, e.g. `type:Bug,Feature;status:open,in_progress` (merged with --filter-status/--filter-type)" },
  { long: "--no-preserve-ids", value_type: "boolean", description: "Do not persist the original Beads id (default: preserve)" },
  { long: "--no-preserve-timestamps", value_type: "boolean", description: "Do not carry over bead created_at/updated_at (default: preserve)" },
  { long: "--type", value_name: "type", value_type: "string", description: "Override item type for all imported items" },
  { long: "--priority", value_name: "n", value_type: "string", description: "Override priority (0-4) for all items" },
  { long: "--tags", value_name: "tags", value_type: "string", description: "Comma-separated tags to add to all items" },
  { long: "--filter-status", value_name: "list", value_type: "string", description: "Only import beads whose mapped status is in this comma-separated list" },
  { long: "--filter-type", value_name: "list", value_type: "string", description: "Only import beads whose type is in this comma-separated list" },
];

const EXPORT_FLAGS: FlagDefinition[] = [
  { long: "--output", short: "-o", value_name: "file", value_type: "string", description: "Write JSONL to a file instead of stdout" },
  { long: "--dry-run", value_type: "boolean", description: "Preview the export count without writing to a file or stdout" },
  { long: "--no-preserve-ids", value_type: "boolean", description: "Emit pm ids instead of the original Beads ids (default: preserve)" },
  { long: "--filter", value_name: "expr", value_type: "string", description: "Combined row filter, e.g. `type:Bug,Feature;status:open,in_progress` (merged with --filter-status/--filter-type)" },
  { long: "--filter-status", value_name: "list", value_type: "string", description: "Only export items whose Beads status is in this comma-separated list" },
  { long: "--filter-type", value_name: "list", value_type: "string", description: "Only export items whose type is in this comma-separated list" },
];

const VALIDATE_FLAGS: FlagDefinition[] = [
  // `--json` is a host-owned global flag: extensions must not redeclare it
  // (the host rejects the registration) and must read it from ctx.global.
  { long: "--no-workspace", value_type: "boolean", description: "Skip cross-checking dependency references against the current pm workspace" },
];

const DIFF_FLAGS: FlagDefinition[] = [
  { long: "--against-workspace", value_type: "boolean", description: "Diff <file> against the current pm workspace (exported to Beads in-memory) instead of a second file" },
  // `--json` is a host-owned global flag: extensions must not redeclare it
  // (the host rejects the registration) and must read it from ctx.global.
  { long: "--strict", value_type: "boolean", description: "Exit nonzero when any drift (added/removed/changed) is found — for CI fidelity gates" },
  { long: "--no-preserve-ids", value_type: "boolean", description: "When diffing against the workspace, key on pm ids instead of the original Beads ids (default: preserve)" },
  { long: "--filter", value_name: "expr", value_type: "string", description: "Combined row filter, e.g. `type:Bug,Feature;status:open,in_progress` (merged with --filter-status/--filter-type)" },
  { long: "--filter-status", value_name: "list", value_type: "string", description: "Only compare beads whose mapped status is in this comma-separated list" },
  { long: "--filter-type", value_name: "list", value_type: "string", description: "Only compare beads whose type is in this comma-separated list" },
];

// Read the --filter-status / --filter-type pair into a RowFilter, honoring both
// the kebab-case flag and the camelCase key the runtime normalizes it to.
// Parse the combined `--filter` expression into a RowFilter. The grammar is a
// semicolon-separated list of `dimension:values` clauses, where each values
// list is comma-separated, e.g. `type:Bug,Feature;status:open,in_progress`.
// Unknown dimensions are ignored (forward-compatible). Returns an empty filter
// (no dimensions set) for an unset or blank expression.
/**
 * Parse a combined `--filter` expression into a {@link RowFilter}.
 *
 * Accepts semicolon-separated `dimension:csv` clauses (e.g.
 * `type:Bug,Feature;status:open,in_progress`); unknown dimensions are ignored
 * for forward compatibility. Returns an empty filter for an unset/blank input.
 *
 * @param raw - The raw filter expression string.
 * @returns The resolved row filter.
 */
export function parseFilterExpression(raw: string | undefined): RowFilter {
  const filter: RowFilter = { statuses: undefined, types: undefined };
  if (!raw) return filter;
  for (const clause of raw.split(";")) {
    const dim = clause.split(":");
    if (dim.length < 2) continue;
    const key = dim[0].trim().toLowerCase();
    const values = dim.slice(1).join(":"); // tolerate ids containing ':'
    const set = parseFilterCsv(values);
    if (!set) continue;
    if (key === "status" || key === "statuses") filter.statuses = set;
    else if (key === "type" || key === "types") filter.types = set;
    // Unknown dimensions are ignored so future clauses do not break older hosts.
  }
  return filter;
}

/**
 * Merge two row filters, with `override` winning per dimension.
 *
 * Used to combine the combined `--filter` expression with the granular
 * `--filter-status`/`--filter-type` flags: a granular dimension overrides the
 * combined form for that dimension only.
 *
 * @param base - The base filter (the combined `--filter` value).
 * @param override - The override filter (the granular flags).
 * @returns The merged filter.
 */
export function mergeRowFilters(base: RowFilter, override: RowFilter): RowFilter {
  return {
    statuses: override.statuses ?? base.statuses,
    types: override.types ?? base.types,
  };
}

/**
 * Resolve a {@link RowFilter} from the export/import options bag.
 *
 * Combines the granular `--filter-status`/`--filter-type` flags with the
 * combined `--filter` expression (granular wins per dimension).
 *
 * @param options - The raw option object from the command handler.
 * @returns The resolved row filter.
 */
export function parseRowFilter(options: Record<string, unknown>): RowFilter {
  const granular = {
    statuses: parseFilterCsv(optionString(options, "filter-status", "filterStatus")),
    types: parseFilterCsv(optionString(options, "filter-type", "filterType")),
  };
  const combined = parseFilterExpression(optionString(options, "filter"));
  return mergeRowFilters(combined, granular);
}

/**
 * Parse `--merge-strategy`, defaulting to `update`.
 *
 * Throws {@link CommandError} (USAGE) on an unrecognized value so a typo fails
 * loudly rather than silently falling back to the default.
 *
 * @param options - The raw option object from the command handler.
 * @returns The resolved merge strategy.
 */
export function parseMergeStrategy(options: Record<string, unknown>): MergeStrategy {
  const raw = optionString(options, "merge-strategy", "mergeStrategy");
  if (raw === undefined) return "update";
  const v = raw.toLowerCase();
  if ((MERGE_STRATEGIES as readonly string[]).includes(v)) return v as MergeStrategy;
  throw new CommandError(
    `Unknown --merge-strategy "${raw}". Valid values: ${MERGE_STRATEGIES.join(", ")}.`,
    EXIT_CODE.USAGE,
  );
}

/**
 * Resolve `--preserve-timestamps` / `--no-preserve-timestamps` (default ON).
 *
 * @param options - The raw option object from the command handler.
 * @returns Whether source bead timestamps should be preserved on import.
 */
export function resolvePreserveTimestamps(options: Record<string, unknown>): boolean {
  if (options["no-preserve-timestamps"] === true || options["noPreserveTimestamps"] === true) return false;
  for (const k of ["preserveTimestamps", "preserve-timestamps"]) {
    const v = options[k];
    if (v !== undefined) return v !== false && v !== "false" && v !== "0";
  }
  return true;
}

/**
 * Parse a positive-integer option honoring both kebab and camel spellings.
 *
 * Throws {@link CommandError} (USAGE) when the option is set but not a positive
 * integer; returns `undefined` when unset.
 *
 * @param options - The raw option object from the command handler.
 * @param keys - The keys to try (kebab or camel).
 * @returns The parsed positive integer, or `undefined` when unset.
 */
export function parsePositiveIntOption(options: Record<string, unknown>, ...keys: string[]): number | undefined {
  const raw = keys.map((key) => options[key]).find((value) => value !== undefined);
  if (raw === undefined) return undefined;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : Number.NaN;
  if (!Number.isInteger(n) || n <= 0) {
    throw new CommandError(
      `Invalid value for --${keys[0]}: "${String(raw)}". Must be a positive integer.`,
      EXIT_CODE.USAGE,
    );
  }
  return n;
}

/**
 * Options governing one Beads export, normalized from the CLI flag bag.
 */
export interface ExportOptions {
  /** When true, preview the export without writing a file. */
  dryRun: boolean;
  /** When true, re-emit the original bead id rather than the pm item id. */
  preserveIds: boolean;
  /** Output file path (stdout when unset). */
  output?: string;
  /** Status/type filter narrowing which items are exported. */
  filter: RowFilter;
}

export function parseExportOptions(options: Record<string, unknown>): ExportOptions {
  return {
    dryRun: readBoolOption(options, "dry-run", "dryRun"),
    preserveIds: resolvePreserveIds(options),
    output: optionString(options, "output", "o"),
    filter: parseRowFilter(options),
  };
}

function parseImportOptions(options: Record<string, unknown>): ImportOptions {
  return {
    dryRun: readBoolOption(options, "dry-run", "dryRun"),
    validateOnly: readBoolOption(options, "validate-only", "validateOnly"),
    upsert: readBoolOption(options, "upsert"),
    mergeStrategy: parseMergeStrategy(options),
    batchSize: parsePositiveIntOption(options, "batch-size", "batchSize"),
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
    // `--json` is a host-owned global flag: extensions must not redeclare it
    // (the host rejects the registration) and must read it from ctx.global.
    json: readBoolOption(global, "json"),
    strict: readBoolOption(options, "strict"),
    againstWorkspace: readBoolOption(options, "against-workspace", "againstWorkspace"),
    preserveIds: resolvePreserveIds(options),
    filter: parseRowFilter(options),
    pmRoot,
  };
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

// Resolve the import input file from the raw command args: the first positional
// (non-flag) argument. Flags (e.g. `--dry-run`, `--type Task`) may trail the
// path in the raw args array, so we skip flags and their values.
export function resolveImportInputFile(args: unknown): string | undefined {
  if (!Array.isArray(args)) return undefined;
  const valueFlags = new Set([
    "--type", "--priority", "--tags",
    "--filter", "--filter-status", "--filter-type",
    "--merge-strategy", "--batch-size", "--file",
  ]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== "string") continue;
    if (a.startsWith("-")) {
      if (valueFlags.has(a)) i++;
      continue;
    }
    return a;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// SDK authoring builders — local identity stand-ins.
//
// `@unbrained/pm-cli/sdk/authoring` ships zero-cost identity builders
// (`defineImporter`, `defineExporter`, `defineCommand`, `defineItemField`, …)
// whose value is entirely at the type level: they contract-check each
// registration literal against the host surface and preserve its narrow
// literal type, so a malformed definition is caught at edit time instead of at
// activation. They are plain identity functions (`x => x`).
//
// They are declared here as local stand-ins constrained by the real SDK
// contract types (imported type-only above) rather than imported as values, so
// this package keeps its type-only dependency on `@unbrained/pm-cli` and the
// published `dist/index.js` carries no static runtime module edge to the CLI —
// it remains standalone-runnable. This mirrors the established `defineExtension`
// stand-in pattern (commit a80a113): identical type-level contract checking and
// literal preservation, no runtime edge. Importing the builder values as static
// runtime imports would break that design and is a behaviour change we do not
// ship silently.
// ---------------------------------------------------------------------------
const defineExtension = <TModule extends ExtensionModule>(module: TModule): TModule => module;
const defineCommand = <TDefinition extends CommandDefinition>(definition: TDefinition): TDefinition => definition;
const defineImporter = (importer: Importer): Importer => importer;
const defineExporter = (exporter: Exporter): Exporter => exporter;
const defineItemField = <TField extends SchemaFieldDefinition>(field: TField): TField => field;

export default defineExtension({
  name: "pm-beads",
  version: "2026.9.6",

  activate(api: ExtensionApi) {
    // -----------------------------------------------------------------------
    // schema — declare the bead_id provenance field
    // -----------------------------------------------------------------------
    api.registerItemFields([
      defineItemField({ name: "bead_id", type: "string", optional: true }),
    ]);

    // -----------------------------------------------------------------------
    // importer — `pm beads import <file>` (native import pipeline)
    //
    // The fail-fast malformed-input gate runs INSIDE runImport (see
    // assertBeadsImportable), not on the single-winner preflight surface, so
    // it holds even when a co-installed package owns the preflight slot.
    //
    // The third ImportExportRegistrationOptions argument (SDK 2026.6.10+) makes
    // the auto-created `beads import` command a first-class one: description,
    // flags, examples and failure hints surface in `--help` and in runtime
    // contracts. Older hosts simply ignore the extra argument.
    // -----------------------------------------------------------------------
    api.registerImporter(
      "beads",
      defineImporter(async (ctx: ImportExportContext) => {
        const file = resolveImportInputFile(ctx.args) ?? optionString(ctx.options, "file");
        return runImport(file, ctx.pm_root, parseImportOptions(ctx.options));
      }),
      {
        description:
          "Import work items from a Beads JSONL file into pm. Each JSON line becomes a pm item; " +
          "the original Beads id, blocker edges, parent links and timestamps are preserved. " +
          "The file is structurally validated up front — a malformed file aborts before any item is written.",
        intent: "import Beads JSONL work items as pm items",
        examples: [
          "pm beads import items.jsonl",
          "pm beads import data.jsonl --dry-run",
          "pm beads import data.jsonl --validate-only",
          "pm beads import data.jsonl --upsert",
          "pm beads import data.jsonl --upsert --merge-strategy skip",
          'pm beads import data.jsonl --filter "type:Bug;status:open"',
          "pm beads import big.jsonl --batch-size 100",
          "pm beads import data.jsonl --filter-status open,in_progress",
        ],
        failure_hints: [
          "Run `pm beads validate <file>` to see the structural errors that blocked the import.",
          "Use --validate-only to run that gate without importing.",
        ],
        arguments: [
          { name: "file", required: true, description: "Path to the Beads JSONL source file." },
        ],
        flags: IMPORT_FLAGS,
      },
    );

    // -----------------------------------------------------------------------
    // exporter — `pm beads export` (serialize pm items back to Beads JSONL)
    // -----------------------------------------------------------------------
    api.registerExporter(
      "beads",
      defineExporter(async (ctx: ImportExportContext) => {
        return runExport(ctx.pm_root, parseExportOptions(ctx.options));
      }),
      {
        description:
          "Serialize pm items back to Beads JSONL, preserving the original Beads id (when present) " +
          "and emitting dependency/blocker edges.",
        intent: "export pm items as Beads JSONL",
        examples: [
          "pm beads export",
          "pm beads export --output items.jsonl",
          'pm beads export --filter "type:Bug;status:open"',
          "pm beads export --filter-type Bug",
          "pm beads export --dry-run",
        ],
        flags: EXPORT_FLAGS,
      },
    );

    // -----------------------------------------------------------------------
    // command — legacy `pm beads-import <file>` alias (rich flag help).
    // Named distinctly from the `beads` importer so the two do not collide on
    // the auto-created `beads import` command handler. Delegates to the same
    // import core, so behavior is identical.
    // -----------------------------------------------------------------------
    api.registerCommand(defineCommand({
      name: "beads-import",
      description:
        "Import work items from a Beads JSONL file into pm (alias of `pm beads import`). " +
        "Each JSON line becomes a pm item; the original Beads id and blocker edges are preserved.",
      intent: "import Beads JSONL work items as pm items",
      examples: [
        "pm beads import items.jsonl",
        "pm beads import data.jsonl --dry-run",
        "pm beads import data.jsonl --validate-only",
        "pm beads import data.jsonl --upsert",
        "pm beads import data.jsonl --upsert --merge-strategy skip",
        "pm beads import data.jsonl --type Task --priority 2",
        'pm beads import data.jsonl --filter "type:Bug;status:open"',
        "pm beads import data.jsonl --filter-status open,in_progress",
        "pm beads import data.jsonl --filter-type Bug",
        "pm beads import big.jsonl --batch-size 100",
        "pm beads import data.jsonl --no-preserve-ids",
        "pm beads import data.jsonl --no-preserve-timestamps",
      ],
      arguments: [
        { name: "file", required: true, description: "Path to the Beads JSONL source file." },
      ],
      flags: IMPORT_FLAGS,
      async run(ctx: CommandHandlerContext) {
        const file = resolveImportInputFile(ctx.args) ?? optionString(ctx.options, "file");
        return runImport(file, ctx.pm_root, parseImportOptions(ctx.options));
      },
    }));

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
        "pm beads export --dry-run",
        'pm beads export --filter "type:Bug;status:open"',
        "pm beads export --filter-status open,in_progress",
        "pm beads export --filter-type Bug",
        "pm beads export --no-preserve-ids",
      ],
      flags: EXPORT_FLAGS,
      async run(ctx: CommandHandlerContext) {
        return runExport(ctx.pm_root, parseExportOptions(ctx.options));
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
      arguments: [
        { name: "file", required: true, description: "Path to the Beads JSONL file to validate." },
      ],
      flags: VALIDATE_FLAGS,
      async run(ctx: CommandHandlerContext) {
        const options = ctx.options;
        // `--json` is a host-owned global flag: extensions must not redeclare
        // it (the host rejects the registration) and must read it from
        // ctx.global so the structured report is returned (and rendered by
        // the runtime) instead of the human listing. The spread yields a fresh
        // object literal, which — unlike the GlobalOptions interface — is
        // assignable to the Record<string, unknown> readBoolOption reads
        // through; spreading undefined still yields {} if a host omits it.
        const json = readBoolOption({ ...ctx.global }, "json");
        // Cross-workspace dependency check is ON by default; --no-workspace opts out.
        const workspace = resolveWorkspaceCheck(options);
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
        'pm beads diff a.jsonl b.jsonl --filter "type:Bug;status:open"',
        "pm beads diff a.jsonl b.jsonl --filter-status open,in_progress",
        "pm beads diff a.jsonl b.jsonl --filter-type Bug",
      ],
      arguments: [
        { name: "source", required: true, description: "First Beads JSONL file." },
        {
          name: "target",
          required: false,
          description: "Second Beads JSONL file; omit with --against-workspace.",
        },
      ],
      flags: DIFF_FLAGS,
      async run(ctx: CommandHandlerContext) {
        // See the validate handler for why ctx.global is spread: `--json` is a
        // host-owned global read through ctx.global, and the spread keeps the
        // read runtime-tolerant and assignable to Record<string, unknown>.
        return runDiff(ctx.args, parseDiffOptions(ctx.options, { ...ctx.global }, ctx.pm_root));
      },
    });
    api.registerCommand(makeDiffCommand("beads diff"));
    api.registerCommand(makeDiffCommand("beads-diff"));
  },
});
