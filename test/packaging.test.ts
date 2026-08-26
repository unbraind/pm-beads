import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  checkExtensionManifestCompatibility,
  type ExtensionManifestCompatibilityManifest,
} from "@unbrained/pm-cli/sdk";

/**
 * Shape of the fields this suite asserts on. Only the three dependency maps
 * matter here; the rest of the manifest is deliberately not modelled so an
 * unrelated field addition cannot fail this suite.
 */
interface DependencyManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
}

/** The published manifest, read from disk rather than imported so the assertions run against the same bytes npm publishes. */
const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as DependencyManifest;
/** Release workflow text inspected for host-owned changelog read controls. */
const releaseWorkflow = readFileSync(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);

/** The host CLI package whose placement in the manifest this suite governs. */
const HOST_CLI = "@unbrained/pm-cli";
/** Canonical-list behavior floor advertised to consumers. */
const REQUIRED_MINIMUM_VERSION = "2026.8.20";
/** Exact host version exercised by this checkout's gates. */
const REQUIRED_DEVELOPMENT_VERSION = "2026.8.24";

/**
 * An exact version: digits and dots only, with no range operator, so npm
 * resolves one version rather than "whatever is newest and still matching".
 */
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
/**
 * Shape required of the consumer-facing peer declaration: a `>=` floor.
 *
 * Deliberately distinct from {@link EXACT_VERSION}. The dev pin must be exact so
 * the gates are reproducible; the peer declaration must be a floor so a consumer
 * running any later host CLI is not a peer conflict.
 */
const MINIMUM_VERSION_RANGE = /^>=\d+\.\d+\.\d+$/;

/**
 * Order two dotted versions, returning a negative number when `left` precedes
 * `right`, zero when they are equal, and a positive number otherwise.
 *
 * Compares part by part and stops at the first difference, because comparing
 * the parts independently would rank `1.0.5` above `2.0.0` on the strength of
 * its final segment.
 */
function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * This package is a pure extension: the host CLI loads it, so the CLI must be
 * a peer the host satisfies, never a dependency npm installs underneath us.
 *
 * Declaring it in `dependencies` alongside the peer range let npm satisfy the
 * two independently: a consumer whose host pin sits below the dependency range
 * — while still inside the peer range this package declares — got their copy at
 * the tree root and a second, newer copy nested under this package. npm dedupes
 * only when the two ranges happen to overlap, so the tree was clean for some
 * host pins and skewed for others, which is why this survived review for as
 * long as it did.
 *
 * Skew is not cosmetic in this ecosystem: consecutive CLI releases have
 * disagreed about whether identical history bytes are fatal, a warning, or
 * invisible, so which copy loads can decide whether a workspace passes its own
 * gates.
 */
test("the host CLI is declared as a peer dependency and never as a runtime dependency", () => {
  assert.equal(
    manifest.dependencies?.[HOST_CLI],
    undefined,
    `${HOST_CLI} must not appear in dependencies: npm would install a second copy underneath this package whenever the consumer's host pin does not match this range`,
  );
  const peer = manifest.peerDependencies?.[HOST_CLI];
  assert.ok(peer, `${HOST_CLI} must be declared as a peer dependency so the host's copy is the one that loads`);
  // A FLOOR, not an exact pin. The dev declaration and the peer declaration have
  // different audiences and therefore different correct shapes.
  //
  // The dev pin decides which CLI this package's own gates run against, so it is
  // exact and reproducible. The peer declaration tells *consumers* which hosts
  // this plugin works with. An exact peer pin makes every other installed CLI a
  // peer conflict, so the next patch release breaks installs under strict peer
  // resolution until this package republishes — it converts a compatibility
  // statement into a lockstep release dependency.
  //
  // The thing actually worth excluding is the known-bad 2026.8.14, whose
  // Hosts before the canonical complete-read contract could silently truncate.
  // and nothing more.
  assert.match(
    peer,
    MINIMUM_VERSION_RANGE,
    `${HOST_CLI} must declare a ">=x.y.z" floor, not "${peer}": an exact peer pin makes every later CLI patch a peer conflict for consumers`,
  );
  assert.ok(
    compareVersions(peer.replace(/^>=/, ""), REQUIRED_MINIMUM_VERSION) >= 0,
    `${HOST_CLI} peer floor "${peer}" must be at least ${REQUIRED_MINIMUM_VERSION}: older hosts predate the canonical complete-read contract`,
  );
});

/**
 * The dev declaration is what CI installs to run `pm health --strict-exit` and
 * the rest of `release:check`, so it decides the verdict those gates report.
 *
 * A caret range is not a pin: it admits any later release, and three
 * consecutive CLI releases disagreed about whether the same bytes on disk are
 * fatal, a warning, or invisible. Pinning exactly keeps the gate reproducible.
 *
 * The peer declaration is governed differently (see the peer test above): it is
 * a `>=` floor, because it addresses consumers rather than this package's CI.
 * The relationship this test enforces is therefore *satisfaction*, not equality
 * — the dev pin must sit at or above the advertised floor. A dev pin below the
 * floor would make that floor a claim no gate ever tested; a dev pin above it is
 * both normal and fine, and is what every routine CLI bump produces.
 *
 * The assertion is deliberately on the *shape* and the ordering rather than on
 * today's literal version. Hardcoding the number would turn every Dependabot
 * bump into a test failure needing a second, lockstep edit, without buying any
 * safety: what matters is that the pin is exact and not older than what this
 * package tells consumers it needs.
 */
test("the host CLI dev dependency is pinned to an exact version at or above the declared peer floor", () => {
  const declared = manifest.devDependencies?.[HOST_CLI];
  assert.ok(declared, `${HOST_CLI} must be a devDependency so the gates have a CLI to run`);
  assert.match(
    declared,
    EXACT_VERSION,
    `${HOST_CLI} must be pinned exactly, not declared as the range "${declared}": the gate verdict depends on which CLI version runs it`,
  );
  assert.equal(declared, REQUIRED_DEVELOPMENT_VERSION, "development must exercise the currently approved exact host");

  // The dev pin must SATISFY the peer floor, not equal it. Equality would force
  // a lockstep edit of the consumer-facing floor on every routine Dependabot
  // bump; what actually matters is that the gates never run against a CLI older
  // than the floor this package advertises, because then the floor would be a
  // claim no gate ever tested.
  const peer = manifest.peerDependencies?.[HOST_CLI] ?? "";
  assert.match(
    peer,
    MINIMUM_VERSION_RANGE,
    "the peer floor must be a concrete \">=x.y.z\" range for the dev pin to be checked against it",
  );
  assert.ok(
    compareVersions(declared, peer.replace(/^>=/, "")) >= 0,
    `${HOST_CLI} dev pin ${declared} must be at or above the declared peer floor ${peer}: gating against a CLI older than the floor this package advertises would make that floor an untested claim`,
  );
});

/**
 * `package.json` and `manifest.json` state the same host-compatibility fact to
 * two different installers: npm reads the `peerDependencies` floor, the pm host
 * reads `manifest.json`'s `pm_min_version` at load time. Nothing binds them, so
 * they drift silently — each file stays internally consistent while the pair
 * disagrees. This package shipped exactly that: a manifest still advertising
 * `2026.7.28` while the code refused on a completeness receipt that only exists
 * from `2026.8.15`, meaning a 2026.7.28 host would load an extension that
 * cannot work against it. The current 2026.8.20 floor additionally guarantees
 * the canonical complete-read contract. This test binds the declarations.
 */
test("the manifest host floor matches the package peer floor", () => {
  const extensionManifest = JSON.parse(
    readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
  ) as { pm_min_version?: string };
  const peer = manifest.peerDependencies?.[HOST_CLI] ?? "";
  assert.match(peer, MINIMUM_VERSION_RANGE, "the peer declaration must be a concrete >= floor");
  assert.equal(
    extensionManifest.pm_min_version,
    peer.replace(/^>=/, ""),
    `manifest.json pm_min_version "${extensionManifest.pm_min_version}" must equal the ${HOST_CLI} peer floor "${peer}": they are the same claim to two different installers`,
  );
  assert.equal(extensionManifest.pm_min_version, REQUIRED_MINIMUM_VERSION);
});

test("the complete raw manifest satisfies the public SDK at minimum and development hosts", () => {
  const rawManifest = JSON.parse(
    readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
  ) as ExtensionManifestCompatibilityManifest;
  assert.deepEqual(
    checkExtensionManifestCompatibility(rawManifest, { pmVersion: REQUIRED_MINIMUM_VERSION }),
    { compatible: true, findings: [], pmVersion: REQUIRED_MINIMUM_VERSION },
  );
  assert.deepEqual(
    checkExtensionManifestCompatibility(rawManifest, { pmVersion: REQUIRED_DEVELOPMENT_VERSION }),
    { compatible: true, findings: [], pmVersion: REQUIRED_DEVELOPMENT_VERSION },
  );
});

test("every changelog and release-note read uses the local CLI with unbounded host controls", () => {
  for (const name of ["changelog", "changelog:full", "changelog:check", "release:notes"]) {
    const script = manifest.scripts?.[name];
    assert.ok(script, `package.json must declare ${name}`);
    assert.match(script, /--pm-bin \.\/node_modules\/\.bin\/pm/u);
    assert.match(script, /--pm-arg=--output-budget\s+--pm-arg=unbounded/u);
    assert.match(script, /--pm-arg=--output-limit\s+--pm-arg=unbounded/u);
  }
  const commands = releaseWorkflow.split("\n").filter((line) => line.includes("npx pm-changelog"));
  assert.equal(commands.length, 3);
  for (const command of commands) {
    assert.match(command, /--pm-bin \.\/node_modules\/\.bin\/pm/u);
    assert.match(command, /--pm-arg=--output-budget\s+--pm-arg=unbounded/u);
    assert.match(command, /--pm-arg=--output-limit\s+--pm-arg=unbounded/u);
  }
});
