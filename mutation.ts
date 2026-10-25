/** Explicit creation policy for source-owned imports, independent of receiver defaults. */
import type { PmClientFullMutationOptions } from "@unbrained/pm-cli/sdk";

/** Resolve the invocation author once before forwarding it explicitly to every mutation. */
export function beadsMutationAuthor(author: string | undefined): string {
  return author ?? process.env.PM_AUTHOR ?? "pm-beads";
}

/** Attribute newly imported edges explicitly, rather than using the SDK's fallback author. */
export function sourceDependency(id: string, author: string): string {
  return `id=${JSON.stringify(id)},kind=blocked_by,author=${JSON.stringify(author)}`;
}

/** Pin source defaults and use the SDK's typed unset contract for absent optional scalars. */
export function sourceCreateOptions(options: PmClientFullMutationOptions, author: string): PmClientFullMutationOptions {
  return {
    ...options,
    author,
    // Templates are opt-in: omission is the SDK's documented disable operation.
    template: undefined,
    createMode: "progressive",
    type: options.type ?? "Task",
    status: options.status ?? "open",
    priority: options.priority ?? "2",
    tags: options.tags ?? "[]",
    unset: ["parent", "assignee", "deadline", "sprint", "release"].filter(field => options[field] === undefined),
  };
}

/** Compensation preserves durable items and identity reservations for an explicit retry. */
export async function preserveBeadsProgress(): Promise<void> {}
