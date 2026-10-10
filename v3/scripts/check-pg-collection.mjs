#!/usr/bin/env node
/**
 * PG 整合測試「收檔」自我檢查（**離線**，不需要 PG）。
 *
 * 為什麼要有這支：`v3/scripts/run-pg-integration.sh` 用
 *   `grep -rl PG_TEST_URL v3/test/*.test.js`
 * 決定「哪些測試檔要跑」。也就是說，**一支測試要不要被 CI 執行，取決於檔內有沒有那個字串**——
 * 註解被清掉、字串被改寫、檔案被搬走，那一支就會**靜默地不再執行**（沒有紅燈、沒有 skip 訊息、
 * CI 全綠）。2026-10-10 的 `write-path-http-live-pg.test.js` 正是靠檔頭一句「不吃 PG_TEST_URL」
 * 才被收進去的：那一句就是它唯一的收檔依據。
 *
 * 這支把「收檔」變成可以離線重跑的事實檢查：
 *   1. 目標檔必須在收檔清單裡；不在 ⇒ exit 1。
 *   2. 目標檔的 `PG-COLLECT-KEEP` 標記行必須逐字存在，而且該檔的字串必須**恰好出現 1 次**
 *      （唯一依據；多一個地方提到它就會掩蓋「標記被刪」的事實）。
 *   3. 以 `master`（d4854a0）當時的 69 支為基準：任何一支從清單消失就 exit 1
 *      （＝靜默漏測，正是本檢查要防的）；**多**出來的只警告（刻意新增測試檔不必改這支）。
 *
 * 跑法：`node v3/scripts/check-pg-collection.mjs`
 * （`v3/scripts/run-pg-integration.sh` 每次啟動都會先呼叫它，失敗就不跑整合測試）。
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TEST_DIR = path.join(ROOT, "v3/test");
const TARGET = "write-path-http-live-pg.test.js";
const MARKER = "PG-COLLECT-KEEP";
// 不在 v3/test/*.test.js 的掃描範圍內（本檔是 scripts/），但仍拆開寫，避免以後有人
// 把這支複製進 v3/test/ 就多出一支「自己收自己」的檔案。
const LITERAL = "PG_TEST" + "_URL";

// 2026-10-10 從 master（d4854a0）實測得到的 69 支：
//   `git show master:<file> | grep -l PG_TEST_URL`（逐檔），或直接看本清單。
const BASELINE = [
  "v3/test/admin-maps-demo-live-pg.test.js",
  "v3/test/budget-parity.test.js",
  "v3/test/commute-snapshot-live-pg.test.js",
  "v3/test/content-documents-live-pg.test.js",
  "v3/test/crawl-cancellation.test.js",
  "v3/test/crawl-ownership.test.js",
  "v3/test/crawl-schedule.test.js",
  "v3/test/crawl-source-streaks-live-pg.test.js",
  "v3/test/crawler-reads-parity.test.js",
  "v3/test/crm-parity.test.js",
  "v3/test/data-revision-live-pg.test.js",
  "v3/test/decoration-data.test.js",
  "v3/test/demand-aggregate-live-pg.test.js",
  "v3/test/demand-create-live-pg.test.js",
  "v3/test/demand-live-pg.test.js",
  "v3/test/domain-tool-guards.test.js",
  "v3/test/feedback-media-live-pg.test.js",
  "v3/test/geo-cache-live-pg.test.js",
  "v3/test/job-queue-parity.test.js",
  "v3/test/legal-copy-live-pg.test.js",
  "v3/test/listing-detail-parity.test.js",
  "v3/test/listing-enrich-parity.test.js",
  "v3/test/listing-enrich-worker-live-pg.test.js",
  "v3/test/listing-fields-parity.test.js",
  "v3/test/listing-import-lifecycle-live-pg.test.js",
  "v3/test/listing-import-start-live-pg.test.js",
  "v3/test/listing-imports-live-pg.test.js",
  "v3/test/listing-input-optimizations.test.js",
  "v3/test/listing-search-entry-live-pg.test.js",
  "v3/test/listing-search-parity.test.js",
  "v3/test/listing-similarity-admin-parity.test.js",
  "v3/test/listing-state-writes.test.js",
  "v3/test/listing-stats-parity.test.js",
  "v3/test/listing-tools-live-pg.test.js",
  "v3/test/member-auth-live-pg.test.js",
  "v3/test/member-consents-live-pg.test.js",
  "v3/test/member-media-live-pg.test.js",
  "v3/test/mrt-cache-schema-live-pg.test.js",
  "v3/test/notify-enqueue-parity.test.js",
  "v3/test/notify-queue-parity.test.js",
  "v3/test/oauth-callback-live-pg.test.js",
  "v3/test/pg-candidate-array.test.js",
  "v3/test/pg-candidate-content.test.js",
  "v3/test/pg-import-batches.test.js",
  "v3/test/pg-live-integration.test.js",
  "v3/test/pg-provider-canaries.test.js",
  "v3/test/refresh-failure-counting-live-pg.test.js",
  "v3/test/register-live-pg.test.js",
  "v3/test/reject-match-live-pg.test.js",
  "v3/test/rental-flags-live-pg.test.js",
  "v3/test/rental-match-seen-ha-race.test.js",
  "v3/test/rental-notify-live-pg.test.js",
  "v3/test/rental-notify-prefs-live-pg.test.js",
  "v3/test/rental-ops-live-pg.test.js",
  "v3/test/rental-survey-live-pg.test.js",
  "v3/test/route-cache-live-pg.test.js",
  "v3/test/self-listing-copy-live-pg.test.js",
  "v3/test/self-listing-create-live-pg.test.js",
  "v3/test/self-listing-match-live-pg.test.js",
  "v3/test/self-listing-matches-live-pg.test.js",
  "v3/test/self-listing-publish-live-pg.test.js",
  "v3/test/self-listing-report-live-pg.test.js",
  "v3/test/settings-driver-parity.test.js",
  "v3/test/site-reset-async.test.js",
  "v3/test/sqlite-fallback-policy.test.js",
  "v3/test/system-crawl-live-pg.test.js",
  "v3/test/user-flags-relist-parity.test.js",
  "v3/test/wish-offer-create-live-pg.test.js",
  "v3/test/write-path-parity.test.js",
];

function collect() {
  return readdirSync(TEST_DIR)
    .filter((name) => name.endsWith(".test.js"))
    .filter((name) => readFileSync(path.join(TEST_DIR, name), "utf8").includes(LITERAL))
    .map((name) => `v3/test/${name}`)
    .sort();
}

const collected = collect();
const targetRel = `v3/test/${TARGET}`;
const problems = [];

if (!collected.includes(targetRel)) {
  problems.push(`收檔清單裡沒有 ${targetRel} ⇒ CI 不會執行這一支（靜默漏測）`);
}

const targetPath = path.join(TEST_DIR, TARGET);
if (!existsSync(targetPath)) {
  problems.push(`找不到 ${targetRel}`);
} else {
  const text = readFileSync(targetPath, "utf8");
  const markerLine = text.split(/\r?\n/).find((line) => line.includes(MARKER));
  if (!markerLine) {
    problems.push(`${targetRel} 裡找不到 ${MARKER} 標記行（被刪掉或改寫了？）`);
  } else if (!markerLine.includes(LITERAL)) {
    problems.push(`${MARKER} 標記行裡沒有 ${LITERAL} 字串 ⇒ 收檔條件不成立`);
  }
  const hits = text.split(LITERAL).length - 1;
  if (hits !== 1) {
    problems.push(`${targetRel} 裡的 ${LITERAL} 出現 ${hits} 次（必須恰好 1 次、就在 ${MARKER} 那一行）`);
  }
}

const missing = BASELINE.filter((file) => !collected.includes(file));
if (missing.length) {
  problems.push(`以 master 的 69 支為基準少了 ${missing.length} 支（收檔條件被破壞）：${missing.join(", ")}`);
}
const added = collected.filter((file) => !BASELINE.includes(file) && file !== targetRel);

console.log(
  `[pg-collect] 收檔 ${collected.length} 支（基準 ${BASELINE.length} 支；`
  + `${targetRel} 在清單內＝${collected.includes(targetRel)}）`,
);
if (added.length) {
  console.log(`[pg-collect] 注意：比基準多 ${added.length} 支（刻意新增就不必改本檔）：${added.join(", ")}`);
}

if (problems.length) {
  for (const problem of problems) console.error(`[pg-collect] ✗ ${problem}`);
  console.error("[pg-collect] 收檔自我檢查失敗（exit 1）");
  process.exit(1);
}
console.log("[pg-collect] ✓ 收檔自我檢查通過");
