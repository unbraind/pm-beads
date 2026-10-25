/** Execute the same read workload against either immutable baseline or candidate build. */
import { readFileSync } from "node:fs";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import { PmClient } from "@unbrained/pm-cli/sdk";
import extension, { buildBeadsFromWorkspace, assertListAllComplete } from "../../dist/index.js";
import { readBeadsItemDocument, readBeadsItemHistory } from "../../dist/item-access.js";

const [pmRoot, input] = process.argv.slice(2);
const client = new PmClient({ pmRoot, noExtensions: true });
const full = await client.listAllComplete();
const serialized = buildBeadsFromWorkspace(pmRoot, { preserveIds: true, filter: {} });
const filtered = buildBeadsFromWorkspace(pmRoot, { preserveIds: false, filter: { statuses: new Set(["open"]) } });
const documents = [];
for (const item of full.items) {
  const history = await readBeadsItemHistory(pmRoot, item.id);
  documents.push({ id: item.id, document: await readBeadsItemDocument(pmRoot, item.id, history), verification: history.verification });
}
const ext = await createExtensionTestHarness(extension, { name: "pm-beads", capabilities: ["commands", "schema", "importers"] });
const global = { json: true };
try {
  const exported = await ext.runExporter({ exporter: "beads", pmRoot, options: { "dry-run": true }, global });
  const diff = await ext.runCommand({ command: "beads diff", args: [input], pmRoot, options: { "against-workspace": true }, global });
  const validation = await ext.runCommand({ command: "beads validate", args: [input], pmRoot, options: {}, global });
  const cases: Record<string, unknown> = JSON.parse(readFileSync(input + ".receipts.json", "utf8"));
  const receipts: Record<string, { accepted: boolean; message?: string }> = {};
  for (const [name, envelope] of Object.entries(cases)) {
    try { assertListAllComplete(envelope); receipts[name] = { accepted: true }; }
    catch (error) { receipts[name] = { accepted: false, message: (error as Error).message }; }
  }
  console.log(JSON.stringify({ serialized, filtered, documents, exported: exported.result, diff: diff.result, validation: validation.result, receipts }));
} finally { await ext.deactivate(); }
