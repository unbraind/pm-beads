# Acknowledged outgoing deltas

An acknowledged snapshot is a `BeadsAcknowledgement` returned by
`acknowledgeBeadsSnapshot` or `readBeadsAcknowledgement`. Save the baseline
before reconciling the next incoming snapshot. Read the advanced acknowledgement
after reconciliation and save it separately. Both receipts belong to the same
source. Preserve these JSON values verbatim: their revisions cover the exact
canonical records and bindings, including property order.

```ts
import { writeFile } from 'node:fs/promises';
import {
  readBeadsAcknowledgement,
  generateBeadsOutgoingDelta,
  replayBeadsOutgoingDelta,
  planBeadsReconciliation,
} from 'pm-beads';

// pmRoot is the initialized tracker's root; team is the source already acknowledged.
const baseline = await readBeadsAcknowledgement(pmRoot, 'team');
if (!baseline) throw new Error('Acknowledge the baseline first');
await writeFile('base.json', JSON.stringify(baseline));
// Reconcile source changes through the existing reviewed reconciliation workflow.
const target = await readBeadsAcknowledgement(pmRoot, 'team');
if (!target) throw new Error('Read the advanced acknowledgement first');
await writeFile('target.json', JSON.stringify(target));
const delta = generateBeadsOutgoingDelta(baseline, target);
const received = replayBeadsOutgoingDelta(baseline, delta);
const plan = await planBeadsReconciliation(receiverPmRoot, 'team', received.acknowledgement.records);
// Review plan and use the existing reconciliation apply API with current SDK revisions.
```

```sh
pm beads outgoing --base base.json --target target.json --json > delta.json
pm beads outgoing --base base.json --replay delta.json --json > received.json
# No sender base: full snapshot fallback, with the same target receipt.
pm beads outgoing --target target.json --json > full.json
# Default output is TOON; the alias has the same flags.
pm beads-outgoing --base base.json --target target.json
```

The replay result wraps `{ acknowledgement, unchanged }`. Save its
`acknowledgement` as the receiver's next baseline; it is not the wrapper itself.
Do this in the receiving application's own atomic revision-checked storage
transaction. This command never saves checkpoints, updates acknowledgements,
changes tracker items, or deletes records. Concurrent invocations have no shared
mutable state; callers retain ownership of their own snapshots and publication.

For 1,000 records with only a title and description change, `mode: delta`
contains exactly two `set` operations. Identity receipts include the source,
SHA-256 source digest, exact base and target revisions, target predecessor and
bindings. Unchanged bindings use `inheritBindings: true`, verified through the
exact base receipt, instead of sending the identity map again. Changed bindings
are sent in full. Legacy acknowledgements with no bindings retain that absence.

`unset` explicitly clears optional scalars or collections (`[]` for tags and
dependencies, empty string for scalar fields). `add` carries one complete record;
`remove` explicitly omits one source record from the reconstructed snapshot.
An omission remains a deletion proposal when handed to reconciliation. No core
item is deleted by transport. All 12 reconciliation fields are supported:
`title`, `status`, `type`, `priority`, `tags`, `assignee`, `parent`, `deadline`,
`dependencies`, `description`, `sprint`, `release`. Timestamps, annotations and
unknown provider fields remain outside this protocol; use their existing APIs.
Status strings are opaque: transport neither filters records nor infers lifecycle
meaning. The SDK status registry remains the authority for any lifecycle action.

Exact replay against the target revision returns `unchanged: true` after reading
and validating the supplied current acknowledgement. A different revision
refuses with `base_mismatch`; request a full snapshot by omitting `--base`.
Replaying an older delta against a newer revision also refuses. A forged target
refuses with `target_mismatch`. Cross-source inputs refuse with `source_mismatch`.
Malformed, oversized or unreadable input refuses with `invalid_input`. Each
`BeadsOutgoingRefusal` includes `code`, `remedy` and exit status 2. A named but
unreadable base is an error; it never silently becomes an empty base.

One strict schema checks both SDK and CLI boundaries. JSON envelopes reject
unknown keys, sparse arrays, duplicate record identities, conflicting operations,
invalid SHA-256 receipts and invalid priority strings (only integers 0–4 or the
canonical empty value). One shared declarative schema in `snapshot-schema.ts`
derives SDK types and validation for canonical records, live SDK records, and
schema-1 acknowledgements. Producers use that same schema before emitting or
persisting values. Live `pmId`, `version`, and `updatedAt` metadata is accepted and
preserved. `recordReceipts` carries changed metadata and property layout without
duplicating field values; dropping metadata is explicit in those receipts.

New snapshot, acknowledgement, reconciliation, transfer selection, dependency,
and diff identity orders use the total Unicode code-point comparator
`compareBeadsIdentities`. No locale collation or Unicode normalization is used.
Distinct `é` and `e\u0301`, case variants, and confusables remain distinct.
Historical acknowledgements may retain older array/property order: optional
`recordOrder` and layout receipts preserve their exact digest bytes rather than
rewriting them. A full snapshot also preserves historical order verbatim.

Bounds are 16 MiB serialized JSON, 20,000 records,
240,000 operations, 1 MiB per field string, 4,097 characters per collection entry,
and 256 characters per source name. The only numeric wire value is schema `1`;
all emitted numbers have a finite, bounded domain. Large results refuse instead
of truncating protocol data. Integrity digests detect accidental or inconsistent
content; an authenticated transport must establish who supplied a snapshot.

Run `node test/public-outgoing-validation.ts` to reproduce the read-only public
tracker measurement. Run `node --test test/outgoing*.test.ts` for acceptance,
seeded SDK differential sequences, boundary fuzz and real compiled CLI checks.
