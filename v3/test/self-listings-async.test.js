// 站內刊登讀取（`getSelfListing`）PG 分支的 parity（2026-09-27）。
//
// 這條路徑有兩個一定要釘住的地方：
//
//   1. **過期清理是一句 UPDATE**（`expire_open_self_listings`），而同步版用的是
//      `IFNULL(self_expires_at, '')`——**PostgreSQL 不接受 IFNULL**，且 `pgExec()` 在注入
//      `exec` 時不經過 `toPostgresSql`，所以 PG 分支必須寫 `COALESCE`。
//      這裡不只比回傳值，而是比**實際落地的 `self_status`**，否則方言寫錯也照樣過關。
//   2. 三道 404 的順序與條件（找不到／不可見／已關閉且非本人）必須與同步版一致——
//      順序錯了會讓「不是本人的已關閉刊登」從 404 變成 200（洩漏）。
//
// 時間刻意用「很久以前」與「很久以後」的到期日，而不是注入 `now`：
// 同步版沒有 `now` 參數，用極端日期才能讓兩邊在任何執行時刻都得到同一個結果。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-selflistings-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const syncMod = await import("../src/selfListings.js");
const asyncMod = await import("../src/selfListingsAsync.js");

const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");
const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(text, unknown) does not exist"],
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
];

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  const rows = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='listings'").all();
  disk.close();
  assert.equal(rows.length, 1, "必須抓到 listings 的 DDL");
  mem.exec(rows[0].sql);
  const exec = async (sql, params = []) => {
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    return mem.prepare(sql).all(...params);
  };
  exec.raw = mem;
  return exec;
}

// 欄位從 PRAGMA 推導，不手寫（本系列已經因為「憑印象寫欄位名」踩過三次）。
function seed(handle, postId, extra = {}) {
  const info = handle.prepare("PRAGMA table_info(listings)").all();
  const provided = { post_id: postId, source: "self", title: `t${postId}`, ...extra };
  const required = info.filter((c) => c.notnull === 1 && c.dflt_value === null && c.pk === 0);
  const names = info.map((c) => c.name).filter((n) => n in provided || required.some((c) => c.name === n));
  handle.prepare(`INSERT INTO listings(${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
    .run(...names.map((n) => {
      if (n in provided) return provided[n];
      const col = info.find((c) => c.name === n);
      return /INT|REAL|NUM/i.test(col.type) ? 0 : "";
    }));
}

const selfStatus = (h, postId) =>
  h.prepare("SELECT self_status FROM listings WHERE post_id = ?").get(postId)?.self_status;

function resetBoth(seedFn) {
  const disk = new DatabaseSync(diskPath());
  disk.prepare("DELETE FROM listings").run();
  try { disk.prepare("DELETE FROM sqlite_sequence WHERE name='listings'").run(); } catch { /* 沒有 AUTOINCREMENT */ }
  const exec = pgFixture();
  exec.raw.prepare("DELETE FROM listings").run();
  if (seedFn) { seedFn(disk); seedFn(exec.raw); }
  return [disk, exec];
}

// ---------------------------------------------------------------------------

test("過期清理：過期的要變 expired、未到期的不得動，且落地的 self_status 必須相同", async () => {
  const [disk, exec] = resetBoth((h) => {
    seed(h, 1, { self_status: "open", self_expires_at: PAST });
    seed(h, 2, { self_status: "open", self_expires_at: FUTURE });
  });

  // 只呼叫清理本身，確保比較的是「這一句 UPDATE 的落地結果」。
  await asyncMod.expireOpenSelfListingsAsync(exec, new Date());
  syncMod.expireOpenSelfListings(disk);

  assert.equal(selfStatus(disk, 1), "expired", "同步版：過期的必須被標成 expired");
  assert.equal(selfStatus(exec.raw, 1), selfStatus(disk, 1), "兩邊落地結果必須相同");
  assert.equal(selfStatus(disk, 2), "open", "未到期的不得被動到");
  assert.equal(selfStatus(exec.raw, 2), "open");
  disk.close();
});

test("過期清理：到期日是空字串的不得被標成 expired（COALESCE 的 != '' 判斷）", async () => {
  // ⚠️ 這一項的**測試資料是關鍵**，第一版我用 NULL，結果變異測試顯示
  // 「拿掉 `COALESCE(self_expires_at,'') != ''` 這個判斷」照樣過關——因為
  // `NULL <= '2020-…'` 在 SQLite／PG 都是 NULL（不成立），本來就不會被更新。
  // 真正需要這個判斷的是**空字串**：`'' <= '2020-…'` 是 TRUE。實測：
  //   沒有 guard 改 1 列（空字串那列）、有 guard 改 0 列。
  // 兩者都放進夾具，並分別斷言——NULL 那一列由 `<=` 擋下，空字串那一列由 guard 擋下。
  const [disk, exec] = resetBoth((h) => {
    seed(h, 3, { self_status: "open", self_expires_at: "" });
    seed(h, 4, { self_status: "open", self_expires_at: null });
  });
  await asyncMod.expireOpenSelfListingsAsync(exec, new Date());
  syncMod.expireOpenSelfListings(disk);
  assert.equal(selfStatus(disk, 3), "open", "同步版：空字串到期日必須保持 open");
  assert.equal(selfStatus(disk, 4), "open", "同步版：NULL 到期日必須保持 open");
  assert.equal(selfStatus(exec.raw, 3), selfStatus(disk, 3), "空字串那一列的落地結果必須相同");
  assert.equal(selfStatus(exec.raw, 4), selfStatus(disk, 4), "NULL 那一列的落地結果必須相同");
  disk.close();
});

test("getSelfListingAsync：本人的 open 刊登要回傳與同步版相同的形狀", async () => {
  const [disk, exec] = resetBoth((h) => {
    seed(h, 11, { self_status: "open", self_expires_at: FUTURE, listed_by_user_id: 7, title: "我的刊登", url: "/go/11" });
  });
  const a = await asyncMod.getSelfListingAsync(11, { viewerId: 7, ...PG, exec });
  assert.deepEqual(a, syncMod.getSelfListing(disk, 11, { viewerId: 7 }));
  assert.equal(a.post_id, 11);
  assert.equal(a.title, "我的刊登", "必須真的讀到資料（否則這條測試沒鑑別力）");
  disk.close();
});

test("getSelfListingAsync：別人的 open 刊登也可讀（公開分享）且形狀相同", async () => {
  const [disk, exec] = resetBoth((h) => {
    seed(h, 12, { self_status: "open", self_expires_at: FUTURE, listed_by_user_id: 7, title: "別人的" });
  });
  const a = await asyncMod.getSelfListingAsync(12, { viewerId: 0, ...PG, exec });
  assert.deepEqual(a, syncMod.getSelfListing(disk, 12, { viewerId: 0 }));
  disk.close();
});

test("404 條件必須一致：找不到／非 self／已關閉且非本人", async () => {
  const [disk, exec] = resetBoth((h) => {
    seed(h, 21, { self_status: "expired", self_expires_at: PAST, listed_by_user_id: 7 });
    seed(h, 22, { source: "591", self_status: "open" }); // 不是站內刊登
  });
  const cases = [
    { postId: 999, viewerId: 0, why: "找不到" },
    { postId: 22, viewerId: 0, why: "不是 self" },
    { postId: 21, viewerId: 0, why: "已關閉且非本人" },
  ];
  for (const c of cases) {
    let syncErr = null;
    try { syncMod.getSelfListing(disk, c.postId, { viewerId: c.viewerId }); } catch (e) { syncErr = e; }
    let asyncErr = null;
    try { await asyncMod.getSelfListingAsync(c.postId, { viewerId: c.viewerId, ...PG, exec }); } catch (e) { asyncErr = e; }
    assert.ok(syncErr, `同步版應該要丟錯（${c.why}）`);
    assert.ok(asyncErr, `PG 分支應該要丟錯（${c.why}）`);
    assert.equal(asyncErr.status, syncErr.status, `status 必須相同（${c.why}）`);
    assert.equal(asyncErr.message, syncErr.message, `訊息必須相同（${c.why}）`);
  }
  disk.close();
});

test("本人的已關閉刊登仍可讀（mine 不受狀態限制）", async () => {
  const [disk, exec] = resetBoth((h) => {
    seed(h, 23, { self_status: "expired", self_expires_at: PAST, listed_by_user_id: 7, title: "自己的舊刊登" });
  });
  const a = await asyncMod.getSelfListingAsync(23, { viewerId: 7, ...PG, exec });
  assert.deepEqual(a, syncMod.getSelfListing(disk, 23, { viewerId: 7 }));
  assert.equal(a.title, "自己的舊刊登");
  disk.close();
});

test("非 postgres 必須回退同步路徑（讀磁碟，不讀傳入的 exec）", async () => {
  const disk = new DatabaseSync(diskPath());
  disk.prepare("DELETE FROM listings").run();
  seed(disk, 31, { self_status: "open", self_expires_at: FUTURE, listed_by_user_id: 1, title: "磁碟版" });
  const exec = pgFixture();
  exec.raw.prepare("DELETE FROM listings").run();
  seed(exec.raw, 31, { self_status: "open", self_expires_at: FUTURE, listed_by_user_id: 1, title: "夾具版" });

  const a = await asyncMod.getSelfListingAsync(31, { viewerId: 1, driver: "sqlite", exec });
  assert.equal(a.title, "磁碟版", "sqlite 模式必須讀磁碟");
  assert.equal(exec.raw.prepare("SELECT title FROM listings WHERE post_id=31").get().title, "夾具版",
    "sqlite 模式不得改動 PG 夾具");
  disk.close();
});

test("夾具本身要真的拒絕 IFNULL（否則上面的方言守衛是空的）", async () => {
  const exec = pgFixture();
  await assert.rejects(() => exec("SELECT IFNULL(title,'') FROM listings"), /function ifnull/);
  await assert.doesNotReject(() => exec("SELECT COALESCE(title,'') AS t FROM listings"), "COALESCE 必須放行");
});
