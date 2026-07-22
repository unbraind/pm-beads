# pm-beads

Beads JSONL importer **and exporter** for [pm-cli](https://github.com/unbraind/pm-cli).

Import work items from the Beads JSONL format into pm items, and export pm items back to Beads JSONL. The original Beads `id` and dependency/blocker edges survive a full import → export round-trip.

---

## Installation

```bash
pm install github.com/unbraind/pm-beads --global
```

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
`id` — recovered from the `[bead_id: <id>]` provenance marker that round-trip
already maintains (**not** on tags, which pm case-folds on storage, which would
mangle mixed-case ids). On upsert, dependency edges are replaced atomically
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
the workspace (from a prior import, matched on its `[bead_id]` provenance) is
downgraded from an error to a `cross_workspace_dependency` warning, since it
will resolve at import time. A dependency present in neither the file nor the
workspace stays a hard error. The workspace is read via the SDK item-store
(`listAllFrontMatter`), falling back to `pm list-all` for standalone installs.
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

`pm create` exposes no generic custom-field setter to standalone extensions, so
on import the original Beads `id` is persisted in the item description behind a
parseable marker (`[bead_id: <id>]`). On export the marker is read back and the
native Beads id is re-emitted (and stripped from the description). Beads
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

## License

MIT

## Release Automation

This package is release-ready for GitHub, npm, and Bun-compatible installs. CI runs type checking, build, production dependency audit, package packing, Bun install verification, and pm-changelog validation. The daily release workflow publishes only when commits exist after the latest release tag and uses pm-changelog to generate CHANGELOG.md and GitHub release notes.

## Multi-agent merge safety

This repo tracks its project management in `.agents/pm/` and ships a committed `.gitattributes`
that maps those tracker artifacts to pm-cli's field-aware Git merge drivers, so concurrent-branch
tracker edits merge cleanly instead of hard-conflicting. The driver **definitions** live in
per-clone Git config; `npm install` / `npm ci` wires them automatically via the `prepare` script (a portable Node guard, `scripts/prepare-merge-driver.mjs`: it runs
`pm merge install` only when the `pm` CLI is on `PATH`, and no-ops cleanly otherwise so
production / `--omit=dev` installs are not broken; being Node-based it behaves identically
on POSIX shells and Windows `cmd.exe`). To (re)run manually: `npm run merge:install`. After merging a branch that
touched `.agents/pm/`, run `pm history-repair --all` to reconcile history verification.
