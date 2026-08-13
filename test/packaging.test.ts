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
 * A peer range stating a concrete lower bound, as `>=X.Y.Z` or `^X.Y.Z`.
 *
 * The point is to exclude `*` and `x`, which declare a peer while promising
 * nothing: they would satisfy a bare presence check while telling a consumer
 * that any CLI version whatsoever will do.
 */
const CONCRETE_PEER_RANGE = /^(>=|\^)(\d+)\.(\d+)\.(\d+)$/;

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
  assert.match(
    peer,
    CONCRETE_PEER_RANGE,
    `${HOST_CLI} must declare a concrete peer floor, not the permissive range "${peer}": a wildcard declares a peer while promising a consumer nothing about which CLI versions actually work`,
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
 * The assertion is deliberately on the *shape* rather than on today's literal
 * version. Hardcoding the number would turn every Dependabot bump into a test
 * failure needing a second, lockstep edit, without buying any safety: what
 * matters is that the pin is exact and consistent with what this package tells
 * consumers it needs, not that it equals the version current when this test was
 * written.
 */
test("the host CLI dev dependency is pinned to an exact version at or above the declared peer floor", () => {
  const declared = manifest.devDependencies?.[HOST_CLI];
  assert.ok(declared, `${HOST_CLI} must be a devDependency so the gates have a CLI to run`);
  assert.match(
    declared,
    EXACT_VERSION,
    `${HOST_CLI} must be pinned exactly, not declared as the range "${declared}": the gate verdict depends on which CLI version runs it`,
  );

  // A pin below this package's own advertised floor would mean the gates ran
  // against a CLI the package tells consumers is too old to use.
  const floor = CONCRETE_PEER_RANGE.exec(manifest.peerDependencies?.[HOST_CLI] ?? "");
  assert.ok(floor, "the peer range must be concrete for the dev pin to be checked against it");
  const minimum = `${floor[2]}.${floor[3]}.${floor[4]}`;
  assert.ok(
    compareVersions(declared, minimum) >= 0,
    `${HOST_CLI} is pinned at ${declared}, below the peer floor of ${minimum} this package declares: the gates would run against a CLI consumers are told is too old`,
  );
});
