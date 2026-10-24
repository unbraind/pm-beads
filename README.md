# pm-beads

Beads JSONL importer **and exporter** for [pm-cli](https://github.com/unbraind/pm-cli).

Import work items from the Beads JSONL format into pm items, and export pm items back to Beads JSONL. The original Beads `id` and dependency/blocker edges survive a full import → export round-trip.

---

## Installation

```bash
pm install npm:pm-beads --global
```

> The `npm:` prefix is required. A bare `pm install pm-beads` resolves only a local
> directory or a bundled alias, never the registry, and a
> `github.com/unbraind/pm-beads` source cannot work either — pm copies a GitHub
> source as-is without building it, and this repository does not commit `dist/`.

## Capabilities

| SDK capability | What it provides |
|---|---|
| `importers` | `pm beads import <file>` — read a Beads JSONL file and create (or, with `--upsert`, update) pm items |
| `importers` (exporter) | `pm beads export` — serialize pm items back to Beads JSONL |
| `commands` | `pm beads-import` / `pm beads-export` / `pm beads-validate` / `pm beads-diff` — rich-help aliases of the import/export/validate/diff pipelines |
| `schema` | declares the `bead_id` item field |

## Fail-fast import gate

Before `pm beads import` (and its `pm beads-import` alias) creates anything,
the import pipeline itself runs the same structural validator used by
`pm beads validate` against the input file. If the file has any structural
**error** (invalid JSON line, a record that is not a JSON object, a missing
`title`, or a dangling dependency that resolves neither in the file nor in the
workspace), the import **aborts immediately** with a clear, line-naming message
and a non-zero exit — *before* a single pm item is written. Warnings alone
(e.g. an unknown status, a duplicate id) do not block.

```text
$ pm beads import broken.jsonl
Beads JSONL validation failed for /abs/path/broken.jsonl — 2 structural error(s); nothing was imported. Fix the file (or run `pm beads validate <file>`) and retry:
  - line 2 [invalid_json]: line is not valid JSON
  - line 3 [missing_title]: missing required field: title
$ echo $?
1
```

The gate is part of the import command itself — it deliberately does **not**
use pm's preflight-override surface, which is single-winner: when another
package (e.g. `pm-todos`) is co-installed and owns the preflight slot
(`extension_preflight_override_collision`), a gate registered there silently
stops running. Embedding the validation in the import path guarantees fail-fast
behavior in every installation combination.

The gate is scoped strictly to the import path: `pm beads export` and
`pm beads-validate` are never blocked by it.

## Import

### `pm beads import <file>`

```bash
pm beads import items.jsonl
pm beads import data.jsonl --dry-run
pm beads import data.jsonl --validate-only         # validate then exit, no import
pm beads import data.jsonl --upsert                 # idempotent re-import (update, not duplicate)
pm beads import data.jsonl --upsert --merge-strategy skip   # leave duplicates untouched
pm beads import data.jsonl --type Task --priority 2
pm beads import data.jsonl --filter "type:Bug;status:open"  # combined row filter
pm beads import data.jsonl --filter-status open,in_progress
pm beads import data.jsonl --filter-type Bug
pm beads import big.jsonl --batch-size 100         # chunk the create/update pass
pm beads import data.jsonl --no-preserve-ids
pm beads import data.jsonl --no-preserve-timestamps
```

**Flags**

| Flag | Type | Description |
|---|---|---|
| `--dry-run` | boolean | Preview create/update/skip counts without writing |
| `--validate-only` | boolean | Validate the input file then exit without importing (like `pm beads validate`, scoped to import) |
| `--upsert` | boolean | Update existing items matched by their Beads id instead of creating duplicates (requires preserved ids) |
| `--merge-strategy <strategy>` | string | How `--upsert` handles a duplicate bead id: `update` (default) \| `skip` \| `fail` |
| `--batch-size <n>` | number | Process the create/update pass in batches of n records (progress reporting) |
| `--filter <expr>` | string | Combined row filter, e.g. `type:Bug,Feature;status:open,in_progress` (merged with `--filter-status`/`--filter-type`) |
| `--no-preserve-ids` | boolean | Do not persist the original Beads id (default: preserve) |
| `--no-preserve-timestamps` | boolean | Do not carry over the bead `created_at`/`updated_at` (default: preserve) |
| `--type <type>` | string | Override item type for all imported items |
| `--priority <n>` | number | Override priority (0–4) for all items |
| `--tags <tags>` | string | Comma-separated tags to add to all items |
| `--filter-status <list>` | string | Only import beads whose **mapped** pm status is in this comma-separated list |
| `--filter-type <list>` | string | Only import beads whose type is in this comma-separated list |

`--filter` is a compact alternative to the granular `--filter-status`/`--filter-type`
flags. Its grammar is a semicolon-separated list of `dimension:values` clauses,
e.g. `type:Bug,Feature;status:open,in_progress`. When both are given, the granular
flag wins for its dimension and the `--filter` clause supplies the rest.

### Validate-only and batching

`--validate-only` runs the same fail-fast structural gate as a real import
(including the workspace cross-check for dependency edges), prints the report,
and exits without writing anything — a one-command CI gate for an import job.
A structurally invalid file still exits nonzero, exactly as a real import would.

`--batch-size <n>` chunks the create/update pass into fixed-size groups and logs
a `Batch k/N` progress line per group, useful for very large imports and for
throttling. Writes remain per-record (pm exposes no batch create), so batching
is a progress/throughput concern, not a transactional one.

### Merge strategy (`--upsert --merge-strategy`)

`--merge-strategy` only applies with `--upsert` (duplicate handling needs a key
to match on). It controls what happens when a bead id in the file already maps
to an existing pm item:

| Strategy | Behavior |
|---|---|
| `update` (default) | Replace the matched item in place (the original `--upsert` behavior) |
| `skip` | Leave the existing item untouched and move on; the bead id is still resolved so later records and dependency edges reference the right item |
| `fail` | Abort the import with a nonzero exit on the first duplicate |

Import runs in three passes: every item is created (or updated) first, then
dependency/blocker edges are wired up so a record can depend on another record
defined later in the same file, and finally — unless `--no-preserve-timestamps`
is given — the bead's original `created_at`/`updated_at` are written back onto
the persisted item (the dependency pass would otherwise re-stamp `updated_at`).

### Planning-field fidelity

The importer and exporter preserve common pm planning fields in addition to the
core Beads fields: `assignee`, `parent`, `deadline` (or legacy `due_date` on
import), `sprint`, and `release`. Parent links are resolved after all records in
the file are created, so `parent` can name either an existing pm id or another
Beads id from the same file.

### Timestamp fidelity

`pm create`/`update` expose no flag for the canonical `created_at`/`updated_at`
front-matter fields, so on import they are stamped by the runtime. To keep the
import side symmetric with the exporter (which already re-emits both
timestamps), the importer patches the persisted item file in place after
create/update, making the round-trip lossless for timestamps. Only well-formed
ISO instants are written; an unparseable value or an item file that cannot be
located is skipped with a warning (never a hard failure). Opt out with
`--no-preserve-timestamps`.

### Idempotent re-import (`--upsert`)

Re-importing the same Beads file with `--upsert` updates the previously imported
items instead of creating duplicates. Matching is keyed on the original Beads
`id`, stored in the registered `bead_id` metadata field with its original case. On upsert, dependency edges are replaced atomically
(`--replace-deps`) so repeated imports never accumulate duplicate edges, and a
status that is already terminal (e.g. `closed`) is not re-sent (which would
otherwise demand `--force`). Items imported with `--no-preserve-ids` have no
stable key, so `--upsert` rejects that combination.

## Validate

### `pm beads validate <file>`

Structurally lint a Beads JSONL file before import. Reports invalid JSON lines,
missing required fields, unknown statuses, duplicate ids, and dangling
dependency references (an edge naming a bead id not defined in the file). Exits
nonzero when any **error**-severity problem is present; warnings alone keep a
zero exit.

By default the dangling-dependency check also cross-references the **current pm
workspace**: a dependency that is not defined in the file but already exists in
the workspace (from a prior import, matched on its `bead_id` metadata) is
downgraded from an error to a `cross_workspace_dependency` warning, since it
will resolve at import time. A dependency present in neither the file nor the
workspace stays a hard error. The workspace is read via the SDK item-store
(`listAllItemMetadata`), falling back to canonical `pm list --all --json` with a
full projection and explicit unbounded output budget and row limit for
standalone installs. The fallback rejects incomplete, malformed, omitted,
count-inconsistent, identity-less, or duplicate-ID envelopes before import,
export, or workspace diff consumes any row.
Pass `--no-workspace` to restrict the check to the file alone.

```bash
pm beads validate items.jsonl
pm beads validate items.jsonl --json          # structured report on stdout
pm beads validate items.jsonl --no-workspace  # file-only dangling check
```

| Issue | Severity | Exit impact |
|---|---|---|
| invalid JSON / non-object line | error | nonzero |
| missing `title` | error | nonzero |
| dangling dependency reference (not in file or workspace) | error | nonzero |
| cross-workspace dependency (in workspace, not in file) | warning | none |
| unknown status | warning | none |
| duplicate id | warning | none |

## Export

### `pm beads export`

```bash
pm beads export                              # Beads JSONL to stdout
pm beads export --output items.jsonl         # write to a file
pm beads export --dry-run                    # preview the count, write nothing
pm beads export --filter "type:Bug;status:open" # combined row filter
pm beads export --filter-status open         # only export open items
pm beads export --filter-type Issue          # only export items of a given type
pm beads export --no-preserve-ids            # emit pm ids instead of the original Beads ids
```

The default stdout stream contains only Beads JSONL records, so it can be
piped directly into JSONL consumers. The human-readable export count is sent
to stderr; no global `--quiet` flag is required for correctness.

**Flags**

| Flag | Type | Description |
|---|---|---|
| `--output <file>`, `-o` | string | Write JSONL to a file instead of stdout |
| `--dry-run` | boolean | Preview the export count without writing to a file or stdout |
| `--no-preserve-ids` | boolean | Emit pm ids instead of the original Beads ids (default: preserve) |
| `--filter <expr>` | string | Combined row filter, e.g. `type:Bug;status:open` (merged with granular filters) |
| `--filter-status <list>` | string | Only export items whose **Beads** status is in this comma-separated list |
| `--filter-type <list>` | string | Only export items whose type is in this comma-separated list |

The import and export `--filter`, `--filter-status`, and `--filter-type` flags are symmetric:
import compares against the **mapped pm** status (so `--filter-status closed`
matches a bead with `done`/`complete`), export compares against the **Beads**
status the exporter emits.

## Diff (round-trip fidelity audit)

### `pm beads diff <fileA> <fileB>` / `pm beads diff <file> --against-workspace`

Compare two Beads sources and report per-bead drift, so you can **audit
round-trip fidelity** before or after an import. Beads are matched on their
stable bead `id`; each matched pair is classified, and the unmatched ids on each
side are reported as added/removed.

```bash
pm beads diff before.jsonl after.jsonl          # compare two files
pm beads export --output now.jsonl              # snapshot, then…
pm beads diff before.jsonl --against-workspace  # …compare a file to the live workspace
pm beads diff a.jsonl b.jsonl --json            # structured diff object
pm beads diff a.jsonl b.jsonl --strict          # exit nonzero on any drift (CI gate)
pm beads diff a.jsonl b.jsonl --filter "type:Bug;status:open"
pm beads diff a.jsonl b.jsonl --filter-status open,in_progress
pm beads diff a.jsonl b.jsonl --filter-type Bug
```

With `--against-workspace`, the **current pm workspace** is serialized to Beads
in memory using the same exporter core (`pm beads export`) — preserving the
original bead ids and translating dependency edges — and compared against the
single file you pass. Provide exactly one file in that mode.

**Classification** (keyed on bead `id`):

| Class | Meaning |
|---|---|
| `added` | bead present only in B (the second file, or the workspace) |
| `removed` | bead present only in A (the first file) |
| `changed` | id present in both, but one or more compared fields differ |
| `unchanged` | id present in both with all compared fields equal (count) |

The compared field set is exactly what a round-trip is meant to preserve:
`title`, `status`, `type`, `priority`, `tags`, `assignee`, `parent`, `deadline`,
`dependencies`. Comparison is semantic, not byte-level — status is compared on
the canonical mapped value (so `done` vs `closed` is **not** drift), priority
`2` equals `"2"`, and tag/dependency ordering is ignored.

**Flags**

| Flag | Type | Description |
|---|---|---|
| `--against-workspace` | boolean | Diff `<file>` against the current pm workspace instead of a second file |
| `--json` | boolean | Emit the structured diff object as JSON |
| `--strict` | boolean | Exit nonzero when any drift is found (for CI fidelity gates) |
| `--no-preserve-ids` | boolean | When diffing against the workspace, key on pm ids instead of the original Beads ids (default: preserve) |
| `--filter <expr>` | string | Combined row filter, e.g. `type:Bug;status:open` (merged with granular filters) |
| `--filter-status <list>` | string | Only compare beads whose **mapped** status is in this comma-separated list |
| `--filter-type <list>` | string | Only compare beads whose type is in this comma-separated list |

The command is strictly **read-only** — it never mutates the workspace or any
file. Without `--strict` it always exits 0 (drift is reported, not fatal), which
makes it safe to run as an informational pre/post-import check; add `--strict`
in CI to fail the build on any fidelity loss.

```text
$ pm beads diff before.jsonl --against-workspace
Beads diff: /abs/before.jsonl (A) → workspace (B)
  A: 12 bead(s), B: 12 bead(s)
  Changed: 1
    ~ bd-007 (status, tags)
  Unchanged: 11
```

## Round-trip: ids and dependencies

Imports, transfers and reconciliation persist the original Beads `id` in the
registered `bead_id` string field using the pm SDK schema registry. Descriptions
are stored and exported byte-for-byte, including whitespace and marker-like text.
The field supplies export ids and upsert keys independently of descriptions.
Identity opt-out and id-less imports persist an empty field to disable legacy
fallback for new user text. Initialized local imports use public SDK mutations with the literal-field policy,
preserving NUL, literal dashes and CRLF without stdin newline normalization.

For legacy items only, an absent `bead_id` permits the exact historical envelope:
`[bead_id: ID]` alone or a trimmed body followed by two LF newlines and that
terminal marker. The id has exactly one space after the colon, no brackets or
newlines, and no surrounding whitespace; the body contains no earlier marker.
Embedded, nested, repeated, noncanonical or body-field markers remain user text.
First modifying touch or export migrates the envelope into `bead_id`, removes
only that envelope, writes a history message and reports the migration on stderr.
Dry-run and validation do not migrate. Present metadata, including an invalid or
empty value, always disables the legacy fallback. Beads
`dependencies` / `blocked_by` edges are mapped to pm `blocked_by` dependencies on
import and translated back to current Beads `dependencies`
(`issue_id` / `depends_on_id`, `type: "blocks"`) on export, with upstream ids
resolved to their original Beads ids.

## JSONL Format

Each line is a JSON object. Required: `title`. Current `bd export` fields are
supported, including `id`, `description`, `status`, `issue_type`, `priority`,
`labels`, `owner`, `created_at`, `updated_at`, and dependency rows such as
`dependencies: [{ "issue_id": "...", "depends_on_id": "...", "type": "blocks" }]`.
Legacy aliases are also accepted: `type`, `tags`, `assignee`, `deadline`,
`due_date`, `due_at`, `sprint`, `release`,
`dependencies: [{ "id": "...", "kind": "blocked_by" }]`, and `blocked_by: "..."`.

```jsonl
{"id":"bd-001","title":"Design schema","issue_type":"feature","status":"closed","priority":1}
{"id":"bd-002","title":"Implement API","issue_type":"task","status":"in_progress","dependencies":[{"issue_id":"bd-002","depends_on_id":"bd-001","type":"blocks"}]}
{"id":"bd-003","title":"Write docs","issue_type":"task","status":"open","blocked_by":"bd-002"}
```

## Three-way snapshot reconciliation

Requires pm CLI/SDK 2026.10.15 or newer for certified corpus reads and durable
transactions.

`pm beads reconcile` compares a complete incoming Beads snapshot with its last
acknowledged external snapshot and the live tracker. Unlike `import --upsert`, it
reports concurrent field edits instead of choosing a winner. The comparison
preserves local-only edits observed in the snapshot; matching edits converge.
External omissions are deletion proposals and
never delete items, including on application. Unresolved omissions stay in the
base so future previews continue to show them.

```sh
pm beads import baseline.jsonl
pm beads export --output acknowledged.jsonl
pm beads reconcile acknowledged.jsonl --source team --acknowledge
pm beads reconcile incoming.jsonl --source team --plan-out review.json --json
pm beads reconcile --source team --apply-plan review.json --json
```

Acknowledge once, after the baseline matches live items. When bootstrapping with
an import, export the live tracker and acknowledge that export: import fills a
missing description with the title and normalizes defaults. A snapshot
that already matches every supported live field can be acknowledged directly.
Reuse the same source name for the same external tracker. The source
owns a durable base under the tracker’s `beads/` directory; retain that directory
with your tracker backups. Do not reset it to resolve a conflict.

Acknowledgements persist a source-specific `bindings` map from external ids to
core item ids. Different sources may use the same external id. Later previews
follow the stored binding even if another local item copies its Beads marker.
For an ambiguous first acknowledgement, the refusal names the external id and
candidate core ids. SDK callers can select the intended item with
`acknowledgeBeadsSnapshot(pmRoot, source, records, author, { bindings: { "bd-1": "demo-a1b2" } })`.
An item already bound to another source cannot be selected again. The initial
baseline must still match all supported fields of the selected item. To add
bindings to a legacy base that has none, pass that base's existing `records` to
this SDK call with an explicit `bindings` map. This migration requires the
same acknowledged values after type/deadline normalization and leaves local edits
untouched; it refuses changed baseline values
or a concurrently advanced base. Once bindings exist, acknowledgement still
refuses to replace the base.

```ts
import { readFile } from "node:fs/promises";
import {
  parseBeadsSnapshot, planBeadsReconciliation, applyBeadsReconciliation,
} from "pm-beads";

const incoming = parseBeadsSnapshot(await readFile("incoming.jsonl", "utf8"));
const plan = await planBeadsReconciliation(".agents/pm", "team", incoming);
// Review plan.conflicts, plan.changes and plan.deletions before applying.
if (plan.conflicts.length === 0) {
  await applyBeadsReconciliation(".agents/pm", plan, "snapshot-agent");
}
```

The SDK exports `parseBeadsSnapshot`, `acknowledgeBeadsSnapshot`,
`planBeadsReconciliation`, `applyBeadsReconciliation`, the pure
`reconcileBeadsSnapshots` classifier and their TypeScript contracts. Use
`BeadsReconcileRefusal.code` and `.remedy` to recover from `missing_base`,
`base_exists`, `ack_mismatch`, `invalid_snapshot`, `invalid_plan`, `conflicts`,
`stale_base`, `stale_tracker` or `recovery_required`. CLI refusals exit 2. Application checks the base
and core history revisions again under the workspace transaction lock. This lock
serializes workspace transactions, but ordinary `pm update` and `PmClient`
mutations do not participate in it. Per-item history checks detect edits before
inspection; they are not an atomic compare-and-swap with the following mutation.
Pause ordinary writers during apply: an edit between inspection and mutation can
be overwritten. Any item-history change anywhere in the tracker, including an
unrelated comment, conservatively invalidates a saved plan. Compensation
uses exact core history versions; ambiguous legacy checkpoints refuse before writing. Resolve
conflicts and regenerate stale plans; there is no force-overwrite flag.

Reconciled fields are title, description, status, type, priority, tags, assignee,
parent, deadline, dependencies, sprint and release. Existing Beads aliases and
core tag normalization apply. Snapshots require unique, stable ids; optional
fields use empty/default values. Comments, notes, arbitrary provider fields and
source timestamps are outside this field contract. Jira and ADO reconciliation
remains in their own adapters.

Beads type synonyms use the host's built-in mapping (`bug` to `issue`, `story`
to `feature`). Deadlines are compared and saved as canonical ISO timestamps;
`2026-10-01T00:00:00Z` and `2026-10-01T00:00:00.000Z` represent the same value.
Legacy base values are normalized for comparison without resetting their revision;
the next successful apply persists canonical values.

Only `blocked_by` dependency edges belong to the Beads dependency field. Other
relationship kinds and their recorded provenance stay local, including when an
incoming snapshot clears every Beads blocker.

For SDK callers, canonical `SnapshotRecord.fields.tags` and `.dependencies` must
be JSON arrays containing only strings. `parseBeadsSnapshot` and
`canonicalBeadsRecord` construct these representations; malformed canonical
collections refuse with `invalid_snapshot` before tracker mutation.

Default output uses the host’s compact TOON renderer; `--json` returns the same
bounded report. Counts remain complete when rows are omitted. The full plan saved
by `--plan-out` contains external field values and a copy of every live tracker
record in `plan.live`, including local descriptions of items with no proposed
changes. Store it with the same access controls and retention policy as both the
snapshots and the tracker. See the
[worked example](examples/snapshot-reconciliation.md) for conflict, omission and
recovery behavior.

## Unknown-field sidecars

Preserve explicitly opted-in opaque Beads extensions through ordinary import/export:

```sh
pm beads sidecar incoming.jsonl --capture extensions.json --fields vendor --json
pm beads import incoming.jsonl
pm beads export --output exported.jsonl
pm beads sidecar exported.jsonl --restore extensions.json --output restored.jsonl
```

Versioned sidecars preserve nested JSON values without flattening. Compact TOON
or JSON receipts report preserved and dropped unknown top-level field counts.
Native field selection, differing overlays, unknown versions, missing identities,
oversized payloads and sensitive extensions refuse before any output write.
Capture must succeed **before import**; sidecars stay separate from item metadata
and must accompany the matching complete snapshot. The sidecar contains original
opted-in values and ids: use the source snapshot's access controls and retention.
Unknown properties inside native mapped fields are outside this contract.

The typed SDK exports `captureBeadsExtensions`, `parseBeadsExtensionSidecar`,
`restoreBeadsExtensions`, `BeadsExtensionSidecar`, `BeadsExtensionLossReport`,
`BeadsSidecarRefusal` and the fixed limits. See the [complete example and refusal
remedies](examples/unknown-field-sidecars.md) for bounds, privacy policy and SDK usage.

## Dependency-closed resumable transfer

`pm beads transfer` creates a bounded plan for selected Beads ids, including their
transitive blockers and parents. Rows are ordered before their dependents, so a
blocker appearing late in the input can arrive in an earlier chunk. The existing
Beads parser still validates JSONL, aliases, duplicate ids and dependency cycles.
A closure that exceeds its bounds is refused in full with measured `omission`
fields (`dimension`, `required`, `limit`, `included: 0`) and a remedy.

```sh
pm beads transfer snapshot.jsonl --source team --select bd-root --chunk-size 25 --plan-out exchange.json
pm beads transfer --apply-plan exchange.json --chunks 2 --json
# Repeat the same command until complete is true.
```

This is a creation-only exchange into a receiving tracker. It preserves every
existing record and later peer edit. Use `beads reconcile` for changes to an
existing acknowledged source. The exact plan digest scopes deterministic core
ids and SDK transaction checkpoints; a changed plan starts a separate exchange.
Keep the original plan to resume interrupted work. The full plan contains the
selected descriptions and supported Beads fields; protect and retain it like the
source tracker. Unknown provider fields require the separate opted-in sidecar
workflow; this command transfers the canonical reconciliation fields, rather
than claiming a lossless copy of every provider field or original timestamp.

Creation uses source fields and explicit source defaults (Task, open, priority 2,
empty tags), with progressive create mode. A missing parent is explicitly unset,
so a receiving tracker's active focus cannot become an imported relationship.
Absent assignee and planning fields are also explicitly unset. Imports never
select a receiver template; SDK clients and child mutations disable extension
loading to exclude extension field defaults and mutation hooks. Scalar values,
relationships and mutation authors come from the import invocation, including
edge author provenance. Reconciliation updates retain unrelated local fields.
Receiver validation and workflow transition policies still apply and may refuse
an incompatible source; they do not substitute receiver defaults for source data.

The public SDK exports `snapshotBeadsTransferSettings`, `planBeadsTransfer`,
`validateBeadsTransferPlan`, `applyBeadsTransfer`,
`summarizeBeadsTransfer`, `beadsTransferItemId`, their option/receipt types, and
`BeadsTransferRefusal` with `code`, `remedy` and optional `omission`. Expected CLI
refusals return those fields as TOON/JSON and exit 2. Plan and drain summaries
include counts, at most 20 row identifiers, omission totals, and a resume remedy;
record descriptions never appear in these summaries.

Defaults are 1,000 closure rows, 4,000 edges (including parents), 4 MiB canonical
closure data and 25 rows per chunk. `--max-rows`, `--max-edges`, `--max-bytes` and
`--chunk-size` can raise these up to 10,000 rows, 40,000 edges, 16 MiB and 100 rows.
Input JSONL is capped at 16 MiB and Beads ids at 128 characters. `--chunks` bounds
new/resumed chunks per invocation; completed chunks replay without consuming that
budget. A completed transfer can include skipped rows: inspect `skipped` and
`rows[].reason`, not only `complete`.

Plans bind a non-secret snapshot of creation settings, template hashes and saved
focus. The SDK planner takes this snapshot as its fourth argument, followed by
optional bounds; see the [SDK example](examples/dependency-closed-transfer.md).
A changed configuration returns `plan_settings_changed` until every creation has
been pinned; restore the original configuration before resuming incomplete work.
The identity ledger at `transactions/beads-transfer/<digest>.json` records each
source row's exact `pmId` before create and its `itemHash` before `after_create`.
Resume uses only these recorded identities. Missing/corrupt ledgers refuse with
`invalid_journal`. Edited or deleted items become `item_changed` skips, including
when replaying committed chunks; they are never recreated or counted as current
successful transfers. Source descriptions round-trip verbatim. The package-owned
`bead_id` registration is excluded from the ambient settings fingerprint; other
creation settings remain guarded.

Each chunk uses the core SDK workspace writer lease and durable journal. Reads
that select mutations occur inside that lease; the core releases it after
journal persistence. Immutable create-history messages establish row ownership.
Foreign ids, missing/corrupt foreign histories, and unavailable foreign blockers
are skipped with reasons, including deleted ids reserved by retained history.
The full recorded row receipts are the `results` maps in the receiving tracker's
`transactions/sdk/beads-transfer-<digest>-<chunk>.json` journals (chunk numbers
start at zero); inspect them when the summary reports omitted rows.
No transfer recovery deletes, closes, restores or
rewrites a record. Already created rows remain valid progress when a chunk fails,
and the same plan resumes them without duplicating items. Competing drainers
report the same recorded completion, including a peer's success. After an abrupt
process death, retry after the SDK's abandoned lease expires (normally 30 seconds);
`busy` tells callers to retry the original plan. Keep chunks small enough to
finish within the host coordinator's lease lifetime.

See [the SDK and CLI example](examples/dependency-closed-transfer.md).

## Without git

Import, export, validate, diff, sidecar capture/restore, snapshot reconciliation
and resumable transfer work in a plain pm tracker without a git executable.
Reconciliation and transfer use SDK reads, history and transactions. Transfer
checkpoints belong to the receiving tracker. GitHub synchronization and release
tooling need their respective repository/service context.

## License

MIT

## Release Automation

This package is release-ready for GitHub, npm, and Bun-compatible installs. CI runs type checking, build, production dependency audit, package packing, Bun install verification, and pm-changelog validation. The daily release workflow publishes only when commits exist after the latest release tag and uses pm-changelog to generate CHANGELOG.md and GitHub release notes.

## Multi-agent merge safety

This repo tracks its project management in `.agents/pm/` and ships a committed `.gitattributes`
that maps those tracker artifacts to pm-cli's field-aware Git merge drivers, so concurrent-branch
tracker edits merge cleanly instead of hard-conflicting. The driver **definitions** live in
per-clone Git config; `npm install` / `npm ci` wires them automatically via the `prepare` script, `scripts/prepare-merge-driver.ts`: the launcher template pm-ops ships, copied unchanged, which a test compares byte for byte with the pinned template. It runs pm-ops's installer, which calls `pm merge install` when the `pm` CLI is on `PATH` and skips with a notice when it is not. A production install of a clone (`npm ci --omit=dev`) has no `pm-ops`, so the launcher skips with one notice, while a stale or broken `pm-ops` fails the install. Registry installs of this package never run `prepare`. Being Node-based, it behaves identically on POSIX shells and Windows `cmd.exe`. To (re)run manually: `npm run merge:install`.

After merging a branch that touched `.agents/pm/`, reconcile any residual history-hash drift with
**`pm merge reconcile`** (pm-cli ≥ 2026.7.22): preview with `pm merge reconcile --dry-run`, apply with
`pm merge reconcile --message "post-merge reconcile"`, then confirm with `pm validate`, which scans the
whole tracker and flags remaining history drift across **every** affected item (`pm merge reconcile`
itself lists each affected stream in its output; `pm history --verify <id>` spot-checks one item). The field-aware driver already unions every author's
content, so `reconcile` only re-greens the hash chain (no data loss) — see the authoritative
[pm-cli merge-safety guide](https://github.com/unbraind/pm-cli/blob/main/docs/MERGE_SAFETY.md). The
older blunt `pm history-repair --all` remains available as a lower-level primitive.
