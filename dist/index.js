// pm-beads — Beads JSONL importer for pm-cli
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
const defineExtension = ((extension) => extension);
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function mapStatus(raw) {
    if (!raw)
        return "open";
    const s = raw.trim().toLowerCase();
    const map = {
        open: "open", todo: "open", new: "open",
        "in_progress": "in_progress", wip: "in_progress", doing: "in_progress",
        blocked: "blocked", on_hold: "blocked",
        closed: "closed", done: "closed", complete: "closed",
        canceled: "canceled", cancelled: "canceled",
        draft: "draft",
    };
    return map[s] ?? "open";
}
function mapPriority(raw) {
    if (raw === undefined || raw === null)
        return undefined;
    const n = typeof raw === "number" ? raw : parseInt(String(raw), 10);
    if (isNaN(n))
        return undefined;
    return String(Math.min(4, Math.max(0, n)));
}
// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
export default defineExtension({
    name: "pm-beads",
    version: "2026.5.28",
    activate(api) {
        // -----------------------------------------------------------------------
        // Command: pm beads import <file>
        // -----------------------------------------------------------------------
        api.registerCommand({
            name: "beads import",
            description: "Import work items from a Beads JSONL file into pm. " +
                "Each JSON line becomes a pm item. Required fields: title.",
            intent: "import Beads JSONL work items as pm items",
            examples: [
                "pm beads import items.jsonl",
                "pm beads import data.jsonl --dry-run",
                "pm beads import data.jsonl --type Task",
            ],
            flags: [
                { long: "--dry-run", description: "Preview without writing" },
                { long: "--type", value_name: "type", description: "Override item type for all imported items" },
                { long: "--priority", value_name: "n", description: "Override priority (0-4) for all items" },
                { long: "--tags", value_name: "tags", description: "Comma-separated tags to add to all items" },
            ],
            async run(ctx) {
                const filePath = ctx.args[0];
                if (!filePath) {
                    console.error("Usage: pm beads import <file> [--dry-run]");
                    return { error: "No file path provided" };
                }
                const dryRun = Boolean(ctx.options["dry-run"]);
                const typeOverride = ctx.options["type"];
                const priorityOverride = ctx.options["priority"];
                const tagsOverride = ctx.options["tags"];
                const absolutePath = resolve(filePath);
                console.error(`Parsing Beads JSONL from: ${absolutePath}`);
                let raw;
                try {
                    raw = readFileSync(absolutePath, "utf-8");
                }
                catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    console.error(`Failed to read file: ${msg}`);
                    return { error: msg };
                }
                const lines = raw.split("\n").filter((l) => l.trim());
                if (lines.length === 0) {
                    console.error("File is empty.");
                    return { imported: 0, skipped: 0 };
                }
                let imported = 0;
                let skipped = 0;
                for (let i = 0; i < lines.length; i++) {
                    let item;
                    try {
                        item = JSON.parse(lines[i]);
                    }
                    catch {
                        console.error(`Line ${i + 1}: invalid JSON — skipping`);
                        skipped++;
                        continue;
                    }
                    const title = String(item.title || item.name || "").trim();
                    if (!title) {
                        console.error(`Line ${i + 1}: missing title — skipping`);
                        skipped++;
                        continue;
                    }
                    const type = typeOverride || item.type || "Task";
                    const status = mapStatus(item.status);
                    const priority = priorityOverride || mapPriority(item.priority);
                    const tags = tagsOverride
                        ? tagsOverride
                        : Array.isArray(item.tags)
                            ? item.tags.join(",")
                            : undefined;
                    if (dryRun) {
                        console.error(`  [dry-run] ${title} (${type}, ${status})`);
                        imported++;
                        continue;
                    }
                    try {
                        const spawnArgs = [
                            "--path", ctx.pm_root,
                            "create",
                            "--title", title,
                            "--type", type,
                            "--status", status,
                            "--description", item.description || title,
                        ];
                        if (priority)
                            spawnArgs.push("--priority", priority);
                        if (tags)
                            spawnArgs.push("--tags", tags);
                        if (item.assignee)
                            spawnArgs.push("--assignee", String(item.assignee));
                        const result = spawnSync("pm", spawnArgs, { encoding: "utf-8" });
                        if (result.status !== 0) {
                            throw new Error(result.stderr || "pm create failed");
                        }
                        imported++;
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        console.error(`Line ${i + 1}: create failed — ${msg}`);
                        skipped++;
                    }
                }
                if (dryRun) {
                    console.error(`[dry-run] Would import ${imported}, skip ${skipped}.`);
                    return { dryRun: true, wouldImport: imported, wouldSkip: skipped };
                }
                console.error(`Imported ${imported}, skipped ${skipped}.`);
                return { imported, skipped };
            },
        });
        // -----------------------------------------------------------------------
        // Importer: beads-import
        // -----------------------------------------------------------------------
        api.registerImporter("beads-import", async (ctx) => {
            const filePath = ctx.options["file"];
            if (!filePath) {
                console.error("beads-import: no 'file' provided — skipping.");
                return;
            }
            const absolutePath = resolve(filePath);
            console.error(`beads-import: reading ${absolutePath}`);
            let raw;
            try {
                raw = readFileSync(absolutePath, "utf-8");
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`beads-import: failed — ${msg}`);
                return;
            }
            const lines = raw.split("\n").filter((l) => l.trim());
            let imported = 0;
            let skipped = 0;
            for (const line of lines) {
                let item;
                try {
                    item = JSON.parse(line);
                }
                catch {
                    skipped++;
                    continue;
                }
                const title = String(item.title || item.name || "").trim();
                if (!title) {
                    skipped++;
                    continue;
                }
                try {
                    const spawnArgs = [
                        "--path", ctx.pm_root,
                        "create",
                        "--title", title,
                        "--type", item.type || "Task",
                        "--status", mapStatus(item.status),
                    ];
                    const result = spawnSync("pm", spawnArgs, { encoding: "utf-8" });
                    if (result.status !== 0)
                        throw new Error(result.stderr || "pm create failed");
                    imported++;
                }
                catch {
                    skipped++;
                }
            }
            console.error(`beads-import: done — imported ${imported}, skipped ${skipped}.`);
        });
    },
});
//# sourceMappingURL=index.js.map