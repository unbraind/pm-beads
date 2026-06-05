export declare const EXIT_CODE: {
    readonly GENERIC_FAILURE: 1;
    readonly USAGE: 2;
    readonly NOT_FOUND: 3;
};
export declare class CommandError extends Error {
    exitCode: number;
    constructor(message: string, exitCode?: number);
}
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
    dependencies?: Array<string | {
        id?: string;
        kind?: string;
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
    created_at?: string;
    updated_at?: string;
    dependencies?: PmDependency[];
    blocked_by?: string;
    bead_id?: string;
}
/**
 * Read a boolean option honoring both the kebab-case long flag and the
 * camelCase key the runtime normalizes it to (e.g. `--dry-run` -> `dryRun`).
 * Without this, `ctx.options["dry-run"]` is silently `undefined`.
 */
export declare function readBoolOption(options: Record<string, unknown>, ...keys: string[]): boolean;
export declare function optionString(options: Record<string, unknown>, ...keys: string[]): string | undefined;
/**
 * Resolve the tri-state of `--preserve-ids` / `--no-preserve-ids`.
 * Commander normalizes a `--no-foo` flag to `{ foo: false }`, but depending on
 * runtime it may surface as `preserveIds`, `preserve-ids`, or an explicit
 * `no-preserve-ids: true`. Default is ON (preserve) when nothing was passed.
 */
export declare function resolvePreserveIds(options: Record<string, unknown>): boolean;
export declare function mapStatus(raw: string | undefined): string;
export declare function pmStatusToBeads(raw: string | undefined): string;
export declare function mapPriority(raw: number | string | undefined): string | undefined;
export declare function encodeBeadId(description: string, beadId: string | undefined): string;
export declare function decodeBeadId(item: PmItem): string | undefined;
export declare function stripBeadIdMarker(text: string | undefined): string;
export declare const KNOWN_BEADS_STATUSES: Set<string>;
export declare function normalizeBeadKey(id: string | undefined): string | undefined;
export declare function extractBlockerIds(item: BeadsItem): string[];
export declare function normalizeIsoTimestamp(raw: unknown): string | undefined;
export declare function patchTimestampLines(text: string, values: {
    created_at?: string;
    updated_at?: string;
}): string | null;
export declare function locateItemFile(pmRoot: string, pmId: string): string | undefined;
export interface RowFilter {
    statuses?: Set<string>;
    types?: Set<string>;
}
export declare function beadPassesFilter(bead: BeadsItem, typeOverride: string | undefined, filter: RowFilter): boolean;
export declare function pmItemPassesFilter(item: PmItem, filter: RowFilter): boolean;
export interface ValidationIssue {
    line: number;
    severity: "error" | "warning";
    code: string;
    message: string;
}
export interface ValidationReport {
    file?: string;
    records: number;
    valid: boolean;
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
export declare function detectDependencyCycles(adj: Map<string, string[]>): string[][];
export declare function validateBeadsText(text: string, file?: string, workspaceBeadIds?: Set<string>): ValidationReport;
export interface ExistingBeadItem {
    pmId: string;
    status?: string;
}
export declare function buildBeadIndex(items: PmItem[]): Map<string, ExistingBeadItem>;
export declare function extractCreatedId(stdout: string): string | undefined;
export declare function pmItemToBead(item: PmItem, pmToBead: Map<string, string>, preserveIds: boolean): BeadsItem;
export declare function parseRowFilter(options: Record<string, unknown>): RowFilter;
export declare function resolvePreserveTimestamps(options: Record<string, unknown>): boolean;
export declare function resolveImportInputFile(args: unknown): string | undefined;
declare const _default: {
    name: string;
    version: string;
    activate(api: any): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map