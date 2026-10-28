# Dependency error repair packets

Given `snapshot.jsonl`:

```jsonl
{"id":"bd-A","title":"Build","dependencies":["bd-B"]}
{"id":"bd-B","title":"Build","blocked_by":"bd-C"}
{"id":"bd-C","title":"Build","dependencies":[{"depends_on_id":"bd-A","type":"blocks"}]}
```

```sh
pm beads repair snapshot.jsonl --json
pm beads repair snapshot.jsonl --max-output-bytes 65536
```

Both commands are read-only. The packet identifies lines 1, 2 and 3, exact
case-sensitive external IDs, and all three cycle edges. Identical titles do not
participate in identity resolution. Exit codes: 0 means valid dependencies,
1 means a packet with cycles or gaps, and 2 means a typed refusal with a remedy.
The host renders TOON by default and JSON with `--json`; it needs no git executable
or tracker read to inspect a file.
The host's compact presentation may omit empty arrays; `counts` always reports
their sizes. The SDK returns those arrays explicitly.

The packet contains a deterministic **candidate edit set**, not a claim about the
author's intent: remove the first edge in each cyclic component, recompute core
topology, and repeat within the budget. It is not a minimum feedback-edge solver.
An edit's `line`, `id`, `blockerLine` and `blocker` name one semantic edge; preview
removes every duplicate spelling of that edge in `dependencies` and `blocked_by`.
No proposal adds a replacement ID. The complete candidate must pass the existing
Beads import validator before it is emitted. A malformed row, missing/duplicate
ID, unresolved target or uninterpreted dependency representation remains a gap;
usable rows still produce witnesses, but gaps prevent candidates.

```ts
import { readFile } from 'node:fs/promises';
import {
  explainBeadsDependencies,
  previewBeadsDependencyRepair,
  BeadsRepairRefusal,
} from 'pm-beads';

const text = await readFile('snapshot.jsonl', 'utf8');
try {
  const packet = explainBeadsDependencies(text, { maxRows: 10_000 });
  for (const candidate of packet.candidates) {
    // Read again: an older packet is never authority over a changed source.
    const current = await readFile('snapshot.jsonl', 'utf8');
    const correctedText = previewBeadsDependencyRepair(current, candidate);
    console.log(correctedText); // Review it; this API never writes the input.
  }
} catch (error) {
  if (!(error instanceof BeadsRepairRefusal)) throw error;
  console.error(error.code, error.remedy);
}
```

Preview uses the same producer and validator, regenerates the exact candidate,
and checks the SHA-256 revision of the **whole source text**, including whitespace
and line endings. A reserialized proposal is supported; changed or forged edits
refuse. Consumers that write a file must perform their own revision-guarded
publication; this API supplies neither an applying command nor a journal.

| Bound / CLI flag | Default | Hard ceiling |
| --- | ---: | ---: |
| `maxRows` / `--max-rows` (nonblank physical rows) | 10,000 | 100,000 |
| `maxEdges` / `--max-edges` (normalized blockers, including unresolved) | 40,000 | 400,000 |
| `maxInputBytes` / `--max-input-bytes` (UTF-8 bytes) | 4,194,304 | 33,554,432 |
| `maxOutputBytes` / `--max-output-bytes` (pretty JSON plus newline) | 32,768 | 1,048,576 |
| `maxWitnesses` / `--max-witnesses` (cycle rows + cycle edges + gaps) | 100 | 10,000 |
| `maxEdits` / `--max-edits` (candidate removals) | 32 | 256 |
| `maxAnalyses` / `--max-analyses` (core topology calls per explanation) | 16 | 64 |

Only positive safe integers in these domains are accepted. Input and output
limits refuse the entire packet, with no silently truncated success. Exhausting
the proposal work budget returns complete witnesses with no candidate and a
remedy. Numeric output is checked for safe, finite nonnegative integers. The CLI
reads a regular UTF-8 file up to its byte budget plus one byte. Unknown native
fields are preserved by preview; JSON nesting beyond 64 levels and nonfinite
JSON exponents are explicit row gaps. Returned rows omit titles and descriptions;
the unchanged input can contain sensitive source data, so keep it local.

Regression acceptance bounds the three-of-10,000 scenario, including preview
regeneration, to 30 seconds. The example does not promise a wall-clock deadline
on arbitrary hardware. `test/public-repair-validation.ts` separately measures a
frozen public fleet tracker copy without git and verifies its byte fingerprint.
