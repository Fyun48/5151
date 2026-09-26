// 帳號維護 PG 分支的行為回歸（2026-09-26 上線收尾）。
//
// 背景：`server.js` 的維護 tick 原本在 PG 模式仍呼叫 db.js 的同步版本，所以「誰被標記驗證碼過期、
// 誰被閒置暫停」只寫進回答那台節點的本機 SQLite，另一個節點重複處理或永遠不處理。
// accountMaintenanceAsync.js 讓 PG 分支用同一組語句與同一組純規則寫 PG。
//
// 離線用 SQLite fixture 當 PG 替身（注入式 exec 收到 `?` 風格語句，與其它島嶼一致）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  expireStaleVerifyTokensAsync,
  listIdleMemberIdsAsync,
  pauseIdleMembersAsync,
} from "../src/accountMaintenanceAsync.js";
import { IDLE_PAUSE_MS } from "../src/members.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-account-maint-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the file locked
  }
});

const NOW = Date.parse("2026-09-26T12:00:00.000Z");

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'member',
      plan TEXT NOT NULL DEFAULT 'free', deleted_at TEXT, email_verified INTEGER DEFAULT 1,
      verify_token TEXT, verify_expires_at TEXT, verify_expire_notified INTEGER DEFAULT 0,
      last_login_at TEXT, created_at TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE user_settings (user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key));
    CREATE TABLE user_search_profiles (id TEXT NOT NULL, user_id INTEGER NOT NULL, name TEXT NOT NULL DEFAULT '',
      data_json TEXT NOT NULL DEFAULT '{}', active INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
      last_used_at TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY (user_id, id));
  `);
  const user = db.prepare(
    `INSERT INTO users(id, email, role, plan, deleted_at, email_verified, verify_token, verify_expires_at,
      verify_expire_notified, last_login_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const iso = (ms) => new Date(ms).toISOString();
  // 1：驗證碼已過期且未通知 → 應該被清掉並標記
  user.run(1, "stale@jibby.test", "member", "free", null, 0, "tok-1", iso(NOW - 3600_000), 0, null, iso(NOW - 90 * 86400_000));
  // 2：驗證碼還沒過期 → 不動
  user.run(2, "fresh@jibby.test", "member", "free", null, 0, "tok-2", iso(NOW + 3600_000), 0, null, iso(NOW - 5 * 86400_000));
  // 3：已通知過 → 不重複處理
  user.run(3, "notified@jibby.test", "member", "free", null, 0, "tok-3", iso(NOW - 3600_000), 1, null, iso(NOW));
  // 4：閒置超過兩個月的一般會員 → 應被暫停
  user.run(4, "idle@jibby.test", "member", "free", null, 1, null, null, 0, iso(NOW - IDLE_PAUSE_MS - 86400_000), iso(NOW));
  // 5：管理員 → 不暫停
  user.run(5, "admin@jibby.test", "admin", "free", null, 1, null, null, 0, iso(NOW - IDLE_PAUSE_MS - 86400_000), iso(NOW));
  // 6：最近有登入 → 不暫停
  user.run(6, "active@jibby.test", "member", "free", null, 1, null, null, 0, iso(NOW - 86400_000), iso(NOW));
  return db;
}

function sqliteExec(db) {
  return async (sql, params = []) => {
    const text = String(sql);
    const stmt = db.prepare(text);
    if (/^\s*select/i.test(text)) return stmt.all(...params);
    stmt.run(...params);
    return [];
  };
}

const options = (db) => ({ driver: "postgres", exec: sqliteExec(db) });

test("過期驗證碼：只有未通知過的過期列被清掉，並回報筆數", async () => {
  const db = fixture();
  const expired = [];
  const n = await expireStaleVerifyTokensAsync({ now: NOW, onExpire: (u) => expired.push(u.id) }, options(db));

  assert.equal(n, 1, "只有 id=1 符合（過期且未通知）");
  assert.deepEqual(expired, [1], "onExpire 要收到被處理的使用者");
  const row = db.prepare("SELECT verify_token, verify_expire_notified FROM users WHERE id = ?").get(1);
  assert.equal(row.verify_token, null, "verify_token 要清成 NULL");
  assert.equal(Number(row.verify_expire_notified), 1, "要標記已通知");
  assert.equal(db.prepare("SELECT verify_token FROM users WHERE id = ?").get(2).verify_token, "tok-2", "未過期不可動");
  assert.equal(db.prepare("SELECT verify_token FROM users WHERE id = ?").get(3).verify_token, "tok-3", "已通知過不可重複處理");
});

test("閒置名單：排除管理員、已刪除與未驗證，只回超過門檻的會員", async () => {
  const db = fixture();
  db.prepare("INSERT INTO users(id, email, role, deleted_at, email_verified, last_login_at, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(7, "deleted@jibby.test", "member", new Date(NOW).toISOString(), 1, new Date(NOW - IDLE_PAUSE_MS * 3).toISOString(), new Date(NOW).toISOString());
  db.prepare("INSERT INTO users(id, email, role, deleted_at, email_verified, last_login_at, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(8, "unverified@jibby.test", "member", null, 0, new Date(NOW - IDLE_PAUSE_MS * 3).toISOString(), new Date(NOW).toISOString());

  const ids = await listIdleMemberIdsAsync({ now: NOW }, options(db));
  assert.deepEqual(ids, [4], "只有 id=4 是超過門檻的一般會員");
});

test("閒置暫停：把暫停旗標寫進 PG 的 user_settings", async () => {
  const db = fixture();
  const n = await pauseIdleMembersAsync({ now: NOW }, options(db));

  assert.equal(n, 1, "只有 id=4 要被暫停");
  // saveSettings 會依 planSettingWrites() 寫入整份規劃過的鍵（與同步版相同），
  // 所以這裡斷言「暫停旗標確實落到 PG 的 user_settings」，而不是只有這兩列。
  const stored = new Map(
    db.prepare("SELECT key, value FROM user_settings WHERE user_id = ?").all(4).map((r) => [r.key, JSON.parse(r.value)]),
  );
  assert.equal(stored.get("notificationsPaused"), true, "notificationsPaused 要寫進 PG 的 user_settings");
  assert.equal(stored.get("inactivityPaused"), true, "inactivityPaused 要寫進 PG 的 user_settings");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM user_settings WHERE user_id = ?").get(5).n, 0, "管理員不可被暫停");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM user_settings WHERE user_id = ?").get(6).n, 0, "最近登入者不可被暫停");
});

test("閒置暫停：已暫停者不重複寫入（沿用 idlePause 的跳過規則）", async () => {
  const db = fixture();
  db.prepare("INSERT INTO user_settings(user_id, key, value) VALUES (?,?,?)").run(4, "notificationsPaused", JSON.stringify(true));
  const n = await pauseIdleMembersAsync({ now: NOW }, options(db));
  assert.equal(n, 0, "notificationsPaused=true 時要跳過");
});
