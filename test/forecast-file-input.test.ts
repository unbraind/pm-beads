/** Real process deadlines for forecast contract inputs, including FIFOs with no writer. */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { decodeToon } from "@unbrained/pm-cli/sdk/testing";
import { forecastBeadsDialect, type BeadsProducerContract } from "../forecast.ts";

const contract: BeadsProducerContract = { schema: 1, producer: "file-input/v1", fields: [
  { name: "id", kind: "text" }, { name: "title", kind: "text" },
] };
const root = resolve(import.meta.dirname, "..");
const remedy = "Supply a readable regular contract file no larger than 65536 bytes.";

for (const route of ["sdk", "json", "toon"] as const) {
  test(`${route} forecast rejects nonregular contracts without a writer and preserves regular-file semantics`, async t => {
    const dir = await mkdtemp(join(tmpdir(), "beads-forecast-input-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const pmRoot = join(dir, "tracker"), client = new PmClient({ pmRoot, noExtensions: true, author: "forecast-test" });
    await client.init("sample");
    const extension = join(pmRoot, "extensions", "pm-beads");
    await mkdir(extension, { recursive: true });
    for (const entry of ["dist", "package.json", "manifest.json"]) await cp(join(root, entry), join(extension, entry), { recursive: true });
    await symlink(join(root, "node_modules"), join(extension, "node_modules"), "junction");
    const before = (await client.listAllComplete()).items, settings = await readFile(join(pmRoot, "settings.json"));
    const regular = join(dir, "regular.json"), linkedRegular = join(dir, "linked-regular");
    const malformed = join(dir, "malformed.json"), oversized = join(dir, "oversized.json");
    const fifo = join(dir, "fifo"), linkedFifo = join(dir, "linked-fifo");
    await writeFile(regular, JSON.stringify(contract).padEnd(65_536));
    await symlink(regular, linkedRegular);
    await writeFile(malformed, "{");
    await writeFile(oversized, JSON.stringify(contract).padEnd(65_537));
    const made = spawnSync("mkfifo", [fifo], { encoding: "utf8", timeout: 5_000 });
    assert.equal(made.status, 0, made.stderr);
    await symlink(fifo, linkedFifo);
    // Both callers exercise the compiled public reader; no FIFO writer is ever started.
    for (const [file, code] of [[regular, null], [linkedRegular, null], [malformed, "invalid_contract"],
      [oversized, "io_error"], [dir, "io_error"], [fifo, "io_error"], [linkedFifo, "io_error"]] as const) {
      const args = route === "sdk" ? ["--input-type=module", "--eval", `
        import { readBeadsProducerContract, forecastBeadsDialect, beadsDialectRefusalReceipt } from ${JSON.stringify(pathToFileURL(join(root, "dist/forecast.js")).href)};
        try { console.log(JSON.stringify(forecastBeadsDialect(await readBeadsProducerContract(process.argv[1])))); }
        catch (error) { console.log(JSON.stringify(beadsDialectRefusalReceipt(error))); process.exitCode = 2; }
      `, file] : [join(root, "node_modules/@unbrained/pm-cli/dist/cli.js"), "--path", pmRoot,
        ...(route === "json" ? ["--json"] : []), "beads", "forecast", file];
      const result = spawnSync(process.execPath, args, {
        cwd: dir, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL",
        env: { ...process.env, PATH: "", GIT_CEILING_DIRECTORIES: dir },
      });
      assert.equal(result.error, undefined, `${route}: ${file.slice(dir.length + 1)} exceeded the process deadline: ${result.error?.message}`);
      assert.equal(result.status, code ? 2 : 0, result.stdout + result.stderr);
      const receipt: unknown = route === "toon" ? decodeToon(result.stdout) : JSON.parse(result.stdout);
      if (code === "io_error") assert.deepEqual(receipt, { refused: true, code, remedy });
      else if (code) assert.deepEqual(receipt, { refused: true, code, remedy: "Use valid contract JSON without duplicate properties." });
      else assert.deepEqual(receipt, forecastBeadsDialect(contract));
    }
    assert.deepEqual((await client.listAllComplete()).items, before);
    assert.deepEqual(await readFile(join(pmRoot, "settings.json")), settings);
  });
}
