// 關閉站內刊登 PG 分支的 parity（2026-09-27）。
//
// 三步都要驗：**取列 → 擁有權 → UPDATE 落地**。擁有權寫錯會讓「別人的刊登被關掉」，
// 而 UPDATE 的 `self_status` 寫錯不會有任何錯誤、只是前台狀態不對。
//
// ⚠️ `listingOfferHook`（wishOffers 註冊的清掃）在 PG 分支**仍用本機 SQLite handle 呼叫**
// ——wishOffers 還沒移植、它的函式全都吃 handle。測試裡那個 hook 是 null（沒有 import wishOffers），
// 所以這裡驗不到；等 wishOffers 移植時要另外補。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-closeself-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const db = (await import("../src/db.js")).sqliteHandle();
const syncDb = await import("../src/db.js");
const asyncMod = await import("../src/selfListingsAsync.js");

const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");
const FUTURE = "2099-01-01T00:00:00.000Z";

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  const ddl = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='listings'").get();
  assert.ok(ddl?.sql, "必須抓到 listings 的 DDL");
  mem.exec(ddl.sql);
  disk.close();
  const exec = async (sql, params = []) => mem.prepare(sql).all(...params);
  exec.raw = mem;
  return exec;
}

// 欄位從 PRAGMA 推導（`listings` 有很多 NOT NULL 無 default 的欄位）。
function seed(handle, postId, extra = {}) {
  const info = handle.prepare("PRAGMA table_info(listings)").all();
  const provided = { post_id: postId, source: "self", title: `t${postId}`, url: `/go/${postId}`,
    self_status: "open", self_expires_at: FUTURE, listed_by_user_id: 7, ...extra };
  const required = info.filter((c) => c.notnull === 1 && c.dflt_value === null && c.pk === 0);
  const names = info.map((c) => c.name).filter((n) => n in provided || required.some((c) => c.name === n));
  handle.prepare(`INSERT INTO listings(${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
    .run(...names.map((n) => {
      if (n in provided) return provided[n];
      const col = info.find((c) => c.name === n);
      return /INT|REAL|NUM/i.test(col.type) ? 0 : "";
    }));
}

function resetBoth(seedFn) {
  db.prepare("DELETE FROM listings").run();
  try { db.prepare("DELETE FROM sqlite_sequence WHERE name='listings'").run(); } catch { /* 沒有 AUTOINCREMENT */ }
  const exec = pgFixture();
  exec.raw.prepare("DELETE FROM listings").run();
  if (seedFn) { seedFn(db); seedFn(exec.raw); }
  return exec;
}

const status = (h, postId) => h.prepare("SELECT self_status FROM listings WHERE post_id=?").get(postId)?.self_status;
const reasonOf = (e) => `${e.status || "-"}/${e.message}`;

test("關閉自己的刊登：落地 self_status='closed'，兩邊相同", async () => {
  const exec = resetBoth((h) => seed(h, 11));
  const pg = await asyncMod.closeSelfListingAsync(7, 11, { now: new Date("2026-06-01T00:00:00Z"), ...PG, exec });
  // ⚠️ 順序與鑑別力（P5a 之後）：async 版**不碰本機**，所以跑完之後本機必須還是 `open`；
  // 接著再跑同步版，本機才會變成 `closed`。這樣「本機的 closed 是誰寫的」一目了然。
  assert.equal(status(db, 11), "open", "async 版不得寫本機（本機仍要是起點的 open）");
  const lite = syncDb.closeSelfListing(7, 11, {});
  assert.equal(pg.post_id, lite.post_id);
  assert.equal(pg.self_status, lite.self_status);
  assert.equal(status(exec.raw, 11), "closed", "PG 落地必須是 closed");
  assert.equal(status(db, 11), "closed", "同步版也一樣");
  assert.equal(status(exec.raw, 11), status(db, 11), "兩邊落地結果必須相同");
});

test("PG 分支只寫 PG：本機那一列不得被動到（不能只靠同步版跑過）", async () => {
  const exec = resetBoth((h) => seed(h, 12));
  // 🚫 P5a（2026-10-10）：`closeSelfListingAsync()` 的**本機鏡射已刪**（正式站開閘時那一句
  // 必拋 `business SQLite is closed`，會員按關閉會收到 400）。這一條原本斷言「本機也必須被
  // async 版自己寫成 closed」，現在改成斷言**本機那一列不得被動到**（同 #700 的做法）。
  await asyncMod.closeSelfListingAsync(7, 12, { now: new Date("2026-06-01T00:00:00Z"), ...PG, exec });
  assert.equal(status(exec.raw, 12), "closed", "PG 落地必須是 closed");
  assert.equal(status(db, 12), "open", "async 版不得再寫本機 listings（PG 是唯一來源）");
});

test("別人的刊登：非 admin 要 403，admin 可以關（兩邊訊息相同）", async () => {
  const exec = resetBoth((h) => seed(h, 21));
  let syncErr = null;
  try { syncDb.closeSelfListing(8, 21, {}); } catch (e) { syncErr = e; }
  assert.ok(syncErr, "同步版應該擋下別人的刊登");
  await assert.rejects(() => asyncMod.closeSelfListingAsync(8, 21, { ...PG, exec }),
    (e) => reasonOf(e) === reasonOf(syncErr), `PG 分支必須一致（同步版：${reasonOf(syncErr)}）`);
  assert.equal(status(exec.raw, 21), "open", "被擋下就不得改狀態");

  // ⚠️ admin 關閉別人的刊登之後，回傳值是 `getSelfListing(postId, { viewerId: admin })`
  // ——而刊登此時已關閉、viewer 又不是屋主 ⇒ **同步版也會丟「這則刊登已關閉或隱藏」**。
  // 這是程式庫既有的（有點怪）行為，不是移植造成的；parity 才是這裡要驗的：
  // 兩邊都要丟同樣的錯，而且 UPDATE **已經落地**（狀態確實被改掉）。
  let pgErr = null;
  try { await asyncMod.closeSelfListingAsync(8, 21, { admin: true, ...PG, exec }); } catch (e) { pgErr = e; }
  let liteErr = null;
  try { syncDb.closeSelfListing(8, 21, { admin: true }); } catch (e) { liteErr = e; }
  assert.ok(pgErr && liteErr, "兩邊都應該丟錯（回讀時 viewer 不是屋主）");
  assert.equal(reasonOf(pgErr), reasonOf(liteErr), "錯誤必須完全相同");
  assert.equal(status(exec.raw, 21), "closed", "狀態仍然必須被改掉（UPDATE 已執行）");
});

test("找不到刊登：404，兩邊訊息相同", async () => {
  const exec = resetBoth();
  let syncErr = null;
  try { syncDb.closeSelfListing(7, 999, {}); } catch (e) { syncErr = e; }
  assert.equal(syncErr?.status, 404);
  await assert.rejects(() => asyncMod.closeSelfListingAsync(7, 999, { ...PG, exec }),
    (e) => reasonOf(e) === reasonOf(syncErr));
});

test("非 postgres 模式必須回退同步路徑（寫磁碟，不碰傳入的 exec）", async () => {
  const exec = resetBoth((h) => seed(h, 31));
  const lite = await asyncMod.closeSelfListingAsync(7, 31, { driver: "sqlite", exec });
  // 只驗「sqlite 分支真的有跑」與「磁碟真的被改」——`getSelfListing` 的裝飾結果不含
  // `self_status`（那是列上的原始欄位），硬要斷言它只會驗到裝飾層的形狀，不是這裡的重點。
  assert.equal(Number(lite.post_id), 31, "sqlite 分支必須回傳同一則刊登");
  assert.equal(status(db, 31), "closed", "sqlite 模式必須寫磁碟");
  assert.equal(status(exec.raw, 31), "open", "sqlite 模式不得改動 PG 夾具");
});
