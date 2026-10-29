/** Read-only compatibility forecasts for explicit, versioned Beads producer contracts. */
import { open } from "node:fs/promises";
import type { CommandHandlerContext, ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { CommandError } from "./contracts.ts";
import { parseBeadsSnapshot } from "./reconcile.ts";
import { BEADS_NATIVE_FIELDS, captureBeadsExtensions, restoreBeadsExtensions, type BeadsExtensionSidecar } from "./sidecar.ts";
import { checkBeadsSchema, type BeadsSchemaValue } from "./snapshot-schema.ts";
import { extractBlockerIds, type BeadsItem } from "./index.ts";
import { jsonSourceEntries } from "./json-source.ts";

/** Fixed budgets keep contracts and agent output independent of tracker size. */
export const BEADS_DIALECT_LIMITS = { bytes: 65_536, fields: 64, outputBytes: 32_768 } as const;
/** Canonical means the semantic domain accepted by the package's snapshot mapper, not original JSON bytes. */
export type BeadsDialectKind = BeadsProducerContract["fields"][number]["kind"];
/** A named, versioned producer's declared top-level fields; dotted names explicitly describe unsupported paths. */
export type BeadsProducerContract = BeadsSchemaValue<typeof contractSchema>;

/** Field-level fidelity and an explicit transformation or corrective action. */
export interface BeadsDialectFieldForecast {
  field: string; target: string; fidelity: "exact" | "sidecar-dependent" | "unsupported"; remedy: string;
}
/** Bounded semantic forecast; exact mappings still require the receiving tracker to accept the canonical domain. */
export interface BeadsDialectForecast {
  schema: 1; producer: string; basis: "canonical-state"; importable: boolean;
  counts: { exact: number; sidecarDependent: number; unsupported: number };
  fields: BeadsDialectFieldForecast[];
}
/** Typed failures cover malformed contracts, unsupported mappings and missing extension custody. */
export type BeadsDialectRefusalCode = "invalid_contract" | "unsupported_dialect" | "invalid_snapshot" | "sidecar_required" | "io_error";
/** Expected payload-free refusal with an actionable remedy. */
export class BeadsDialectRefusal extends CommandError {
  /** Stable machine-readable refusal category. */
  readonly code: BeadsDialectRefusalCode;
  /** Safe corrective action for callers. */
  readonly remedy: string;
  /** Construct a usage refusal without source values. */
  constructor(code: BeadsDialectRefusalCode, remedy: string) {
    super(`${code}: ${remedy}`, 2); this.name = "BeadsDialectRefusal"; this.code = code; this.remedy = remedy;
  }
}
const contractSchema = { type: "object", required: ["schema", "producer", "fields"], properties: {
  schema: { type: "literal", value: 1 }, producer: { type: "string", maxLength: 128, format: "nonempty" },
  fields: { type: "array", maxItems: BEADS_DIALECT_LIMITS.fields, items: { type: "object", required: ["name", "kind"], properties: {
    name: { type: "string", maxLength: 128, format: "nonempty" }, kind: { type: "enum", values: ["text", "priority", "labels", "blockers", "json"] },
  } } },
} } as const;
/** Native transformations point to the canonical mapper rather than implementing normalization again. */
const mappings = new Map<string, { target: string; kind: BeadsDialectKind }>([
  ["id", { target: "id", kind: "text" }], ["title", { target: "title", kind: "text" }], ["name", { target: "title", kind: "text" }],
  ["description", { target: "description", kind: "text" }], ["priority", { target: "priority", kind: "priority" }],
  ["labels", { target: "tags", kind: "labels" }], ["tags", { target: "tags", kind: "labels" }],
  ["assignee", { target: "assignee", kind: "text" }], ["owner", { target: "assignee", kind: "text" }],
  ["parent", { target: "parent", kind: "text" }], ["deadline", { target: "deadline", kind: "text" }],
  ["due_date", { target: "deadline", kind: "text" }], ["due_at", { target: "deadline", kind: "text" }],
  ["sprint", { target: "sprint", kind: "text" }], ["release", { target: "release", kind: "text" }],
  ["dependencies", { target: "dependencies", kind: "blockers" }], ["blocked_by", { target: "dependencies", kind: "blockers" }],
]);
/** Refuse untrusted shapes before reading any payload values or performing I/O. */
function contractOf(value: unknown): BeadsProducerContract {
  if (!checkBeadsSchema(value, contractSchema)) throw new BeadsDialectRefusal("invalid_contract", "Use a schema-1 producer contract with at most 64 dense field descriptors and no extra properties.");
  const contract = value as BeadsProducerContract;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(contract.producer) ||
      contract.fields.some(field => !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(field.name)) ||
      new Set(contract.fields.map(field => field.name)).size !== contract.fields.length ||
      !contract.fields.some(field => field.name === "id") || !contract.fields.some(field => field.name === "title" || field.name === "name")) {
    throw new BeadsDialectRefusal("invalid_contract", "Name the producer and unique fields with portable identifiers; declare id and title (or name), and keep the contract within 65536 bytes.");
  }
  return contract;
}
/** Parse one strict contract, rejecting duplicate JSON properties instead of silently choosing a winner. */
export function parseBeadsProducerContract(text: string): BeadsProducerContract {
  if (typeof text !== "string" || Buffer.byteLength(text) > BEADS_DIALECT_LIMITS.bytes) throw new BeadsDialectRefusal("invalid_contract", "Supply a UTF-8 producer contract no larger than 65536 bytes.");
  try {
    const value: unknown = JSON.parse(text);
    const contract = contractOf(value);
    // The schema has already bounded depth and shape, so only these objects need duplicate checks.
    for (const object of [text, ...jsonSourceEntries(text).filter(entry => entry.key === "fields").flatMap(entry =>
      jsonSourceEntries(text, entry.valueStart).map(field => text.slice(field.valueStart, field.end)))]) {
      const keys = jsonSourceEntries(object).map(entry => entry.key);
      if (new Set(keys).size !== keys.length) throw new Error("duplicate");
    }
    return contract;
  } catch (error) {
    if (error instanceof BeadsDialectRefusal) throw error;
    throw new BeadsDialectRefusal("invalid_contract", "Use valid contract JSON without duplicate properties.");
  }
}
/** Forecast canonical semantic fidelity without opening or mutating a tracker. No lifecycle roles are inferred from status names. */
export function forecastBeadsDialect(value: unknown): BeadsDialectForecast {
  const contract = contractOf(value), targets = new Map<string, number>();
  for (const field of contract.fields) {
    const target = mappings.get(field.name)?.target;
    if (target) targets.set(target, (targets.get(target) ?? 0) + 1);
  }
  const fields: BeadsDialectFieldForecast[] = [...contract.fields].sort((a, b) => a.name < b.name ? -1 : 1).map(field => {
    const mapping = mappings.get(field.name);
    if (mapping && mapping.kind === field.kind && targets.get(mapping.target) === 1) return {
      field: field.name, target: mapping.target, fidelity: "exact", remedy: "Use the canonical mapping domain; preserve ids and the complete relationship closure.",
    };
    if (!BEADS_NATIVE_FIELDS.includes(field.name) && !field.name.includes(".")) {
      try { captureBeadsExtensions('{"id":"probe","title":"Probe"}', [field.name]);
        return { field: field.name, target: "extension-sidecar", fidelity: "sidecar-dependent", remedy: "Capture this opted-in top-level field before import; retain and restore its matching sidecar after export." };
      } catch { /* The sidecar selector policy makes this extension unsupported. */ }
    }
    return { field: field.name, target: mapping?.target ?? "none", fidelity: "unsupported", remedy:
      "Flatten native nesting, remove competing aliases, or choose a producer contract using supported canonical fields. Status/type and source timestamps need a separate target-specific audit." };
  });
  const counts = { exact: fields.filter(field => field.fidelity === "exact").length,
    sidecarDependent: fields.filter(field => field.fidelity === "sidecar-dependent").length, unsupported: fields.filter(field => field.fidelity === "unsupported").length };
  const forecast: BeadsDialectForecast = { schema: 1, producer: contract.producer, basis: "canonical-state", importable: counts.unsupported === 0, counts, fields };
  assertBeadsDialectForecast(forecast); return forecast;
}
/** Check emitted numeric domains and the field partition before returning a successful forecast. */
export function assertBeadsDialectForecast(report: BeadsDialectForecast): void {
  if (Object.values(report.counts).some(count => !Number.isSafeInteger(count) || count < 0 || count > BEADS_DIALECT_LIMITS.fields) ||
      report.counts.exact + report.counts.sidecarDependent + report.counts.unsupported !== report.fields.length ||
      Buffer.byteLength(JSON.stringify(report)) > BEADS_DIALECT_LIMITS.outputBytes) throw new BeadsDialectRefusal("invalid_contract", "Reduce contract fields; forecast counts and output must fit their documented finite budgets.");
}
/** Reject native edge payloads that the blocker-only domain cannot preserve, using the production edge mapper. */
function assertBlockerDomain(value: unknown): void {
  const edges = typeof value === "string" ? [value] : value;
  if (!Array.isArray(edges)) throw new Error("blocker representation");
  const keys = new Set(["id", "kind", "issue_id", "depends_on_id", "type"]);
  for (const edge of edges) {
    if (typeof edge !== "string" && Object.keys(edge as object).some(key => !keys.has(key))) throw new Error("opaque native edge");
    if (extractBlockerIds({ dependencies: [edge] } as BeadsItem).length !== 1) throw new Error("unsupported edge semantics");
  }
}
/** Validate the same snapshot/sidecar producers used by conversion; a guard never commits or repairs input. */
export function assertBeadsDialectImportable(text: string, value: unknown, sidecar?: BeadsExtensionSidecar): BeadsDialectForecast {
  const report = forecastBeadsDialect(value);
  if (!report.importable) throw new BeadsDialectRefusal("unsupported_dialect", "Review unsupported forecast fields and select a compatible producer before importing.");
  const extensions = report.fields.filter(field => field.fidelity === "sidecar-dependent").map(field => field.field);
  if (sidecar) {
    try { restoreBeadsExtensions(text, sidecar); }
    catch { throw new BeadsDialectRefusal("invalid_snapshot", "Supply a valid matching sidecar captured from this complete source snapshot."); }
  }
  if (extensions.length && (!sidecar || extensions.some(field => !sidecar.fields.includes(field)))) throw new BeadsDialectRefusal("sidecar_required", "Capture every sidecar-dependent field before import and supply the matching sidecar to the dialect guard.");
  try {
    captureBeadsExtensions(text, extensions);
    const declared = new Map((value as BeadsProducerContract).fields.map(field => [field.name, field.kind]));
    for (const line of text.split("\n").filter(line => line.trim())) {
      const row = JSON.parse(line) as Record<string, unknown>;
      for (const [name, data] of Object.entries(row)) {
        const kind = declared.get(name);
        if (kind === "blockers") assertBlockerDomain(data);
        if (!kind || (kind === "text" && typeof data !== "string") ||
            (kind === "priority" && (typeof data !== "number" || !Number.isInteger(data) || data < 0 || data > 4)) ||
            (kind === "labels" && !Array.isArray(data))) throw new Error("contract drift");
      }
    }
    parseBeadsSnapshot(text);
  } catch { throw new BeadsDialectRefusal("invalid_snapshot", "Supply a valid complete snapshot matching the contract, with canonical native values and no undeclared fields; repair nesting before import."); }
  return report;
}
/** Bound file reads before allocating source text, including growing files and nonregular inputs. */
export async function readBeadsProducerContract(file: string): Promise<BeadsProducerContract> {
  try {
    const handle = await open(file, "r");
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > BEADS_DIALECT_LIMITS.bytes) throw new Error("size");
      const bytes = Buffer.alloc(BEADS_DIALECT_LIMITS.bytes + 1), result = await handle.read(bytes, 0, bytes.length, 0);
      return parseBeadsProducerContract(bytes.subarray(0, result.bytesRead).toString("utf8"));
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof BeadsDialectRefusal) throw error;
    throw new BeadsDialectRefusal("io_error", "Supply a readable regular contract file no larger than 65536 bytes.");
  }
}
/** Translate expected command failures while preserving unexpected programming errors for the host. */
export function beadsDialectRefusalReceipt(error: unknown): { refused: true; code: BeadsDialectRefusalCode; remedy: string } {
  if (!(error instanceof BeadsDialectRefusal)) throw error;
  return { refused: true, code: error.code, remedy: error.remedy };
}
/** Render a compact native host object in either TOON or JSON, with no tracker or git requirement. */
async function runForecast(ctx: CommandHandlerContext): Promise<unknown> {
  try {
    const file = ctx.args[0];
    if (typeof file !== "string" || !file.trim() || ctx.args.length !== 1) throw new BeadsDialectRefusal("invalid_contract", "Pass exactly one producer contract file to beads forecast.");
    return forecastBeadsDialect(await readBeadsProducerContract(file));
  } catch (error) {
    const receipt = beadsDialectRefusalReceipt(error);
    process.exitCode = 2; return receipt;
  }
}
/** Register one command over the public read-only forecast implementation. */
export function registerForecastCommands(api: ExtensionApi): void {
  api.registerCommand({ name: "beads forecast", description: "Forecast a named producer's canonical mappings, sidecar requirements and unsupported fields before choosing an exchange format.",
    arguments: [{ name: "contract", required: true, description: "Schema-1 producer contract JSON." }],
    examples: ["pm beads forecast producer.json --json"], run: runForecast });
}
