// 「背景逐筆讀取」的 settings 讀取計數器（2026-10-12，#72x 之後）。
//
// 為什麼要有這一支：`runWatch()` 一輪裡的逐筆迴圈（下架掃描、明細補抓、來源套件、
// 待通知定位、落地時逐筆重讀）都有 400ms 的節奏，每一筆都會各自讀一次
// `SELECT key, value FROM settings`（`listingDetailAsync.js:60/63`）⇒ 正式站 140 秒
// 窗口實測 1,113 次（≈8 次/秒）。這一支用**真的 `runWatch()`** 在隔離庫上跑 N 輪，
// 把每一條全域設定讀取歸因到 `檔案:行號`，做 before/after 對照。
//
// 不連外站：`PG_TRACE_BLOCK_NET=1`（逐頁 fail-soft 照樣跑完）；房源由注入的
// `hbPostJson` 夾具產生（與 `v3/test/crawl-round-integration.test.js` 同一份），
// 所以「落地 → 逐筆重讀」那條最熱的路徑一定會被走到。
//
// 用法（**只准隔離庫**）：
//   set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
//   export PG_URL="$PG_LIVE_REPRO_URL" DB_DRIVER=postgres PG_NO_SQLITE_OPEN=1 PG_SQLITE_FALLBACK=strict
//   export PG_TRACE_BLOCK_NET=1 PG_TRACE_OUT=/tmp/sethot-before.json
//   node v3/scripts/settings-hot-read-count.mjs --rounds 3 --label before
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : fallback;
};
const rounds = Math.max(1, Number(flag("rounds", 3)));
const label = String(flag("label", "run"));

process.env.DB_DRIVER = process.env.DB_DRIVER || "postgres";
if (!/^postgres(-|:)/.test(String(process.env.PG_URL || ""))) {
  console.error("[sethot] 拒絕執行：PG_URL 必須是 postgres://（這一支只跑隔離庫）");
  process.exit(2);
}

// 插樁要在任何 repo 模組之前載入（同樣的 pool／client 兩層，見 L-0709）。
await import("./pg-callsite-trace.mjs");

const { sharedPgDriver } = await import("../src/pgSharedDriver.js");
const driver = await sharedPgDriver();
const { runWatch } = await import("../src/watcher.js");

const HB_FIXTURE = JSON.parse(readFileSync(new URL("../test/fixtures/hbhousing-page.json", import.meta.url), "utf8"));

// 只留住商一個來源：整輪不會去打 591 或其他外站（房源走注入的夾具）。
const original = (await driver.query("SELECT value FROM settings WHERE key = $1", ["crawlSources"])).rows[0]?.value ?? null;
const wanted = JSON.stringify([
  { id: "591", label: "591 租屋", stub: false, enabled: false },
  { id: "hbhousing", label: "住商不動產", stub: false, enabled: true },
  { id: "houseprice", label: "5168 實價登錄", stub: false, enabled: false },
  { id: "sinyi", label: "信義房屋", stub: false, enabled: false },
  { id: "ddroom", label: "租租通", stub: false, enabled: false },
  { id: "housefun", label: "好房網", stub: false, enabled: false },
  { id: "rakuya", label: "樂屋網", stub: false, enabled: false },
]);
await driver.query(
  "INSERT INTO settings(key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ["crawlSources", wanted],
);

const jobs = [{ regionId: 1, sectionIds: [8], priceMin: 0, priceMax: 0, searchUrl: "https://example.test/scope" }];
const summary = [];
try {
  for (let round = 1; round <= rounds; round += 1) {
    const startedAt = Date.now();
    const result = await runWatch({
      jobs,
      memberRequirements: [],
      includeSystem: false,
      skipHeavyGeo: true,
      silent: true,
      driver: "postgres",
      pgDriver: driver,
      hbPostJson: async () => HB_FIXTURE,
    });
    summary.push({ round, ms: Date.now() - startedAt, fetched: result?.fetched ?? 0, error: result?.error ?? "" });
    console.log(`[sethot:${label}] round ${round} ${Date.now() - startedAt}ms fetched=${result?.fetched ?? 0}${result?.error ? ` error=${result.error}` : ""}`);
  }
} finally {
  if (original == null) await driver.query("DELETE FROM settings WHERE key = $1", ["crawlSources"]);
  else await driver.query("UPDATE settings SET value = $1 WHERE key = $2", [original, "crawlSources"]);
}
console.log(`[sethot:${label}] rounds=${JSON.stringify(summary)}`);
writeFileSync(`/tmp/settings-hot-read-summary-${label}.json`, JSON.stringify({ label, rounds: summary }, null, 1));
// 讓 tracer 的 exit hook 把 JSON 寫出來再收工。
process.exit(0);
