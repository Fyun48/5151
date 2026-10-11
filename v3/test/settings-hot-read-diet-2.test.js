// 「同一批內重複讀同一份全域列」的第二包瘦身（2026-10-12）。
//
// 為什麼有這一檔：`#723` 收掉的是**爬蟲輪次內**的逐筆讀取；正式機發版後
// `pg_stat_statements` 指紋 `SELECT key, value FROM settings` 仍有 ≈2.8 次/秒。
// 第二包的歸因（`v3/scripts/settings-hot-read-attribution.mjs` 的 pool／driver 插樁）指出，
// 剩下的來源是**四個各自成批的迴圈**，每一個都在同一批裡把同一份全域列讀了 N 次：
//   1. `repository/notifyEnqueue.js`：每一筆事件各讀一次（正式站 196 秒窗口 328 筆事件 ⇒ 328 次）
//   2. `settingsAsync.collectCommuteSettingsAsync()`：每一位會員各讀一次
//   3. `accountMaintenanceAsync.pauseIdleMembersAsync()`：每位候選會員各讀一次（寫入又再讀一次）
//   4. `watcher.flushPendingNotifications()` 的第二圈：每位要通知的會員各讀一次（信件範本再一次）
//
// 這一檔只驗**次數**（結果的正確性由各自的 parity 測試負責）：
// 把 `globalRows` 的傳遞拿掉，或把其中一圈改回逐筆讀，這裡就會紅。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-sethot2-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const PG = { driver: "postgres" };
const UID_A = 920000000001;
const UID_B = 920000000002;
const UID_C = 920000000003;
const POST_ID = 920000000009;

const GLOBAL_ROWS = [
  { key: "crawlSources", value: JSON.stringify([{ id: "591", enabled: true }]) },
  { key: "systemCrawlIntervalMinutes", value: JSON.stringify(20) },
];
const REQUEST_CONTEXT = { crawlSources: [{ id: "591", enabled: true }], systemCrawl: { intervalMinutes: 20 } };

// 只有**站台層級**那一條 (`GLOBAL_SETTINGS_SQL`) 才算「全域列」；
// `SELECT value FROM settings WHERE key = ?` 是單鍵讀取，不在這一包的範圍。
const GLOBAL_SQL = /^\s*SELECT key, ?value FROM settings\s*$/i;
const globalReads = (calls) => calls.filter((row) => GLOBAL_SQL.test(String(row.sql)));

const LISTING = {
  post_id: POST_ID,
  source_key: "591",
  source: "591",
  title: "夾具物件",
  url: "https://example.test/l",
  price: "20000",
  price_num: 20000,
  address: "台北市",
  lat: 25.11,
  lng: 121.52,
  geo_source: "geocode",
  location_class: "street",
  coord_version: 1,
  offline: 0,
  content_seq: 1,
  first_seen_at: "2026-10-01T00:00:00.000Z",
  last_seen_at: "2026-10-01T00:00:00.000Z",
  created_at: "2026-10-01T00:00:00.000Z",
};

function driverOf(exec) {
  const pgDriver = {
    query: async (sql, params = []) => ({ rows: await exec(sql, params), rowCount: 0 }),
    exec: async () => undefined,
    withTransaction: (fn) => fn(pgDriver),
  };
  return pgDriver;
}

// ── 1. 通知入列：每一筆事件 ────────────────────────────────────────────────────
function enqueueFixture() {
  const calls = [];
  const exec = async (sql, params = []) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (/SELECT id FROM users WHERE deleted_at/i.test(text)) return [{ id: UID_A }, { id: UID_B }];
    if (/FROM user_settings/i.test(text)) return [
      { user_id: UID_A, key: "notificationsPaused", value: JSON.stringify(false) },
    ];
    if (/FROM users WHERE id =/i.test(text)) {
      return [{ id: Number(params[0]) || UID_A, email: "member@example.test", role: "member", plan: "free", created_at: "2026-01-01T00:00:00.000Z" }];
    }
    if (/FROM user_events/i.test(text)) return [];
    return [];
  };
  return { calls, exec, pgDriver: driverOf(exec) };
}

test("通知入列：同一批事件帶了當輪快照就不得逐筆重讀全域設定", async () => {
  const { enqueueListingEventAsync } = await import("../src/notifyEnqueueAsync.js");
  const events = [
    { type: "new", detail: "第一筆" },
    { type: "new", detail: "第二筆" },
    { type: "offline", detail: "第三筆" },
  ];

  const withSnapshot = enqueueFixture();
  for (const event of events) {
    await enqueueListingEventAsync(LISTING, event, {
      ...PG, exec: withSnapshot.exec, pgDriver: withSnapshot.pgDriver,
      globalRows: GLOBAL_ROWS, requestContext: REQUEST_CONTEXT,
    });
  }
  assert.equal(globalReads(withSnapshot.calls).length, 0,
    `帶了當輪快照，3 筆事件只能有 0 條全域設定讀取，實際 ${JSON.stringify(globalReads(withSnapshot.calls).map((r) => r.sql))}`);

  // 對照組：沒帶快照時本來就每一筆事件各讀一次（證明上面的 0 不是夾具壞掉）。
  const withoutSnapshot = enqueueFixture();
  for (const event of events) {
    await enqueueListingEventAsync(LISTING, event, { ...PG, exec: withoutSnapshot.exec, pgDriver: withoutSnapshot.pgDriver });
  }
  assert.equal(globalReads(withoutSnapshot.calls).length, events.length,
    `沒有快照時每一筆事件各讀一次（夾具要觀測得到），實際 ${globalReads(withoutSnapshot.calls).length}`);
});

test("通知入列：爬蟲輪次的入列呼叫端要把當輪快照傳下去（原始碼層）", () => {
  const src = readFileSync(path.join(dir, "../src/watcher.js"), "utf8");
  const start = src.indexOf("export async function runWatch");
  const end = src.indexOf("\nasync function ", start);
  const body = src.slice(start, end === -1 ? undefined : end);
  assert.match(body, /await enqueueListingEventAsync\(saved, evt, roundOptions\)/,
    "runWatch 的逐筆入列要帶 roundOptions（否則每一筆事件重讀一次全域設定）");
});

// ── 2. 通勤設定清單：每一位會員 ────────────────────────────────────────────────
function commuteFixture() {
  const calls = [];
  const exec = async (sql, params = []) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (/SELECT id FROM users WHERE deleted_at/i.test(text)) return [{ id: UID_A }, { id: UID_B }, { id: UID_C }];
    if (/FROM user_settings/i.test(text)) return [];
    if (/FROM users WHERE id =/i.test(text)) {
      return [{ id: Number(params[0]) || 0, email: "member@example.test", role: "member", plan: "free", created_at: "2026-01-01T00:00:00.000Z" }];
    }
    return [];
  };
  return { calls, exec, pgDriver: driverOf(exec) };
}

test("通勤設定清單：整份清單只讀一次全域設定（不是每位會員一次）", async () => {
  const { collectCommuteSettingsAsync } = await import("../src/settingsAsync.js");
  const fixture = commuteFixture();
  const list = await collectCommuteSettingsAsync({ ...PG, exec: fixture.exec, pgDriver: fixture.pgDriver, strict: true });

  // 3 位會員 ＋ 站台那一份 ＋ 示範補丁 ＝ 5 筆。
  assert.equal(list.length, 5, `清單長度要維持（3 會員＋站台＋示範）：${list.length}`);
  assert.equal(globalReads(fixture.calls).length, 1,
    `整份清單只能有 1 條全域設定讀取，實際 ${globalReads(fixture.calls).length}`);
});

// ── 3. 閒置暫停：每一位候選會員 ────────────────────────────────────────────────
function maintenanceFixture({ pausedKeys = [] } = {}) {
  const calls = [];
  const exec = async (sql, params = []) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (/COALESCE\(last_login_at, created_at\)/i.test(text)) return [{ id: UID_A }, { id: UID_B }, { id: UID_C }];
    if (/FROM user_settings/i.test(text)) {
      return [...pausedKeys].map((id) => ({ user_id: id, key: "notificationsPaused", value: JSON.stringify(true) }));
    }
    if (/FROM users WHERE id =/i.test(text)) {
      return [{ id: Number(params[0]) || 0, email: "member@example.test", role: "member", plan: "free", created_at: "2026-01-01T00:00:00.000Z" }];
    }
    return [];
  };
  return { calls, exec, pgDriver: driverOf(exec) };
}

test("閒置暫停：整圈維護只讀一次全域設定（讀與寫都不再逐位會員重讀）", async () => {
  const { pauseIdleMembersAsync } = await import("../src/accountMaintenanceAsync.js");
  const fixture = maintenanceFixture();
  const paused = await pauseIdleMembersAsync({ now: Date.now() }, { ...PG, exec: fixture.exec, pgDriver: fixture.pgDriver, strict: true });

  assert.equal(paused, 3, `3 位候選會員都要被暫停，實際 ${paused}`);
  assert.equal(globalReads(fixture.calls).length, 1,
    `整圈維護只能有 1 條全域設定讀取，實際 ${globalReads(fixture.calls).length}`);
});

// ── 4. flush 的第二圈：每一位要通知的會員 ─────────────────────────────────────
function flushFixture() {
  const calls = [];
  const exec = async (sql, params = []) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (/FROM user_events/i.test(text) && !/^\s*UPDATE/i.test(text)) {
      return [{
        id: 980001, user_id: UID_A, post_id: POST_ID, type: "new", title: "新物件",
        created_at: "2026-10-01T00:00:00.000Z", notified: 0, notify_decide: "", notify_reason: "",
        notify_next_at: null, notify_ready_at: null, notify_coord_version: 0, notify_retry_count: 0,
        dock_job_state: "", line_job_state: "", email_job_state: "", push_job_state: "",
      }];
    }
    if (/FROM users/i.test(text)) {
      return [{ id: UID_A, email: "member@example.test", role: "member", plan: "free", created_at: "2026-01-01T00:00:00.000Z" }];
    }
    if (/FROM listings/i.test(text)) return [{ ...LISTING, location_class: "street" }];
    if (/FROM user_settings/i.test(text)) return [];
    return [];
  };
  return { calls, exec, pgDriver: driverOf(exec) };
}

test("flush 第二圈：整批只讀一次全域設定（逐會員的設定與信件範本都吃當輪快照）", async () => {
  const { flushPendingNotifications } = await import("../src/watcher.js");
  const fixture = flushFixture();
  await flushPendingNotifications(null, { ...PG, exec: fixture.exec, pgDriver: fixture.pgDriver, strict: true });

  assert.equal(globalReads(fixture.calls).length, 1,
    `整批 flush 只能有 1 條全域設定讀取（就是開頭那一批），實際 ${globalReads(fixture.calls).length}`);
});
