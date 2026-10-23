# Round-trip another tool's Beads extensions

Sidecars complement ordinary import/export. Capture before importing: the native
mapping does not store opaque extensions in item metadata. Keep each sidecar
with its original full snapshot and use it only with that same external record
set. Capture and restore never mutate a tracker or invoke git.

Given `incoming.jsonl`:

```jsonl
{"id":"bd-widget","title":"Build widget","vendor":{"view":{"columns":["ready","done"]},"enabled":true},"unselected":{"color":"blue"}}
```

```sh
pm beads sidecar incoming.jsonl --capture extensions.json --fields vendor --json
pm beads import incoming.jsonl
pm beads export --output exported.jsonl
pm beads sidecar exported.jsonl --restore extensions.json --output restored.jsonl
```

The capture receipt reports one preserved extension field and one dropped
extension field (`unselected`). `restored.jsonl` contains `vendor.view.columns`
and `vendor.enabled` with their original JSON types. To retain both fields,
recapture with `--fields vendor,unselected` before import. A field counts once at
the top level, regardless of its nested size. Unselected values are never copied
to the envelope. The loss report covers unknown top-level fields; native aliases,
normalization, annotations and extension properties nested *inside native
fields* are outside this contract. Use `beads diff` to audit mapped fields.

SDK callers can use the same pipeline without filesystem or tracker access:

```ts
import { captureBeadsExtensions, restoreBeadsExtensions,
  parseBeadsExtensionSidecar, BeadsSidecarRefusal } from 'pm-beads';

const sidecar = captureBeadsExtensions(incomingJsonl, ['vendor']);
const stored = JSON.stringify(sidecar);
const verified = parseBeadsExtensionSidecar(stored);
try {
  const { text, loss } = restoreBeadsExtensions(exportedJsonl, verified);
  // Persist text, and review loss.droppedFields before delivering the snapshot.
} catch (error) {
  if (error instanceof BeadsSidecarRefusal) {
    console.error(error.code, error.remedy);
  } else throw error;
}
```

The version-1 `pm-beads/extensions` envelope holds explicit field selectors,
exact external ids, opaque JSON values, loss counts, and a SHA-256 integrity
digest. The digest detects accidental changes; it does not authenticate a sender.
Unknown versions refuse. Do not edit sidecars to resolve conflicts; resolve the
source data explicitly and capture a new snapshot.

Select only unknown top-level names. All native mapping names and aliases
(including `title`, `name`, `dependencies`, and `owner`) refuse. Conflicting
existing extension values refuse rather than overwrite; identical values are
idempotent. Restore requires the exact complete external id set. Preserve ids
and avoid filtered exports, unrelated records, or reusing ids for different
items. A different tracker can use the same ids: the sidecar intentionally has
no tracker binding, so choose the matching snapshot yourself.

All input files and generated artifacts are bounded to 8 MiB, with at most
10,000 records, 128 selected fields, 16 KiB of extensions per record, 128 entries
per nested object/array, and 16 nesting levels. Numbers must be finite and integer
values must be safe JavaScript integers; represent larger integers as strings
in the source tool to prevent precision loss.
Sensitive key names, obvious credentials, email addresses, private home paths,
and prototype-related keys refuse recursively before any output write. The
key checks ignore case, underscores and hyphens, including `api_key`, `apiKey`,
`API-KEY`, `accessToken`, `client_secret`, `password` and `private_key`.
These conservative checks are a baseline, not a general personal-data detector. Review
opted-in fields before capture. Sidecars contain the original opted-in values
and external ids: apply the same access controls and retention policy as the
source snapshot. Receipts contain counts and remedies, never extension values.

Expected SDK/CLI refusal codes are `invalid_input`, `invalid_sidecar`,
`unsupported_version`, `native_conflict`, `field_conflict`, `identity_mismatch`,
`size_limit`, `privacy_limit`, and `io_error`. Each has an actionable remedy;
CLI refusals exit 2. CLI capture and restore validate the entire operation before
atomically replacing the selected output. Use distinct input and output files;
existing outputs are replaced on success and remain intact on validation failure.
Input/output comparisons resolve directory aliases and existing file symlinks;
an output alias of either input refuses before writing. New outputs require an
existing accessible parent directory.
