/** Structured Beads provenance and the narrowly scoped historical envelope reader. */
import { PmClient, preserveMutationStdinTokenFields, type PmClientFullMutationOptions } from "@unbrained/pm-cli/sdk";

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
  if (!body || body.trim() !== body || body.includes("[bead_id:")) return undefined;
  return { id, description: body };
}

/** Register the durable field through the SDK so no-extensions mutations also preserve it. */
export async function ensureBeadIdentityField(client: PmClient): Promise<void> {
  const fields = await client.schemaListFields();
  if (!fields.fields.some(field => field.key === "bead_id")) {
    await client.schemaAddField("bead_id", { type: "string", commands: ["create", "update"], cliFlag: "bead-id" });
  }
}

/** Migrate an unstructured legacy envelope on first SDK touch, recording and reporting the change. */
export async function migrateLegacyBeadIdentity(client: PmClient, item: { id: string; bead_id?: unknown; description?: string }): Promise<boolean> {
  if (item.bead_id !== undefined) return false;
  const legacy = legacyBeadIdentity(item.description);
  if (!legacy) return false;
  await ensureBeadIdentityField(client);
  const options: PmClientFullMutationOptions = { beadId: legacy.id, description: legacy.description, message: "Migrate legacy Beads identity to bead_id" };
  const result = await client.update(item.id, preserveMutationStdinTokenFields(options, ["description"]));
  Object.assign(item, result.item);
  console.error("Migrated 1 legacy Beads identity to bead_id.");
  return true;
}
