/** Item access belongs to the SDK, including addressing, storage and history resolution. */
import {
  PmCliError, EXIT_CODE, generateItemId, readSettings, resolveItemTypeRegistry,
  locateItem, readLocatedItem, getHistoryPath, readHistorySnapshot, verifyHistoryEntries,
  type ItemDocument, type HistoryStreamSnapshot, type HistoryVerificationResult,
} from "@unbrained/pm-cli/sdk";

/** Complete SDK read, retaining the canonical document that verification actually inspected. */
interface BeadsItemSnapshot {
  entries: HistoryStreamSnapshot["entries"];
  verification: HistoryVerificationResult;
  document?: ItemDocument;
}

/** Resolve literal identities with complete SDK configuration and read history without side effects. */
export async function readBeadsItemHistory(pmRoot: string, id: string, onLocated?: () => void | Promise<void>): Promise<BeadsItemSnapshot> {
  const settings = await readSettings(pmRoot);
  // High-level get/history currently re-prefix saved canonical IDs after prefix
  // drift. The SDK's literal lookup preserves them and owns all folder/format
  // resolution. Never replace this with a package-owned path or type map.
  const located = await locateItem(pmRoot, id, settings.id_prefix, settings.item_format, resolveItemTypeRegistry(settings).type_to_folder);
  if (located) await onLocated?.();
  const history = await readHistorySnapshot(getHistoryPath(pmRoot, located?.id ?? id), located?.id ?? id);
  let document: ItemDocument | undefined;
  if (located) {
    try { ({ document } = await readLocatedItem(located, { schema: settings.schema })); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return { entries: history.entries, verification: verifyHistoryEntries(history.entries, document), document };
}

/** Return the same canonical document verified by the SDK, never a package-read item file. */
export async function readBeadsItemDocument(pmRoot: string, id: string, snapshot?: BeadsItemSnapshot, onLocated?: () => void | Promise<void>): Promise<ItemDocument> {
  const history = snapshot ?? await readBeadsItemHistory(pmRoot, id, onLocated);
  if (!history.document) throw new PmCliError("Item not found.", EXIT_CODE.NOT_FOUND);
  if (!history.verification.ok) throw new Error("Item history does not verify against the current item.");
  return history.document;
}

/** Delegate identity generation and folder resolution to the SDK, retaining unpublished batch reservations. */
export async function allocateBeadsItemId(pmRoot: string, reserved: Set<string> = new Set()): Promise<string> {
  const settings = await readSettings(pmRoot);
  const options = { tokenLength: settings.ids.token_length, typeToFolder: resolveItemTypeRegistry(settings).type_to_folder };
  for (let attempt = 0; attempt < 32; attempt++) {
    const id = await generateItemId(pmRoot, settings.id_prefix, options);
    if (reserved.has(id)) continue;
    reserved.add(id);
    return id;
  }
  throw new Error("SDK identity allocation repeatedly collided with this batch's reservations; retry without discarding existing progress.");
}
