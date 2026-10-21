# Review and apply a Beads snapshot

Start in a plain directory with a pm tracker and pm-beads installed. Use complete
snapshots from one external tracker, with stable ids. Treat an omitted optional
field as its empty/default value; use a different workflow for sparse patches.

```sh
pm init --prefix demo
pm beads import baseline.jsonl
pm beads reconcile baseline.jsonl --source team --acknowledge --json
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

A plan is bound to both its acknowledged external base and the complete local
tracker revision. If either changes, generate a new plan and review it again.
Never edit a plan file to bypass a refusal. Ordinary application failures use
core transaction compensation and preserve history; new items can remain closed
as compensation evidence. After an interruption, re-read the tracker and generate
a fresh plan. Resolve any compensation evidence before retrying conflicting data.

The full plan contains external field values. Store it with the same access
controls and retention policy as the snapshots. The default TOON/JSON report
returns counts, at most 20 compact rows, revisions, and the omitted-row count.
