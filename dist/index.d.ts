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
export declare function extractBlockerIds(item: BeadsItem): string[];
export declare function extractCreatedId(stdout: string): string | undefined;
export declare function pmItemToBead(item: PmItem, pmToBead: Map<string, string>, preserveIds: boolean): BeadsItem;
declare const _default: {
    name: string;
    version: string;
    activate(api: any): void;
};
export default _default;
//# sourceMappingURL=index.d.ts.map