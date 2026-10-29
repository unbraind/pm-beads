# Dialect forecast acceptance evidence

Public source: `unbraind/pm-beads` main commit `f45fc815fa59a29cea17c0ec84ddb8d2da98554d`, tracker tree `cfebb171226b791dc432fe795643ca5bc15620fb`.

`node test/public-forecast-validation.ts` archives only the public tracker into a disposable directory outside git, warms SDK-derived caches, makes the copy read-only, removes git from PATH, and reads the complete item corpus through `PmClient.listAllComplete`. It neither imports into nor modifies that copy. A recursive fingerprint and a second complete SDK read prove the frozen copy stayed unchanged. Raw public records are not committed as fixtures.

| Measurement | Result |
| --- | ---: |
| SDK-read records | 113 |
| Native JSONL bytes | 72,353 |
| Full native-export contract fields | 13 |
| Exact / sidecar-dependent / unsupported fields | 9 / 0 / 4 |
| Explicit canonical projection fields passing the shared guard | 9 |
| Synthetic nested extensions preserved by matching sidecars | 113 |
| Full forecast JSON bytes | 2,598 |
| Analysis and guard measurement, milliseconds | 1,399.16 |

The full export's unsupported fields remain visible; the second contract explicitly projects supported canonical fields and does not claim to preserve the excluded source fields. The third contract adds one explicitly opted-in synthetic extension. Frozen tracker fingerprint: `0ff7047a88eb9c5e6758abf1e8251bf3244c794ed849c9b9694ce8268b2049f4`.

`node test/packed-forecast-acceptance.ts` tested one unchanged, 64-file artifact with host `@unbrained/pm-cli@2026.10.28`: npm global, Bun global, project-local, npx and bunx. Each launcher returned the same four-field report in both JSON and TOON, resolved the public SDK, and left its real non-git tracker empty. Artifact SHA-256: `5990506199db096820806df322561619d068164efbaac915b28f2b6ba5373533`. The artifact is temporary and untracked; no package is published.

Focused regressions cover both deterministic fixture contracts, every refusal code, finite count/output budgets, 512 seeded producer-contract cases, unsupported native nesting before both import entry points, and compiled JSON/TOON without git. All 17 exact source names and aliases pass six real import/export/upsert variants against independently created SDK reference state, including CRLF descriptions, labels, deadlines, parents, blockers and ambient focus. The existing 512-sequence native mutation/export/outgoing-delta/reconciliation/upsert model also validates the forecast guard at every state; it compares full native fields read back through SDK clients, includes older-input replays, and does not introduce a handwritten normalization oracle.

Behavioral revert proof used a disposable non-git source copy: changing the exact verdict to unsupported failed the fixture test; independently removing the unsupported-dialect guard failed the same test. Removing the native-edge domain guard independently failed its nesting regression. Restoring the fixed source passed. The working implementation was never reverted.

The unchanged CI release gate remains authoritative for npm and Bun, Node 22 and 26, and the package's existing 100% line/branch/function thresholds. CI results belong to the PR's exact head; this document does not replace those checks. No new journal, lease, replay key, state coordinator, mutation policy or concurrency-isolation claim is introduced.
