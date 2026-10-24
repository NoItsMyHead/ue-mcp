/**
 * editor(checkpoint), list_checkpoints, list_changes, restore and
 * clear_checkpoints (#1482): the MCP face of src/checkpoints/service.ts, with
 * the same payloads as the daemon's /v1/checkpoints routes.
 */
import { z } from "zod";
import type { ActionSpec, ToolContext } from "../core/types.js";
import { checkpointsFor } from "../checkpoints/service.js";

function sessionOf(ctx: ToolContext) {
  if (!ctx.session) throw new Error("Checkpoints need an editor session; this call has none");
  return checkpointsFor(ctx.session);
}

const stringList = (v: unknown): string[] | undefined => {
  if (Array.isArray(v)) return v.map(String).filter((s) => s.trim() !== "");
  if (typeof v === "string" && v.trim() !== "") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return undefined;
};

export const checkpointActions: Record<string, ActionSpec> = {
  checkpoint: {
    kind: "handler",
    effect: "mutate",
    description: "Record a checkpoint in this project's shadow history (Saved/UE_MCP_Bridge/shadow.git, separate from the project's own source control): the current bytes of every path written through ue-mcp since the last one, packages saved in the editor included. Returns its id, the paths it recorded as changed, and dirtyPackages: unsaved packages the history does not cover, which the editor's transactions do; save them first to record them. Bracket each group of edits (a chat turn) with one before and one after. Checkpoints are off unless ue-mcp.yml sets checkpoints: on or the daemon turned them on for the session. Params: label?",
    handler: async (ctx: ToolContext, p: Record<string, unknown>) => sessionOf(ctx).create(typeof p.label === "string" ? p.label : undefined),
  },
  list_checkpoints: {
    kind: "handler",
    effect: "read",
    description: "Whether checkpoints are on for this session and why (config or session override), the shadow repository's path, and its checkpoints newest first with id, label, createdAt, trigger (client, restore-before, restore-after) and the number of files each recorded. Params: limit? (default 50)",
    handler: async (ctx: ToolContext, p: Record<string, unknown>) => sessionOf(ctx).state(typeof p.limit === "number" && p.limit > 0 ? p.limit : 50),
  },
  list_changes: {
    kind: "handler",
    effect: "read",
    description: "Every file that differs between checkpoint `from` and checkpoint `to`, or the project now when `to` is omitted. Each entry has path, status (added, modified, deleted), kind (package, config, source, other), a unified text diff for config and source, and for a modified Blueprint package blueprintDiff, the structural diff blueprint(diff) gives, run in the editor against the checkpoint's copy. untracked marks a path changed outside the bridge and outside package saves, which restore will not overwrite without force. Params: from, to?, blueprintDiffs? (default true)",
    handler: async (ctx: ToolContext, p: Record<string, unknown>) =>
      sessionOf(ctx).changes(String(p.from ?? ""), typeof p.to === "string" && p.to ? p.to : null, { blueprintDiffs: p.blueprintDiffs !== false }),
  },
  restore: {
    kind: "handler",
    effect: "mutate",
    description: "Put every path, or only `paths`, back to its state at a checkpoint and reload it in the editor: packages are reloaded (or unloaded and dropped from the asset registry when they did not exist then), restored config files reload their GConfig branch, and open asset editors on them are closed and reopened. Source is restored as bytes; rebuilding is yours to call. Restoring a subset is a cherry pick: the rest of the turn stays. The restore is itself bracketed by checkpoints, `before` and `after`, so restore(before) undoes it. A path edited outside the agent since the checkpoint is refused and named unless force; a path nothing recorded is refused as not-recorded. Refused during PIE. Unsaved in-memory edits are not in the history: cancel the turn's editor transaction first when reverting a whole turn. Params: checkpoint, paths? (project-relative), force?",
    handler: async (ctx: ToolContext, p: Record<string, unknown>) =>
      sessionOf(ctx).restore(String(p.checkpoint ?? ""), { paths: stringList(p.paths), force: p.force === true }),
  },
  clear_checkpoints: {
    kind: "handler",
    effect: "mutate",
    description: "Delete this project's checkpoint history: the shadow repository, its plain copies of large files and anything pending. Turning checkpoints off keeps the history; this is how to remove it. Params: none",
    handler: async (ctx: ToolContext) => sessionOf(ctx).clear(),
  },
};

/** Keys only the checkpoint actions read. label, limit, paths and force are already declared by the editor specs. */
export const checkpointSchema = {
  from: z.string().optional().describe("list_changes: checkpoint id (or a unique prefix of 7 or more) to compare from"),
  to: z.string().optional().describe("list_changes: checkpoint id to compare to; omitted compares against the project now"),
  checkpoint: z.string().optional().describe("restore: checkpoint id (or a unique prefix) to put files back to"),
  blueprintDiffs: z.boolean().optional().describe("list_changes: run blueprint(diff) in the editor for modified Blueprint packages (default true)"),
};
