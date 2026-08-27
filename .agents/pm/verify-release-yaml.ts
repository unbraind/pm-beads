/**
 * Verify the release workflow's failure-alert job is wired correctly.
 *
 * The alert job is the only thing that turns a failed scheduled release into a
 * visible signal. It is therefore verified by parsing the workflow rather than
 * by matching text: a job that exists but has the wrong `needs`, the wrong `if`,
 * or no checkout would look correct in a diff and alert on nothing.
 *
 * @packageDocumentation
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

/** One step of a workflow job, in the shape this verifier inspects. */
interface WorkflowStep {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}

/** One workflow job, in the shape this verifier inspects. */
interface WorkflowJob {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  concurrency?: Record<string, unknown>;
  steps?: WorkflowStep[];
}

/** A parsed workflow file, reduced to the parts this verifier inspects. */
interface Workflow {
  jobs: Record<string, WorkflowJob>;
}

/**
 * Parse a workflow file into the shape this verifier inspects.
 *
 * @param path - Repository-relative workflow path.
 * @returns The parsed workflow.
 */
function readWorkflow(path: string): Workflow {
  const parsed: unknown = parse(readFileSync(path, "utf8"));
  assert.ok(
    parsed !== null && typeof parsed === "object" && "jobs" in parsed,
    `${path} did not parse into a workflow with jobs`,
  );
  return parsed as Workflow;
}

const workflow = readWorkflow(".github/workflows/release.yml");
const jobs = workflow.jobs;
const releaseJobs = Object.keys(jobs).filter((name) => name !== "alert-on-release-failure");
assert.ok(releaseJobs.length > 0, "no release jobs found");

const alert = jobs["alert-on-release-failure"];
assert.ok(alert, "missing alert-on-release-failure job");
assert.equal(alert.if, "failure() && github.event_name == 'schedule'");
assert.deepEqual(alert.concurrency, {
  group: "release-failure-alert-${{ github.repository }}",
  "cancel-in-progress": false,
});
const needs = Array.isArray(alert.needs) ? alert.needs : [alert.needs];
// Every release job must be a dependency: one missing from `needs` is a release
// path whose failure the alert job never observes.
assert.deepEqual([...needs].sort(), [...releaseJobs].sort());
assert.deepEqual(alert.permissions, { contents: "read", issues: "write" });

assert.ok(
  (alert.steps ?? []).some(
    (step) =>
      step.uses === "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
      && step.with?.ref === "${{ github.event.repository.default_branch }}"
      && step.with?.["persist-credentials"] === false,
  ),
  "alert job must check out the default branch without persisted credentials",
);
assert.ok(
  (alert.steps ?? []).some((step) => step.run === "bash scripts/alert-on-release-failure.sh"),
  "alert job must execute the tracked alert script",
);

const script = readFileSync("scripts/alert-on-release-failure.sh", "utf8");
assert.ok(script.includes("release-failure"), "dedup marker label missing from alert script");

const ciWorkflow = readWorkflow(".github/workflows/ci.yml");
assert.ok(
  Object.values(ciWorkflow.jobs).some((job) =>
    (job.steps ?? []).some((step) => step.run === "npm run verify:release-workflow")),
  "pull-request CI must execute the parsed release-workflow verifier",
);

console.log("release.yml alert job verified");
