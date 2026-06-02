// pm-beads — Beads JSONL importer/exporter for pm-cli
//
// Capabilities (see manifest.json):
//   commands  — `pm beads import <file>` (legacy, full-featured command)
//   importers — `pm beads import` (native import pipeline) + legacy `beads-import`
//   exporters — `pm beads export` (serialize pm items back to Beads JSONL)
//   schema    — declares the `bead_id` item field
//
// Round-trip guarantee: the original Beads `id` and the dependency/blocker edges
// survive a `pm beads import` → `pm beads export` cycle. pm's `create` command has
// no generic custom-field setter for standalone extensions, so the original bead
// id is persisted in the item description behind a parseable marker
// (`[bead_id: <id>]`); the exporter reads it back and re-emits the native bead id.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
// Import core — shared by the legacy command and the native importer
// ---------------------------------------------------------------------------

interface ImportOptions {
  dryRun: boolean;
  preserveIds: boolean;
  typeOverride?: string;
  priorityOverride?: string;
  tagsOverride?: string;
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

// Run the import. Two passes so dependency edges can reference items created
// earlier in the same file: pass 1 creates every item and records bead-id → pm-id;
// pass 2 wires up the blocker edges via `pm update --dep`.
function runImport(filePath: string | undefined, pmRoot: string, opts: ImportOptions) {
  if (!filePath) {
    throw new CommandError(
      "Usage: pm beads import <file> [--dry-run] [--no-preserve-ids] [--type <type>] [--priority <n>] [--tags <tags>]",
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

  // Map of original bead id -> the pm id we created for it (used to wire deps).
  const beadToPm = new Map<string, string>();
  const created: Array<{ beadId?: string; pmId: string; blockers: string[] }> = [];
  let imported = 0;

  for (let i = 0; i < records.length; i++) {
    const item = records[i];
    const title = String(item.title || item.name || "").trim();
    if (!title) {
      console.error(`Record ${i + 1}: missing title — skipping`);
      skipped++;
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

    if (opts.dryRun) {
      console.error(
        `  [dry-run] ${title} (${type}, ${status}${beadId ? `, bead_id=${beadId}` : ""}` +
          `${blockers.length ? `, blocked_by=${blockers.join(",")}` : ""})`,
      );
      imported++;
      continue;
    }

    try {
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
      if (item.assignee) spawnArgs.push("--assignee", String(item.assignee));

      const result = spawnSync("pm", spawnArgs, { encoding: "utf-8" });
      if (result.status !== 0) {
        throw new Error(result.stderr || "pm create failed");
      }
      const pmId = extractCreatedId(result.stdout);
      if (!pmId) throw new Error("could not determine created pm id");
      if (beadId) beadToPm.set(beadId, pmId);
      created.push({ beadId, pmId, blockers });
      imported++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Record ${i + 1}: create failed — ${msg}`);
      skipped++;
    }
  }

  // Pass 2: wire dependency/blocker edges now that every item exists.
  let edges = 0;
  if (!opts.dryRun) {
    for (const entry of created) {
      for (const blockerBeadId of entry.blockers) {
        const blockerPmId = beadToPm.get(blockerBeadId);
        if (!blockerPmId) {
          console.error(`  dep skipped: ${entry.pmId} blocked_by unknown bead ${blockerBeadId}`);
          continue;
        }
        const dep = spawnSync(
          "pm",
          ["--path", pmRoot, "update", entry.pmId, "--dep", `id=${blockerPmId},kind=blocked_by`],
          { encoding: "utf-8" },
        );
        if (dep.status === 0) edges++;
        else console.error(`  dep failed: ${entry.pmId} -> ${blockerPmId}: ${dep.stderr?.trim()}`);
      }
    }
  }

  if (opts.dryRun) {
    console.error(`[dry-run] Would import ${imported}, skip ${skipped}.`);
    return { dryRun: true, wouldImport: imported, wouldSkip: skipped };
  }

  if (imported === 0 && skipped > 0) {
    throw new CommandError(`No items imported — all ${skipped} record(s) failed (malformed input?).`);
  }

  console.error(`Imported ${imported}, skipped ${skipped}, linked ${edges} dependency edge(s).`);
  return { imported, skipped, dependencies: edges };
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
  if (item.created_at) bead.created_at = item.created_at;
  if (item.updated_at) bead.updated_at = item.updated_at;
  if (blockers.length) bead.dependencies = blockers;
  return bead;
}

function runExport(pmRoot: string, opts: { preserveIds: boolean; output?: string }) {
  const items = readPmItems(pmRoot);

  // First build the pm-id -> bead-id translation table so dependency edges that
  // reference another exported item resolve to its native bead id.
  const pmToBead = new Map<string, string>();
  if (opts.preserveIds) {
    for (const item of items) {
      const beadId = decodeBeadId(item);
      if (item.id && beadId) pmToBead.set(item.id, beadId);
    }
  }

  const beads = items.map((item) => pmItemToBead(item, pmToBead, opts.preserveIds));
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
// Extension
// ---------------------------------------------------------------------------

const IMPORT_FLAGS = [
  { long: "--dry-run", description: "Preview without writing" },
  { long: "--no-preserve-ids", description: "Do not persist the original Beads id (default: preserve)" },
  { long: "--type", value_name: "type", description: "Override item type for all imported items" },
  { long: "--priority", value_name: "n", description: "Override priority (0-4) for all items" },
  { long: "--tags", value_name: "tags", description: "Comma-separated tags to add to all items" },
];

const EXPORT_FLAGS = [
  { long: "--output", short: "-o", value_name: "file", description: "Write JSONL to a file instead of stdout" },
  { long: "--no-preserve-ids", description: "Emit pm ids instead of the original Beads ids (default: preserve)" },
];

function parseImportOptions(options: Record<string, unknown>): ImportOptions {
  return {
    dryRun: readBoolOption(options, "dry-run", "dryRun"),
    preserveIds: resolvePreserveIds(options),
    typeOverride: optionString(options, "type"),
    priorityOverride: optionString(options, "priority"),
    tagsOverride: optionString(options, "tags"),
  };
}

export default defineExtension({
  name: "pm-beads",
  version: "2026.6.1",

  activate(api: any) {
    // -----------------------------------------------------------------------
    // schema — declare the bead_id provenance field
    // -----------------------------------------------------------------------
    api.registerItemFields([
      { name: "bead_id", type: "string", optional: true },
    ]);

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
        "pm beads import data.jsonl --type Task --priority 2",
        "pm beads import data.jsonl --no-preserve-ids",
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
        "pm beads export --no-preserve-ids",
      ],
      flags: EXPORT_FLAGS,
      async run(ctx: any) {
        const options = ctx.options || {};
        return runExport(ctx.pm_root, {
          preserveIds: resolvePreserveIds(options),
          output: optionString(options, "output", "o"),
        });
      },
    });
  },
});
