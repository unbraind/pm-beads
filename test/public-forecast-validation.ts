/** Measure dialect forecasts on a frozen public tracker copy with no git or source writes. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { pmItemToBead, type PmItem } from "../index.ts";
import { forecastBeadsDialect, assertBeadsDialectImportable, type BeadsProducerContract } from "../forecast.ts";
import { captureBeadsExtensions } from "../sidecar.ts";
const root = resolve(import.meta.dirname, ".."), repository = "unbraind/pm-beads";
assert.equal(JSON.parse(execFileSync("gh", ["api", `repos/${repository}`], { encoding: "utf8" })).private, false);
const sourceHead = execFileSync("git", ["-C", root, "rev-parse", "origin/main"], { encoding: "utf8" }).trim();
const trackerTree = execFileSync("git", ["-C", root, "rev-parse", `${sourceHead}:.agents/pm`], { encoding: "utf8" }).trim();
const scratch = await mkdtemp(join(tmpdir(), "beads-dialect-public-")), pmRoot = join(scratch, ".agents", "pm");
/** Fingerprint only the bounded disposable public tree. */
async function fingerprint(dir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(entry.name); hash.update(entry.isDirectory() ? await fingerprint(join(dir, entry.name)) : await readFile(join(dir, entry.name)));
  }
  return hash.digest("hex");
}
/** Restore exact scratch permissions in finally; the source checkout is never chmodded. */
async function permissions(dir: string, readonly: boolean): Promise<void> {
  if (!readonly) await chmod(dir, 0o700);
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await permissions(join(dir, entry.name), readonly);
    else await chmod(join(dir, entry.name), readonly ? 0o400 : 0o600);
  }
  if (readonly) await chmod(dir, 0o500);
}
try {
  await mkdir(scratch, { recursive: true });
  execFileSync("tar", ["-x", "-C", scratch], { input: execFileSync("git", ["-C", root, "archive", sourceHead, ".agents/pm"], { maxBuffer: 64 * 1024 * 1024 }) });
  const client = new PmClient({ pmRoot, noExtensions: true, author: "public-validation" });
  await client.listAllComplete(); // Warm existing SDK caches before freezing; item/history bytes stay unchanged.
  await permissions(pmRoot, true); const before = await fingerprint(pmRoot);
  const previousPath = process.env.PATH, previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  try {
    process.env.PATH = ""; process.env.GIT_CEILING_DIRECTORIES = tmpdir();
    const native = (await client.listAllComplete()).items;
    const ids = new Map(native.map(item => [item.id, item.id]));
    const rows = native.map(item => pmItemToBead(item as PmItem, ids, false));
    const text = rows.map(row => JSON.stringify(row)).join("\n");
    const known=new Map<string, BeadsProducerContract["fields"][number]["kind"]>([["priority","priority"],["labels","labels"],["tags","labels"],["dependencies","blockers"]]);
    const fields=[...new Set(rows.flatMap(row=>Object.keys(row)))].sort().map(name=>({name,kind:known.get(name)??"text" as const}));
    const contract:BeadsProducerContract={schema:1,producer:"public-fleet/native-export-v1",fields};
    const started=performance.now(), full=forecastBeadsDialect(contract);
    assert.deepEqual(forecastBeadsDialect({...contract,fields:[...fields].reverse()}),full);
    // A second explicit contract selects the existing native canonical fields, excluding audited unsupported fields and the redundant owner alias.
    const selected:BeadsProducerContract={...contract,producer:"public-fleet/canonical-projection-v1",fields:fields.filter(field=>!["owner","status","issue_type","created_at","updated_at","closed_at","completed_at"].includes(field.name))};
    const selectedFields=new Set(selected.fields.map(field=>field.name));
    const projected=rows.map(row=>Object.fromEntries(Object.entries(row).filter(([name])=>selectedFields.has(name))));
    const selectedText=projected.map(row=>JSON.stringify(row)).join("\r\n");
    const projectedReport=assertBeadsDialectImportable(selectedText,selected);
    assert.equal(projectedReport.counts.unsupported,0);
    const extended:BeadsProducerContract={...selected,producer:"public-fleet/extension-projection-v1",fields:[...selected.fields,{name:"vendor",kind:"json"}]};
    const enriched=projected.map((row,index)=>({...row,vendor:{nested:{sequence:index,values:[true,null,"synthetic"]}}})).map(row=>JSON.stringify(row)).join("\n");
    const sidecar=captureBeadsExtensions(enriched,["vendor"]);
    assert.equal(assertBeadsDialectImportable(enriched,extended,sidecar).counts.sidecarDependent,1);
    assert.equal(await fingerprint(pmRoot),before);assert.deepEqual((await client.listAllComplete()).items,native);
    console.log(JSON.stringify({repository,sourceHead,trackerTree,records:rows.length,sourceJsonlBytes:Buffer.byteLength(text),
      fullContractFields:full.fields.length,fullCounts:full.counts,exactProjectionFields:projectedReport.fields.length,exactProjectionCounts:projectedReport.counts,
      extensionRecords:sidecar.loss.preservedFields,forecastJsonBytes:Buffer.byteLength(JSON.stringify(full)),
      elapsedMs:Number((performance.now()-started).toFixed(2)),readOnly:true,nonGit:true,gitAbsentFromPath:true,trackerUnchanged:true,trackerFingerprint:before},null,2));
  } finally { process.env.PATH = previousPath; if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling; }
} finally { await permissions(scratch, false); await rm(scratch, { recursive: true, force: true }); }
