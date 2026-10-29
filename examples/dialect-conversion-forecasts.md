# Choose a Beads producer contract before importing

Contracts are explicit names and versions, not inferred vendor identities. For example, save this as `producer.json`:

```json
{"schema":1,"producer":"agent-board/v1","fields":[{"name":"id","kind":"text"},{"name":"title","kind":"text"},{"name":"description","kind":"text"},{"name":"priority","kind":"priority"},{"name":"dependencies","kind":"blockers"}]}
```

```sh
pm beads forecast producer.json --json
pm beads forecast producer.json
pm beads import incoming.jsonl --dialect producer.json --dry-run
pm beads import incoming.jsonl --dialect producer.json
```

The forecast returns five exact field mappings. `--dialect` invokes the same public guard for native import and the `beads-import` alias, before schema or item writes. It uses the validated source text for the import, so replacing the input file while the contract is read cannot substitute an unchecked record. Empty or nonstring guard options refuse. The guard applies only when explicitly selected; existing persisted data and ordinary import/export retain their existing contracts.

Exact means **canonical mapped state on present fields**: titles and scalar aliases normalize through the existing Beads mapper, labels are semantic sets, priority is an integer from 0 through 4, and relationships preserve external identities over a complete, valid closure. This does not promise identical JSON bytes, source spellings, tag order, generated timestamps, absent-field deletion, or arbitrary receiver schema acceptance. The receiver must accept the package's canonical mapping domain. Native domains are:

| Kind | Supported native fields | Domain |
| --- | --- | --- |
| `text` | `id`, `title`/`name`, `description`, `assignee`/`owner`, `parent`, `deadline`/`due_date`/`due_at`, `sprint`, `release` | Native scalar text; IDs must be stable and encodable, titles nonblank, deadlines parseable ISO dates. Descriptions retain whitespace and CRLF. Planning fields use canonical nonempty values accepted by the receiver. |
| `priority` | `priority` | Integer 0–4; no strings, fractions or clamping. |
| `labels` | `labels`/`tags` | Dense string arrays interpreted as semantic sets by the package and SDK. |
| `blockers` | `dependencies`/`blocked_by` | Existing Beads blocker-edge representations, with complete identities and no cycles. Opaque edge properties and uninterpreted edge kinds refuse; use a top-level extension for foreign edge payloads. |
| `json` | Unknown top-level fields only | Existing sidecar JSON/privacy/size limits; native nesting is unsupported. |

Declare only one source alias for each native target. A contract declaring both `labels` and `tags`, for example, cannot prove which value wins and forecasts both as unsupported. Dotted paths are unsupported: a nested `planning.parent` cannot become a native parent implicitly. Nested **unknown top-level extensions** can be preserved recursively in sidecars.

Status and type domains depend on the receiving schema and status registry. This forecast does not decide lifecycle meaning by spelling and conservatively reports those fields as unsupported. It also refuses exact claims for source creation/update/closure timestamps, close reasons, resolutions, and `blocks` reverse-edge semantics. Review them separately with a target-specific conversion policy rather than treating a successful structural import as proof of fidelity.

For an extension producer, add `{"name":"vendor","kind":"json"}` to the contract. The forecast reports `sidecar-dependent`, including when the payload is nested. Capture custody explicitly before import:

```sh
pm beads sidecar incoming.jsonl --capture extensions.json --fields vendor
```

```ts
import {
  assertBeadsDialectImportable, captureBeadsExtensions,
  forecastBeadsDialect, parseBeadsProducerContract,
} from "pm-beads";

const contract = parseBeadsProducerContract(contractJson);
const forecast = forecastBeadsDialect(contract); // read-only, deterministic
const sidecar = captureBeadsExtensions(snapshotJsonl, ["vendor"]);
assertBeadsDialectImportable(snapshotJsonl, contract, sidecar);
// Persist the matching sidecar, then use the existing importer. After export,
// restore with restoreBeadsExtensions, or beads sidecar --restore.
```

The CLI import guard intentionally refuses sidecar-dependent contracts without custody; the SDK guard accepts and verifies the matching envelope. Matching means the current complete identity set and every selected field’s presence and canonical JSON value, including absence. Recapture after adding, deleting or changing an extension; an older envelope cannot prove current custody. Ordinary restore still fills fields omitted by native export and continues to read existing envelopes. A forecast alone never captures or saves extension data. Sidecars preserve opaque values, not target-native semantics.

The guard requires a closed, acyclic parent graph. Native imports also check the effective graph after filtering and composing upserts with retained receiver parents, before schema or item writes; `invalid_parent_graph` means include required parent identities or remove the cycle and retry. Reconciliation applies the same topology check before mutations. Upserts clear explicitly supplied parent links in the first pass and link the validated final graph in the second pass, so acyclic rewires work in any input order. Omitted parents are retained. Imports remain multi-step; replay an interrupted upsert to finish its relationship pass. Explicit `labels: []` or `tags: []` clears receiver tags; omitted labels leave existing tags untouched. Explicit empty optional planning strings clear their native fields (including `owner`, `due_date` and `due_at` aliases); omissions preserve receiver values. Export retains native empty tag arrays so later upserts can restore them.

`BeadsDialectRefusal` carries `code`, `remedy`, and exit code 2. Codes are `invalid_contract`, `unsupported_dialect`, `invalid_snapshot`, `sidecar_required`, and `io_error`. `beads forecast` returns typed refusal receipts for malformed/unreadable contracts. A valid forecast with unsupported rows remains a successful read; inspect `importable` and its field receipts before choosing a format.

Budgets are fixed: 64 unique fields, 128 characters per identifier, 65,536 contract input bytes, and 32,768 JSON output bytes. Schema 1 rejects sparse arrays, extra properties, duplicate fields and duplicate JSON keys. Numeric output consists only of finite integer field counts from 0 through 64, with an exact partition; no floating-point threshold decisions occur. Unknown top-level fields are subject to the existing sidecar selector policy. Producers, parser and guard share the same schema and conversion validators.

Forecasts need neither git nor a tracker. The SDK and CLI leave items, sidecars and history untouched. The optional import guard verifies representation compatibility, not transaction isolation or safe concurrent upsert. No new journal, retry protocol or idempotency key is introduced. Existing SDK transaction leases serialize transactions only; an ordinary writer can still interleave with import/reconciliation between the last SDK read and write. Coordinate mutating imports separately and replan after a competing change.
