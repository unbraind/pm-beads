/** Real process deadlines for forecast contract inputs, including FIFOs with no writer. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { appendFile, cp, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
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
type Route = "sdk" | "json" | "toon";

/** Invoke the same compiled public SDK reader or installed CLI extension for every scenario. */
function forecastArgs(route: Route, file: string, pmRoot: string): string[] {
  return route === "sdk" ? ["--input-type=module", "--eval", `
    import { readBeadsProducerContract, forecastBeadsDialect, beadsDialectRefusalReceipt } from ${JSON.stringify(pathToFileURL(join(root, "dist/forecast.js")).href)};
    try { console.log(JSON.stringify(forecastBeadsDialect(await readBeadsProducerContract(process.argv[1])))); }
    catch (error) { console.log(JSON.stringify(beadsDialectRefusalReceipt(error))); process.exitCode = 2; }
  `, file] : [join(root, "node_modules/@unbrained/pm-cli/dist/cli.js"), "--path", pmRoot,
    ...(route === "json" ? ["--json"] : []), "beads", "forecast", file];
}

/** Seed an isolated real non-git tracker and retain its state for read-only assertions. */
async function raceFixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "beads-forecast-race-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pmRoot = join(dir, "tracker"), client = new PmClient({ pmRoot, noExtensions: true, author: "forecast-test" });
  await client.init("sample");
  const extension = join(pmRoot, "extensions", "pm-beads");
  await mkdir(extension, { recursive: true });
  for (const entry of ["dist", "package.json", "manifest.json"]) await cp(join(root, entry), join(extension, entry), { recursive: true });
  await symlink(join(root, "node_modules"), join(extension, "node_modules"), "junction");
  const before = (await client.listAllComplete()).items, settings = await readFile(join(pmRoot, "settings.json"));
  return { dir, pmRoot, client, before, settings };
}

/** Mutate a real file in the parent while a separate reader process pauses at a known I/O boundary. */
async function atReadBarrier(route: Route, file: string, dir: string, pmRoot: string,
  point: "opened" | "statted", mutate: () => Promise<void>) {
  const child = spawn(process.execPath, ["--import", pathToFileURL(join(import.meta.dirname, "fixtures/forecast-read-barrier.ts")).href,
    ...forecastArgs(route, file, pmRoot)], {
    cwd: dir, stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: { ...process.env, PATH: "", GIT_CEILING_DIRECTORIES: dir,
      BEADS_FORECAST_BARRIER_FILE: file, BEADS_FORECAST_BARRIER_POINT: point },
  });
  let stdout = "", stderr = "", reached = 0, failure: unknown, timedOut = false;
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.once("error", error => { failure = error; });
  const closed = new Promise<number | null>(resolve => child.once("close", code => resolve(code)));
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 30_000);
  let mutation: Promise<void> = Promise.resolve();
  child.on("message", message => {
    reached++;
    mutation = (async () => {
      assert.equal(message, point);
      assert.equal(reached, 1);
      await mutate();
      await new Promise<void>((resolve, reject) => child.send("continue", error => error ? reject(error) : resolve()));
    })().catch(error => { failure = error; child.kill("SIGKILL"); });
  });
  try {
    const status = await closed;
    await mutation;
    if (failure) throw failure;
    assert.equal(timedOut, false, `${route} ${point} reader exceeded its process deadline`);
    assert.equal(reached, 1, "The real reader must reach the requested filesystem boundary");
    return { status, stdout, stderr };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    await mutation;
  }
}

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
      const args = forecastArgs(route, file, pmRoot);
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

  test(`${route} growing contract after stat refuses instead of accepting its valid prefix`, async t => {
    const { dir, pmRoot, client, before, settings } = await raceFixture(t);
    const file = join(dir, "growing.json");
    await writeFile(file, JSON.stringify(contract).padEnd(65_536));
    const result = await atReadBarrier(route, file, dir, pmRoot, "statted", async () => {
      assert.equal((await lstat(file)).size, 65_536);
      await appendFile(file, " ");
      assert.equal((await lstat(file)).size, 65_537);
    });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    const receipt: unknown = route === "toon" ? decodeToon(result.stdout) : JSON.parse(result.stdout);
    assert.deepEqual(receipt, { refused: true, code: "invalid_contract", remedy: "Supply a UTF-8 producer contract no larger than 65536 bytes." });
    assert.deepEqual((await client.listAllComplete()).items, before);
    assert.deepEqual(await readFile(join(pmRoot, "settings.json")), settings);
  });

  test(`${route} pathname replacement after open forecasts the original descriptor`, async t => {
    const { dir, pmRoot, client, before, settings } = await raceFixture(t);
    const file = join(dir, "producer.json"), retained = join(dir, "retained.json");
    await writeFile(file, JSON.stringify(contract));
    const result = await atReadBarrier(route, file, dir, pmRoot, "opened", async () => {
      await rename(file, retained);
      const made = spawnSync("mkfifo", [file], { encoding: "utf8", timeout: 5_000 });
      assert.equal(made.status, 0, made.stderr);
      assert.equal((await lstat(file)).isFIFO(), true);
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(route === "toon" ? decodeToon(result.stdout) : JSON.parse(result.stdout), forecastBeadsDialect(contract));
    assert.equal((await lstat(file)).isFIFO(), true);
    assert.equal(await readFile(retained, "utf8"), JSON.stringify(contract));
    assert.deepEqual((await client.listAllComplete()).items, before);
    assert.deepEqual(await readFile(join(pmRoot, "settings.json")), settings);
  });
}
