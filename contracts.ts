/** Shared Beads command errors and comparison field vocabulary. */
/** Semantic shell exit codes preserved by the host extension runtime. */
export const EXIT_CODE = {
  GENERIC_FAILURE: 1,
  USAGE: 2,
  NOT_FOUND: 3,
} as const;

/**
 * Error that carries a semantic process exit code.
 *
 * pm's command runtime treats a thrown error as a cleanly handled non-zero exit
 * only when it exposes a numeric `exitCode`; a plain `Error` instead falls
 * through to the "unhandled" path, which re-invokes the handler a second time
 * and exits with a generic code. Throwing this routes a failure to a clean,
 * single exit at the chosen code.
 */
export class CommandError extends Error {
  /** Numeric exit code the runtime propagates to the shell (one of {@link EXIT_CODE}). */
  exitCode: number;
  constructor(message: string, exitCode: number = EXIT_CODE.GENERIC_FAILURE) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
  }
}

/** Fields preserved by the existing Beads diff contract. */
export const DIFF_FIELDS = [
  "title",
  "status",
  "type",
  "priority",
  "tags",
  "assignee",
  "parent",
  "deadline",
  "dependencies",
] as const;

/** A Beads record field that the diff compares between two files. */
export type DiffField = (typeof DIFF_FIELDS)[number];

/** Validate the historical supported id range independently of description contents. */
export function isEncodableBeadId(beadId: string): boolean {
  return Boolean(beadId) && beadId.trim() === beadId && beadId.length <= 4097 && !/[\[\]\r\n]/.test(beadId);
}
