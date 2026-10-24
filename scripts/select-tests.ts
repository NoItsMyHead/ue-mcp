#!/usr/bin/env tsx
/**
 * Pick the live and automation tests a change needs, from the dependency graph (#1509).
 *
 *   npx tsx scripts/select-tests.ts --base v1.4.11-beta.3            diff against a ref
 *   npx tsx scripts/select-tests.ts --files a.cpp,b.ts               name the changed files
 *   npx tsx scripts/select-tests.ts --base <ref> --stable            a stable release: everything
 *   npx tsx scripts/select-tests.ts --base <ref> --out sel.json      also write the selection
 *   npx tsx scripts/select-tests.ts --base <ref> --related           run `vitest related` on the
 *                                                                    unit and integration suites
 *
 * Prints what it chose and why. Unit and integration tests import src/ directly, so
 * `vitest related` reads their graph itself; live tests start the server as a process and
 * reach action code only through the action map, which is what this adds.
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { buildTestGraph, type BuildStats } from "./lib/test-graph.js";
import { selectTests, type Selection } from "./lib/test-selection.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LIFECYCLE_FILE = "tests/live/editor-lifecycle.test.ts";

export interface SelectionFile {
  base: string | null;
  changed: string[];
  full: boolean;
  fullReason: string | null;
  /** Live files for the sharded run, lifecycle excluded. */
  live: string[];
  lifecycle: boolean;
  /** Automation test names, or "all". */
  automation: string[] | "all";
  /** Measured seconds for the selected live files, from tests/live/timing-baseline.json. */
  liveEstimateS: number;
  reasons: Record<string, string>;
}

/** The selection as the release runner consumes it. */
export function toSelectionFile(sel: Selection, changed: string[], base: string | null, baseline: Record<string, { durationMs?: number }>): SelectionFile {
  const liveAll = sel.tests.filter((t) => t.suite === "live");
  const live = liveAll.filter((t) => t.file !== LIFECYCLE_FILE && t.kind !== "lifecycle").map((t) => t.file);
  const automation = sel.tests.filter((t) => t.suite === "automation").map((t) => t.id);
  return {
    base,
    changed,
    full: sel.full,
    fullReason: sel.fullReason ?? null,
    live,
    lifecycle: liveAll.some((t) => t.file === LIFECYCLE_FILE),
    automation: sel.full ? "all" : automation,
    liveEstimateS: Math.round(live.reduce((s, f) => s + (baseline[f]?.durationMs ?? 0), 0) / 1000),
    reasons: Object.fromEntries(sel.tests.map((t) => [t.id, t.reason])),
  };
}

export function describeSelection(file: SelectionFile, sel: Selection): string[] {
  const lines: string[] = [];
  lines.push(`select: ${file.changed.length} changed file(s)${file.base ? ` since ${file.base}` : ""}`);
  if (file.full) {
    lines.push(`select: full suite. ${file.fullReason}`);
    return lines;
  }
  const automation = file.automation === "all" ? "all" : String(file.automation.length);
  lines.push(`select: ${file.live.length} live file(s), about ${file.liveEstimateS}s measured; lifecycle ${file.lifecycle ? "yes" : "no"}; ${automation} automation test(s); ${sel.actions.length} action(s) reached`);
  for (const t of sel.tests.filter((x) => x.suite === "live")) lines.push(`  live        ${t.file}  (${t.reason})`);
  const byFile = new Map<string, { n: number; reason: string }>();
  for (const t of sel.tests.filter((x) => x.suite === "automation")) {
    const e = byFile.get(t.file) ?? { n: 0, reason: t.reason };
    e.n++;
    byFile.set(t.file, e);
  }
  for (const [f, e] of byFile) lines.push(`  automation  ${path.posix.basename(f)} x${e.n}  (${e.reason})`);
  for (const f of sel.inert) lines.push(`  no test     ${f}`);
  return lines;
}

export function changedSince(base: string, head = "HEAD"): string[] {
  return execFileSync("git", ["diff", "--name-only", `${base}...${head}`], { cwd: REPO, encoding: "utf8" })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function readBaseline(repo = REPO): Record<string, { durationMs?: number }> {
  try {
    return (JSON.parse(fs.readFileSync(path.join(repo, "tests", "live", "timing-baseline.json"), "utf8")) as { files?: Record<string, { durationMs?: number }> }).files ?? {};
  } catch {
    return {};
  }
}

function main(argv: string[]): number {
  const flag = (n: string) => {
    const i = argv.indexOf(n);
    return i === -1 ? null : argv[i + 1] ?? null;
  };
  const base = flag("--base");
  const files = flag("--files");
  if (!base && !files) {
    console.error("usage: npx tsx scripts/select-tests.ts (--base <ref> [--head <ref>] | --files a,b) [--stable] [--out <file>] [--related]");
    return 2;
  }
  const changed = files ? files.split(",").filter(Boolean) : changedSince(base!, flag("--head") ?? "HEAD");
  const stats: BuildStats = { files: 0, reparsed: 0 };
  const started = Date.now();
  const graph = buildTestGraph(REPO, { stats });
  const sel = selectTests(graph, changed, { stable: argv.includes("--stable") });
  const file = toSelectionFile(sel, changed, base, readBaseline());
  console.log(`select: graph of ${stats.files} files (${stats.reparsed} reparsed) in ${Date.now() - started} ms`);
  for (const line of describeSelection(file, sel)) console.log(line);
  const out = flag("--out");
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
  }
  if (argv.includes("--related")) {
    const sources = changed.filter((f) => /\.(?:ts|mts|mjs|js)$/.test(f) && fs.existsSync(path.join(REPO, f)));
    if (sources.length === 0) {
      console.log("select: no changed TS or JS source, so no unit or integration test is related");
      return 0;
    }
    const vitest = path.join(REPO, "node_modules", "vitest", "vitest.mjs");
    for (const config of ["vitest.config.ts", "vitest.integration.config.ts"]) {
      const run = spawnSync(process.execPath, [vitest, "related", "--run", "--passWithNoTests", "--config", config, ...sources], { cwd: REPO, stdio: "inherit" });
      if (run.status !== 0) return run.status ?? 1;
    }
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
