/** Exercise one immutable npm artifact through five real npm/Bun host installation paths. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { decodeToon } from "@unbrained/pm-cli/sdk/testing";
import type * as ForecastSdk from "../forecast.ts";
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, ".."), scratch = await mkdtemp(join(tmpdir(), "beads-forecast-pack-"));
const childEnv = { ...process.env, NPM_CONFIG_USERCONFIG: "/dev/null", npm_config_userconfig: "/dev/null", GIT_CEILING_DIRECTORIES: scratch,
  NPM_CONFIG_CACHE: join(scratch, "npm-cache"), npm_config_cache: join(scratch, "npm-cache"), npm_config_prefer_offline: "true" };
for (const key of Object.keys(childEnv)) if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|NPM_MEDIA_SERVER/i.test(key)) delete childEnv[key as keyof typeof childEnv];
/** Execute a bounded install or command without exposing environment values or inherited credentials. */
function run(bin: string, args: string[], cwd = scratch, extra: Record<string, string> = {}): string {
  const result = spawnSync(bin, args, { cwd, env: { ...childEnv, ...extra }, encoding: "utf8", timeout: 240_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Acceptance subprocess failed (${bin.split("/").at(-1)}): ${result.stderr.slice(-1000)}`);
  return result.stdout;
}
/** Link the actual installed package into a real non-git tracker and run the selected launcher. */
async function accept(name: string, packageDir: string, bin: string, prefix: string[] = [], extra: Record<string, string> = {}): Promise<void> {
  const pmRoot = join(scratch, name, "tracker"), client = new PmClient({ pmRoot, noExtensions: true, author: "packed-acceptance" });
  await client.init("sample"); const extension = join(pmRoot, "extensions", "pm-beads");
  await mkdir(extension, { recursive: true });
  for (const entry of ["dist", "manifest.json", "package.json"]) await cp(join(packageDir, entry), join(extension, entry), { recursive: true });
  await symlink(resolve(packageDir, ".."), join(extension, "node_modules"), "junction");
  const file = join(scratch, "source.jsonl");
  const source = await readFile(file, "utf8"), sdk = require(join(packageDir, "dist/index.js")) as typeof ForecastSdk;
  const contract=JSON.parse(source),expected=sdk.forecastBeadsDialect(contract);
  for (const format of ["json", "toon"]) {
    const args = [...prefix, "--path", pmRoot, ...(format === "json" ? ["--json"] : []), "beads", "forecast", file];
    const output = spawnSync(bin, args, { cwd: scratch, env: { ...childEnv, ...extra }, encoding: "utf8", timeout: 240_000, maxBuffer: 1024 * 1024 });
    assert.equal(output.status, 0, `${name}: ${output.stderr}`);
    const packet = format === "json" ? JSON.parse(output.stdout) : decodeToon(output.stdout);
    assert.deepEqual(packet,expected);assert.equal(packet.counts.exact,2);assert.equal(packet.counts.sidecarDependent,1);assert.equal(packet.counts.unsupported,1);
  }
  assert.equal(await readFile(file, "utf8"), source);
  assert.equal((await client.listAllComplete()).items.length, 0);
  results.push({ launcher: name, fields:4,formats:2,sdkResolved:true,nonGit:true });
  process.stderr.write(`Packed acceptance passed: ${name}\n`);
}
const results: { launcher: string; fields:number; formats:number; sdkResolved: boolean; nonGit: boolean }[] = [];
try {
  const packed = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], root)) as { filename: string; files: { path: string }[] }[];
  const artifact = join(scratch, packed[0].filename), digest = createHash("sha256").update(await readFile(artifact)).digest("hex");
  for (const file of ["dist/forecast.js", "dist/forecast.d.ts", "dist/snapshot-schema.js", "examples/dialect-conversion-forecasts.md"]) assert(packed[0].files.some(entry => entry.path === file));
  const host = "@unbrained/pm-cli@2026.10.28";
  await writeFile(join(scratch,"source.jsonl"),JSON.stringify({schema:1,producer:"packed/v1",fields:[{name:"id",kind:"text"},{name:"title",kind:"text"},{name:"vendor",kind:"json"},{name:"status",kind:"text"}]}));
  const npmGlobal = join(scratch, "npm-global");
  run("npm", ["install", "--global", "--prefix", npmGlobal, "--ignore-scripts", "--no-audit", "--no-fund", host, artifact]);
  await accept("npm-global", join(npmGlobal, "lib/node_modules/pm-beads"), join(npmGlobal, "bin/pm"));
  const bunGlobal = join(scratch, "bun-global"), bunBin = join(scratch, "bun-bin");
  await mkdir(bunGlobal); await mkdir(bunBin);
  await writeFile(join(bunGlobal, "package.json"), '{"name":"packed-global-acceptance","private":true}\n');
  run("bun", ["add", "--global", "--ignore-scripts", host, artifact], scratch, {
    BUN_INSTALL_GLOBAL_DIR: bunGlobal, BUN_INSTALL_BIN: bunBin, BUN_INSTALL_CACHE_DIR: join(scratch, "bun-cache"),
  });
  await accept("bun-global", join(bunGlobal, "node_modules/pm-beads"), join(bunBin, "pm"));
  const local = join(scratch, "local"); await mkdir(local); await writeFile(join(local, "package.json"), '{"name":"packed-acceptance","private":true,"type":"module"}\n');
  run("npm", ["install", "--prefix", local, "--ignore-scripts", "--no-audit", "--no-fund", host, artifact]);
  const packageDir = join(local, "node_modules/pm-beads");
  await accept("project-local", packageDir, join(local, "node_modules/.bin/pm"));
  await accept("npx", packageDir, "npx", ["--yes", "--package", host, "pm"], { npm_config_cache: join(scratch, "npm-cache") });
  await accept("bunx", packageDir, "bunx", ["--bun", "--package", host, "pm"], { BUN_INSTALL_CACHE_DIR: join(scratch, "bun-cache") });
  assert.equal(createHash("sha256").update(await readFile(artifact)).digest("hex"), digest);
  console.log(JSON.stringify({ host, artifactSha256: digest, artifactFiles: packed[0].files.length, exactArtifactUnchanged: true, results }, null, 2));
} finally { await rm(scratch, { recursive: true, force: true }); }
