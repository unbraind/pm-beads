# Fleet CI v2

Required checks stay `test (22)` and `test (26)` on GitHub-hosted Ubuntu.
PRs and dispatch run quick depth; superseded PRs cancel. Every PR job has a
25-minute timeout. Dispatch always selects the code path.

| Check | Code PR 22 | Code PR 26 | Docs/tracker-only PR, both | Deep 22 + 26 |
| --- | --- | --- | --- | --- |
| npm ci / merge-driver prepare | yes | yes | yes | yes |
| Strict pm health / required merge drivers | — | yes | yes | yes |
| Build and test typecheck | yes | via coverage | build for executable docs | npm + Bun |
| Test suite | quick | quick via coverage | identity, packaging, metadata, reconciliation CLI/docs | full npm + Bun |
| Typecheck and docstrings | — | yes | — | npm + Bun |
| Coverage, unchanged 100% lines/branches/functions | — | quick | — | full npm + Bun |
| Release workflow contract | via tests | gate | — | npm + Bun |
| Production dependency audit | — | yes | — | npm + Bun |
| Pack dry-run / file list | — | yes | ignore scripts, after docs build | npm + Bun |
| Changelog consistency | — | yes | yes | npm + Bun |
| Publish attestation | via tests | gate | yes | npm + Bun |
| Release changelog date | via tests | gate | — | npm + Bun |
| Bun graph install, compiled module load, bunx CLI smoke | — | yes | — | graph install plus full Bun gate |
| CodeQL | matching paths | separate workflow | filtered | main matching paths and weekly scan |

The cheap path includes a build because the README and reconciliation example
are executed against the compiled extension by `test/reconcile-cli.test.ts`.
It keeps all existing identity/privacy checks, metadata assertions, changelog
validation and package file enumeration. Executable tracker files select the
code path. There is no standalone lint script or additional secret gate.

Deep runs on main pushes, dispatch and daily at 01:29 UTC, away from release
(03:23 and hourly :41) and weekly CodeQL (Monday 02:11). Jobs `deep (22)` and
`deep (26)` run both original npm and Bun release gates, full depth, with
`PM_TEST_TIME_SCALE=3`, a 120-minute timeout and cancellation per ref.
`PM_LOCAL_DEEP=off` selects GitHub-hosted Ubuntu; otherwise jobs queue for
`self-hosted,pm-local`. Local runners use their persistent npm cache and installed
Bun; hosted runners restore npm cache and install Bun. Bun's version is logged.
No release workflow or verifier is changed.

Quick runs the first 52 of 512 property cases, 205 of 2,048 fuzz cases, and
25 of 64 cases. Full is the default when depth is unset. Boundary-size fixtures
and per-case assertions stay intact. Harness deadlines validate a finite positive
scale and round up to integer milliseconds before spawning. The declared
30-second repair product ceiling remains unscaled; CPU-growth checks also retain
their original contract.

`test/packed-repair-acceptance.ts` and `test/packed-forecast-acceptance.ts`
already prove npm/Bun global installation, project installation, npx and bunx
against real tarballs, but are manual acceptance scripts outside the original
release gate. The PR tier therefore explicitly runs Bun install, a compiled-module
load and bunx host CLI smoke; it does not claim full packed acceptance from this
smoke. No old gate check is removed; the full original gates remain in deep.

## Measurements

Owner fleet baseline: 39,929 runner-minutes in 24 hours; typical PR wall time
45–90 minutes, including about 28 minutes queueing for 20 hosted jobs.
Successful main run [43704644296](https://github.com/unbraind/pm-beads/actions/runs/43704644296)
repeated npm/Bun release gates on both Node versions. Its log archive reports
up to 338.876 seconds for the 512-sequence outgoing property test and
45.886 seconds for a seeded transfer pipeline. These are individual test timings,
not a new full-depth local measurement. Full depth is intentionally left to deep.
Quick coverage and PR CI observations are recorded in the linked tracker item
and PR; pending jobs are not reported as passing.

Local quick coverage passed all 21 required source files at 100% lines, branches
and functions in 754.15 seconds (12m34s); touched tests passed 96/96 in 359.605
seconds, with no skips. These local times are not directly comparable to hosted
full-matrix execution times.

The attestation auditor reads shebangs in every tracked file, including docs and
tracker files, so the docs path also runs publish-attestation verification.

Both required checks passed on `1e4be3d` in
[run 43734511967](https://github.com/unbraind/pm-beads/actions/runs/43734511967).
Jobs API queue-inclusive wall / execution times: Node 22 18m13s / 2m30s;
Node 26 44m57s / 2m26s. The final receipt-only commit does not change the
validated source or workflows and its CI is not awaited.

CodeQL ignores inert tracker data extensions while keeping executable tracker scripts eligible on PRs and main pushes.
