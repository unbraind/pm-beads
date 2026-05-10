# pm-ext-beads

Beads JSONL importer for [pm-cli](https://github.com/unbraind/pm-cli).

Import work items from the Beads JSONL format into pm items. Each JSON line becomes a pm item.

---

## Installation

```bash
pm extension install github.com/unbraind/pm-ext-beads --global
```

## Commands

### `pm beads import <file>`

```bash
pm beads import items.jsonl
pm beads import data.jsonl --dry-run
pm beads import data.jsonl --type Task --priority 2
```

**Flags**

| Flag | Type | Description |
|---|---|---|
| `--dry-run` | boolean | Preview without writing |
| `--type <type>` | string | Override item type |
| `--priority <n>` | number | Override priority (0–4) |
| `--tags <tags>` | string | Comma-separated tags |

## JSONL Format

Each line is a JSON object. Required: `title`. Optional: `description`, `status`, `type`, `priority`, `tags`, `assignee`.

```jsonl
{"title":"Add login page","type":"Feature","status":"open","priority":1}
{"title":"Fix navbar bug","type":"Issue","status":"in_progress","tags":["bug","ui"]}
```

## License

MIT
