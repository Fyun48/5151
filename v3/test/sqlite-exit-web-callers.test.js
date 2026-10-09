// sqlite-exit 批次 F：web 開閘前最後一批「同族殘留」的同步 SQLite 呼叫點。
//
// 開閘（PG_NO_SQLITE_OPEN=1、DB_DRIVER=postgres）時，`db` 是碰任何 method 就拋
// 「business SQLite is closed」的 proxy；任何同步讀（getSettings→settingKey→db.prepare）
// 都會讓該路徑炸掉。這裡驗證三處殘留不再同步讀本機 SQLite、改走 driver-aware 的 async 版：
//   ① watcher.js resolvePendingNotifyLocations 的逐會員設定（抓取節點）
//   ② server.js 帳號維護 tick 的驗證碼過期通知信（queueSystemMail→queueSystemMailAsync）
//   ③ accountMaintenanceAsync.js 的 onExpire 非同步工作要 await（失敗不被吞）
//
// 未開閘（本機／sqlite）行為逐字回歸：SQLite 分支不變。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expireStaleVerifyTokensAsync } from "../src/accountMaintenanceAsync.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

// ① 抓取節點：resolvePendingNotifyLocations 的逐會員設定改讀 PG（getSettingsAsync）。
test("resolvePendingNotifyLocations 用 async 讀 PG 設定（開閘不碰本機 SQLite）", () => {
  const src = readFileSync(path.join(dir, "../src/watcher.js"), "utf8");
  assert.match(
    src,
    /const userSettings = userId \? await getSettingsAsync\(userId, options\) : settings;\n    if \(!shouldNotify\(userSettings, listing, event\)\) continue;/,
    "resolvePendingNotifyLocations 要用 getSettingsAsync 讀 PG 設定",
  );
  assert.doesNotMatch(
    src,
    /const userSettings = userId \? getSettings\(userId\) : settings;\n    if \(!shouldNotify\(userSettings, listing, event\)\) continue;/,
    "不得再同步 getSettings(userId)（開閘會拋 business SQLite is closed）",
  );
});

// ② 帳號維護 tick：驗證碼過期通知信改走 queueSystemMailAsync（範本與 SMTP 讀 PG）。
test("驗證碼過期信走 async：onExpire 用 queueSystemMailAsync（開閘不讀本機 SMTP 範本）", () => {
  const src = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  assert.match(
    src,
    /if \(user\?\.email\) return queueSystemMailAsync\("verify_expired", user\.email\);/,
    "驗證碼過期信要改走 queueSystemMailAsync（讀 PG 的範本與 SMTP）",
  );
  assert.doesNotMatch(
    src,
    /queueSystemMail\("verify_expired", user\.email\);\s*$/m,
    "不得再同步呼叫 queueSystemMail（getMailTemplates/getStoredSmtp 會同步讀 SQLite）",
  );
});

// ③ onExpire 的 async 工作要 await：失敗不被吞、成功路徑完成後才回傳。
// 離線用 SQLite fixture 當 PG 替身（注入式 exec 收到 `?` 風格語句，與其它島嶼一致）。
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY, email TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'member',
      plan TEXT NOT NULL DEFAULT 'free', deleted_at TEXT, email_verified INTEGER DEFAULT 1,
      verify_token TEXT, verify_expires_at TEXT, verify_expire_notified INTEGER DEFAULT 0,
      last_login_at TEXT, created_at TEXT)
  `);
  db.prepare(
    `INSERT INTO users(id, email, role, plan, deleted_at, email_verified, verify_token, verify_expires_at,
      verify_expire_notified, last_login_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(1, "stale@jibby.test", "member", "free", null, 0, "tok-1",
    new Date(Date.now() - 3600_000).toISOString(), 0, null, new Date().toISOString());
  return db;
}

function execFor(db) {
  return async (sql, params = []) => {
    const text = String(sql);
    const stmt = db.prepare(text);
    if (/^\s*select/i.test(text)) return stmt.all(...params);
    stmt.run(...params);
    return [];
  };
}

test("onExpire 的 async 工作被等待：resolve 後才回傳（成功路徑）", async () => {
  const db = fixture();
  let settled = false;
  await expireStaleVerifyTokensAsync({
    now: Date.now(),
    onExpire: async () => { await new Promise((r) => setTimeout(r, 10)); settled = true; },
  }, { driver: "postgres", exec: execFor(db) });
  assert.equal(settled, true, "onExpire 的 async 工作要被 await 到完成（不能 fire-and-forget）");
});

test("onExpire 的 async 工作被等待：reject 會往上傳（失敗不被吞）", async () => {
  const db = fixture();
  await assert.rejects(
    () => expireStaleVerifyTokensAsync({
      now: Date.now(),
      onExpire: async () => { throw new Error("mail failed"); },
    }, { driver: "postgres", exec: execFor(db) }),
    /mail failed/,
    "onExpire 的非同步失敗要往上傳，不得吞掉",
  );
});
