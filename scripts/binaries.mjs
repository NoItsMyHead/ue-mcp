#!/usr/bin/env node
/**
 * Prebuilt bridge binaries, built on this machine and attached to a release.
 *
 *   node scripts/binaries.mjs build [--engines 5.7,5.8] [--out dist-binaries]
 *   node scripts/binaries.mjs upload [--out dist-binaries]
 *
 * build compiles the plugin's editor modules once per installed engine, in a
 * host project kept between runs so only changed files recompile, and packages
 * each as UE_MCP_Bridge-<version>-UE<engine>-<platform>.zip, the name
 * `ue-mcp init` asks for: the editor binaries, Resources and the installed
 * descriptor, as BuildPlugin packages them less Source and Intermediate. It writes
 * UE_MCP_Bridge-<version>-manifest.json with each zip's SHA-256, which the
 * installer checks before installing anything.
 *
 * upload attaches the zips and the manifest to the draft GitHub release for the
 * version in package.json. It refuses a published release: binaries ship with
 * the release that carries them, never after it.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isSameOrUnder, protectedEngineRoots } from "./build-utils.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(ROOT, "plugin", "ue_mcp_bridge", "UE_MCP_Bridge.uplugin");
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")).version;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const out = path.resolve(arg("--out", path.join(ROOT, "dist-binaries")));
const platform = process.platform === "win32" ? "Win64" : process.platform === "darwin" ? "Mac" : "Linux";

/** Engine roots by major.minor: UE_MCP_BINARY_ENGINES (5.7=C:/...;5.8=C:/...) or the launcher's default location. */
function engines() {
  const explicit = process.env.UE_MCP_BINARY_ENGINES;
  if (explicit) {
    return explicit.split(";").filter(Boolean).map((e) => {
      const [v, root] = e.split("=");
      return { version: v, root };
    });
  }
  const base = process.platform === "win32" ? "C:/Program Files/Epic Games" : "/Users/Shared/Epic Games";
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base)
    .map((d) => /^UE_(\d+\.\d+)$/.exec(d))
    .filter(Boolean)
    .map((m) => ({ version: m[1], root: path.join(base, m[0]) }));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function zipName(engine) {
  return `UE_MCP_Bridge-${version}-UE${engine}-${platform}.zip`;
}

function manifestName() {
  return `UE_MCP_Bridge-${version}-manifest.json`;
}

/** bsdtar writes zip from the extension; on Windows it is named by path because Git Bash puts GNU tar first. */
function zipDir(parent, folder, zipPath) {
  const tar = process.platform === "win32" ? path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  fs.rmSync(zipPath, { force: true });
  execFileSync(tar, ["-a", "-c", "-f", zipPath, "-C", parent, folder], { stdio: "inherit" });
}

/** Engine/Build/Build.version as major.minor.0, which BuildPlugin stamps into a packaged descriptor. */
function engineVersion(root) {
  const v = JSON.parse(fs.readFileSync(path.join(root, "Engine", "Build", "Build.version"), "utf-8"));
  return `${v.MajorVersion}.${v.MinorVersion}.0`;
}

/** Make dst match src file for file, touching only what differs, so UBT's dependency check sees real edits only. */
function syncTree(src, dst, skip) {
  fs.mkdirSync(dst, { recursive: true });
  const want = new Set();
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.includes(ent.name)) continue;
    want.add(ent.name);
    const a = path.join(src, ent.name);
    const b = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      syncTree(a, b, []);
    } else {
      const same = fs.existsSync(b) && fs.statSync(b).size === fs.statSync(a).size && fs.readFileSync(a).equals(fs.readFileSync(b));
      if (!same) fs.copyFileSync(a, b);
    }
  }
  for (const ent of fs.readdirSync(dst, { withFileTypes: true })) {
    if (skip.includes(ent.name) || want.has(ent.name)) continue;
    fs.rmSync(path.join(dst, ent.name), { recursive: true, force: true });
  }
}

function runAsync(cmd, args, logFile) {
  return new Promise((resolve) => {
    const log = fs.openSync(logFile, "w");
    // A .bat runs under cmd, and the engine path has spaces: quote every piece and pass the line verbatim.
    const child = process.platform === "win32"
      ? spawn(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[cmd, ...args].map((x) => `"${x}"`).join(" ")}"`], {
          stdio: ["ignore", log, log],
          windowsVerbatimArguments: true,
        })
      : spawn(cmd, args, { stdio: ["ignore", log, log] });
    child.on("close", (code) => {
      fs.closeSync(log);
      resolve(code);
    });
  });
}

/**
 * One engine: the plugin's editor modules, compiled in a host project kept between runs, so a
 * release recompiles only the files that changed. The zip carries the editor binaries alone, so
 * the UnrealGame builds BuildPlugin also makes are not compiled here.
 */
async function buildEngine(engine) {
  const batch = path.join(engine.root, "Engine", "Build", "BatchFiles");
  const script = process.platform === "win32" ? path.join(batch, "Build.bat") : path.join(batch, process.platform === "darwin" ? "Mac" : "Linux", "Build.sh");
  if (!fs.existsSync(script)) {
    console.warn(`skip UE ${engine.version}: no ${script}`);
    return null;
  }
  // A short root: UBT refuses action paths over Windows' 260 characters.
  const stage = path.join(arg("--stage", path.join(os.tmpdir(), "uemcpb")), `UE${engine.version}`);
  const host = path.join(stage, "Host");
  const hostProject = path.join(host, "Host.uproject");
  const hostPlugin = path.join(host, "Plugins", "UE_MCP_Bridge");
  fs.mkdirSync(host, { recursive: true });
  if (!fs.existsSync(hostProject)) {
    fs.writeFileSync(hostProject, JSON.stringify({ FileVersion: 3, Plugins: [{ Name: "UE_MCP_Bridge", Enabled: true }] }, null, "\t"));
  }
  syncTree(path.dirname(PLUGIN), hostPlugin, ["Binaries", "Intermediate"]);

  const manifest = path.join(stage, "Manifest.xml");
  fs.rmSync(manifest, { force: true });
  const started = Date.now();
  const logFile = path.join(out, `build-UE${engine.version}.log`);
  console.log(`== UE ${engine.version}: compiling (log ${logFile})`);
  const code = await runAsync(script, [
    "UnrealEditor", platform, "Development",
    `-Project=${hostProject}`, `-plugin=${path.join(hostPlugin, path.basename(PLUGIN))}`, `-manifest=${manifest}`, "-nohotreload",
    // Its own host project and intermediates, so it needs no claim on UBT's single-instance lock.
    // Holding it stalled an editor launched beside it for 294 s in its AutoSDK step.
    "-NoMutex",
    // Each engine's UBT its own log: two in parallel otherwise fight over %LOCALAPPDATA%/UnrealBuildTool/Log.txt.
    `-log=${path.join(stage, "UBT.log")}`,
  ], logFile);
  if (code !== 0) throw new Error(`UE ${engine.version}: compile failed (exit ${code}); see ${logFile}`);

  // Package what BuildPlugin would, less the Source and Intermediate the installer strips anyway:
  // the build products under the plugin, its Resources, and the installed descriptor.
  const pkgRoot = path.join(stage, "pkg");
  const pkg = path.join(pkgRoot, "UE_MCP_Bridge");
  fs.rmSync(pkgRoot, { recursive: true, force: true });
  // UBT writes the manifest as UTF-16 with a byte order mark.
  const manifestText = fs.readFileSync(manifest).toString("utf16le").replace(/^﻿/, "");
  const products = [...manifestText.matchAll(/<string>([^<]+)<\/string>/g)]
    .map((m) => path.resolve(m[1]))
    .filter((f) => isSameOrUnder(f, path.join(hostPlugin, "Binaries")));
  if (!products.some((f) => f.endsWith(".modules"))) throw new Error(`UE ${engine.version}: the build manifest lists no .modules file`);
  for (const f of products) {
    const to = path.join(pkg, path.relative(hostPlugin, f));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(f, to);
  }
  for (const dir of ["Resources", "Content", "Shaders", path.join("Binaries", "ThirdParty")]) {
    const from = path.join(hostPlugin, dir);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(pkg, dir), { recursive: true });
  }
  const descriptor = JSON.parse(fs.readFileSync(PLUGIN, "utf-8"));
  delete descriptor.EnabledByDefault;
  // UE's descriptor writer leaves out flags that are false.
  for (const k of ["IsBetaVersion", "IsExperimentalVersion"]) if (descriptor[k] === false) delete descriptor[k];
  descriptor.EngineVersion = engineVersion(engine.root);
  descriptor.Installed = true;
  fs.writeFileSync(path.join(pkg, path.basename(PLUGIN)), JSON.stringify(descriptor, null, "\t"));

  const zip = path.join(out, zipName(engine.version));
  zipDir(pkgRoot, "UE_MCP_Bridge", zip);
  console.log(`== UE ${engine.version}: ${zipName(engine.version)} in ${Math.round((Date.now() - started) / 1000)} s`);
  return { engine: engine.version, platform, file: zipName(engine.version), sha256: sha256(zip), size: fs.statSync(zip).size };
}

async function build() {
  // Binaries carry the descriptor they were built from; it must already name this version.
  const descriptor = JSON.parse(fs.readFileSync(PLUGIN, "utf-8")).VersionName;
  if (descriptor !== version) {
    throw new Error(`the plugin descriptor says ${descriptor}, package.json says ${version}; run npm run generate:metadata first`);
  }
  const wanted = arg("--engines", null)?.split(",");
  // UE_MCP_PROTECTED_ENGINE_ROOTS outranks everything, as it does for the test builds.
  const denied = protectedEngineRoots();
  const found = engines()
    .filter((e) => !wanted || wanted.includes(e.version))
    .filter((e) => {
      const blocked = denied.some((root) => isSameOrUnder(e.root, root));
      if (blocked) console.warn(`skip UE ${e.version}: ${e.root} is in UE_MCP_PROTECTED_ENGINE_ROOTS`);
      return !blocked;
    });
  if (found.length === 0) throw new Error("no engines to build against; set UE_MCP_BINARY_ENGINES or install one");
  fs.mkdirSync(out, { recursive: true });

  // Engines in parallel: each is one editor target, and an incremental one is mostly linking.
  const assets = (await Promise.all(found.map(buildEngine))).filter(Boolean);

  // Merge with a manifest from an earlier run of the same version, so engines can be built one at a time.
  const manifestPath = path.join(out, manifestName());
  const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf-8")) : null;
  const kept = previous?.version === version ? previous.assets.filter((a) => !assets.some((b) => b.file === a.file)) : [];
  const merged = [...kept, ...assets].sort((a, b) => a.file.localeCompare(b.file));
  fs.writeFileSync(manifestPath, JSON.stringify({ version, assets: merged }, null, 2) + "\n");
  console.log(`\nmanifest: ${manifestPath} (${merged.length} asset(s))`);
}

function upload() {
  const manifestPath = path.join(out, manifestName());
  if (!fs.existsSync(manifestPath)) throw new Error(`no ${manifestPath}; run build first`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  if (manifest.version !== version) throw new Error(`manifest is for ${manifest.version}, package.json says ${version}`);
  for (const a of manifest.assets) {
    const file = path.join(out, a.file);
    if (!fs.existsSync(file) || sha256(file) !== a.sha256) throw new Error(`${a.file} is missing or does not match the manifest`);
  }

  const tag = `v${version}`;
  const view = spawnSync("gh", ["release", "view", tag, "--json", "isDraft"], { encoding: "utf-8" });
  if (view.status !== 0) throw new Error(`no release ${tag}; create the draft first (gh release create ${tag} --draft --notes-file ...)`);
  if (!JSON.parse(view.stdout).isDraft) throw new Error(`${tag} is already published; binaries go on the draft before the version bump`);

  const files = [...manifest.assets.map((a) => path.join(out, a.file)), manifestPath];
  const r = spawnSync("gh", ["release", "upload", tag, ...files, "--clobber"], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("gh release upload failed");
  console.log(`uploaded ${files.length} file(s) to draft ${tag}`);
}

const command = process.argv[2];
try {
  if (command === "build") await build();
  else if (command === "upload") upload();
  else {
    console.error("usage: node scripts/binaries.mjs <build|upload> [--engines 5.7,5.8] [--out dir]");
    process.exit(2);
  }
} catch (e) {
  console.error(`binaries: ${e.message}`);
  process.exit(1);
}
