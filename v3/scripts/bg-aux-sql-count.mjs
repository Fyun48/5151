// 背景迴圈輔助查詢「每輪呼叫次數」量測（唯讀觀測；只讀 PG，除了被測函式本身的正常寫入）。
//
// 目的：把背景路徑（補欄位佇列 seed／排空、通知入列、通知 flush）一輪裡對 PostgreSQL
// 送了哪些語句、各幾次、由哪一行呼叫，逐條列出來，作為 #719 之後「背景輔助查詢瘦身」
// 的 before/after 對照證據。做法是 patch `pg.Client.prototype.query`（與
// `member-list-sql-count.mjs` 同一招），並在呼叫當下抓 `new Error().stack`，
// 把 repo 內的呼叫端行號記下來 —— 沒有這一步就只能憑猜說「大概是哪一支」。
//
// 用法（PG 一律用隔離庫，見 v3/evidence 的 README）：
//   set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
//   export PG_URL="$PG_LIVE_REPRO_URL" DB_DRIVER=postgres
//   node v3/scripts/bg-aux-sql-count.mjs --phase notify-event --label before --out out.json
//
// phase：
//   notify-event  —— 一次 `enqueueListingEventAsync()`（一個事件 × 全部會員）
//   enrich-seed   —— 一次補欄位種子入列（`seedHousepriceEnrichJobsAsync`，limit 40）
//   enrich-drain  —— 一次補欄位佇列排空（`processListingEnrichBatch`，limit 2）
//   flush         —— 一次通知 flush（`flushPendingNotifications`）
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : fallback;
};

process.env.DB_DRIVER = process.env.DB_DRIVER || "postgres";
Error.stackTraceLimit = 60;
const phase = String(flag("phase", "notify-event"));
const label = String(flag("label", "run"));
const outPath = flag("out");

const repoFrame = /(v3\/(?:src|scripts)\/[^:()\s]+):(\d+):\d+/;
function callsiteOf() {
  const stack = String(new Error().stack || "").split("\n").slice(2);
  const frames = [];
  for (const line of stack) {
    const m = line.match(repoFrame);
    if (!m) continue;
    // 跳過這支量測腳本自己的 frame（patch wrapper 永遠是第一個）。
    if (m[1].endsWith("bg-aux-sql-count.mjs")) continue;
    frames.push(`${m[1]}:${m[2]}`);
    if (frames.length >= 12) break;
  }
  return frames.length ? frames.join(" <- ") : "(non-repo)";
}

const pg = (await import("pg")).default;
const log = [];
// `driver.query()` -> `pool.query()` -> （pg 內部 promise）-> `client.query()`。
// client.query 被呼叫時已經跨過 async 邊界，同步堆疊只剩 pg 自己的 frame，
// 所以在 **pool.query**（與 repo 呼叫端同步同一個堆疊）先記下 SQL→呼叫端，
// 再由 client 層的紀錄依 SQL 文字 FIFO 配對回來。
const siteQueue = new Map();
const originalPoolQuery = pg.Pool.prototype.query;
pg.Pool.prototype.query = function patchedPoolQuery(config, ...rest) {
  const sql = typeof config === "string" ? config : (config && config.text) || "";
  const queue = siteQueue.get(sql) || (siteQueue.set(sql, []), siteQueue.get(sql));
  queue.push(callsiteOf());
  return originalPoolQuery.call(this, config, ...rest);
};
const unmatched = { count: 0, sites: {} };
function siteFor(sql) {
  const queue = siteQueue.get(sql);
  if (queue && queue.length) return queue.shift();
  unmatched.count += 1;
  const site = callsiteOf();
  unmatched.sites[site] = (unmatched.sites[site] || 0) + 1;
  return site;
}
const originalQuery = pg.Client.prototype.query;
pg.Client.prototype.query = function patchedQuery(config, ...rest) {
  const sql = typeof config === "string" ? config : (config && config.text) || "";
  const params = Array.isArray(config?.values) ? config.values : (Array.isArray(rest[0]) ? rest[0] : []);
  const site = siteFor(sql);
  const started = performance.now();
  const record = () => log.push({ sql, params, ms: performance.now() - started, site });
  const result = originalQuery.call(this, config, ...rest);
  if (result && typeof result.then === "function") {
    result.then(() => record(), () => record());
  } else if (typeof rest[rest.length - 1] === "function") {
    const cb = rest.pop();
    return originalQuery.call(this, config, ...rest, (...args) => { record(); return cb(...args); });
  }
  return result;
};

const { sharedPgDriver, closeSharedPgDriver } = await import("../src/pgSharedDriver.js");
const driver = await sharedPgDriver();
const exec = (sql, params = []) => driver.query(sql, params).then((r) => r.rows);

const fingerprint = (sql) => String(sql)
  .replace(/'[^']*'/g, "?")
  .replace(/\b\d+\b/g, "?")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 84);

async function pickListing() {
  const rows = await exec(
    `SELECT * FROM listings
      WHERE source = 'houseprice' AND COALESCE(offline, 0) = 0
      ORDER BY post_id LIMIT 1`,
  );
  return rows[0] || null;
}

let detail = {};
if (phase === "notify-event") {
  const { enqueueListingEventAsync } = await import("../src/notifyEnqueueAsync.js");
  const listing = await pickListing();
  if (!listing) throw new Error("repro 庫找不到 houseprice 房源，無法量測 notify-event");
  const ids = await enqueueListingEventAsync(listing, {
    type: "price_down",
    detail: "bg-aux-sql-count probe",
    created_at: new Date().toISOString(),
  }, { driver: "postgres", strict: true });
  detail = { post_id: Number(listing.post_id), inserted: ids.length };
} else if (phase === "enrich-seed") {
  const { seedHousepriceEnrichJobsAsync } = await import("../src/listingEnrichQueueAsync.js");
  const { db } = await import("../src/db.js");
  const n = await seedHousepriceEnrichJobsAsync(db, { limit: 40, isEnabled: () => true }, { driver: "postgres" });
  detail = { seeded: n };
} else if (phase === "enrich-drain") {
  const { processListingEnrichBatch } = await import("../src/listingEnrichQueue.js");
  const { db } = await import("../src/db.js");
  const { listingEnrichHelpers } = await import("../src/watcher.js");
  const limit = Number(flag("limit", 2)) || 2;
  const result = await processListingEnrichBatch(db, listingEnrichHelpers(), { limit });
  detail = { attempted: result.attempted, processed: result.processed };
} else if (phase === "flush") {
  // `--unpend N`：把 N 筆事件重設成「待處理」（`notify_next_at = NULL`）。
  // flush 跑過一次就會把事件推進去重試退避，第二次呼叫沒有東西可跑就量不到次數。
  // ⚠️ 這一支**只准用在隔離庫**（repro），不要對正式庫跑。
  const unpend = Number(flag("unpend", 0)) || 0;
  if (unpend > 0) {
    await exec(`UPDATE user_events SET notify_next_at = NULL
                 WHERE id IN (SELECT id FROM user_events WHERE COALESCE(notified, 0) = 0 ORDER BY id LIMIT $1)`,
      [unpend]);
  }
  const { flushPendingNotifications } = await import("../src/watcher.js");
  await flushPendingNotifications(null, { silent: true });
  detail = { unpend };
} else {
  throw new Error(`未知的 phase：${phase}`);
}

await new Promise((r) => setTimeout(r, 250)); // 讓 promise 形式的紀錄全部落地

const queries = {};
const fps = {};
let totalMs = 0;
for (const entry of log) {
  totalMs += entry.ms;
  const q = queries[entry.sql] || (queries[entry.sql] = { count: 0, ms: 0, callsites: {} });
  q.count += 1;
  q.ms = Math.round((q.ms + entry.ms) * 100) / 100;
  q.callsites[entry.site] = (q.callsites[entry.site] || 0) + 1;
  const fp = fps[fingerprint(entry.sql)] || (fps[fingerprint(entry.sql)] = { count: 0, ms: 0, callsites: {} });
  fp.count += 1;
  fp.ms = Math.round((fp.ms + entry.ms) * 100) / 100;
  fp.callsites[entry.site] = (fp.callsites[entry.site] || 0) + 1;
}

// 這一輪的三條目標指紋各幾次（I-0700 的 before/after 表就是讀這裡）。
const countMatching = (re) => log.filter((entry) => re.test(String(entry.sql))).length;
const totals = {
  queries: log.length,
  ms: Math.round(totalMs * 100) / 100,
  // `SELECT * FROM listing_enrich_jobs WHERE post_id = $1`（逐列版；目標是 0）
  enrichJobPerPostReads: countMatching(/FROM\s+listing_enrich_jobs\s+WHERE\s+post_id\s*=\s*\$1/),
  // `SELECT * FROM listing_enrich_jobs WHERE post_id = ANY($1::bigint[])`（集合式版）
  enrichJobBatchReads: countMatching(/FROM\s+listing_enrich_jobs\s+WHERE\s+post_id\s*=\s*ANY\(/),
  // `SELECT detail FROM user_events WHERE user_id = $1 AND post_id = $2 AND type = $3 …`（逐會員版；目標是 0）
  lastEventDetailPerUserReads: countMatching(/FROM\s+user_events\s+WHERE\s+user_id\s*=\s*\$1\s+AND\s+post_id\s*=\s*\$2\s+AND\s+type\s*=\s*\$3/),
  // 集合式去重讀取（每事件準 1 條）
  lastEventDetailBatchReads: countMatching(/FROM\s+user_events\s+WHERE\s+user_id\s*=\s*ANY\(\$1::bigint\[\]\)\s+AND\s+post_id/),
  groupNotifiedBatchReads: countMatching(/FROM\s+user_events\s+WHERE\s+user_id\s*=\s*ANY\(\$1::bigint\[\]\)\s+AND\s+group_id/),
  newEventBatchReads: countMatching(/FROM\s+user_events\s+WHERE\s+user_id\s*=\s*ANY\(\$1::bigint\[\]\)[\s\S]*type = 'new'/),
  // `SELECT key, value FROM settings`（目標：一輪／一事件只讀一次）
  globalSettingsReads: countMatching(/^\s*SELECT key, value FROM settings/i),
  // flush 一輪處理幾個事件（settings 讀取要按這個數字正規化）
  flushEventReads: countMatching(/FROM\s+user_events\s+WHERE\s+id\s*=\s*\$1/i),
};

const payload = {
  label,
  unmatchedSites: unmatched,
  phase,
  generatedAt: new Date().toISOString(),
  detail,
  totals,
  fingerprints: fps,
  queries,
};
const text = JSON.stringify(payload, null, 2);
if (outPath) writeFileSync(outPath, `${text}\n`);
const top = Object.entries(fps).sort((a, b) => b[1].count - a[1].count).slice(0, 12);
console.log(`[${label}/${phase}] queries=${log.length} ms=${payload.totals.ms} detail=${JSON.stringify(detail)}`);
console.log(`  totals=${JSON.stringify(totals)}`);
for (const [fp, v] of top) {
  console.log(`  ${String(v.count).padStart(5)}x ${fp}`);
  for (const [site, n] of Object.entries(v.callsites).sort((a, b) => b[1] - a[1]).slice(0, 3)) {
    console.log(`          ${String(n).padStart(5)}x @ ${site}`);
  }
}
await closeSharedPgDriver?.().catch(() => {});
process.exit(0);
