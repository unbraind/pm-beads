/** Shared pre-write parent closure and cycle checks for native imports and snapshot consumers. */
import { CommandError } from "./contracts.ts";
import { normalizeBeadKey } from "./index.ts";
import { beadsGraphSdk } from "./graph-sdk.ts";
/** Expected structural refusal before any tracker schema, identity or item write. */
export class BeadsParentRefusal extends CommandError {
  /** Stable machine-readable parent topology category. */
  readonly code = "invalid_parent_graph";
  /** Safe corrective action for parent graphs. */
  readonly remedy = "Supply every parent identity, remove parent cycles, and retain required parents when filtering before import.";
  /** Construct a payload-free hierarchy refusal. */
  constructor() { super("invalid_parent_graph: Supply resolved, acyclic parent relationships before importing.", 2); }
}
/** Verify normalized source parent identities; only explicit known receiver identities may leave the source snapshot. */
export function assertBeadsParentGraph(rows: readonly { id?: unknown; parent?: unknown }[], externalIds: ReadonlySet<string> = new Set()): void {
  const selected = rows.map((row, index) => ({ id: normalizeBeadKey(row.id), parent: typeof row.parent === "string" ? normalizeBeadKey(row.parent) : undefined,
    supplied: row.parent !== undefined && row.parent !== null,
    malformed: row.parent !== undefined && row.parent !== null && typeof row.parent !== "string", token: `row${index}` }));
  if (selected.some(row => row.malformed)) throw new BeadsParentRefusal();
  if (!selected.some(row => row.parent)) return;
  const byId = new Map(selected.filter(row => row.id).map(row => [row.id!, row.token]));
  // Duplicate upsert rows compose as patches: a clear replaces an earlier
  // link, while an omitted/null parent leaves the last explicit edit intact.
  const effective = new Map<string, typeof selected[number]>();
  for (const row of selected) {
    const token = row.id ? byId.get(row.id)! : row.token;
    if (!effective.has(token) || row.supplied) effective.set(token, row);
  }
  const edges: Array<{ source: string; target: string; kind: string }> = [];
  for (const row of effective.values()) {
    if (!row.parent) continue;
    const target = byId.get(row.parent);
    if (target) edges.push({ source: row.id ? byId.get(row.id)! : row.token, target, kind: "blocked_by" });
    else if (!externalIds.has(row.parent)) throw new BeadsParentRefusal();
  }
  const sdk = beadsGraphSdk();
  // Opaque graph tokens preserve external identity spelling; diagnostic self-edges must remain representable.
  const registry = new sdk.RelationshipKindRegistry(sdk.BUILTIN_RELATIONSHIP_KINDS.map(kind => ({ ...kind, allowSelf: true })));
  if (!sdk.analyzeRelationshipExecution(new sdk.RelationshipGraph(selected.map(row => row.token), edges, registry), { registry }).acyclic) throw new BeadsParentRefusal();
}

/** Translate expected hierarchy failures into validation issues while preserving unexpected SDK errors. */
export function beadsParentRefusalIssue(error: unknown): { code: string; message: string } {
  if (!(error instanceof BeadsParentRefusal)) throw error;
  return { code: error.code, message: error.remedy };
}
