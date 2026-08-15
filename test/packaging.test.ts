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
    EXACT_VERSION,
    `${HOST_CLI} must declare an exact peer pin, not the range "${peer}": a floating floor is how the 2026.8.14 truncated-\`list-all\` regression reached this package with no diff to review`,
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
 * The same argument now covers the peer declaration (see the peer test above):
 * the 2026.8.14 `list-all` truncation regression shipped to consumers through
 * the floating peer floor, so both blocks carry the SAME exact pin and this
 * test enforces that they agree — a pin below the peer declaration would gate
 * against a CLI this package tells consumers is too old, and a pin above it
 * would advertise a floor the gates never actually ran against.
 *
 * The assertion is deliberately on the *shape* and cross-consistency rather
 * than on today's literal version. Hardcoding the number would turn every
 * Dependabot bump into a test failure needing a second, lockstep edit, without
 * buying any safety: what matters is that the pin is exact and consistent with
 * what this package tells consumers it needs, not that it equals the version
 * current when this test was written.
 */
test("the host CLI dev dependency is pinned to an exact version at or above the declared peer floor", () => {
  const declared = manifest.devDependencies?.[HOST_CLI];
  assert.ok(declared, `${HOST_CLI} must be a devDependency so the gates have a CLI to run`);
  assert.match(
    declared,
    EXACT_VERSION,
    `${HOST_CLI} must be pinned exactly, not declared as the range "${declared}": the gate verdict depends on which CLI version runs it`,
  );

  // The dev pin and the peer declaration must agree exactly now that both are
  // concrete: the floor this package advertises to consumers is the same CLI
  // the gates actually run against.
  const peer = manifest.peerDependencies?.[HOST_CLI] ?? "";
  assert.ok(
    EXACT_VERSION.test(peer),
    "the peer range must be concrete for the dev pin to be checked against it",
  );
  assert.ok(
    compareVersions(declared, peer) === 0,
    `${HOST_CLI} dev pin ${declared} and peer pin ${peer} must be the SAME exact version: a dev pin above the peer pin would gate against a CLI this package tells consumers is too old, and below it would advertise a floor the gates never ran against`,
  );
});
