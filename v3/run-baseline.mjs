// Drives the runtime baseline across 1k / 10k / 50k synthetic datasets and
// writes reproducible evidence to evidence/runtime-modernization/.
//
// Each dataset size runs in its own child process so the module-level SQLite
// singleton is fresh and file locks are released on process exit.
//
// Run:
//   node --no-warnings v3/run-baseline.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const here = fileURLToPath(import.meta.url);
const v3Dir = path.dirname(here);
const root = path.dirname(v3Dir);
const outDir = path.join(root, "evidence", "runtime-modernization");
mkdirSync(outDir, { recursive: true });

function git(field) {
  try {
    return execFileSync("git", ["rev-parse", field], { encoding: "utf8", cwd: root }).trim();
  } catch {
    return "";
  }
}

const plan = [
  { count: 1000, iterations: 10 },
  { count: 10000, iterations: 10 },
  { count: 50000, iterations: 7 },
];

const datasets = [];
for (const { count, iterations } of plan) {
  process.stderr.write(`benchmark ${count} rows (${iterations} iters)...\n`);
  const result = spawnSync(
    process.execPath,
    ["--no-warnings", path.join(v3Dir, "benchmark-runtime.mjs"), String(count), String(iterations)],
    { encoding: "utf8", timeout: 10 * 60_000, cwd: root },
  );
  if (result.status !== 0) {
    throw new Error(`benchmark ${count} failed:\n${result.stderr || result.stdout}`);
  }
  datasets.push(JSON.parse(result.stdout));
}

const baseline = {
  generated_at: new Date().toISOString(),
  base_sha: git("origin/master"),
  final_head: git("HEAD"),
  platform: process.platform,
  arch: process.arch,
  engine: "node:sqlite (DatabaseSync)",
  methodology:
    "Synthetic listings seeded via upsertListing into a fresh temporary SQLite DB. " +
    "listListings() + stats() measured with the Node perf_hooks monotonic clock across " +
    "multiple sorts and repeated iterations; p50/p95/p99 reported per sort.",
  note:
    "commuteKm=0 isolates the pure SQL candidate -> Node filter -> sort -> hydrate path " +
    "without external route/geo provider calls (see section 21: geo/route must never block the API).",
  datasets,
};

writeFileSync(path.join(outDir, "baseline.json"), JSON.stringify(baseline, null, 2) + "\n", "utf8");
writeFileSync(path.join(outDir, "baseline.md"), renderMarkdown(baseline), "utf8");
console.log(JSON.stringify(baseline, null, 2));

function renderMarkdown(b) {
  const lines = [];
  lines.push("# 5151 Runtime 搜尋效能基準（baseline）");
  lines.push("");
  lines.push(`- 產生時間：${b.generated_at}`);
  lines.push(`- BASE_SHA：\`${b.base_sha}\``);
  lines.push(`- FINAL_HEAD：\`${b.final_head}\``);
  lines.push(`- 平台：${b.platform}/${b.arch}，Node ${b.datasets[0].node}`);
  lines.push(`- 引擎：${b.engine}`);
  lines.push("");
  lines.push("## 方法");
  lines.push("");
  lines.push(b.methodology);
  lines.push("");
  lines.push(b.note);
  lines.push("");
  lines.push("## 結果（listListings，毫秒）");
  lines.push("");
  const sorts = ["newest", "price_asc", "commute_asc", "fit_desc"];
  lines.push("| dataset | sort | p50 | p95 | p99 | candidates | matched |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const ds of b.datasets) {
    for (const sort of sorts) {
      const s = ds.sorts[sort];
      const candidates = Math.round(s.stages.candidates?.p50 || 0);
      lines.push(`| ${ds.rows} | ${sort} | ${s.latency_ms.p50} | ${s.latency_ms.p95} | ${s.latency_ms.p99} | ${candidates} | ${ds.sample.totalMatched} |`);
    }
  }
  lines.push("");
  lines.push("## stats（毫秒）");
  lines.push("");
  lines.push("| dataset | p50 | p95 | p99 |");
  lines.push("|---|---|---|---|");
  for (const ds of b.datasets) {
    lines.push(`| ${ds.rows} | ${ds.stats.latency_ms.p50} | ${ds.stats.latency_ms.p95} | ${ds.stats.latency_ms.p99} |`);
  }
  lines.push("");
  lines.push("## 接受標準（對照 section 21）");
  lines.push("");
  lines.push("- 10k：warm p95 ≤ 500ms / cold p95 ≤ 1000ms");
  lines.push("- 50k：warm p95 ≤ 1200ms");
  lines.push("");
  return lines.join("\n") + "\n";
}
