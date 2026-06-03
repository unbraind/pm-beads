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
| `commands` | `pm beads-import` / `pm beads-export` / `pm beads-validate` — rich-help aliases of the import/export/validate pipelines |
| `schema` | declares the `bead_id` item field |

## Import

### `pm beads import <file>`

```bash
pm beads import items.jsonl
pm beads import data.jsonl --dry-run
pm beads import data.jsonl --upsert         # idempotent re-import (update, not duplicate)
pm beads import data.jsonl --type Task --priority 2
pm beads import data.jsonl --filter-status open,in_progress
pm beads import data.jsonl --filter-type Bug
pm beads import data.jsonl --no-preserve-ids
pm beads import data.jsonl --no-preserve-timestamps
```

**Flags**

| Flag | Type | Description |
|---|---|---|
| `--dry-run` | boolean | Preview create/update/skip counts without writing |
| `--upsert` | boolean | Update existing items matched by their Beads id instead of creating duplicates (requires preserved ids) |
| `--no-preserve-ids` | boolean | Do not persist the original Beads id (default: preserve) |
| `--no-preserve-timestamps` | boolean | Do not carry over the bead `created_at`/`updated_at` (default: preserve) |
| `--type <type>` | string | Override item type for all imported items |
| `--priority <n>` | number | Override priority (0–4) for all items |
| `--tags <tags>` | string | Comma-separated tags to add to all items |
| `--filter-status <list>` | string | Only import beads whose **mapped** pm status is in this comma-separated list |
| `--filter-type <list>` | string | Only import beads whose type is in this comma-separated list |

Import runs in three passes: every item is created (or updated) first, then
dependency/blocker edges are wired up so a record can depend on another record
defined later in the same file, and finally — unless `--no-preserve-timestamps`
is given — the bead's original `created_at`/`updated_at` are written back onto
the persisted item (the dependency pass would otherwise re-stamp `updated_at`).

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
pm beads export --filter-status open         # only export open items
pm beads export --filter-type Issue          # only export items of a given type
pm beads export --no-preserve-ids            # emit pm ids instead of the original Beads ids
```

**Flags**

| Flag | Type | Description |
|---|---|---|
| `--output <file>`, `-o` | string | Write JSONL to a file instead of stdout |
| `--no-preserve-ids` | boolean | Emit pm ids instead of the original Beads ids (default: preserve) |
| `--filter-status <list>` | string | Only export items whose **Beads** status is in this comma-separated list |
| `--filter-type <list>` | string | Only export items whose type is in this comma-separated list |

The import and export `--filter-status`/`--filter-type` flags are symmetric:
import compares against the **mapped pm** status (so `--filter-status closed`
matches a bead with `done`/`complete`), export compares against the **Beads**
status the exporter emits.

## Round-trip: ids and dependencies

`pm create` exposes no generic custom-field setter to standalone extensions, so
on import the original Beads `id` is persisted in the item description behind a
parseable marker (`[bead_id: <id>]`). On export the marker is read back and the
native Beads id is re-emitted (and stripped from the description). Beads
`dependencies` / `blocked_by` edges are mapped to pm `blocked_by` dependencies on
import and translated back to Beads `dependencies` (`kind: "blocked_by"`) on
export, with upstream ids resolved to their original Beads ids.

## JSONL Format

Each line is a JSON object. Required: `title`. Optional: `id`, `description`,
`status`, `type`, `priority`, `tags`, `assignee`, and blocker edges via either
`dependencies: [{ "id": "...", "kind": "blocked_by" }]` or `blocked_by: "..."`.

```jsonl
{"id":"bd-001","title":"Design schema","type":"Feature","status":"closed","priority":1}
{"id":"bd-002","title":"Implement API","type":"Task","status":"in_progress","dependencies":[{"id":"bd-001","kind":"blocked_by"}]}
{"id":"bd-003","title":"Write docs","type":"Task","status":"open","blocked_by":"bd-002"}
```

## License

MIT

## Release Automation

This package is release-ready for GitHub, npm, and Bun-compatible installs. CI runs type checking, build, production dependency audit, package packing, Bun install verification, and pm-changelog validation. The daily release workflow publishes only when commits exist after the latest release tag and uses pm-changelog to generate CHANGELOG.md and GitHub release notes.
