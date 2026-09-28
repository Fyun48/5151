// `getUserByIdAsync()` 的 parity（2026-09-28）。
//
// 這一支本身不難，但它是「缺口頭號卡點（25 條路由）」的第一步，所以要把**形狀**釘死：
// 呼叫端（`adminPatchMember`、`getSettings`、`saveSettings`…）都是靠 `user?.role`／`user?.plan`
// 做判斷，而「查不到人」必須回 **null**（不是 undefined、不是空物件），
// 否則那些 `if (!user)` 的守衛會失效。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-users-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const dbMod = await import("../src/db.js");
const usersAsync = await import("../src/usersAsync.js");

const PG = { driver: "postgres" };
const handle = () => dbMod.sqliteHandle();
const UID = 900000001001;
const ADMIN = 900000001002;

function fixture() {
  const mem = new DatabaseSync(":memory:");
  const ddl = handle().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  assert.ok(ddl?.sql, "必須抓到 users 的 DDL");
  mem.exec(ddl.sql);
  const exec = async (sql, params = []) => {
    const rows = mem.prepare(sql).all(...params);
    return { rows, rowCount: Number(mem.prepare("SELECT changes() AS n").get().n) || 0 };
  };
  exec.raw = mem;
  return exec;
}

function resetWorld() {
  const db = handle();
  db.prepare("DELETE FROM users WHERE id >= 900000000000").run();
  for (const [id, email, role, plan] of [[UID, "u1@example.com", "member", "pro"], [ADMIN, "u2@example.com", "admin", "free"]]) {
    db.prepare(
      "INSERT INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?,'?','?','2026-01-01T00:00:00.000Z')"
        .replace("'?'", "?").replace("'?'", "?"),
    ).run(id, email, `n${id}`, role, plan);
  }
  const exec = fixture();
  for (const row of db.prepare("SELECT * FROM users").all()) {
    const cols = Object.keys(row);
    exec.raw.prepare(`INSERT INTO users(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
      .run(...cols.map((c) => row[c]));
  }
  return [db, exec];
}

// ---------------------------------------------------------------------------

test("查得到人：role／plan 與同步版相同（呼叫端靠這兩個欄位）", async () => {
  const [db, exec] = resetWorld();
  const sync = dbMod.getUserById(UID);
  const asyncUser = await usersAsync.getUserByIdAsync(UID, { ...PG, exec, strict: true });
  assert.equal(asyncUser.id, sync.id);
  assert.equal(asyncUser.role, sync.role, "role 必須相同");
  assert.equal(asyncUser.plan, sync.plan, "plan 必須相同");
  assert.equal(asyncUser.email, sync.email);
  assert.equal(asyncUser.role, "member");
  assert.equal(asyncUser.plan, "pro", "必須真的讀到非預設值（否則這條沒鑑別力）");
});

test("查不到人：必須回 null（不是 undefined、不是空物件）", async () => {
  const [, exec] = resetWorld();
  const missing = await usersAsync.getUserByIdAsync(999999999, { ...PG, exec, strict: true });
  // ⚠️ 一定要用**嚴格**比較：`assert.equal(undefined, null)` 是通過的，
  // 所以「回 undefined 而不是 null」的變異原本殺不死（變異測試抓到的）。
  assert.strictEqual(missing, null, "查不到必須是 null（不是 undefined）");
  assert.strictEqual(dbMod.getUserById(999999999), null, "同步版也是 null（兩邊形狀一致）");
  // 0／非數字：同步版直接回 null，PG 版必須一樣（不要送出一句 id = 0 的查詢）
  for (const bad of [0, null, undefined, "abc", ""]) {
    assert.strictEqual(
      await usersAsync.getUserByIdAsync(bad, { ...PG, exec, strict: true }), null,
      `uid=${String(bad)} 必須是 null（嚴格比較）`,
    );
  }
  // 而且**不得**真的送出查詢（送出去就代表守衛被拿掉了）
  let calls = 0;
  const counting = async (sql, params = []) => {
    calls += 1;
    const rows = exec.raw.prepare(sql).all(...params);
    return { rows, rowCount: rows.length };
  };
  counting.raw = exec.raw;
  await usersAsync.getUserByIdAsync(0, { ...PG, exec: counting, strict: true });
  assert.equal(calls, 0, "uid 0 時不得送出查詢（守衛必須在呼叫前就早退）");
});

test("admin 的 role 要正確（權限判斷的來源）", async () => {
  const [db, exec] = resetWorld();
  assert.equal(dbMod.getUserById(ADMIN).role, "admin");
  const asyncAdmin = await usersAsync.getUserByIdAsync(ADMIN, { ...PG, exec, strict: true });
  assert.equal(asyncAdmin.role, "admin");
  assert.equal(asyncAdmin.role, dbMod.getUserById(ADMIN).role);
});

test("寫入失敗時 fail-closed：PG 丟錯就往上丟，不得靜默回退 SQLite", async () => {
  resetWorld();
  const bad = async () => { throw new Error("connection terminated unexpectedly"); };
  await assert.rejects(
    () => usersAsync.getUserByIdAsync(UID, { ...PG, exec: bad, strict: true }),
    /connection terminated/,
  );
});

test("非 postgres 必須回退同步路徑（讀磁碟，完全不碰傳入的 exec）", async () => {
  const [db, exec] = resetWorld();
  let calls = 0;
  const boom = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  const user = await usersAsync.getUserByIdAsync(UID, { driver: "sqlite", exec: boom });
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
  assert.equal(user.id, dbMod.getUserById(UID).id, "sqlite 模式必須讀磁碟");
});
