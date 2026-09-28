// 許願房範例 PG 分支的 parity（2026-09-27）。
//
// 兩個函式都只碰一張表（`user_id` 是主鍵，一人一列），重點在**讀取的 try/catch**：
// `payload` 是 JSON 字串，壞掉時同步版只回 `updated_at`，**不能讓端點爆掉**。
// 另外刪除一定要帶 `user_id`（少了它會刪到別人的範例）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-wishexample-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const db = (await import("../src/db.js")).sqliteHandle();
const syncDb = await import("../src/db.js");
const asyncMod = await import("../src/wishExampleAsync.js");

const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");
const TABLES = ["wish_room_example", "users"];

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  for (const t of TABLES) {
    const ddl = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(t);
    assert.ok(ddl?.sql, `必須抓到 ${t} 的 DDL`);
    mem.exec(ddl.sql);
  }
  const u = disk.prepare("SELECT * FROM users WHERE id=1").get();
  disk.close();
  if (u) {
    const info = mem.prepare("PRAGMA table_info(users)").all();
    const names = info.map((c) => c.name).filter((n) => u[n] !== undefined);
    mem.prepare(`INSERT INTO users(${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...names.map((n) => u[n]));
  }
  const exec = async (sql, params = []) => mem.prepare(sql).all(...params);
  exec.raw = mem;
  return exec;
}

function resetBoth() {
  db.prepare("DELETE FROM wish_room_example").run();
  const exec = pgFixture();
  exec.raw.prepare("DELETE FROM wish_room_example").run();
  return exec;
}

function seed(h, userId, payload, updatedAt = "2026-09-01T00:00:00.000Z") {
  h.prepare("INSERT INTO wish_room_example(user_id, payload, created_at, updated_at) VALUES (?,?,?,?)")
    .run(userId, payload, updatedAt, updatedAt);
}

// ---------------------------------------------------------------------------

test("沒有範例：回 null，與同步版相同", async () => {
  const exec = resetBoth();
  const pg = await asyncMod.getWishExampleAsync(1, { ...PG, exec });
  const lite = syncDb.getWishExampleFor(1);
  assert.equal(pg, null);
  assert.equal(lite, null);
});

test("有範例：payload 要展開，updated_at 一定要帶上（兩邊逐欄相同）", async () => {
  const exec = resetBoth();
  const payload = JSON.stringify({ title: "想找兩房", budget: 25000 });
  seed(db, 1, payload);
  seed(exec.raw, 1, payload);
  const pg = await asyncMod.getWishExampleAsync(1, { ...PG, exec });
  const lite = syncDb.getWishExampleFor(1);
  assert.deepEqual(pg, lite, "整包必須相同");
  assert.equal(pg.title, "想找兩房", "payload 必須被展開");
  assert.equal(pg.budget, 25000);
  assert.equal(pg.updated_at, "2026-09-01T00:00:00.000Z");
});

test("payload 壞掉：只回 updated_at，不得丟錯（try/catch 的價值）", async () => {
  const exec = resetBoth();
  seed(db, 1, "{不是合法 JSON");
  seed(exec.raw, 1, "{不是合法 JSON");
  const pg = await asyncMod.getWishExampleAsync(1, { ...PG, exec });
  const lite = syncDb.getWishExampleFor(1);
  assert.deepEqual(pg, lite, "整包必須相同");
  assert.deepEqual(pg, { updated_at: "2026-09-01T00:00:00.000Z" }, "壞掉的 payload 只能回 updated_at");
  // ⚠️ 一定要用 `strict: true` 再驗一次：預設的讀取 fail-open 會**回退到磁碟**，
  // 而磁碟種了同一筆資料 ⇒ 就算 PG 分支把例外丟出來，測試照樣過（變異殺不死）。
  // strict 讓例外真的往上丟，try/catch 才有被驗到。
  assert.deepEqual(await asyncMod.getWishExampleAsync(1, { ...PG, exec, strict: true }),
    { updated_at: "2026-09-01T00:00:00.000Z" },
    "strict 模式下也不得丟錯——壞掉的 payload 必須被 try/catch 接住");
});

test("刪除：只刪自己那一列，其他使用者不受影響；未登入丟 401", async () => {
  const exec = resetBoth();
  for (const h of [db, exec.raw]) {
    h.prepare("INSERT OR IGNORE INTO users(id,email,role,plan,created_at) VALUES (2,'u2@example.test','member','free','2026-01-01T00:00:00.000Z')").run();
  }
  seed(db, 1, JSON.stringify({ mine: true }));
  seed(exec.raw, 1, JSON.stringify({ mine: true }));
  seed(db, 2, JSON.stringify({ other: true }));
  seed(exec.raw, 2, JSON.stringify({ other: true }));

  const pg = await asyncMod.deleteWishExampleAsync(1, { ...PG, exec });
  const lite = syncDb.deleteWishExampleFor(1);
  assert.deepEqual(pg, lite);
  assert.deepEqual({ deleted: true }, pg, "回傳形狀必須是 { deleted: true }");
  const left = exec.raw.prepare("SELECT user_id FROM wish_room_example ORDER BY user_id").all().map((r) => Number(r.user_id));
  assert.deepEqual(left, [2], "只能刪掉自己那一列");

  let syncErr = null;
  try { syncDb.getWishExampleFor(0); } catch (e) { syncErr = e; }
  assert.equal(syncErr?.status, 401);
  await assert.rejects(() => asyncMod.getWishExampleAsync(0, { ...PG, exec }), (e) => e.status === 401);
  await assert.rejects(() => asyncMod.deleteWishExampleAsync(0, { ...PG, exec }), (e) => e.status === 401);
});

test("非 postgres 模式必須回退同步路徑（讀寫磁碟，不碰傳入的 exec）", async () => {
  const exec = resetBoth();
  seed(exec.raw, 1, JSON.stringify({ from: "fixture" }));
  assert.equal((await asyncMod.getWishExampleAsync(1, { ...PG, exec })).from, "fixture");
  const lite = await asyncMod.getWishExampleAsync(1, { driver: "sqlite", exec });
  assert.equal(lite, null, "sqlite 模式讀磁碟（磁碟沒有資料 ⇒ null）");
  await asyncMod.deleteWishExampleAsync(1, { driver: "sqlite", exec });
  assert.equal(exec.raw.prepare("SELECT COUNT(*) n FROM wish_room_example").get().n, 1, "sqlite 模式不得改動 PG 夾具");
});
