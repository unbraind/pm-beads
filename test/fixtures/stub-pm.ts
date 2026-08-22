#!/usr/bin/env node
/**
 * A scripted stand-in for the real `pm` binary, used by the suite to drive the
 * importer's failure and recovery paths deterministically.
 *
 * This is NOT a mock of this package's code: `index.ts` keeps spawning a real
 * executable named `pm` over argv/stdout/exit codes, exactly as it does in
 * production. The stub only controls what that executable answers, so failure
 * modes that need specific child behavior (an "Invalid type value" rejection on
 * the first update, a failing history-repair, an unwritable item file) can be
 * reproduced on any machine without mutating package code.
 *
 * Scenario file (env `PM_STUB_SCENARIO`, JSON):
 *   listEnvelope   object emitted for `pm ... list --all --json`
 *   listFail       {status, stderr} — exit nonzero instead of listing
 *   create         {fail?, noId?, idBase?} — per-create behavior; the emitted
 *                  id is `<idBase ?? "pm-stub">-<n>`, n counted over invocations
 *   update         {invalidTypeTimes?, fail?} — scripted update behavior; the
 *                  invalid-type rejection fires only for the first N invocations
 *   depFail / parentFail — fail dependency / parent wiring calls
 *   close          {fail?}
 *   historyRepair  {fail?, chmodItemReadonly?} — may revoke the item file's
 *                  write bit before failing, which is how the revert-failure
 *                  branch inside the timestamp preserver is reached
 *
 * Every invocation appends one JSON line of its full argv to env `STUB_PM_LOG`
 * BEFORE dispatching; per-subcommand invocation counts are derived from that
 * log, because separate spawned processes share no memory.
 */
import { appendFileSync, chmodSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const scenarioPath: string = process.env.PM_STUB_SCENARIO ?? "";
const logPath: string = process.env.STUB_PM_LOG ?? "";
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8"));

const args = process.argv.slice(2);

function argValue(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Count prior invocations whose argv satisfies `pred` (excluding ours). */
function priorWhere(pred: (argv: string[]) => boolean) {
  const lines = readFileSync(logPath, "utf8").split("\n").filter(Boolean);
  return lines.slice(0, -1).map((l) => JSON.parse(l)).filter(pred).length;
}

const isTitleUpdate = (argv: string[]): boolean =>
  argv.includes("update") && !argv.some((a) => ["--dep", "--parent", "--replace-deps", "--clear-deps"].includes(a));
const isCreate = (argv: string[]): boolean => argv.includes("create");

appendFileSync(logPath, `${JSON.stringify(args)}\n`);

if (args.includes("list")) {
  if (scenario.listFail) {
    process.stderr.write(`${scenario.listFail.stderr}\n`);
    process.exit(scenario.listFail.status);
  }
  process.stdout.write(`${JSON.stringify(scenario.listEnvelope)}\n`);
  process.exit(0);
}

if (isCreate(args)) {
  const create = scenario.create ?? {};
  if (create.fail) {
    process.stderr.write("create exploded\n");
    process.exit(1);
  }
  if (create.noId) {
    process.stdout.write('{"unexpected":"shape"}\n');
    process.exit(0);
  }
  const seq = priorWhere(isCreate) + 1;
  process.stdout.write(`${JSON.stringify({ id: create.idBase ? `${create.idBase}-${seq}` : `pm-stub-${seq}` })}\n`);
  process.exit(0);
}

if (isTitleUpdate(args)) {
  const update = scenario.update ?? {};
  if ((update.invalidTypeTimes ?? 0) > priorWhere(isTitleUpdate)) {
    process.stderr.write('{"error":"invalid_argument_value","message":"Invalid type value: bug"}\n');
    process.exit(2);
  }
  if (update.fail) {
    process.stderr.write("update exploded\n");
    process.exit(1);
  }
  process.stdout.write("{}\n");
  process.exit(0);
}

// Dependency/parent wiring always succeeds unless the scenario says otherwise.
if (args.includes("--replace-deps") || args.includes("--clear-deps")
    || (args.includes("--dep") && args.includes("update"))) {
  if (scenario.depFail) {
    process.stderr.write("dep exploded\n");
    process.exit(1);
  }
  process.exit(0);
}
if (args.includes("--parent")) {
  if (scenario.parentFail) {
    process.stderr.write("parent exploded\n");
    process.exit(1);
  }
  process.exit(0);
}

if (args.includes("close")) {
  const close = scenario.close ?? {};
  if (close.fail) {
    process.stderr.write("close exploded\n");
    process.exit(1);
  }
  process.stdout.write("{}\n");
  process.exit(0);
}

if (args.includes("history-repair")) {
  const repair = scenario.historyRepair ?? {};
  if (repair.chmodItemReadonly) {
    const root: string = argValue("--path") ?? "";
    const pmId: string = args[args.indexOf("history-repair") + 1] ?? "";
    for (const entry of readdirSync(root)) {
      try {
        if (readdirSync(join(root, entry)).includes(`${pmId}.toon`)) {
          chmodSync(join(root, entry, `${pmId}.toon`), 0o444);
        }
      } catch {
        /* not a directory */
      }
    }
  }
  if (repair.fail) {
    process.stderr.write("repair exploded\n");
    process.exit(1);
  }
  process.exit(0);
}

process.stderr.write(`stub pm: unhandled argv ${JSON.stringify(args)}\n`);
process.exit(64);
