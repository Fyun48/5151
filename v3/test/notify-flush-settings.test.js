// 通知佇列 flush 迴圈的「讀哪一個 store」parity（2026-09-29 第七十四批）。
//
// `flushPendingNotifications()` 逐會員做兩個同步讀取：`getSettings(userId)`（通知暫停／管道偏好）
// 與 `getUserById(userId).email`（信要寄到哪）。PG 模式下那兩個都讀本機 ⇒
// **暫停通知的會員照樣被通知**、信件寄到舊的（或空的）信箱，而且不會報錯。
//
// 這一檔用一個「只回答幾種語句」的假 exec 直接驅動整個 flush，斷言：
//   1. 迴圈的設定讀取走的是注入的 PG runner（不是本機）；
//   2. 逐會員的設定與信箱也一樣（uid 要對）；
//   3. PG 說「暫停」的事件會被記成 `notify_reason:"paused"`（本機說沒暫停也沒用）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-notifyflush-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const PG = { driver: "postgres" };
const UID = 900000008001;
const EVENT_ID = 880001;
const POST_ID = 880002;

// 假 exec：只認這個 flush 會用到的幾種語句，其餘（DDL／未知查詢）一律回空。
function flushFixture({ paused }) {
  const calls = [];
  const updates = [];
  const exec = async (sql, params = []) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    // 佇列：一筆待處理事件（`pendingNotifyEventsQuery` 的 PG 版）。
    if (/user_events/i.test(text) && !/^\s*UPDATE/i.test(text)) {
      return [{
        id: EVENT_ID,
        user_id: UID,
        post_id: POST_ID,
        type: "new",
        title: "新物件",
        created_at: "2026-09-28T00:00:00.000Z",
        notified: 0,
        notify_decide: "",
        notify_reason: "",
        notify_next_at: null,
        dock_job_state: "",
        line_job_state: "",
        email_job_state: "",
        push_job_state: "",
      }];
    }
    // 會員：信箱（`getUserByIdAsync`）與他那一列（`getSettingsAsync` 的 `users` 讀取）。
    if (/FROM users/i.test(text)) {
      return [{ id: UID, email: "member@example.test", role: "member", plan: "free", created_at: "2026-01-01T00:00:00.000Z" }];
    }
    // 站台層級設定（`settings`）與會員層級設定（`user_settings`）。
    if (/FROM settings/i.test(text)) {
      return [{ key: "settings", value: JSON.stringify({}) }, { key: "systemCrawl", value: JSON.stringify({}) }];
    }
    if (/FROM user_settings/i.test(text)) {
      // ⚠️ `user_settings` 是**一個鍵一列**（key=設定名稱、value=JSON），不是一個大 blob：
      // 第一版回 `{key:"settings"}` 讓 `settingsFromRows()` 組出預設值 ⇒ 暫停旗標等於沒生效。
      return [
        { user_id: UID, key: "notificationsPaused", value: JSON.stringify(paused) },
        { user_id: UID, key: "watchDistricts", value: JSON.stringify(["1-8"]) },
      ];
    }
    // 物件列（`listingForWatchAsync`）。
    if (/FROM listings/i.test(text)) {
      return [{
        post_id: POST_ID, source: "591", title: "新物件", url: "https://example.test/l", price: "20000",
        price_num: 20000, lat: 25.11, lng: 121.52, geo_source: "geocode", location_class: "street",
        coord_version: 1, offline: 0, content_seq: 1, created_at: "2026-09-28T00:00:00.000Z",
        first_seen_at: "2026-09-28T00:00:00.000Z", last_seen_at: "2026-09-28T00:00:00.000Z",
      }];
    }
    if (/UPDATE user_events/i.test(text)) {
      updates.push({ sql: text, params });
      return [];
    }
    return [];
  };
  exec.calls = calls;
  exec.updates = updates;
  // ⚠️ 有幾個島嶼（例如 listings 的 hydrate）走的是 `pgDriver.query()` 而不是注入的 exec，
  // 只給 exec 會讓它們去連真的 127.0.0.1:5432（第一版就是這樣紅的）。同一個假 exec 包成 driver。
  const pgDriver = {
    query: async (sql, params = []) => ({ rows: await exec(sql, params), rowCount: 0 }),
    exec: async () => undefined,
    withTransaction: (fn) => fn(pgDriver),
  };
  return { exec, pgDriver };
}

// 更新語句的參數順序由 repository 決定；把所有參數攤平來找理由字串最穩。
// ⚠️ 不要把空字串也算進候選（`notify_decide` 在 paused 那筆是空的）——第一版就是這樣誤判。
const allParams = (updates) => updates.flatMap((row) => row.params.map((value) => String(value)));

test("flush：迴圈與逐會員的設定／信箱都讀注入的 PG runner（暫停旗標以 PG 為準）", async () => {
  const { flushPendingNotifications } = await import("../src/watcher.js");
  const { exec, pgDriver } = flushFixture({ paused: true });
  await flushPendingNotifications(null, { silent: true, ...PG, exec, pgDriver, strict: true });

  // 1) 站台層級的設定讀取走 PG（否則整個迴圈會用本機那份決定誰收得到通知）。
  assert.ok(exec.calls.some((row) => /FROM settings/i.test(row.sql)), "設定的讀取要走注入的 PG runner");
  // 2) 逐會員的讀取也走 PG，而且 uid 要對。
  const userRead = exec.calls.find((row) => /FROM user_settings/i.test(row.sql));
  assert.ok(userRead, "會員設定的讀取要走注入的 PG runner");
  assert.ok(userRead.params.some((value) => Number(value) === UID), `會員設定的查詢要帶對 uid：${JSON.stringify(userRead.params)}`);
  const userRow = exec.calls.find((row) => /FROM users/i.test(row.sql));
  assert.ok(userRow && userRow.params.some((value) => Number(value) === UID), "信箱要從 PG 的 users 讀");
  // 3) PG 說暫停 ⇒ 事件被記成 paused（本機那一份根本沒被讀取）。
  assert.ok(exec.updates.length >= 1, "至少要寫回一次事件狀態");
  assert.ok(allParams(exec.updates).includes("paused"), `暫停的會員要被標成 paused：${JSON.stringify(exec.updates)}`);
});

test("flush：PG 沒說暫停時不得被本機的暫停旗標影響", async () => {
  const { flushPendingNotifications } = await import("../src/watcher.js");
  const { exec, pgDriver } = flushFixture({ paused: false });
  await flushPendingNotifications(null, { silent: true, ...PG, exec, pgDriver, strict: true });
  assert.ok(!allParams(exec.updates).includes("paused"), "PG 沒有暫停 ⇒ 不得因為本機設定而跳過通知");
});

test("flush：非 postgres 模式不碰注入的 exec（走本機那一份）", async () => {
  const { flushPendingNotifications } = await import("../src/watcher.js");
  const { exec, pgDriver } = flushFixture({ paused: true });
  exec.calls.length = 0;
  await flushPendingNotifications(null, { silent: true, driver: "sqlite", exec, pgDriver });
  assert.deepEqual(exec.calls, [], "sqlite 模式不得呼叫注入的 PG runner");
});

test("watcher.js 的 flush 不得再用同步的 getSettings／getUserById／getMailTemplates", () => {
  const src = readFileSync(path.join(dir, "../src/watcher.js"), "utf8");
  const start = src.indexOf("export async function flushPendingNotifications");
  const end = src.indexOf("\nasync function ", start);
  const body = src.slice(start, end === -1 ? undefined : end);
  for (const sync of ["getSettings", "getUserById", "getMailTemplates"]) {
    const withoutAsync = body.replace(new RegExp(`${sync}Async\\(`, "g"), "");
    assert.ok(!new RegExp(`(?<![A-Za-z])${sync}\\(`).test(withoutAsync), `flush 不得再用同步的 ${sync}()`);
  }
  for (const islandCall of ["await getSettingsAsync(userId, options)", "await getUserByIdAsync(userId, options)", "await getMailTemplatesAsync(options)"]) {
    assert.ok(body.includes(islandCall), `flush 要用 ${islandCall}`);
  }
});
