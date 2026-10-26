# Released compatibility goldens

Captured on 2026-10-26 from the then-latest published `pm-beads@2026.10.26`, obtained with `npm pack pm-beads@latest --pack-destination <scratch> --json`, then extracted with tar. No working-branch producer generated these artifacts. The npm tarball is not committed. The generator pins and verifies the captured SDK host version separately from this branch's current development dependencies.

- npm SHA-1: `2d503a76557768c37eff3ac6a4861129131eb462`
- npm integrity: `sha512-NnWeui1YXHoWTex8xb1FEjVEZHvChMbtpittwd7WpcmgBfbqpZcLqxlLxplFvw2U5z5uT+d0R4jeL+wE3R8AHg==`
- Tarball SHA-256: `17761fded389c1ba91f33223180eb3a44a06ae698c1498d583dfa5c4e5347436`
- Host: pinned `@unbrained/pm-cli@2026.10.20`, satisfying the released package peer range.

[The exact generator](generate.md) documents the commands and producer APIs. Its installed CLI path uses the pinned host loading the extracted released extension, with git absent from PATH. The SDK path imports the extracted released `dist/transfer.js` and `dist/reconcile.js`. Every tracker is an SDK-initialized scratch project outside git. Ids and titles mix BMP, U+10000, U+E000, composed and combining characters; dependency lists contain both U+10000 and U+E000.

| Fixture | Released producer state |
| --- | --- |
| `cli-transfer.json` | CLI-generated schema-1 plan, one completed chunk, identity journal and SDK checkpoints |
| `sdk-transfer.json` | SDK-generated schema-1 plan, interrupted bootstrap after identity allocation, original identity journal and checkpoint |
| `sdk-reconciliation.json` | Released live acknowledgement, schema-1 reconciliation plan, raw reservation ledger and prepared SDK checkpoint |

Each JSON container has its own fixture schema 1 and records the released producer. Its `tracker` map stores original durable UTF-8 file contents. `expected` is the old version's canonical snapshot read through the SDK after completion, retaining all native field values and the exact core identity. Generated timestamps/history hashes are preserved in the captured input; new creation timestamps are not part of the semantic state comparison.

The tests restore these files verbatim, validate/resume with the new package and compare the same SDK producer output to the old result. They verify the original plan digest, identity pins, journal version, checkpoint transaction identity, replay and final acknowledgement revision. The old unversioned reconciliation reservation map is recognized solely as the implicit schema-1 format selected by its owning plan. It is never rewritten as schema 2. New reservation envelopes include explicit schema and plan digest.

Golden SHA-256 values:

```text
ed85ae49adb0a54c02bda924e60bd6adbe47d86b5cf160e7a322f084680b84dd  cli-transfer.json
a1c2493afe554207ec2a0d1e6d3718cec5f1843d27452ae0da5cdf36dd4929b5  sdk-transfer.json
924419b9df0169d7cccf080936ad71823d3bf985f05a06831f723285b78d5833  sdk-reconciliation.json
```

Normal tests never regenerate these files or fetch npm. Run `node --test --test-concurrency=2 test/compat.test.ts`.
