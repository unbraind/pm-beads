import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Shape of the fields this suite asserts on. Only the three dependency maps
 * matter here; the rest of the manifest is deliberately not modelled so an
 * unrelated field addition cannot fail this suite.
 */
interface DependencyManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

/** The published manifest, read from disk rather than imported so the assertions run against the same bytes npm publishes. */
const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as DependencyManifest;

/** The host CLI package whose placement in the manifest this suite governs. */
const HOST_CLI = "@unbrained/pm-cli";

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
  // `list-all` silently returned 10 of 682 items. A floor expresses exactly that
  // and nothing more.
  assert.match(
    peer,
    MINIMUM_VERSION_RANGE,
    `${HOST_CLI} must declare a ">=x.y.z" floor, not "${peer}": an exact peer pin makes every later CLI patch a peer conflict for consumers, while a floor still excludes the 2026.8.14 truncated-\`list-all\` regression`,
  );
  assert.ok(
    compareVersions(peer.replace(/^>=/, ""), "2026.8.15") >= 0,
    `${HOST_CLI} peer floor "${peer}" must be at least 2026.8.15: 2026.8.14 and earlier either truncate \`list-all\` to 10 items or predate the completeness receipt this package refuses on`,
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
 * cannot work against it. This test binds the two declarations together.
 */
test("the manifest host floor matches the package peer floor", () => {
  const extensionManifest = JSON.parse(
    readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
  ) as { pm_min_version?: string };
  const peer = manifest.peerDependencies?.[HOST_CLI] ?? "";
  assert.match(peer, /^>=\d+\.\d+\.\d+$/, "the peer declaration must be a concrete >= floor");
  assert.equal(
    extensionManifest.pm_min_version,
    peer.replace(/^>=/, ""),
    `manifest.json pm_min_version "${extensionManifest.pm_min_version}" must equal the ${HOST_CLI} peer floor "${peer}": they are the same claim to two different installers`,
  );
});
