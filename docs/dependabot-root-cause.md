# Dependabot prepare coverage regression

Dependabot #144 refreshes the canonical `scripts/prepare-merge-driver.ts`
when pm-ops changes. The pm-ops 2026.10.12 template adds an early return for
`npm_command=pack` and `npm_command=publish`. The install-only test harness
never exercised either artifact path. This is shared with
pm-ado#30; neither SDK behavior nor V8 counting caused the loss.

The failing CI job names line 28, the artifact notice, at 98.65% lines and
75% branches in the launcher. Last green main CI run 38941937354 used the old
template and measured 100% of each configured dimension.

The tests now select the lifecycle command explicitly and exercise both pack
and publish against real temporary Git checkouts with the installed pm-ops.
Each configures the declared drivers through the ci path, records Git config,
runs artifact prepare, and verifies successful execution and unchanged config.
The current-pin focused suite passes 10/10. The tests work with both template
generations, asserting behavior rather than
hard-coding a dependency version or its notice. Canonical byte equality and
all existing broken-install checks remain enforced. Dependency pins and
coverage thresholds remain unchanged.

The full local baseline attempt reached the coverage runner process timeout
under shared-host load. Focused behavioral revert proof keeps the added tests
but removes only lifecycle-command injection from the helper: the launcher
fails at 98.65% lines and 75% branches, with line 28 uncovered. Restore the
helper for the complete bumped-tree release checks. This is
a test-only repair: reverting the changed harness and added cases is the
behavioral revert that restores the failure.

Validation uses `npm run release:check` and `bun run release:check`, each with
an empty HOME, `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, on
the fix plus Dependabot's exact dependency and generated-template diff.
The fix branch retains its dependency pins for separate PR CI checks.

Full scratch-tree validation is run on a temporary GitHub validation branch
with the exact dependency and generated-template diff applied to the fix.
This avoids shared-host process timeouts while retaining the complete release
gates and isolated Git identity. The temporary validation workflow uses only
read permissions and runs both release-check commands; it is not part of the
fix PR.

The same artifact lifecycle gap was also confirmed in pm-changelog#248 under
full CI-identity validation, and is fixed there with the same tests.

## Completed validation

[Full npm and Bun scratch-tree gates](https://github.com/unbraind/pm-beads/actions/runs/39022664012)
at `7c7493003bfb2447a7762550a84768b38c9903bb` both passed. Each command passed 354/354 tests with zero failures,
skips, cancellations or todos. Lines, branches and functions measured 100%.

Both commands used a fresh identity HOME and disabled global/system Git config:

```sh
env HOME="$(mktemp -d)" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 npm run release:check
env HOME="$(mktemp -d)" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 bun run release:check
```

The validated tree contains the fix plus the original Dependabot dependency
and generated-template changes. The validation workflow is excluded from the
fix branch. Local full runs interrupted by host load are not pass evidence.
