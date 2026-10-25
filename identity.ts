/** Structured Beads provenance and the narrowly scoped historical envelope reader. */
import {
  PmClient, preserveMutationStdinTokenFields, hashDocument, runWithActiveExtensions, setActiveExtensionHooks, update,
  PmCliError, EXIT_CODE, type PmClientFullMutationOptions, type ItemDocument,
} from "@unbrained/pm-cli/sdk";
import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { readBeadsItemDocument } from "./item-access.ts";
import { beadsMutationAuthor } from "./mutation.ts";

/** Decode only the exact suffix emitted by the former encoder, never embedded or body markers. */
export function legacyBeadIdentity(description: string | undefined): { id: string; description: string } | undefined {
  if (!description) return undefined;
  const start = description.lastIndexOf("[bead_id: ");
  if (start < 0 || !description.endsWith("]")) return undefined;
  const id = description.slice(start + 10, -1);
  if (!id || id.trim() !== id || id.length > 4097 || /[\[\]\r\n]/.test(id)) return undefined;
  if (start === 0) return { id, description: "" };
  if (description.slice(start - 2, start) !== "\n\n") return undefined;
  const body = description.slice(0, start - 2);
  if (!body || body.trim() !== body || /\[bead_id:\s{0,64}(\S[^\]]{0,4096})\]/.test(body)) return undefined;
  return { id, description: body };
}

/** Register the durable field through the SDK so no-extensions mutations also preserve it. */
export async function ensureBeadIdentityField(client: PmClient): Promise<void> {
  const fields = await client.schemaListFields();
  if (!fields.fields.some(field => field.key === "bead_id")) {
    await client.schemaAddField("bead_id", { type: "string", commands: ["create", "update"], cliFlag: "bead-id" });
  }
}

/** Report exact legacy envelopes without modifying items, schemas or history. */
export function reportLegacyBeadIdentities(items: readonly { id?: string; bead_id?: unknown; description?: string }[]): string[] {
  const pending = items.filter(item => item.bead_id === undefined && legacyBeadIdentity(item.description)).map(item => item.id!);
  if (pending.length) console.error(`${pending.length} legacy Beads item(s) need identity migration; preview with pm beads migrate-identities, then use --apply.`);
  return pending;
}

/** Deterministic boundaries for checking peer edits with real SDK trackers. */
export type BeadsMigrationBoundary = "listed" | "located" | "read" | "before_schema" | "after_schema" | "before_update" | "locked";
/** Explicit migration controls; omission always previews without writes. */
export interface BeadsIdentityMigrationOptions {
  apply?: boolean;
  onTransition?(boundary: BeadsMigrationBoundary, id: string): void | Promise<void>;
}
/** Per-item decisions include concurrent changes without exposing item prose. */
export interface BeadsIdentityMigrationReceipt {
  dryRun: boolean; pending: string[]; migrated: string[]; skipped: string[];
}
/** Migrate only explicitly, deriving values and the revision guard from the same document. */
export async function migrateBeadIdentities(pmRoot: string, author?: string, options: BeadsIdentityMigrationOptions = {}): Promise<BeadsIdentityMigrationReceipt> {
  author = beadsMutationAuthor(author);
  const client = new PmClient({ pmRoot, noExtensions: true, author });
  const { items } = await client.listAllComplete();
  const receipt: BeadsIdentityMigrationReceipt = { dryRun: !options.apply, pending: [], migrated: [], skipped: [] };
  for (const item of items) {
    await options.onTransition?.("listed", item.id);
    let document: ItemDocument;
    try {
      document = await readBeadsItemDocument(pmRoot, item.id, undefined, () => options.onTransition?.("located", item.id));
    } catch (error) {
      if (!(error instanceof PmCliError) || error.exitCode !== EXIT_CODE.NOT_FOUND) throw error;
      receipt.skipped.push(item.id); continue;
    }
    const legacy = document.metadata.bead_id === undefined ? legacyBeadIdentity(document.metadata.description) : undefined;
    if (!legacy) continue;
    const revision = hashDocument(document);
    receipt.pending.push(item.id);
    await options.onTransition?.("read", item.id);
    if (!options.apply) continue;
    await options.onTransition?.("before_schema", item.id);
    await ensureBeadIdentityField(client);
    await options.onTransition?.("after_schema", item.id);
    const mutation: PmClientFullMutationOptions = { author, beadId: legacy.id, description: legacy.description, message: "Migrate legacy Beads identity to bead_id" };
    await options.onTransition?.("before_update", item.id);
    try {
      // The SDK has no native update precondition (pm-cli#1576). Like pm-github#174,
      // the transactional hook compares the whole item under the SDK item lock.
      await runWithActiveExtensions({ path: pmRoot, noExtensions: true }, async () => {
        setActiveExtensionHooks({ beforeCommand: [], afterCommand: [], onRead: [], onWrite: [], onIndex: [],
          beforeMutation: [{ layer: "project", name: "beads-identity-revision", run: async context => {
            await options.onTransition?.("locked", item.id);
            if (hashDocument(context.before!) !== revision) throw new PmCliError("Legacy Beads item changed; migration skipped.", 1, { code: "beads_identity_changed" });
          } }],
        });
        await update(item.id, preserveMutationStdinTokenFields(mutation, ["description"]), { pmRoot, noExtensions: true, author });
      });
      receipt.migrated.push(item.id);
    } catch (error) {
      if (!(error instanceof PmCliError) || (error.code !== "beads_identity_changed" && error.exitCode !== EXIT_CODE.NOT_FOUND)) throw error;
      receipt.skipped.push(item.id);
    }
  }
  if (receipt.migrated.length) console.error(`Migrated ${receipt.migrated.length} legacy Beads identities to bead_id.`);
  if (receipt.skipped.length) console.error(`Skipped ${receipt.skipped.length} changed or missing Beads item(s); preview migration again.`);
  return receipt;
}

/** Register the sole manual migration command, with an explicit write opt-in. */
export function registerIdentityMigrationCommand(api: ExtensionApi): void {
  api.registerCommand({
    name: "beads migrate-identities",
    description: "Preview legacy identity migration without writes; --apply migrates unchanged items under their SDK locks.",
    flags: [{ long: "--apply", description: "Apply guarded migration and record history; default is a read-only preview." }],
    examples: ["pm beads migrate-identities", "pm --author reviewer beads migrate-identities --apply"],
    run: ctx => migrateBeadIdentities(ctx.pm_root, ctx.global.author, { apply: ctx.options.apply === true }),
  });
}
