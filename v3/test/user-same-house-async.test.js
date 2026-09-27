// 個人同房源合併的 PG 分支 parity（2026-09-27）。
//
// 背景：`mergePersonalSameHouse()` 是 `/api/listings/:id/{reject,confirm}-match` 與
// `/api/listings/merge-same-house` 的後端，而這條路徑**現在還在寫節點本機 SQLite**——
// 實測 2026-09-27 02:04 產生的新群組 `lg_bd21f312958ba02f1cf5` 只存在於 CasaOS 的檔案。
//
// ⚠️ 這個檔要釘住的**最重要一項是方言**：同步版的 upsert 用
//      system_agrees = MIN(user_same_house_members.system_agrees, excluded.system_agrees)
//    SQLite 的 `MIN(a,b)` 是純量；PostgreSQL 的 `MIN()` 是聚合函式，在該位置會直接報錯。
//    PG 必須用 `LEAST(a,b)`，而 `toPostgresSql` 不會轉譯它。直接照搬 = 正式站一合併就爆。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-usersamehouse-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

// 先載入 db.js 建立完整 schema（user_same_house_members 的 DDL 會參照 users，
// 直接對空檔案呼叫 ensureUserSameHouseSchema 會得到 "no such table: main.users"）。
await import("../src/db.js");
const { mergePersonalSameHouse: mergeSync } = await import("../src/userSameHouse.js");
const { mergePersonalSameHouse: mergeAsync } = await import("../src/userSameHouseAsync.js");

const PG = { driver: "postgres" };
const NOW = new Date("2026-09-27T00:00:00.000Z");
const DDL = `CREATE TABLE user_same_house_members (
  user_id INTEGER NOT NULL, group_key TEXT NOT NULL, post_id INTEGER NOT NULL,
  system_agrees INTEGER NOT NULL DEFAULT 0, created_at TEXT,
  PRIMARY KEY (user_id, post_id))`;

function sqliteHandle() {
  const disk = new DatabaseSync(path.join(dataDir, "v3.db"));
  disk.prepare("DELETE FROM user_same_house_members").run();
  return disk;
}

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  mem.exec(DDL);
  // SQLite 沒有 LEAST()——它是 PostgreSQL 的函式。替身必須自己補上，
  // 否則測不到 PG 分支（這跟 LIMIT -1 是同一類「替身與本尊方言不同」的問題，方向相反）。
  mem.function("LEAST", (a, b) => Math.min(Number(a), Number(b)));
  const exec = async (sql, params = []) => {
    // PG 不接受純量 MIN(a,b)；夾具主動拒絕，才測得出方言寫錯。
    if (/MIN\s*\(/i.test(sql)) throw new Error('function min(integer, integer) does not exist');
    return mem.prepare(sql).all(...params);
  };
  exec.raw = mem;
  return exec;
}

const seed = (h, uid, key, postId, agrees = 1) =>
  h.prepare("INSERT INTO user_same_house_members(user_id,group_key,post_id,system_agrees,created_at) VALUES (?,?,?,?,?)")
    .run(uid, key, postId, agrees, NOW.toISOString());

const rowsOf = (h) => h.prepare("SELECT user_id,group_key,post_id,system_agrees FROM user_same_house_members ORDER BY post_id").all();

test("有既有群組時，兩邊的結果與落地的資料列必須完全相同", async () => {
  // 從既有群組出發 → group_key 由既有資料決定（不是 newGroupKey 的 random），才能完整比對
  const disk = sqliteHandle();
  seed(disk, 1, "ush_existing", 1);
  const exec = pgFixture();
  seed(exec.raw, 1, "ush_existing", 1);

  const listings = [{ post_id: 1 }, { post_id: 2 }];
  const syncOut = mergeSync(disk, 1, listings, { now: NOW });
  const asyncOut = await mergeAsync(1, listings, { ...PG, exec, now: NOW });

  assert.deepEqual(asyncOut, syncOut, "回傳值必須逐欄相同（含 group_key 與訊息文字）");
  assert.deepEqual(rowsOf(exec.raw), rowsOf(disk), "實際落地的資料列必須相同");
  disk.close();
});

test("system_agrees 的聯集要用 LEAST，不是 SQLite 的 MIN", async () => {
  const disk = sqliteHandle();
  seed(disk, 1, "ush_existing", 1, 0); // 既有是 0
  const exec = pgFixture();
  seed(exec.raw, 1, "ush_existing", 1, 0);

  // 系統同意 → excluded 是 1；LEAST(0,1)=0 必須保留 0
  const listings = [{ post_id: 1 }, { post_id: 2 }];
  await mergeAsync(1, listings, { ...PG, exec, now: NOW });
  mergeSync(disk, 1, listings, { now: NOW });

  const pgRow = exec.raw.prepare("SELECT system_agrees FROM user_same_house_members WHERE post_id=1").get();
  const sqRow = disk.prepare("SELECT system_agrees FROM user_same_house_members WHERE post_id=1").get();
  assert.equal(sqRow.system_agrees, 0, "同步版：LEAST/MIN 語意下既有的 0 必須保留");
  assert.equal(pgRow.system_agrees, sqRow.system_agrees);
  disk.close();
});

test("PG 分支不得送出聚合式的 MIN(a,b)（正式站會直接拋錯）", async () => {
  const exec = pgFixture();
  // 夾具會對 MIN( 拋錯，所以這一項若寫錯方言就會失敗
  await assert.doesNotReject(
    () => mergeAsync(1, [{ post_id: 1 }, { post_id: 2 }], { ...PG, exec, now: NOW }),
    "PG 分支不得使用 MIN(a,b)",
  );
});

// ⚠️ 這一项原本叫「keys.slice(1) 搬移」，但變異測試顯示**移除那段搬移迴圈，測試照樣通過**：
// upsert 用的是 allIds（已包含所有既有群組的成員），所以搬移在結果上是多餘的——
// 它是防禦性的，不是必要路徑。測試名稱改成它真正驗證的東西（多群組確實被併成一個），
// 不要留下「這條測試守著搬移邏輯」的錯誤印象。
test("多個既有群組要被併成一個（不論是靠搬移或 upsert）", async () => {
  const disk = sqliteHandle();
  seed(disk, 1, "ush_a", 1);
  seed(disk, 1, "ush_b", 2);
  const exec = pgFixture();
  seed(exec.raw, 1, "ush_a", 1);
  seed(exec.raw, 1, "ush_b", 2);

  const listings = [{ post_id: 1 }, { post_id: 2 }];
  const syncOut = mergeSync(disk, 1, listings, { now: NOW });
  const asyncOut = await mergeAsync(1, listings, { ...PG, exec, now: NOW });

  assert.equal(asyncOut.group_key, syncOut.group_key, "應併到第一個群組");
  assert.deepEqual(rowsOf(exec.raw), rowsOf(disk), "兩邊落地結果必須相同");
  disk.close();
});

test("未登入與不足兩筆的錯誤形狀必須與同步版一致", async () => {
  const exec = pgFixture();
  assert.deepEqual(await mergeAsync(0, [{ post_id: 1 }, { post_id: 2 }], { ...PG, exec }), {
    ok: false, code: "guest", error: "請先登入才能併入同房源", systemAgrees: false,
  });
  assert.deepEqual(await mergeAsync(1, [{ post_id: 1 }], { ...PG, exec }), {
    ok: false, code: "need_two", error: "請至少選 2 筆才能併入同房源", systemAgrees: false,
  });
});
