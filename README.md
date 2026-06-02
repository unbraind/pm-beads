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
| `importers` | `pm beads import <file>` — read a Beads JSONL file and create pm items |
| `importers` (exporter) | `pm beads export` — serialize pm items back to Beads JSONL |
| `commands` | `pm beads-import` / `pm beads-export` — rich-help aliases of the import/export pipelines |
| `schema` | declares the `bead_id` item field |

## Import

### `pm beads import <file>`

```bash
pm beads import items.jsonl
pm beads import data.jsonl --dry-run
pm beads import data.jsonl --type Task --priority 2
pm beads import data.jsonl --no-preserve-ids
```

**Flags**

| Flag | Type | Description |
|---|---|---|
| `--dry-run` | boolean | Preview without writing |
| `--no-preserve-ids` | boolean | Do not persist the original Beads id (default: preserve) |
| `--type <type>` | string | Override item type for all imported items |
| `--priority <n>` | number | Override priority (0–4) for all items |
| `--tags <tags>` | string | Comma-separated tags to add to all items |

Import runs in two passes: every item is created first, then dependency/blocker
edges are wired up so a record can depend on another record defined later in the
same file.

## Export

### `pm beads export`

```bash
pm beads export                          # Beads JSONL to stdout
pm beads export --output items.jsonl     # write to a file
pm beads export --no-preserve-ids        # emit pm ids instead of the original Beads ids
```

**Flags**

| Flag | Type | Description |
|---|---|---|
| `--output <file>`, `-o` | string | Write JSONL to a file instead of stdout |
| `--no-preserve-ids` | boolean | Emit pm ids instead of the original Beads ids (default: preserve) |

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
