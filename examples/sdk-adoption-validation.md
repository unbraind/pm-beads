# SDK adoption validation

The October 25 audit named two local implementations. The immutable baseline
is `556352541cf8a9e01c9813534f9f5896d3ba4235` on main.

| Audit finding | SDK replacement | Evidence |
| --- | --- | --- |
| `index.ts:628-655`, `locateItemFile` scans folders and suffixes | Already removed on baseline main by PR #165. `item-access.ts` uses `locateItem` with configured prefix, format and `resolveItemTypeRegistry(settings).type_to_folder`; reads and verification also use the SDK. | `test/item-access.test.ts`, `test/tracker-configurations.test.ts`; public differential compares every verified item document and history verification. |
| `index.ts:1972` onward, `assertListAllComplete` duplicates complete-list certification | `inspectCompleteListResult` owns all certification predicates. The small adapter retains package error type, command and count/total context. Async initialized workflows already use `PmClient.listAllComplete`; synchronous public API and legacy fallback retain their subprocess boundary. | `test/list-all-refusals.test.ts`, `test/smoke.test.ts`; public differential compares full and filtered serialization, item documents, export, workspace diff and validation. |

One package compatibility predicate remains: reject the presence of either
budget disclosure key, even for an informational value. `inspectCompleteListResult`
checks actual compaction/omission and has no strict-disclosure-presence option
(e.g. `rejectBudgetDisclosures`). The adapter retains only that presence rule;
it does not repeat SDK certification logic. The package tracker records this
SDK API gap for the orchestrator. Existing source timestamp/backend
gaps remain tracked separately by `pm-beads-z4k0`; cold SDK cache creation is
tracked by `pm-beads-w90u`.

Build the candidate and run the differential harness with a public package
checkout and its GitHub repository name:

```sh
npm run build
node test/public-sdk-differential.ts
node test/public-sdk-differential.ts <public-package-checkout> unbraind/pm-changelog
```

The harness confirms the source repository is public, archives an exact source
commit, builds the immutable main baseline with the same pinned dependencies,
and executes both builds against the same non-git tracker copy. Only Node and
pm are available on the subprocess PATH; a git discovery ceiling is set.
SDK-derived caches are warmed before making the copy read-only, because the
pinned SDK initializes them on cold reads. Every tracker path and byte is
fingerprinted before and after the compared operations. Neither source
checkout nor copied tracker items/history are changed by the workload.

Successful outputs must compare deeply equal. Fifteen receipt cases also
compare baseline and candidate admission. Eleven intentional stricter cases cover
missing scope, unknown filters, runtime filters, terminal exclusion, absent strict-read proof,
absent no-truncate proof, an applied limit, selected fields, missing fields
receipt, read-session suppression, and whitespace-equivalent duplicate IDs.
An informational non-omitting budget receipt remains refused by the package's
compatibility rule. Complete output remains accepted;
truncated and omitted output remain refused with SDK diagnostics.

`README.md` documents the error presentation and SDK policy differences.
The regression suite retains the original refusal cases and adds the stricter
receipts. Reverting only `assertListAllComplete` must make those new behavioral
tests fail; the package tracker records the command and observed counts.

## Recorded public differential results

| Public repository | Source commit | Tracker tree | Items | Equal output groups | Receipt cases | Tracker unchanged |
| --- | --- | --- | ---: | ---: | ---: | --- |
| pm-beads | `556352541cf8a9e01c9813534f9f5896d3ba4235` | `7e3fa14a5dc838480739053fc19f8c0519ea54bd` | 102 | 6 | 15 | yes |
| pm-changelog | `fa8a8a1d0af97797e6a34a78bdd6b9b30242378e` | `e7733dfe89c9e72355fce4d8df0087a398754ab7` | 197 | 6 | 15 | yes |

Across 299 public items there were zero successful-output differences, eleven
intentional stricter receipt cases on each corpus. The informational budget
receipt retains its original refusal. Baseline and candidate used the pinned
pm SDK 2026.10.20. Every item document and history verification was compared.

Behavioral revert: restoring only baseline `assertListAllComplete` caused
11/11 new selected tests to fail with missing expected refusals. Restoring
the SDK adapter passed all 58 receipt/seam tests. The focused suite passed
242/242 with zero skips before the extra budget-disclosure compatibility
case, including the 20 configuration matrix cases and four item-access cases
for the already-adopted locator.

## Full release gates

The isolated local `npm run release:check` and `bun run release:check` each
passed 505/505 tests, zero skips/failures/cancellations, with 100% lines,
branches and functions across all 14 required source files. Typecheck, build,
docstring lint, production audit (zero vulnerabilities), package dry-run,
changelog, attestation and release-date checks all passed. Thresholds and
dependency pins were unchanged.

[CI run 40211860833](https://github.com/unbraind/pm-beads/actions/runs/40211860833)
passed npm and Bun gates on both Node 22 and Node 26 for implementation commit
`0cc7c326e8064e101424c8d891653918b104fe36`, with the same 505/505 counts and
100% coverage in all four runs. The review handoff changes only evidence and
tracker state; production code remains identical. Final-head CI is linked
from [PR #174](https://github.com/unbraind/pm-beads/pull/174).

Production source delta: 172 deleted lines and 23 added lines in `index.ts`,
149 net lines removed. The package retains only the documented budget-key
absence compatibility rule because the SDK has no strict-disclosure-presence
option. The locator was already SDK-owned on the immutable baseline.
