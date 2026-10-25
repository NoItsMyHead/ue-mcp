#!/usr/bin/env node
/**
 * Cut a release in one command (#1465).
 *
 *   node scripts/release-run.mjs --version X.Y.Z[-pre.N] --notes <notes.md> [--dry-run]
 *
 * 1. Checks the notes (headline frontmatter, prose rules) before anything moves.
 * 2. Bumps the version on a bump/<version> branch from origin/main, stamps the
 *    metadata, pushes it and opens the pull request, so CI tests it once while
 *    everything below runs.
 * 3. Selects the tests from the dependency graph (scripts/select-tests.ts, #1509):
 *    the diff since the previous release tag, walked back to the actions it reaches,
 *    then every test that sends one. A stable release runs the full suite.
 * 4. Creates the draft release with the notes.
 * 5. In parallel:
 *      binaries  incremental per-engine compile, uploaded to the draft
 *      live      the selected live files, sharded
 *      editor    only when plugin/ changed: smoke over the actions no behavioural
 *                test dispatches, then the selected UE.MCP.* automation tests
 *      lifecycle after live, only when the graph selects editor-lifecycle.test.ts
 * 6. Merges the pull request once CI and every lane above are green. The merge to
 *    main publishes.
 *
 * Unit, integration and the release gates are not run here: the pull request's
 * CI runs them on the same commit. Each lane logs to release-logs/<lane>.log, the
 * selection goes to release-logs/selection.json, and the timing to
 * release-logs/release-timing.json. A run over the 600 s budget says so in its summary.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const version = flag("--version");
const notes = flag("--notes") && path.resolve(flag("--notes"));
const dryRun = argv.includes("--dry-run");
if (!version || !notes) {
  console.error("usage: node scripts/release-run.mjs --version X.Y.Z[-pre.N] --notes <notes.md> [--dry-run]");
  process.exit(2);
}
const logDir = path.join(ROOT, "release-logs");
fs.mkdirSync(logDir, { recursive: true });
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s`;
const sh = (cmd, args, opts = {}) => (execFileSync(cmd, args, { cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"], ...opts }) ?? "").trim();
const git = (...args) => sh("git", args);

// What changed since the last release decides which tests run.
const previousTag = git("describe", "--tags", "--abbrev=0", "--match", "v*", "origin/main");
const changed = git("diff", "--name-only", `${previousTag}...origin/main`).split("\n").filter(Boolean);
const pluginChanged = changed.some((f) => f.startsWith("plugin/"));
const stable = !version.includes("-");
const BUDGET_S = 600;
console.log(`since ${previousTag}: ${changed.length} files; plugin ${pluginChanged ? "changed" : "unchanged"}${stable ? "; stable release" : ""}`);

// 1. Notes first: a bad headline or banned character found after the push costs a CI round.
sh(node, ["scripts/release-headline.mjs", "--body-file", notes], { stdio: ["ignore", "ignore", "inherit"] });
sh(node, ["scripts/lint-prose.mjs", "--release-body", notes], { stdio: ["ignore", "ignore", "inherit"] });

// 2. The bump, on its own branch from origin/main.
const branch = `bump/${version}`;
git("checkout", "-B", branch, "origin/main");
const pkgPath = path.join(ROOT, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
pkg.version = version;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
sh(npm, ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { shell: process.platform === "win32" });
sh(npm, ["run", "generate:metadata"], { shell: process.platform === "win32", stdio: ["ignore", "ignore", "inherit"] });
git("add", "-A", "package.json", "package-lock.json", "plugin/", "src/", "docs/", "CLAUDE.md", "README.md");
git("commit", "-m", `chore(release): ${version}`);

// 3. The selection, from the graph of the tree being released. A dry run prints it too.
const selectionFile = path.join(logDir, "selection.json");
execFileSync(node, ["--import", "tsx", "scripts/select-tests.ts", "--base", previousTag, "--head", "origin/main", "--out", selectionFile, ...(stable ? ["--stable"] : [])], { cwd: ROOT, stdio: ["ignore", "inherit", "inherit"] });
const selection = JSON.parse(fs.readFileSync(selectionFile, "utf-8"));
const runLive = selection.live.length > 0;
const runLifecycle = selection.lifecycle;
const runAutomation = selection.automation === "all" || selection.automation.length > 0;
if (dryRun) {
  console.log("dry run: stopping before the push");
  process.exit(0);
}
// 4. Draft before the push, so the merge always finds it. A rerun reuses the draft and the pull request.
const quiet = { stdio: ["ignore", "pipe", "ignore"] };
const tryRun = (cmd, args) => { try { return sh(cmd, args, quiet); } catch { return ""; } };
if (tryRun("gh", ["release", "view", `v${version}`, "--json", "isDraft", "--jq", ".isDraft"]) === "true") {
  sh("gh", ["release", "edit", `v${version}`, "--notes-file", notes]);
} else {
  sh("gh", ["release", "create", `v${version}`, "--draft", "--notes-file", notes, "--title", `v${version}`]);
}
git("push", "-u", "origin", branch, "--force");
const pr = tryRun("gh", ["pr", "view", branch, "--json", "url,state", "--jq", "select(.state == \"OPEN\") | .url"])
  || sh("gh", ["pr", "create", "--base", "main", "--head", branch, "--title", `chore(release): ${version}`, "--body", `Release ${version}.`]);
console.log(`${stamp()} pull request ${pr}`);

// 5. Lanes.
const steps = [];
function run(name, cmd, args) {
  const logFile = path.join(logDir, `${name}.log`);
  const out = fs.openSync(logFile, "w");
  const started = Date.now();
  console.log(`${stamp()} start  ${name}`);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ["ignore", out, out], shell: process.platform === "win32" });
    child.on("close", (code) => {
      fs.closeSync(out);
      const step = { name, code, startS: (started - t0) / 1000, durationS: (Date.now() - started) / 1000 };
      steps.push(step);
      console.log(`${stamp()} ${code === 0 ? "pass " : "FAIL "} ${name} (${step.durationS.toFixed(0)}s)${code === 0 ? "" : ` see ${logFile}`}`);
      resolve(code === 0);
    });
  });
}
async function lane(list) {
  for (const s of list) if (!(await run(...s))) return false;
  return true;
}
// gh pr checks fails while GitHub has not registered any check yet, so wait for the first one.
const ciGreen = async () => {
  for (let i = 0; i < 60 && !tryRun("gh", ["pr", "checks", pr, "--json", "name", "--jq", ".[0].name"]); i++) {
    await new Promise((r) => setTimeout(r, 3000));
  }
  return run("ci", "gh", ["pr", "checks", pr, "--watch", "--fail-fast"]);
};

// tests/ue_mcp is built once, then the short editor lane (smoke over the actions no behavioural
// test dispatches, and the UE.MCP.* suite) runs and closes its editor, so the live suite sizes its
// shards to the whole machine. Lifecycle runs after live, on tests/ue_mcp itself.
const selected = selection.full ? [] : ["--", "--files-from", selectionFile];
const editorLane = pluginChanged
  ? [
    ["up", npm, ["run", "up"]],
    ["smoke", node, ["scripts/smoke-test.js", "--uncovered"]],
    ...(runAutomation ? [["automation", node, ["scripts/automation-tests.mjs", ...(selection.full ? [] : ["--filters-from", selectionFile])]]] : []),
    ["down", node, ["scripts/stop-editor.mjs"]],
  ]
  : [];
// The lifecycle cases attach to a running editor and stop, crash and restart it.
const afterLive = runLifecycle ? [["up-lifecycle", npm, ["run", "up"]], ["lifecycle", npm, ["run", "test:live", "--", "--lifecycle"]]] : [];
const needsBuild = pluginChanged || runLive || runLifecycle;

const binaries = lane([
  ["binaries", npm, ["run", "binaries:build"]],
  ["binaries-upload", npm, ["run", "binaries:upload"]],
]);
const lanes = [
  binaries,
  (async () => {
    if (!needsBuild) return true;
    if (!(await lane([["deploy", node, ["scripts/deploy.mjs"]], ["build", npm, ["run", "build"]], ...editorLane]))) return false;
    // The live suite sizes its shards to the memory free when it starts, and a binaries compile
    // still running beside it cost 1.4.11-beta.4 its second headless shard (884 s on one). Wait for it.
    await binaries;
    // Lifecycle after live, not beside it: its editor beside the shards ran the machine out of memory.
    return lane([...(runLive ? [["live", npm, ["run", "test:live", ...selected]]] : []), ...afterLive]);
  })(),
  ciGreen(),
];

const results = await Promise.all(lanes);

// Each exit records the timing; an overrun fails the summary, not the release, so it shows every time.
function finish(outcome, code) {
  const totalS = (Date.now() - t0) / 1000;
  fs.writeFileSync(path.join(logDir, "release-timing.json"), `${JSON.stringify({
    recordedAt: new Date().toISOString(),
    version,
    outcome,
    machine: { cpus: os.cpus().length, memoryGB: Math.round(os.totalmem() / 1073741824), freeGB: Math.round(os.freemem() / 1073741824) },
    pluginChanged,
    selection: {
      full: selection.full,
      fullReason: selection.fullReason,
      liveFiles: selection.live.length,
      liveEstimateS: selection.liveEstimateS,
      lifecycle: runLifecycle,
      automation: selection.automation === "all" ? "all" : selection.automation.length,
    },
    totalS,
    budgetS: BUDGET_S,
    overBudget: totalS > BUDGET_S,
    steps: steps.sort((a, b) => a.startS - b.startS),
  }, null, 2)}\n`);
  console.log(`\n${stamp()} ${outcome}`);
  if (totalS > BUDGET_S) {
    console.log(`WARNING: the release took ${totalS.toFixed(0)}s, over the ${BUDGET_S}s budget. The steps are in release-logs/release-timing.json.`);
  }
  process.exit(code);
}

if (results.some((ok) => !ok)) finish("not merged: a lane failed. The draft and the pull request are left as they are.", 1);

// 6. Merge; the push to main publishes.
sh("gh", ["pr", "merge", pr, "--squash", "--delete-branch"]);
const sha = sh("gh", ["pr", "view", pr, "--json", "mergeCommit", "--jq", ".mergeCommit.oid"]);
console.log(`${stamp()} merged as ${sha.slice(0, 8)}; CI publishes ${version} from main`);
let runId = "";
for (let i = 0; i < 30 && !runId; i++) {
  runId = sh("gh", ["run", "list", "--commit", sha, "--workflow", "CI", "--json", "databaseId", "--jq", ".[0].databaseId // empty"]);
  if (!runId) await new Promise((r) => setTimeout(r, 2000));
}
const published = runId ? await run("publish", "gh", ["run", "watch", runId, "--exit-status"]) : false;
finish(published ? `released ${version}` : "publish failed or never started, see release-logs/publish.log", published ? 0 : 1);
