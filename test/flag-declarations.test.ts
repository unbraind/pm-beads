import assert from "node:assert/strict";
import test from "node:test";

import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

import extension from "../index.ts";

/**
 * Well-formed long-flag token: two leading dashes, then lowercase
 * alphanumerics separated by single hyphens.
 */
const LONG_FLAG_PATTERN = /^--[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Collects every flag this extension declares, paired with the command it
 * targets.
 *
 * Flags passed inline to `registerCommand` and flags contributed standalone via
 * `registerFlags` are both normalized by the host into `registrations.flags`
 * and keyed by target command, so that single registry is the complete
 * declared surface.
 *
 * Host-owned flag collisions (`--json`, `--quiet`, `--author`, …) are
 * deliberately not re-checked here: since pm-cli 2026.7.28 the loader rejects
 * them outright, and the smoke suite already asserts `activation.failed` is
 * empty. This suite covers only what the host does not validate.
 */
const declaredFlags = async (): Promise<readonly { command: string; flag: string }[]> => {
  const ext = await createExtensionTestHarness(extension, {
    name: "pm-beads",
    capabilities: ["commands", "schema", "importers"],
  });
  assert.deepEqual(ext.activation.failed, [], "activation must not fail");
  return ext.activation.registrations.flags.flatMap((group) =>
    group.flags
      .filter((flag): flag is typeof flag & { long: string } => typeof flag.long === "string")
      .map((flag) => ({ command: group.target_command, flag: flag.long })),
  );
};

test("the extension declares at least one flag", async () => {
  // Without this, the well-formedness assertion below would pass vacuously if a
  // refactor ever stopped flags reaching the registry.
  assert.ok((await declaredFlags()).length > 0, "expected pm-beads to register flags");
});

test("every declared flag is a well-formed long-form token", async () => {
  // pm stores the declared token verbatim and validates neither its prefix nor
  // its shape, so `verbose` or `-v` in a `long` field activates cleanly and
  // silently. Only this suite catches that authoring typo.
  const malformed = (await declaredFlags()).filter(({ flag }) => !LONG_FLAG_PATTERN.test(flag));
  assert.deepEqual(
    malformed,
    [],
    `Flags must be declared as --long-form tokens; pm accepts any string here without complaint: ` +
      `${malformed.map(({ command, flag }) => `${command} ${flag}`).join(", ")}`,
  );
});
