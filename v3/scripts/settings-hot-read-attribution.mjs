// `SELECT key, value FROM settings` 殘留讀取的**歸因**探針（唯讀觀測；只准隔離庫）。
//
// 為什麼要有這一支：正式機 pg_stat_statements 在 #723 之後仍有 ≈2.8 次/秒的殘留
// （指紋 `^SELECT key, value FROM settings$`）。要收哪一條，必須先把「哪個呼叫端在什麼
// 頻率發這條 SQL」量出來，不能用 grep 猜（L-0709／L-0719：樁要打在 `pg.Pool.prototype.query`，
// 且 `pg-pool` 走 callback 形式，只綁 promise 會整條漏掉 —— 這支直接沿用同一支 tracer）。
//
// 每個場景各自跑一個行程，tracer 在 exit 時把結果寫進 PG_TRACE_OUT，
// 於是 `driverSettingsSites` 的 key 就是「直接呼叫端堆疊」，value 就是次數。
//
// 用法（**只准隔離庫**）：
//   set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
//   export PG_URL="$PG_LIVE_REPRO_URL" DB_DRIVER=postgres
//   export PG_TRACE_OUT=/tmp/attr-commute.json PG_TRACE_BLOCK_NET=1
//   node v3/scripts/settings-hot-read-attribution.mjs --scenario commute
//
// 場景：
//   commute       queueGeoBackfill() 的內圈：collectCommuteSettingsAsync()
//   geobackfill   settingsForGeoBackfillAsync(null)
//   maintenance   排程維護 tick 的 pauseIdleMembersAsync()
//   notify        flushPendingNotifications() 的逐事件迴圈
//   similarity    逐筆 phash 判斷（證明它是**另一條指紋**）
//   server-tick   真的跑一次 server.js 的排程輪（reason=schedule）
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? true) : fallback;
};
const scenario = String(flag("scenario", "commute"));

process.env.DB_DRIVER = process.env.DB_DRIVER || "postgres";
if (!/^postgres(-|:)/.test(String(process.env.PG_URL || ""))) {
  console.error("[attr] 拒絕執行：PG_URL 必須是 postgres://（這一支只跑隔離庫）");
  process.exit(2);
}

// 插樁必須在任何 repo 模組之前載入。
await import("./pg-callsite-trace.mjs");

const { sharedPgDriver } = await import("../src/pgSharedDriver.js");
const driver = await sharedPgDriver();
const notes = [];

async function snapshot(table, columns, where, values = []) {
  const { rows } = await driver.query(`SELECT ${columns} FROM ${table}${where ? ` WHERE ${where}` : ""}`, values);
  return rows;
}

// `--snapshot 1`：模擬「呼叫端已經有當輪快照」（爬蟲輪次的 `roundOptions`）。
// 這是 #720／#723 的契約；沒有它，被呼叫端就會逐筆自己讀一次。
const useSnapshot = String(flag("snapshot", "0")) === "1";
async function snapshotOptions() {
  const base = { pgDriver: driver };
  if (!useSnapshot) return base;
  const { decorationRequestContextFromRows } = await import("../src/db.js");
  const { rows } = await driver.query("SELECT key, value FROM settings");
  notes.push({ scenario, snapshotRows: rows.length });
  return { ...base, globalRows: rows, requestContext: decorationRequestContextFromRows(rows) };
}

// ── 場景：queueGeoBackfill() 的內圈 ────────────────────────────────────────────
async function runCommute() {
  const { collectCommuteSettingsAsync } = await import("../src/settingsAsync.js");
  const list = await collectCommuteSettingsAsync(await snapshotOptions());
  notes.push({ scenario, membersReturned: list.length });
}

// ── 場景：settingsForGeoBackfillAsync() ───────────────────────────────────────
async function runGeoBackfill() {
  const { settingsForGeoBackfillAsync } = await import("../src/settingsAsync.js");
  const picked = await settingsForGeoBackfillAsync(null, { pgDriver: driver });
  notes.push({ scenario, pickedDefault: Boolean(picked && Object.keys(picked).length) });
}

// ── 場景：排程維護 tick 的 pauseIdleMembersAsync() ────────────────────────────
async function runMaintenance() {
  const { pauseIdleMembersAsync } = await import("../src/accountMaintenanceAsync.js");
  const before = await snapshot("user_settings", "user_id, key, value", "key IN ('notificationsPaused','inactivityPaused')");
  const { rows: idle } = await driver.query(
    `SELECT count(*)::int c FROM users
      WHERE COALESCE(role,'member') <> 'admin' AND COALESCE(deleted_at,'') = ''
        AND COALESCE(email_verified,1) <> 0
        AND COALESCE(last_login_at, created_at) <= $1`,
    [new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()],
  );
  const paused = await pauseIdleMembersAsync({ now: Date.now() }, await snapshotOptions());
  notes.push({ scenario, idleCandidates: idle[0].c, pausedNow: paused });
  // 還原（讓這一支可以重跑；隔離庫不留狀態）。
  await driver.query("DELETE FROM user_settings WHERE key IN ('notificationsPaused','inactivityPaused')");
  for (const row of before) {
    await driver.query(
      "INSERT INTO user_settings(user_id, key, value) VALUES ($1,$2,$3) ON CONFLICT(user_id,key) DO UPDATE SET value = excluded.value",
      [row.user_id, row.key, row.value],
    );
  }
  notes.push({ scenario, restoredUserSettings: before.length });
}

// ── 場景：flushPendingNotifications() 的逐事件迴圈 ────────────────────────────
async function runNotify() {
  const { flushPendingNotifications } = await import("../src/watcher.js");
  const cols = "id, notified, notify_decide, notify_reason, notify_next_at, notify_retry_count, notify_ready_at, notify_coord_version, notify_profile_id, notify_profile_version, email_job_state, push_job_state, line_job_state, dock_job_state";
  const before = await snapshot("user_events", cols, "COALESCE(notified,0) = 0");
  notes.push({ scenario, pendingEvents: before.length });
  const result = await flushPendingNotifications(null, { silent: true, pgDriver: driver });
  notes.push({ scenario, result: result && typeof result === "object" ? Object.keys(result).slice(0, 8) : String(result) });
  // 還原被 flush 改掉的欄位（可重跑）。
  for (const row of before) {
    await driver.query(
      `UPDATE user_events SET notified=$2, notify_decide=$3, notify_reason=$4, notify_next_at=$5,
         notify_retry_count=$6, notify_ready_at=$7, notify_coord_version=$8, notify_profile_id=$9,
         notify_profile_version=$10, email_job_state=$11, push_job_state=$12, line_job_state=$13, dock_job_state=$14
       WHERE id=$1`,
      [row.id, row.notified, row.notify_decide, row.notify_reason, row.notify_next_at, row.notify_retry_count,
        row.notify_ready_at, row.notify_coord_version, row.notify_profile_id, row.notify_profile_version,
        row.email_job_state, row.push_job_state, row.line_job_state, row.dock_job_state],
    );
  }
  notes.push({ scenario, restoredEvents: before.length });
}

// ── 場景：逐筆 similarity 的設定讀取（另一條指紋） ───────────────────────────
async function runSimilarity() {
  const { isPhashEnabledAsync, isInsightApplyEnabledAsync } = await import("../src/listingSimilarityAsync.js");
  const n = Number(flag("items", 15));
  for (let i = 0; i < n; i += 1) {
    await isPhashEnabledAsync({ pgDriver: driver });
    await isInsightApplyEnabledAsync({ pgDriver: driver });
  }
  notes.push({ scenario, items: n });
}

// ── 場景：enqueueListingEvent 逐事件（每一筆事件各讀一次全域設定） ─────────────
async function runEnqueue() {
  const { enqueueListingEventAsync } = await import("../src/notifyEnqueueAsync.js");
  const n = Number(flag("items", 20));
  const { rows } = await driver.query("SELECT * FROM listings ORDER BY post_id LIMIT 1");
  const listing = rows[0];
  if (!listing) { notes.push({ scenario, error: "repro 的 listings 是空的" }); return; }
  const { rows: maxRow } = await driver.query("SELECT COALESCE(MAX(id),0)::int m FROM user_events");
  const before = maxRow[0].m;
  const options = await snapshotOptions();
  for (let i = 0; i < n; i += 1) {
    await enqueueListingEventAsync(listing, { type: "new", detail: `attr-probe-${i}` }, options);
  }
  notes.push({ scenario, events: n, postId: listing.post_id });
  await driver.query("DELETE FROM user_events WHERE id > $1", [before]);
  notes.push({ scenario, cleanedEvents: true });
}

const runners = {
  commute: runCommute,
  geobackfill: runGeoBackfill,
  maintenance: runMaintenance,
  notify: runNotify,
  similarity: runSimilarity,
  enqueue: runEnqueue,
};

const runner = runners[scenario];
if (!runner) {
  console.error(`[attr] 未知場景：${scenario}（可用：${Object.keys(runners).join(", ")}）`);
  process.exit(2);
}

try {
  await runner();
} catch (error) {
  notes.push({ scenario, error: error.message });
  console.error("[attr] scenario failed:", error.message);
}
writeFileSync(String(flag("notes", `/tmp/attr-${scenario}-notes.json`)), JSON.stringify({ scenario, notes }, null, 1));
console.log(`[attr:${scenario}] ${JSON.stringify(notes)}`);
process.exit(0);
