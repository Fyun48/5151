// 檢舉站內刊登／後台隱藏 PG 分支的 parity（2026-09-28，第四十六批）。
//
// 涵蓋的兩條路由：
//   `POST /api/self-listings/:id/report`        → `reportSelfListingAsync`
//   `POST /api/admin/self-listings/:id/hide`    → `hideSelfListingAsync`
//
// 這一包要釘住四件事：
//
//   1. **達門檻才隱藏**（`SELF_REPORT_HIDE_AFTER = 2`）：第一筆只寫檢舉、第二筆（不同人）才隱藏。
//      門檻是**共用政策**，parity 抓不到「兩邊一起被改壞」，所以要對值本身下斷言。
//   2. **同一人重複檢舉不得寫第二列**：PG 的 `listing_reports` **沒有**唯一鍵
//      （SQLite 的 DDL 只有一般索引），所以靠先查再寫——把那段查詢拿掉也不會有錯誤，
//      只會多一列，因此要單獨驗。
//   3. **停權要兩個 store 都寫**：`banSelfPublisher()` 寫的是 `users.self_ban_until`，
//      而**同步**的建立路徑（`createSelfListing()` → `assertCanPublish()`）讀的是**本機**
//      handle ⇒ 只寫 PG 會讓被停權的人換一台節點就又能上傳。這裡直接呼叫同步的建立函式
//      驗「本機真的被停權」。
//   4. **檢舉列本身不需要本機鏡射**：`listing_reports` 在島上沒有任何**同步**讀者
//      （唯一的讀者是這一支的門檻計數，而它已經在 PG 上跑），所以 PG 是唯一寫入處。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-selfreport-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const syncMod = await import("../src/selfListings.js");
const asyncMod = await import("../src/selfListingsAsync.js");
const dbMod = await import("../src/db.js");

const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");
const handle = () => dbMod.sqliteHandle();

const OLD = "2026-01-01T00:00:00.000Z";
const NOW = "2026-09-28T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown, unknown) does not exist"],
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
];

const TABLES = ["users", "settings", "listings", "listing_reports"];

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  for (const t of TABLES) {
    const rows = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").all(t);
    assert.equal(rows.length, 1, `必須抓到 ${t} 的 DDL（夾具不自己寫表格定義）`);
    mem.exec(rows[0].sql);
  }
  disk.close();
  const exec = async (sql, params = []) => {
    if (typeof sql !== "string" || !/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) {
      throw new Error(`夾具收到不是 SQL 的東西：${Object.prototype.toString.call(sql)}`);
    }
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    const stmt = mem.prepare(sql);
    const rows = stmt.all(...params);
    rows.rowCount = Number(mem.prepare("SELECT changes() AS n").get().n) || 0;
    return rows;
  };
  exec.raw = mem;
  return exec;
}

// 不用 user 1（bootstrap 管理員在兩個 store 的狀態不同，且被其他表以 FK 引用）。
const OWNER = 81;
const REPORTER_A = 82;
const REPORTER_B = 83;
const ADMIN = 84;
const LISTING_ID = 700001;

function clearWorld(h) {
  h.prepare("DELETE FROM listing_reports WHERE post_id >= 700000").run();
  h.prepare("DELETE FROM listings WHERE post_id >= 700000").run();
  h.prepare("DELETE FROM users WHERE id IN (81, 82, 83, 84)").run();
}

function seedUsers(h) {
  for (const id of [OWNER, REPORTER_A, REPORTER_B, ADMIN]) {
    h.prepare(
      "INSERT INTO users(id, email, nickname, role, plan, created_at) VALUES (?, ?, ?, ?, 'free', ?)",
    ).run(id, `selfrep${id}@example.com`, `會員${id}`, id === ADMIN ? "admin" : "member", OLD);
  }
}

function seedListing(h, { id = LISTING_ID, ownerId = OWNER, status = "open" } = {}) {
  h.prepare(
    `INSERT INTO listings(post_id, source_key, title, url, source, listed_by_user_id, self_status, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, 'self', ?, ?, ?, ?)`,
  ).run(id, `self-${id}`, `站內刊登 ${id}`, `https://example.com/${id}`, ownerId, status, OLD, OLD);
}

function resetBoth(seedFn) {
  const disk = handle();
  clearWorld(disk);
  seedUsers(disk);
  const exec = pgFixture();
  clearWorld(exec.raw);
  seedUsers(exec.raw);
  if (seedFn) { seedFn(disk); seedFn(exec.raw); }
  return [disk, exec];
}

const listingRow = (h, id = LISTING_ID) => h.prepare("SELECT self_status, hidden, hidden_at FROM listings WHERE post_id = ?").get(id);
const reportRows = (h, id = LISTING_ID) => h.prepare("SELECT user_id, reason FROM listing_reports WHERE post_id = ? ORDER BY id").all(id);
const banUntil = (h, uid) => h.prepare("SELECT self_ban_until FROM users WHERE id = ?").get(uid)?.self_ban_until || "";
const plain = (value) => JSON.parse(JSON.stringify(value));
const errorShape = async (fn) => {
  try { await fn(); return null; } catch (error) { return { status: error.status, message: error.message, code: error.code || "" }; }
};
const syncErrorShape = (fn) => {
  try { fn(); return null; } catch (error) { return { status: error.status, message: error.message, code: error.code || "" }; }
};

// ---------------------------------------------------------------------------

test("檢舉：第一筆只寫檢舉不隱藏，第二筆（不同人）才隱藏＋停權", async () => {
  const [disk, exec] = resetBoth((h) => seedListing(h));
  // 同步版基準
  const syncFirst = syncMod.reportSelfListing(disk, REPORTER_A, LISTING_ID, "廣告", new Date(NOW));
  assert.deepEqual(plain(syncFirst), { ok: true, hidden: false }, "同步版：第一筆不該隱藏");
  const syncSecond = syncMod.reportSelfListing(disk, REPORTER_B, LISTING_ID, "重複張貼", new Date(NOW));
  assert.deepEqual(plain(syncSecond), { ok: true, hidden: true }, "同步版：第二筆必須達門檻");
  const syncReports = reportRows(disk);
  const syncListing = listingRow(disk);
  const syncBan = banUntil(disk, OWNER);

  clearWorld(disk);
  seedUsers(disk);
  seedListing(disk);
  const localListingBefore = plain(listingRow(disk));
  const localBanBefore = banUntil(disk, OWNER);

  const first = await asyncMod.reportSelfListingAsync(REPORTER_A, LISTING_ID, "廣告", { ...PG, exec, strict: true, now: NOW });
  assert.deepEqual(plain(first), plain(syncFirst), "第一筆的回傳值必須相同");
  assert.equal(listingRow(exec.raw).self_status, "open", "第一筆不得隱藏（否則這條測試沒有鑑別力）");
  const second = await asyncMod.reportSelfListingAsync(REPORTER_B, LISTING_ID, "重複張貼", { ...PG, exec, strict: true, now: NOW });
  assert.deepEqual(plain(second), plain(syncSecond), "第二筆的回傳值必須相同");

  assert.deepEqual(plain(reportRows(exec.raw)), plain(syncReports), "PG 上的檢舉列必須與同步版相同");
  assert.equal(reportRows(exec.raw).length, 2, "兩筆檢舉都要落地");
  assert.equal(reportRows(disk).length, 0, "檢舉列不需要本機鏡射（島上沒有同步讀者）");
  assert.deepEqual(plain(listingRow(exec.raw)), plain(syncListing), "PG 上的隱藏狀態必須相同");
  assert.equal(listingRow(exec.raw).self_status, "hidden", "達門檻必須真的隱藏");
  assert.equal(banUntil(exec.raw, OWNER), syncBan, "PG 上的停權時間必須與同步版相同");
  assert.ok(banUntil(exec.raw, OWNER), "停權時間必須有值");
  // 🚫 P5a（2026-10-10）：隱藏與停權的**本機鏡射已刪** ⇒ 本機那一列與本機的停權時間都必須原封不動。
  // 原本的斷言是「本機也要追上（同步的讀取還在看它）」與「本機的停權時間也要追上」。
  assert.deepEqual(plain(listingRow(disk)), localListingBefore, "本機的 listings 那一列不得被動到");
  assert.equal(banUntil(disk, OWNER), localBanBefore, "本機的停權時間不得被動到");
});

test("檢舉：同一人重複檢舉不得寫第二列（PG 沒有唯一鍵，靠先查再寫）", async () => {
  const [disk, exec] = resetBoth((h) => seedListing(h));
  syncMod.reportSelfListing(disk, REPORTER_A, LISTING_ID, "廣告", new Date(NOW));
  const syncAgain = syncMod.reportSelfListing(disk, REPORTER_A, LISTING_ID, "廣告", new Date(NOW));
  assert.deepEqual(plain(syncAgain), { ok: true, already: true }, "同步版：同一人第二次必須回 already");

  clearWorld(disk);
  seedUsers(disk);
  seedListing(disk);
  await asyncMod.reportSelfListingAsync(REPORTER_A, LISTING_ID, "廣告", { ...PG, exec, strict: true, now: NOW });
  const again = await asyncMod.reportSelfListingAsync(REPORTER_A, LISTING_ID, "廣告", { ...PG, exec, strict: true, now: NOW });
  assert.deepEqual(plain(again), plain(syncAgain), "重複檢舉的回傳值必須相同");
  assert.equal(reportRows(exec.raw).length, 1, "PG 上不得有第二列");
  assert.equal(listingRow(exec.raw).self_status, "open", "already 不得觸發隱藏");
  assert.equal(banUntil(exec.raw, OWNER), "", "already 不得停權");
});

test("檢舉：自己的刊登、找不到的刊登、未登入，錯誤形狀都要與同步版相同", async () => {
  const [disk, exec] = resetBoth((h) => seedListing(h));
  const cases = [
    { uid: OWNER, id: LISTING_ID, reason: "檢舉自己", why: "不能檢舉自己的" },
    { uid: REPORTER_A, id: 799999, reason: "不存在", why: "找不到刊登" },
    { uid: 0, id: LISTING_ID, reason: "未登入", why: "未登入" },
  ];
  for (const c of cases) {
    const syncErr = syncErrorShape(() => syncMod.reportSelfListing(disk, c.uid, c.id, c.reason, new Date(NOW)));
    const asyncErr = await errorShape(() => asyncMod.reportSelfListingAsync(c.uid, c.id, c.reason, { ...PG, exec, strict: true, now: NOW }));
    assert.ok(syncErr, `同步版應該要丟錯（${c.why}）`);
    assert.deepEqual(asyncErr, syncErr, `錯誤形狀必須相同（${c.why}）`);
    assert.equal(reportRows(exec.raw).length, 0, `PG 不得被寫入（${c.why}）`);
  }
});

test("後台隱藏：立刻隱藏＋停權，找不到時 404", async () => {
  const [disk, exec] = resetBoth((h) => seedListing(h));
  const syncResult = syncMod.hideSelfListing(disk, LISTING_ID, new Date(NOW));
  const syncListing = listingRow(disk);
  const syncBan = banUntil(disk, OWNER);

  clearWorld(disk);
  seedUsers(disk);
  seedListing(disk);
  const localListingBefore = plain(listingRow(disk));
  const localBanBefore = banUntil(disk, OWNER);
  const result = await asyncMod.hideSelfListingAsync(LISTING_ID, { ...PG, exec, strict: true, now: NOW });
  assert.deepEqual(plain(result), plain(syncResult), "回傳值必須相同");
  assert.deepEqual(plain(listingRow(exec.raw)), plain(syncListing), "PG 上的隱藏狀態必須相同");
  assert.equal(banUntil(exec.raw, OWNER), syncBan, "PG 上的停權時間必須相同");
  // 🚫 P5a：本機鏡射已刪 ⇒ 本機那一列與本機的停權時間必須原封不動
  //（原本的斷言是「本機也要追上」）。
  assert.deepEqual(plain(listingRow(disk)), localListingBefore, "本機那一列不得被 async 版隱藏");
  assert.equal(banUntil(disk, OWNER), localBanBefore, "本機不得被寫入停權時間");

  const syncErr = syncErrorShape(() => syncMod.hideSelfListing(disk, 799999, new Date(NOW)));
  const asyncErr = await errorShape(() => asyncMod.hideSelfListingAsync(799999, { ...PG, exec, strict: true, now: NOW }));
  assert.ok(syncErr, "同步版應該要丟 404");
  assert.deepEqual(asyncErr, syncErr, "找不到的錯誤形狀必須相同");
});

test("停權之後：PG 的建立路徑必須擋下來（停權只寫 PG，本機不被動到）", async () => {
  const [disk, exec] = resetBoth((h) => seedListing(h));
  await asyncMod.hideSelfListingAsync(LISTING_ID, { ...PG, exec, strict: true, now: NOW });
  assert.ok(banUntil(exec.raw, OWNER), "PG 上必須有停權時間");
  // 🚫 P5a：本機鏡射已刪 ⇒ 本機不得被寫入停權時間（原本的斷言是「本機必須有停權時間」，
  // 那個前提在正式站開閘時根本走不到——那一句必拋）。
  assert.equal(banUntil(disk, OWNER), "", "本機那一列不得被動到（PG 是唯一來源）");
  // `assertCanPublishAsync()`（PG 的建立路徑）讀的是 PG 的 `self_ban_until`。
  let blocked = null;
  try {
    await asyncMod.assertCanPublishAsync(exec, OWNER, new Date(NOW));
    blocked = "沒有被擋";
  } catch (error) {
    blocked = { status: error.status, message: error.message };
  }
  assert.equal(blocked?.status, 403, `被停權者不得再上傳（實際：${JSON.stringify(blocked)}）`);
  assert.match(blocked?.message || "", /暫停上傳/, "錯誤訊息要是「暫停上傳」那一則");
  // 對照組：沒有被停權的人不受影響（否則這條測試可能只是「建立本來就會失敗」）
  // ⚠️ `createSelfListing()` 的欄位驗證很多（行政區／租金／坪數／屋主聲明／路名…），
  // 少一個就會丟別的錯誤、把「停權有沒有生效」這件事蓋掉——payload 是照
  // `self-listings.test.js` 的 `sampleInput()` 抄的。
  const ok = dbMod.createSelfListing(REPORTER_A, { district: "1-8", rent: 25000, ping: 18, kind: "whole", role: "owner", floor: 3, total_floors: 5, rooms: 2, living: 1, bath: 1, contact_name: "林先生", address: "台北市士林區中正路100號", phone: "0912345678", title: "停權測試用的正常刊登", body: "近捷運、可入住、有洗衣機。", accept_pledge: true });
  assert.ok(ok?.post_id, "沒有被停權的人必須可以上傳");
});

test("非 postgres 模式必須走同步路徑（不碰傳入的 exec）", async () => {
  const [disk, exec] = resetBoth((h) => seedListing(h));
  let touched = 0;
  const counting = async (sql, params = []) => { touched += 1; return exec(sql, params); };
  const reported = await asyncMod.reportSelfListingAsync(REPORTER_A, LISTING_ID, "廣告", { driver: "sqlite", exec: counting, now: NOW });
  const hidden = await asyncMod.hideSelfListingAsync(LISTING_ID, { driver: "sqlite", exec: counting, now: NOW });
  assert.equal(touched, 0, "SQLite 模式不得碰 PG runner");
  assert.equal(reported.hidden, false);
  assert.equal(hidden.hidden, true);
  assert.equal(reportRows(disk).length, 1, "要走同步路徑寫本機");
  assert.equal(reportRows(exec.raw).length, 0, "不得寫 PG 夾具");
  assert.equal(listingRow(exec.raw).self_status, "open", "不得寫 PG 夾具");
});
