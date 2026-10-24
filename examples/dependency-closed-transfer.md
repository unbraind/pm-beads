# Resume an exchange with late dependencies

Save this as `snapshot.jsonl`. The root appears before its blocker; selecting only
`bd-root` still includes both rows.

```jsonl
{"id":"bd-root","title":"Ship feature","dependencies":["bd-prerequisite"]}
{"id":"bd-prerequisite","title":"Prepare feature"}
```

In the receiving tracker, plan the exchange and drain one row per chunk:

```sh
pm beads transfer snapshot.jsonl --source team --select bd-root --chunk-size 1 --plan-out exchange.json --json
pm beads transfer --apply-plan exchange.json --json
pm beads transfer --apply-plan exchange.json --json
```

The first chunk publishes the prerequisite. The second publishes the root with a
resolved `blocked_by` edge. Killing the process at either point and repeating the
last command resumes the original SDK checkpoints. Repeating a completed plan
reports replayed chunks and creates no new items. `--chunks 2` can drain both new
chunks in one invocation. `complete: true` means every chunk has a receipt;
check `skipped` to distinguish an exchange containing foreign-record skips.

A typed bounded refusal can be inspected without parsing prose:

```sh
pm beads transfer snapshot.jsonl --source team --select bd-root --max-rows 1 --json
```

This exits 2 with `code: closure_limit` and
`omission: { included: 0, required: 2, limit: 1, dimension: maxRows }`.
Narrow the selection or raise the bound; a partial closure is never applied.

The SDK uses the same workflow without shelling out or requiring git:

```ts
import {
  planBeadsTransfer, snapshotBeadsTransferSettings, applyBeadsTransfer, BeadsTransferRefusal,
} from 'pm-beads';

try {
  const settings = await snapshotBeadsTransferSettings(pmRoot);
  const plan = planBeadsTransfer(jsonl, ['bd-root'], 'team', settings, { chunkSize: 1 });
  const receipt = await applyBeadsTransfer(pmRoot, plan, 'transfer-agent', {
    maxChunks: 2,
  });
  console.log(receipt.complete, receipt.transferred, receipt.skipped);
} catch (error) {
  if (error instanceof BeadsTransferRefusal) {
    console.log(error.code, error.remedy, error.omission);
  } else throw error;
}
```

Persist the exact plan JSON and protect it like the source tracker: it contains
selected descriptions. Changing its source, selection, values or bounds makes a
new exchange, rather than updating the earlier one. This workflow creates rows;
use acknowledged reconciliation to merge changes to existing rows. Mutable
`bead_id` provenance is never proof of ownership. Foreign occupied ids and their
unavailable dependents are preserved and skipped with explicit reasons. Resume
counts include peer completions while their pinned documents still match.

Chunks preserve completed creations on error and use the SDK's journal for
recovery. After an actual process kill the abandoned SDK lease can take 30 seconds
to expire; a `busy` refusal means retry the same plan. The SDK `lockWaitMs` option
can wait for that expiry (up to 60 seconds). Keep chunks within the coordinator's
lease lifetime. Optional SDK `onTransition` and `onRowTransition` observers run
under that lease; do not await another drainer from them. They support bounded
diagnostics and deliberate interruption at `before_create`, `created_unrecorded`
and `after_create`. The last boundary follows durable recording of the exact
created item ID and document hash.

The plan snapshots creation settings (including prefix, ID generation, schema,
validation and governance), template hashes and saved focus. Changing these before
apply or while rows remain uncreated returns `plan_settings_changed`; restore the
original settings before resuming. Fully created exchanges can replay after
settings change because every item is already pinned. Keep the identity ledger
at `transactions/beads-transfer/<digest>.json` alongside the plan and SDK journals.
Each source row records `pmId` before create and `itemHash` immediately afterward;
resume never recomputes it from live settings. Missing or corrupt ledgers refuse
with `invalid_journal`. Edited or deleted pinned items report `item_changed` skips,
including on completed-chunk replay, and are never recreated. An interrupted
create-to-ledger gap can recover only an unchanged, history-verified creation at
the recorded ID. Saved-plan validation preserves source descriptions
verbatim, including marker-like text, rather than stripping provenance again.

Source Beads ids live in the registered `bead_id` metadata field. Descriptions
remain verbatim, including marker-looking text. Legacy terminal envelopes are
read in memory without writes. Preview `pm beads migrate-identities`, then use
`--apply` to migrate unchanged revisions under their SDK item locks. Transfer apply
can include guarded migration with `--migrate-identities`, with tracked history and a stderr report;
present metadata always disables legacy decoding.
