/**
 * Checkpoints per editor session (#1482): whether they are on, the bridge's
 * save recording, and the checkpoint, changes, restore and clear operations
 * the editor(...) actions and the daemon routes share.
 *
 * Off unless `checkpoints: on` is in ue-mcp.yml or the daemon turned them on
 * for the session. While off, no shadow repository is created and the bridge
 * is told not to intercept saves.
 *
 * The bridge records from UPackage::PreSavePackageWithContextEvent into the
 * pending generation it was armed with. Arming happens on every connect, and
 * each checkpoint re-arms it with a fresh generation, so a checkpoint folds in
 * exactly the copies made before it.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { warn, info } from "../core/log.js";
import type { EditorSession } from "../sessions/session.js";
import {
  CheckpointError,
  DEFAULT_LARGE_FILE_BYTES,
  ShadowRepo,
  changeKind,
  type ChangeEntry,
  type CheckpointInfo,
  type CheckpointTrigger,
  type RestoreRefusal,
} from "./shadow-repo.js";

export { CheckpointError } from "./shadow-repo.js";
export type { ChangeEntry, CheckpointInfo, RestoreRefusal } from "./shadow-repo.js";

/** How many Blueprint packages one list_changes diffs in the editor. */
const MAX_BLUEPRINT_DIFFS = 25;

export interface CheckpointState {
  editor: string;
  enabled: boolean;
  source: "config" | "session";
  configured: boolean;
  repository: string | null;
  checkpoints: CheckpointInfo[];
}

export interface CheckpointResult extends CheckpointInfo {
  editor: string;
  changes: ChangeEntry[];
  dirtyPackages: string[];
  editorConnected: boolean;
}

export interface ChangesResult {
  editor: string;
  from: string;
  to: string | null;
  changes: ChangeEntry[];
}

export interface RestoreResult {
  editor: string;
  checkpoint: string;
  before: string;
  after: string;
  restored: Array<{ path: string; action: "written" | "deleted" }>;
  refused: RestoreRefusal[];
  reloaded: string[];
  unloaded: string[];
  configsReloaded: string[];
  reopened: string[];
}

export type CheckpointEvent =
  | { type: "toggled"; data: { editor: string; enabled: boolean; source: "config" | "session" } }
  | { type: "created"; data: { editor: string; id: string; label: string; trigger: CheckpointTrigger; files: number } }
  | { type: "restored"; data: { editor: string; checkpoint: string; before: string; after: string; restored: string[]; refused: Array<{ path: string; reason: string }> } }
  | { type: "cleared"; data: { editor: string } };

const listeners = new Set<(e: CheckpointEvent) => void>();

/** Every session's checkpoint events. The daemon republishes them as checkpoint.* and checkpoints.*. */
export function subscribeCheckpointEvents(listener: (e: CheckpointEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(e: CheckpointEvent): void {
  for (const l of listeners) {
    try {
      l(e);
    } catch (err) {
      warn("checkpoints", "event listener failed", err);
    }
  }
}

type Json = Record<string, unknown>;

/** `on`, `true` and the object form's `enabled` read as on; anything else as off. */
export function configuredCheckpoints(value: unknown): { enabled: boolean; largeFileBytes: number } {
  const on = (v: unknown) => v === true || v === "on";
  if (value && typeof value === "object") {
    const o = value as { enabled?: unknown; largeFileBytes?: unknown };
    return {
      enabled: on(o.enabled),
      largeFileBytes: typeof o.largeFileBytes === "number" && o.largeFileBytes > 0 ? o.largeFileBytes : DEFAULT_LARGE_FILE_BYTES,
    };
  }
  return { enabled: on(value), largeFileBytes: DEFAULT_LARGE_FILE_BYTES };
}

export class SessionCheckpoints {
  private override: boolean | null = null;
  private repoCache: ShadowRepo | null = null;
  /** The generation the connected bridge records into, which a checkpoint must not fold in. */
  private activeGeneration: string | null = null;
  private warnedNoRecorder = false;

  constructor(private readonly session: EditorSession) {
    session.bridge.onConnectionChanged((change) => {
      if (change.connected) void this.arm().catch((e) => warn("checkpoints", `arming ${session.name} failed`, e));
    });
  }

  private get projectDir(): string {
    const dir = this.session.project.projectDir;
    if (!dir) throw new CheckpointError(400, "Checkpoints need a project; this session has none");
    return dir;
  }

  private configured(): { enabled: boolean; largeFileBytes: number } {
    return configuredCheckpoints(this.session.project.config.checkpoints);
  }

  enabled(): boolean {
    return this.override ?? this.configured().enabled;
  }

  private repo(): ShadowRepo {
    const dir = this.projectDir;
    if (!this.repoCache || this.repoCache.projectDir !== dir) {
      this.repoCache = new ShadowRepo(dir, { largeFileBytes: this.configured().largeFileBytes });
    }
    return this.repoCache;
  }

  private requireEnabled(): void {
    if (!this.enabled()) {
      throw new CheckpointError(409, "Checkpoints are off for this session. Set `checkpoints: on` in ue-mcp.yml, or turn them on through the daemon (PUT /v1/checkpoints/enabled).");
    }
  }

  async state(limit = 50): Promise<CheckpointState> {
    const configured = this.configured().enabled;
    const hasProject = !!this.session.project.projectDir;
    const repo = hasProject ? this.repo() : null;
    return {
      editor: this.session.name,
      enabled: this.enabled(),
      source: this.override === null ? "config" : "session",
      configured,
      repository: repo?.exists() ? repo.gitdir : null,
      checkpoints: repo ? await repo.list(limit) : [],
    };
  }

  /** The daemon's per-session override; null goes back to ue-mcp.yml. */
  async setEnabled(enabled: boolean | null): Promise<CheckpointState> {
    const was = this.enabled();
    this.override = enabled;
    const now = this.enabled();
    if (now !== was || enabled === null) {
      await this.arm().catch((e) => warn("checkpoints", `arming ${this.session.name} failed`, e));
      emit({ type: "toggled", data: { editor: this.session.name, enabled: now, source: this.override === null ? "config" : "session" } });
    }
    return this.state();
  }

  /**
   * Tell the connected bridge whether to record saves, and where. On means a
   * fresh generation; the previous one is left for the next checkpoint.
   */
  private async arm(): Promise<{ dirtyPackages: string[] } | null> {
    if (!this.session.bridge.isConnected || !this.session.project.projectDir) return null;
    if (!this.enabled()) {
      if (this.activeGeneration === null) return null;
      this.activeGeneration = null;
      await this.callBridge("checkpoint_arm", { enabled: false });
      return null;
    }
    const repo = this.repo();
    await repo.ensure();
    const generation = repo.newGeneration("bridge");
    const answer = await this.callBridge("checkpoint_arm", { enabled: true, pendingDir: generation, projectDir: repo.projectDir });
    if (!answer) {
      fs.rmSync(generation, { recursive: true, force: true });
      this.activeGeneration = null;
      return null;
    }
    this.activeGeneration = generation;
    const dirty = Array.isArray(answer.dirtyPackages) ? answer.dirtyPackages.map(String) : [];
    return { dirtyPackages: dirty };
  }

  /** A bridge call that reports failure as null, warning once when the plugin predates the recorder. */
  private async callBridge(method: string, params: Json): Promise<Json | null> {
    try {
      const r = (await this.session.bridge.call(method, params)) as Json | null;
      if (r && r.success === false) {
        if (method !== "checkpoint_arm") throw new CheckpointError(409, String(r.error ?? `${method} failed`));
        warn("checkpoints", `${method}: ${String(r.error ?? "failed")}`);
        return null;
      }
      return r ?? {};
    } catch (e) {
      if (e instanceof CheckpointError) throw e;
      const message = e instanceof Error ? e.message : String(e);
      if (/unknown method/i.test(message)) {
        if (!this.warnedNoRecorder) {
          this.warnedNoRecorder = true;
          warn("checkpoints", `The editor's bridge plugin predates checkpoints (${method}); package saves are not recorded until it is updated.`);
        }
        return null;
      }
      if (method === "checkpoint_arm") {
        warn("checkpoints", `${method} failed`, e);
        return null;
      }
      throw e;
    }
  }

  /** Copy a file's bytes into the history before the server writes it. A no-op while off. */
  recordBeforeWrite(file: string): void {
    if (!this.enabled() || !this.session.project.projectDir) return;
    try {
      this.repo().recordBeforeWrite(file);
    } catch (e) {
      warn("checkpoints", `could not record ${file} before writing it`, e);
    }
  }

  create(label?: string): Promise<CheckpointResult> {
    this.requireEnabled();
    return this.repo().serialize(() => this.createUnlocked(label ?? "", "client"));
  }

  private async createUnlocked(label: string, trigger: CheckpointTrigger, expected?: string[]): Promise<CheckpointResult> {
    const repo = this.repo();
    // Re-arm first, so every save before this point is in a generation this checkpoint folds in.
    const armed = await this.arm();
    const connected = armed !== null;
    const out = await repo.checkpoint({
      label,
      trigger,
      activeGeneration: connected ? this.activeGeneration : null,
      expected,
    });
    emit({ type: "created", data: { editor: this.session.name, id: out.info.id, label: out.info.label, trigger, files: out.info.files } });
    return {
      ...out.info,
      editor: this.session.name,
      changes: out.changes,
      dirtyPackages: armed?.dirtyPackages ?? [],
      editorConnected: connected,
    };
  }

  async changes(from: string, to?: string | null, opts: { blueprintDiffs?: boolean } = {}): Promise<ChangesResult> {
    if (!from) throw new CheckpointError(400, "from is required: the checkpoint id to compare against");
    const repo = this.repo();
    return repo.serialize(async () => {
      const result = await repo.changes(from, to ?? null);
      if (opts.blueprintDiffs !== false && this.session.bridge.isConnected) await this.addBlueprintDiffs(result);
      return { editor: this.session.name, ...result };
    });
  }

  /** blueprint(diff) against the checkpoint, for modified Blueprint packages, run in the editor. */
  private async addBlueprintDiffs(result: { from: string; to: string | null; changes: ChangeEntry[] }): Promise<void> {
    const repo = this.repo();
    const candidates = result.changes
      .filter((c) => c.status === "modified" && !c.large && c.path.toLowerCase().endsWith(".uasset"))
      .slice(0, MAX_BLUEPRINT_DIFFS);
    // Saved/Diff maps to /Temp, which is where the editor loads a package for diffing.
    const tempDir = path.join(this.projectDir, "Saved", "Diff", "UE_MCP_Checkpoints");
    for (const c of candidates) {
      const base = path.basename(c.path, path.extname(c.path));
      const fromFile = path.join(tempDir, `${base}-${result.from.slice(0, 10)}.uasset`);
      const toFile = result.to ? path.join(tempDir, `${base}-${result.to.slice(0, 10)}.uasset`) : null;
      try {
        if (!(await repo.exportAt(result.from, c.path, fromFile))) continue;
        if (toFile && !(await repo.exportAt(result.to!, c.path, toFile))) continue;
        const answer = await this.callBridge("checkpoint_diff_blueprint", {
          originalFile: path.join(this.projectDir, c.path),
          fromFile,
          ...(toFile ? { toFile } : {}),
        });
        if (answer && answer.isBlueprint === true) {
          const { success: _s, isBlueprint: _b, ...diff } = answer;
          c.blueprintDiff = diff;
        }
      } catch (e) {
        warn("checkpoints", `blueprint diff of ${c.path} failed`, e);
      } finally {
        fs.rmSync(fromFile, { force: true });
        if (toFile) fs.rmSync(toFile, { force: true });
      }
    }
  }

  restore(checkpoint: string, opts: { paths?: string[]; force?: boolean } = {}): Promise<RestoreResult> {
    this.requireEnabled();
    if (!checkpoint) throw new CheckpointError(400, "checkpoint is required: the id to restore to");
    const repo = this.repo();
    return repo.serialize(async () => {
      const connected = this.session.bridge.isConnected;
      // Refuse during PIE before anything is recorded or written.
      if (connected) await this.callBridge("checkpoint_prepare_restore", { files: [], checkOnly: true });

      const needle = checkpoint.trim().toLowerCase();
      const matches = (await repo.list(Number.MAX_SAFE_INTEGER)).filter((c) => c.id.startsWith(needle));
      if (matches.length !== 1) {
        throw new CheckpointError(400, matches.length === 0 ? `No checkpoint '${checkpoint}' in this project's history` : `'${checkpoint}' matches ${matches.length} checkpoints; give more of the id`);
      }
      const target = matches[0];
      const before = await this.createUnlocked(`before restore to ${target.label}`, "restore-before");
      const { plan, refused } = await repo.planRestore(target.id, before.id, opts.paths, opts.force === true);

      const prepared = connected && plan.length > 0
        ? await this.callBridge("checkpoint_prepare_restore", { files: plan.map((p) => p.file) })
        : null;
      const restored: RestoreResult["restored"] = [];
      for (const entry of plan) {
        try {
          restored.push({ path: entry.path, action: await repo.apply(entry) });
        } catch (e) {
          refused.push({ path: entry.path, reason: "write-failed", detail: e instanceof Error ? e.message : String(e) });
        }
      }
      const finished = connected && plan.length > 0
        ? await this.callBridge("checkpoint_finish_restore", {
          files: restored.map((r) => ({ file: path.join(repo.projectDir, r.path), exists: r.action === "written", kind: changeKind(r.path) })),
          reopen: Array.isArray(prepared?.closedEditors) ? prepared!.closedEditors : [],
        })
        : null;

      const after = await this.createUnlocked(`restored to ${target.label}`, "restore-after", restored.map((r) => r.path));
      const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
      const result: RestoreResult = {
        editor: this.session.name,
        checkpoint: target.id,
        before: before.id,
        after: after.id,
        restored,
        refused,
        reloaded: strings(finished?.reloaded),
        unloaded: strings(finished?.unloaded),
        configsReloaded: strings(finished?.configsReloaded),
        reopened: strings(finished?.reopened),
      };
      emit({
        type: "restored",
        data: {
          editor: this.session.name,
          checkpoint: result.checkpoint,
          before: result.before,
          after: result.after,
          restored: restored.map((r) => r.path),
          refused: refused.map((r) => ({ path: r.path, reason: r.reason })),
        },
      });
      info("checkpoints", `${this.session.name}: restored ${restored.length} path(s) to ${result.checkpoint.slice(0, 10)}, refused ${refused.length}`);
      return result;
    });
  }

  /** Delete the history. Allowed while off, which is how history kept from before is removed. */
  async clear(): Promise<{ editor: string; cleared: true }> {
    const repo = this.repo();
    await repo.serialize(async () => {
      repo.clear();
      this.activeGeneration = null;
      if (this.enabled()) await this.arm().catch((e) => warn("checkpoints", "re-arming after clear failed", e));
    });
    emit({ type: "cleared", data: { editor: this.session.name } });
    return { editor: this.session.name, cleared: true };
  }
}

const bySession = new WeakMap<EditorSession, SessionCheckpoints>();

/** The session's checkpoints, created on first use; creating them creates nothing on disk. */
export function checkpointsFor(session: EditorSession): SessionCheckpoints {
  let c = bySession.get(session);
  if (!c) {
    c = new SessionCheckpoints(session);
    bySession.set(session, c);
  }
  return c;
}

/** Record a file the server is about to write, for the session a tool call runs in. */
export function recordBeforeWrite(session: EditorSession | undefined, file: string): void {
  if (session) checkpointsFor(session).recordBeforeWrite(file);
}
