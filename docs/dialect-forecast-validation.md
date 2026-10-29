# Dialect forecast acceptance evidence

Public source: `unbraind/pm-beads` main commit `7f3762d942caeb2fb736086132a17268a4e6f622`, tracker tree `cfebb171226b791dc432fe795643ca5bc15620fb`.

`node test/public-forecast-validation.ts` archives only the public tracker into a disposable directory outside git, warms SDK-derived caches, makes the copy read-only, removes git from PATH, and reads the complete item corpus through `PmClient.listAllComplete`. It neither imports into nor modifies that copy. A recursive fingerprint and a second complete SDK read prove the frozen copy stayed unchanged. Raw public records are not committed as fixtures.

| Measurement | Result |
| --- | ---: |
| SDK-read records | 113 |
| Native JSONL bytes | 73,013 |
| Full native-export contract fields | 13 |
| Exact / sidecar-dependent / unsupported fields | 9 / 0 / 4 |
| Explicit canonical projection fields passing the shared guard | 9 |
| Synthetic nested extensions preserved by matching sidecars | 113 |
| Full forecast JSON bytes | 2,598 |
| Analysis and guard measurement, milliseconds | 14,008.70 |

The full export's unsupported fields remain visible; the second contract explicitly projects supported canonical fields and does not claim to preserve the excluded source fields. The third contract adds one explicitly opted-in synthetic extension. Frozen tracker fingerprint: `1f864f14da5e24bd7447dbcec6a7163a19b3e214f4ef8efa96e7ae20c8ea54ee`.

`node test/packed-forecast-acceptance.ts` tested one unchanged, 72-file artifact with host `@unbrained/pm-cli@2026.10.28`: npm global, Bun global, project-local, npx and bunx. Each launcher returned the same four-field report in JSON and TOON, resolved the public SDK, and exercised all three review classes in a real non-git tracker: stale custody refuses, dangling/cyclic parents refuse through native/legacy commands in both formats, and explicit empty label aliases clear SDK-read tags through import/export/replayed upsert. Matching custody survives actual import/export/restore. Every launcher also imports an acyclic parent rewire against retained receiver links and verifies both final parents through SDK reads. Artifact SHA-256: `d127a2f189db295795837e3b488989391f9d1cfdf6399e74067ddff517fbb54b`. Final workspace packaging is checked against these exact validated bytes. The artifact is temporary and untracked; no package is published.

Focused regressions cover both deterministic fixture contracts, every refusal code, finite count/output budgets, 512 seeded producer-contract cases, unsupported native nesting before both import entry points, and compiled JSON/TOON without git. All 17 exact source names and aliases pass six real import/export/upsert variants against independently created SDK reference state, including CRLF descriptions, labels, deadlines, parents, blockers and ambient focus. Review regressions additionally cover 512 sidecar presence/value/deletion/replay transitions and 512 parent graphs against an independent closed-graph model. Real SDK checks cover filtered and dangling parents, cycles through retained receiver ancestry, skipped legacy targets, repeated identities, anonymous rows, reconciliation preflight, every empty-label alias and empty optional planning aliases. The existing 512-sequence native mutation/export/outgoing-delta/reconciliation/upsert model now dirties receiver tags after export and also validates the forecast guard at every state; it compares full native fields read back through SDK clients, includes older-input replays, and does not introduce a handwritten normalization oracle.

Behavioral revert proof used a disposable non-git source copy: changing the exact verdict to unsupported failed the fixture test; independently removing the unsupported-dialect guard failed the same test. Removing the native-edge domain guard independently failed its nesting regression. Restoring the fixed source passed. Seven additional independent behavioral reverts removed current-value custody, source-parent topology, effective-upsert topology, reconciliation topology, empty-label import, empty-label export and optional planning clears. Each failed its targeted assertion. Restoring the fixed disposable source passed all 7 regression tests with zero skips. An eighth revert removed optional SDK NOT_FOUND handling for parent previews; it failed the complete-parent-preview assertion. Restoring that source passed all 8 review regressions, zero skips. Absent and empty tracker roots remain valid for complete source-only previews. A ninth revert restored retention of explicitly supplied nonempty parents in the scalar pass. It failed a valid acyclic rewire (one link set instead of two). The final source passes all 9 review regressions with zero skips, including all six input orders through both importer aliases. Supplied parent links now clear in pass one and the validated final graph links in pass two; omitted parents are retained. The working implementation was never reverted.

The unchanged CI release gate remains authoritative for npm and Bun, Node 22 and 26, and the package's existing 100% line/branch/function thresholds. CI results belong to the PR's exact head; this document does not replace those checks. No new journal, lease, replay key, state coordinator, mutation policy or concurrency-isolation claim is introduced.

The revert commands used `node --test --test-concurrency=2 --test-name-pattern <pattern> test/forecast-regressions.test.ts` in a disposable copy, with these patterns:

| Reverted behavior | Pattern | Result |
| --- | --- | --- |
| Current-value sidecar custody | `512 sidecar` | Assertion failure |
| Closed source parent graph | `512 parent` | Assertion failure |
| Effective upsert ancestry | `upsert validates composed` | Assertion failure |
| Reconciliation ancestry | `reconciliation refuses invalid` | Assertion failure |
| Empty-label import | `all label aliases` | Assertion failure |
| Empty-label export | `all label aliases` | Assertion failure |
| Empty planning-field replacement | `all label aliases` | Assertion failure |
| Optional uninitialized-tracker preview | `complete parent previews` | Assertion failure |
| Parent rewires independent of input order | `acyclic parent rewires` | Assertion failure |
