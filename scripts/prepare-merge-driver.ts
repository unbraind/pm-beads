/**
 * Wire pm-cli's field-aware Git merge drivers into this clone's local Git config
 * on install/clone, but only when the `pm` CLI is actually available.
 *
 * Implemented in TypeScript executed directly by Node (not a POSIX
 * `if ...; then ...; fi` shell guard) so it runs identically on POSIX shells and
 * Windows cmd.exe (npm's default script shell) with no shell-operator parsing.
 *
 * Like the package's other gate scripts, the logic lives in pure exported
 * functions ({@link pmOnPath}, {@link isExecutableFile}, {@link runPrepare}) so
 * the suite can exercise every branch in-process — including the Windows-only
 * spellings, via the injectable platform parameter — while the thin main guard
 * at the bottom runs the real wiring exactly once per invocation.
 */

import { execSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The POSIX executable-mode bit, absent on Windows where PATHEXT rules instead. */
const X_OK = constants.X_OK;

/**
 * Whether a PATH candidate is a regular, executable file.
 *
 * Mirrors how a shell resolves a bare command name: directories and (on POSIX)
 * non-executable files are rejected, so a stray `pm` directory or data file
 * never makes the downstream `execSync` fail the whole install. On Windows the
 * executability question is keyed off PATHEXT by the shell, not a mode bit, so
 * any regular file counts.
 *
 * @param candidate - Absolute path to inspect.
 * @param platform - Injected so tests can exercise both platform branches.
 * @returns True when the path is an executable regular file for `platform`.
 */
export function isExecutableFile(candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  let stat;
  try {
    stat = statSync(candidate);
  } catch {
    return false; // ENOENT / not accessible
  }
  if (!stat.isFile()) return false;
  if (platform === "win32") return true; // Windows keys executability off PATHEXT, not a mode bit
  try {
    accessSync(candidate, X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is the `pm` executable resolvable on PATH?
 *
 * Resolved by inspecting PATH directly (never by executing `pm`), so a
 * present-but-broken CLI is NOT mistaken for "absent": absence means silent
 * skip, presence means run fail-loud below. npm prepends `node_modules/.bin`
 * to PATH for lifecycle scripts, so a devDep-installed pm is found. PATH
 * parsing mirrors shell semantics: an empty POSIX entry means the current
 * directory, and Windows entries may be wrapped in double quotes.
 *
 * @param options.pathEnv - The PATH string to scan (defaults to the environment).
 * @param options.pathExt - The Windows PATHEXT string (defaults to the
 *                          environment, falling back to the canonical list).
 * @param options.platform - Injected so tests can exercise both platforms.
 * @returns True when some PATH entry resolves to an executable `pm`.
 */
export function pmOnPath(
  options: { pathEnv?: string; pathExt?: string; platform?: NodeJS.Platform } = {},
): boolean {
  const platform = options.platform ?? process.platform;
  const isWindows = platform === "win32";
  // Split on the INJECTED platform's delimiter, not the host's: a Linux test
  // exercising Windows spellings passes a ";"-separated PATH.
  const listDelimiter = isWindows ? ";" : delimiter;
  const dirs = (options.pathEnv ?? process.env.PATH ?? "")
    .split(listDelimiter)
    .map((dir) => {
      let d = dir;
      if (isWindows && d.length >= 2 && d.startsWith('"') && d.endsWith('"')) {
        d = d.slice(1, -1);
      }
      // Empty component: current dir on POSIX; ignored on Windows.
      return d === "" ? (isWindows ? "" : ".") : d;
    })
    .filter((d) => d !== "");
  const exts = isWindows
    ? (options.pathExt ?? process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.trim()).filter(Boolean)
    : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      if (isExecutableFile(join(dir, `pm${ext}`), platform)) return true;
    }
  }
  return false;
}

/**
 * Outcome of one prepare run, held as plain fields so a test can inspect it.
 *
 * Captured rather than written, mirroring the package's other scripts' result
 * contracts; the main guard applies the outcome to the process.
 */
export interface PrepareResult {
  /** Process exit code the run would produce (0 on both outcomes today). */
  readonly exitCode: number;
  /** True when `pm` was found and `pm merge install` was executed. */
  readonly wired: boolean;
  /** Human-readable summary of what the run decided. */
  readonly detail: string;
}

/**
 * Run the merge-driver wiring decision.
 *
 * When `pm` is not installed (a production / `--omit=dev` install, or a
 * consumer machine without the CLI) the wiring is skipped silently — exit 0,
 * no output — because a missing optional devDependency must never fail an
 * install. When `pm` IS present, `pm merge install` runs fail-loud: a genuine
 * failure (broken or incompatible CLI) propagates as a thrown error so the
 * install surfaces it instead of swallowing it.
 *
 * @param options.exec - Injectable executor over `pm merge install` (defaults
 *                       to a real `execSync`, inherited stdio).
 * @returns What the run decided, for callers that report it.
 */
export function runPrepare(
  options: { exec?: (command: string) => void } = {},
): PrepareResult {
  if (!pmOnPath()) return { exitCode: 0, wired: false, detail: "pm not found on PATH; skipping merge-driver wiring" };
  const exec = options.exec ?? ((command: string) => {
    execSync(command, { stdio: "inherit" });
  });
  exec("pm merge install");
  return { exitCode: 0, wired: true, detail: "wired pm merge drivers via `pm merge install`" };
}

/**
 * Whether this module is the process entry point rather than a test import.
 *
 * Same realpath-canonicalised comparison the sibling gates use: a launcher
 * reaching this file through a symlink still compares equal, a test import
 * declines to run the wiring, and an unresolvable `argv[1]` propagates rather
 * than silently skipping the wiring. See docstring-gate.ts for the full
 * rationale; the three scripts share the contract deliberately.
 *
 * @param argv - The process argv to inspect.
 * @param moduleUrl - The `import.meta.url` of this module.
 * @returns True when `argv[1]` and `moduleUrl` canonicalise to the same path.
 * @throws Whatever `realpathSync` throws when either path cannot be resolved.
 */
export function isMainInvocation(argv: readonly string[], moduleUrl: string): boolean {
  const entry = argv[1];
  if (entry === undefined) return false;
  return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
}

if (isMainInvocation(process.argv, import.meta.url)) {
  const result = runPrepare();
  if (result.wired) process.stdout.write(`${result.detail}\n`);
  process.exitCode = result.exitCode;
}
