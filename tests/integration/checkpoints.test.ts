/**
 * Checkpoints through a spawned daemon (#1482): the toggle from ue-mcp.yml and
 * the per-session override, the /v1/checkpoints routes, their events, the
 * bridge recording contract (checkpoint_arm hands the editor a pending
 * generation; the editor copies a package there before saving it), a subset
 * restore with the editor told what to reload, and a project .git that no
 * action touches. The editor is a fake bridge that writes what the C++
 * recorder writes.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { covers } from "../helpers/covers.js";
import { FakeBridge } from "../fake-bridge.js";
import { McpServer, Sandbox, json, stopSandboxDaemons, waitFor } from "./harness.js";
import { base, bearer, call, readSse, startDaemonCli, type Discovery } from "./daemon-fakes.js";

type Json = Record<string, any>;

let sb: Sandbox;
let bridge: FakeBridge;
let d: Discovery;
let project: string;
let dir: string;
/** The generation the fake editor was last armed with, or null when disarmed. */
let armed: string | null = null;
const prepared: string[][] = [];
const finished: Json[][] = [];

const file = (rel: string) => path.join(dir, rel);
const write = (rel: string, content: string) => {
  fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
  fs.writeFileSync(file(rel), content);
};
const read = (rel: string) => fs.readFileSync(file(rel), "utf8");

/** What the bridge's PreSavePackageWithContextEvent hook does, then the save itself. */
function editorSave(rel: string, content: string): void {
  if (!armed) throw new Error("the fake editor was never armed");
  const manifest = path.join(armed, "manifest.jsonl");
  const n = fs.existsSync(manifest) ? fs.readFileSync(manifest, "utf8").split("\n").filter(Boolean).length : 0;
  const existed = fs.existsSync(file(rel));
  if (existed) fs.copyFileSync(file(rel), path.join(armed, `${n}.bin`));
  fs.appendFileSync(manifest, `${JSON.stringify({ path: file(rel), existed, ...(existed ? { copy: `${n}.bin` } : {}) })}\n`);
  write(rel, content);
}

const gitSnapshot = () => {
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(file(".git"), { recursive: true }).map(String)) {
    const abs = path.join(file(".git"), f);
    if (fs.statSync(abs).isFile()) out[f] = fs.readFileSync(abs, "utf8");
  }
  return out;
};

beforeAll(async () => {
  sb = new Sandbox();
  project = sb.makeProject("Turns");
  dir = path.dirname(project);
  write(".git/HEAD", "ref: refs/heads/main\n");
  write(".git/config", "[core]\n\tbare = false\n");
  write("Config/DefaultGame.ini", "[/Script/EngineSettings.GeneralProjectSettings]\nProjectName=Turns\n");
  write("Content/BP_Door.uasset", "door v1");
  write("Content/M_Wall.uasset", "wall v1");
  bridge = await FakeBridge.start({
    projectDir: dir,
    handlers: {
      checkpoint_arm: (p) => {
        armed = p.enabled === true ? String(p.pendingDir) : null;
        return { success: true, armed: p.enabled === true, dirtyPackages: ["/Game/Maps/Unsaved"] };
      },
      checkpoint_prepare_restore: (p) => {
        prepared.push((p.files as string[]) ?? []);
        return { success: true, closedEditors: [] };
      },
      checkpoint_finish_restore: (p) => {
        const files = (p.files as Json[]) ?? [];
        finished.push(files);
        return {
          success: true,
          reloaded: files.filter((f) => f.kind === "package" && f.exists).map((f) => path.basename(String(f.file))),
          unloaded: files.filter((f) => f.kind === "package" && !f.exists).map((f) => path.basename(String(f.file))),
          configsReloaded: files.filter((f) => f.kind === "config").map((f) => path.basename(String(f.file), ".ini")),
          reopened: [],
        };
      },
      checkpoint_diff_blueprint: () => ({ success: true, isBlueprint: false }),
    },
  });
  d = await startDaemonCli(sb, project, { UE_MCP_PORT: undefined });
  await waitFor(async () => (await call(d, "GET", "/v1/health")).body.editors[0]?.connected === true, 15_000, "the daemon to reach the fake editor");
}, 60_000);

afterAll(async () => {
  await stopSandboxDaemons(sb);
  await bridge?.stop();
  sb.cleanup();
});

describe("checkpoints through the daemon", () => {
  let start: string;
  let end: string;
  let gitBefore: Record<string, string>;

  it("are off by default: no repository, no armed editor, and creating one is refused", async () => {
    covers("config.checkpoints");
    gitBefore = gitSnapshot();
    const health = await call(d, "GET", "/v1/health");
    expect(health.body.features).toContain("checkpoints");

    const state = await call(d, "GET", "/v1/checkpoints");
    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({ enabled: false, source: "config", configured: false, repository: null, checkpoints: [] });
    const refused = await call(d, "POST", "/v1/checkpoints", { label: "nope" });
    expect(refused.status).toBe(409);
    expect(fs.existsSync(file("Saved/UE_MCP_Bridge/shadow.git"))).toBe(false);
    expect(bridge.calls.some((c) => c.method === "checkpoint_arm" && c.params.enabled === true)).toBe(false);
  });

  it("turn on per session through the daemon, which arms the editor", async () => {
    covers("config.checkpoints", "daemon.checkpoints");
    const before = (await call(d, "GET", "/v1/health")).body.lastEventId as number;
    const stream = readSse(`${base(d)}/v1/events`, { ...bearer(d), "last-event-id": String(before) }, (es) => es.some((e) => e.type === "checkpoints.toggled"));
    const on = await call(d, "PUT", "/v1/checkpoints/enabled", { enabled: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ enabled: true, source: "session", configured: false });
    const toggled = (await stream).find((e) => e.type === "checkpoints.toggled")!;
    expect(toggled.data).toMatchObject({ enabled: true, source: "session" });
    expect(armed).not.toBeNull();
    expect(path.relative(dir, armed!).split(path.sep).slice(0, 3)).toEqual(["Saved", "UE_MCP_Bridge", "shadow-pending"]);
    expect((await call(d, "PUT", "/v1/checkpoints/enabled", { enabled: "yes" })).status).toBe(400);
  });

  it("record a turn's editor saves and server writes and list what changed", async () => {
    covers("daemon.checkpoints");
    const a = await call(d, "POST", "/v1/checkpoints", { label: "turn start" });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body).toMatchObject({ label: "turn start", trigger: "client", editorConnected: true, dirtyPackages: ["/Game/Maps/Unsaved"] });
    start = a.body.id;
    expect(start).toMatch(/^[0-9a-f]{40}$/);

    // The turn: two package saves in the editor and a config and a source write through the server.
    editorSave("Content/BP_Door.uasset", "door v2");
    editorSave("Content/M_Wall.uasset", "wall v2");
    editorSave("Config/DefaultGame.ini", "[/Script/EngineSettings.GeneralProjectSettings]\nProjectName=Turns2\n");
    const server = await McpServer.start(sb, { projects: [project], mode: "daemon", port: null });
    try {
      const wrote = await server.call("tools", { action: "call", category: "project", method: "write_cpp_file", args: { path: "Turns/Door.h", content: "#pragma once\n" } });
      expect(wrote.isError, wrote.text).toBe(false);
    } finally {
      await server.client.close();
    }

    const before = (await call(d, "GET", "/v1/health")).body.lastEventId as number;
    const stream = readSse(`${base(d)}/v1/events`, { ...bearer(d), "last-event-id": String(before) }, (es) => es.some((e) => e.type === "checkpoint.created"));
    const b = await call(d, "POST", "/v1/checkpoints", { label: "turn end" });
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    end = b.body.id;
    expect((b.body.changes as Json[]).map((c) => [c.path, c.status, c.kind])).toEqual([
      ["Config/DefaultGame.ini", "modified", "config"],
      ["Content/BP_Door.uasset", "modified", "package"],
      ["Content/M_Wall.uasset", "modified", "package"],
      ["Source/Turns/Door.h", "added", "source"],
    ]);
    const created = (await stream).find((e) => e.type === "checkpoint.created")!;
    expect(created.data).toMatchObject({ id: end, label: "turn end", trigger: "client", files: 4 });

    const changes = await call(d, "GET", `/v1/checkpoints/changes?from=${start.slice(0, 8)}&to=${end}`);
    expect(changes.status).toBe(200);
    const ini = (changes.body.changes as Json[]).find((c) => c.path === "Config/DefaultGame.ini")!;
    expect(ini.diff).toContain("-ProjectName=Turns\n");
    expect(ini.diff).toContain("+ProjectName=Turns2\n");

    const list = await call(d, "GET", "/v1/checkpoints?limit=10");
    expect((list.body.checkpoints as Json[]).map((c) => c.label)).toEqual(["turn end", "turn start"]);
    expect(list.body.repository).toBe(file("Saved/UE_MCP_Bridge/shadow.git"));
  });

  it("restore a subset to the turn's start, tell the editor what to reload, and keep the rest", async () => {
    covers("daemon.checkpoints");
    const before = (await call(d, "GET", "/v1/health")).body.lastEventId as number;
    const stream = readSse(`${base(d)}/v1/events`, { ...bearer(d), "last-event-id": String(before) }, (es) => es.some((e) => e.type === "checkpoint.restored"));
    const r = await call(d, "POST", "/v1/checkpoints/restore", {
      checkpoint: start,
      paths: ["Content/BP_Door.uasset", "Config/DefaultGame.ini", "Source/Turns/Door.h"],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.refused).toEqual([]);
    expect(r.body.restored).toEqual([
      { path: "Config/DefaultGame.ini", action: "written" },
      { path: "Content/BP_Door.uasset", action: "written" },
      { path: "Source/Turns/Door.h", action: "deleted" },
    ]);
    expect(read("Content/BP_Door.uasset")).toBe("door v1");
    expect(read("Config/DefaultGame.ini")).toContain("ProjectName=Turns\n");
    expect(fs.existsSync(file("Source/Turns/Door.h"))).toBe(false);
    expect(read("Content/M_Wall.uasset")).toBe("wall v2");
    expect(r.body.reloaded).toEqual(["BP_Door.uasset"]);
    expect(r.body.configsReloaded).toEqual(["DefaultGame"]);

    // The editor was told before the write and after it, with the same files.
    expect(prepared.at(-1)!.map((f) => path.basename(f)).sort()).toEqual(["BP_Door.uasset", "DefaultGame.ini", "Door.h"]);
    expect(finished.at(-1)!.map((f) => [path.basename(String(f.file)), f.exists])).toEqual([
      ["DefaultGame.ini", true],
      ["BP_Door.uasset", true],
      ["Door.h", false],
    ]);
    const restored = (await stream).find((e) => e.type === "checkpoint.restored")!;
    expect(restored.data).toMatchObject({ checkpoint: start, before: r.body.before, after: r.body.after });

    // The restore is checkpointed, so restoring to `before` undoes it.
    const undo = await call(d, "POST", "/v1/checkpoints/restore", { checkpoint: r.body.before });
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);
    expect(read("Content/BP_Door.uasset")).toBe("door v2");
    expect(read("Source/Turns/Door.h")).toBe("#pragma once\n");
  });

  it("refuse a path edited outside the agent unless forced", async () => {
    covers("daemon.checkpoints");
    write("Content/M_Wall.uasset", "wall edited by hand");
    const now = await call(d, "GET", `/v1/checkpoints/changes?from=${start}`);
    expect((now.body.changes as Json[]).find((c) => c.path === "Content/M_Wall.uasset")).toMatchObject({ untracked: true });
    const r = await call(d, "POST", "/v1/checkpoints/restore", { checkpoint: start, paths: ["Content/M_Wall.uasset"] });
    expect(r.body.refused).toEqual([expect.objectContaining({ path: "Content/M_Wall.uasset", reason: "edited-outside" })]);
    expect(read("Content/M_Wall.uasset")).toBe("wall edited by hand");
    const forced = await call(d, "POST", "/v1/checkpoints/restore", { checkpoint: start, paths: ["Content/M_Wall.uasset"], force: true });
    expect(forced.body.restored).toEqual([{ path: "Content/M_Wall.uasset", action: "written" }]);
    expect(read("Content/M_Wall.uasset")).toBe("wall v1");
  });

  it("answer bad input with 400 and an unknown editor with 404", async () => {
    covers("daemon.checkpoints");
    expect((await call(d, "GET", "/v1/checkpoints/changes")).status).toBe(400);
    expect((await call(d, "GET", "/v1/checkpoints/changes?from=deadbeef")).status).toBe(400);
    expect((await call(d, "POST", "/v1/checkpoints/restore", {})).status).toBe(400);
    expect((await call(d, "GET", "/v1/checkpoints?editor=nobody")).status).toBe(404);
  });

  it("never touched the project's own .git", () => {
    covers("daemon.checkpoints");
    expect(gitSnapshot()).toEqual(gitBefore);
  });

  it("turn off again, disarming the editor and keeping the history, and clear deletes it", async () => {
    covers("config.checkpoints", "daemon.checkpoints");
    const off = await call(d, "PUT", "/v1/checkpoints/enabled", { enabled: null });
    expect(off.body).toMatchObject({ enabled: false, source: "config" });
    expect(armed).toBeNull();
    expect(bridge.calls.filter((c) => c.method === "checkpoint_arm").at(-1)!.params).toEqual({ enabled: false });
    expect(off.body.checkpoints.length).toBeGreaterThan(0);

    const cleared = await call(d, "DELETE", "/v1/checkpoints");
    expect(cleared.body).toMatchObject({ cleared: true });
    expect(fs.existsSync(file("Saved/UE_MCP_Bridge/shadow.git"))).toBe(false);
    expect((await call(d, "GET", "/v1/checkpoints")).body.repository).toBeNull();
  });
});

describe("checkpoints: on in ue-mcp.yml", () => {
  it("turns them on for the project, and editor(checkpoint) records with no editor running", async () => {
    covers("config.checkpoints", "server.checkpoints");
    const other = sb.makeProject("Configured", { config: "ue-mcp:\n  checkpoints: on\n" });
    const otherDir = path.dirname(other);
    fs.mkdirSync(path.join(otherDir, "Source"), { recursive: true });
    const server = await McpServer.start(sb, { projects: [other], mode: "in-process" });
    try {
      const listed = await server.call("tools", { action: "call", category: "editor", method: "list_checkpoints", args: {} });
      expect(listed.isError, listed.text).toBe(false);
      expect(json(listed)).toMatchObject({ enabled: true, source: "config", configured: true });
      const a = await server.call("tools", { action: "call", category: "editor", method: "checkpoint", args: { label: "offline start" } });
      expect(a.isError, a.text).toBe(false);
      const id = json<Json>(a).id as string;
      expect(json<Json>(a).editorConnected).toBe(false);
      const wrote = await server.call("tools", { action: "call", category: "project", method: "write_cpp_file", args: { path: "Offline.h", content: "// one\n" } });
      expect(wrote.isError, wrote.text).toBe(false);
      const changes = await server.call("tools", { action: "call", category: "editor", method: "list_changes", args: { from: id } });
      expect(json<Json>(changes).changes).toEqual([expect.objectContaining({ path: "Source/Offline.h", status: "added", kind: "source" })]);
      const restored = await server.call("tools", { action: "call", category: "editor", method: "restore", args: { checkpoint: id } });
      expect(restored.isError, restored.text).toBe(false);
      expect(json<Json>(restored).restored).toEqual([{ path: "Source/Offline.h", action: "deleted" }]);
      expect(fs.existsSync(path.join(otherDir, "Source", "Offline.h"))).toBe(false);
      expect(fs.existsSync(path.join(otherDir, "Saved", "UE_MCP_Bridge", "shadow.git", "HEAD"))).toBe(true);
    } finally {
      await server.close();
    }
  }, 60_000);
});
