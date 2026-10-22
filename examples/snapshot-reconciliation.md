# Review and apply a Beads snapshot

Start in a plain directory with a pm tracker and pm-beads installed. Use complete
snapshots from one external tracker, with stable ids. Treat an omitted optional
field as its empty/default value; use a different workflow for sparse patches.

```sh
pm init --prefix demo
pm beads import baseline.jsonl
# Capture the live descriptions and normalized defaults created by import.
pm beads export --output acknowledged.jsonl
pm beads reconcile acknowledged.jsonl --source team --acknowledge --json
pm beads reconcile incoming.jsonl --source team --plan-out review.json --json
# Inspect review.json, including all base/local/incoming conflict values.
pm beads reconcile --source team --apply-plan review.json --json
```

If `baseline.jsonl` contains `{"id":"bd-1","title":"Original"}`, a local title
change to `Local` and an incoming title change to `External` produce a `title`
conflict with those three values. Application refuses the entire conflicted plan.
Changing priority locally and title externally merges both edits. An incoming
omission produces a deletion proposal; applying the plan keeps the item and the
proposal. Resolve deletion decisions separately in the tracker and source.

Import uses the title as the description when that field is missing or empty.
The exported `acknowledged.jsonl` includes the stored description, so the initial
acknowledgement matches the tracker. Keep this normalized baseline when preparing
later full snapshots; omitted optional fields still mean empty/default values.

A plan is bound to both its acknowledged external base and the complete local
tracker revision. If either changes, generate a new plan and review it again.
Even an unrelated item's comment invalidates the saved tracker revision. Pause
ordinary writers during apply: the workspace transaction lock does not serialize
ordinary `pm update` or `PmClient` mutations, and an edit between an item's history
inspection and its mutation can be overwritten.
Never edit a plan file to bypass a refusal. Ordinary application failures use
core transaction compensation using exact history versions and preserve history;
ambiguous legacy version mappings refuse before writing. New items can remain closed
as compensation evidence. After an interruption, re-read the tracker and generate
a fresh plan. Resolve any compensation evidence before retrying conflicting data.

The full plan saved by `--plan-out` contains external field values and a copy of
every live tracker record in `plan.live`, including local descriptions of items
with no proposed changes. Store it with the same access controls and retention
policy as both the snapshots and the tracker. The default TOON/JSON report
returns counts, at most 20 compact rows, revisions, and the omitted-row count.
