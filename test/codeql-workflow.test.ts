import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const codeqlWorkflow = readFileSync(
  new URL("../.github/workflows/codeql.yml", import.meta.url),
  "utf8",
);
const dependabotConfig = readFileSync(
  new URL("../.github/dependabot.yml", import.meta.url),
  "utf8",
);

test("every CodeQL action uses one pinned release", () => {
  const references = [...codeqlWorkflow.matchAll(/github\/codeql-action\/[^@\s]+@([0-9a-f]{40})/g)];

  assert.ok(references.length > 1, "the workflow should use multiple CodeQL actions");
  assert.equal(
    new Set(references.map((reference) => reference[1])).size,
    1,
    "all CodeQL actions must use the same release",
  );
});

test("Dependabot groups CodeQL action updates", () => {
  const githubActions = /  - package-ecosystem: "github-actions"[\s\S]*?(?=\n  - package-ecosystem:|$)/.exec(
    dependabotConfig,
  )?.[0];

  assert.ok(githubActions, "Dependabot should configure the github-actions ecosystem");
  assert.match(
    githubActions,
    /groups:\s*\n\s+codeql-action:\s*\n\s+patterns:\s*\n\s+- "github\/codeql-action\*"/,
  );
});
