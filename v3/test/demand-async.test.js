// 許願房寫入（檢舉／回覆／關閉）PG 分支的 parity（2026-09-28）。
//
// 這一條路徑要釘住三件事：
//
//   1. **`reportDemand` 的隱藏門檻是「寫入之後再數」**（`DEMAND_REPORT_HIDE_AFTER`）。
//      同步版是 `INSERT` 之後才 `SELECT COUNT(*)`，所以第二筆檢舉就會觸發隱藏。
//      如果 PG 版把順序寫反（先數再寫），第二筆會回 `hidden:false`——**回傳值不同**，
//      但更糟的是「落地狀態不同」。這裡比的是**落地狀態**，不只是回傳值。
//   2. **PG 沒有 `demand_reports` 的唯一鍵**（同步版的 DDL 也沒有），所以「同一人不重複檢舉」
//      只能靠先查再寫。這一項要單獨驗，否則把那段查詢拿掉也照樣過關
//      （因為 `already` 的測試資料若不重複，分支永遠不會被走到）。
//   3. 隱藏副作用（`applyReportHideEffects`／`applyClosedPostEffects`）**兩個 driver 共用同一支**，
//      所以「PG 走完之後 SQLite 上的狀態」必須與「同步版走完之後」完全相同。
//
// 夾具刻意**拒絕 SQLite 專屬語法**：`pgExec()` 在注入 `exec` 時不經過 `toPostgresSql`，
// 所以夾具若不擋，寫錯的方言會一路過關到正式站才炸。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-demand-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const syncMod = await import("../src/demand.js");
const asyncMod = await import("../src/demandAsync.js");
const dbMod = await import("../src/db.js");

const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");
const handle = () => dbMod.sqliteHandle();

const OLD = "2026-01-01T00:00:00.000Z"; // 遠早於 24 小時門檻
const NOW = "2026-09-28T00:00:00.000Z";
const EXPIRES = "2099-01-01T00:00:00.000Z";

// PG 不接受的方言（SQLite 專屬）。夾具主動拒絕，否則寫錯照樣綠燈。
const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown, unknown) does not exist"],
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  [/IS\s+NOT\s+OLD\./i, "syntax error at or near \"IS\""],
];

// PG 替身：記憶體 SQLite ＋ 從磁碟鏡射 DDL。回 { rows, rowCount }（與 crmOutboxAsync 同形狀）。
function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  // `users` 是 `demand_posts`／`demand_replies` 的外鍵目標，PG 上真的存在，
  // 所以夾具也必須有——否則不是「PG 比較嚴格」，而是夾具根本不完整。
  // `demand_match_districts` 也要：讀取路徑的過期掃描會跑 `pruneDemandMatchDistricts()`，
  // 少了它 PG 分支會丟 "no such table"（離線夾具第一次就是這樣紅的）。
  // `user_listing_flags` 也是：屋主看自己的許願房時要讀活動訊號（同步版查同一張表）。
  // `wish_room_example` 與 `wish_offers` 也要：屋主摘要會讀「有沒有範例」與待處理報價數。
  for (const t of ["users", "demand_posts", "demand_replies", "demand_reports", "demand_match_districts", "user_listing_flags", "wish_room_example", "wish_offers"]) {
    const rows = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").all(t);
    assert.equal(rows.length, 1, `必須抓到 ${t} 的 DDL（夾具不自己寫表格定義）`);
    mem.exec(rows[0].sql);
  }
  disk.close();
  const exec = async (sql, params = []) => {
    // ⚠️ 這條守衛是為了擋住「把 `exec` 這個名字遮住」那一類的錯誤：PG 分支若不小心
    // 呼叫到自己傳進來的東西，而不是 `withFallback` 給的 runner，送進來的會是 SQL
    // 字串本身（或一個 `{rows,rowCount}` 物件）。沒有這條守衛時，那種 bug 的症狀是
    // 「SQL 看起來都對，但每一列都被判成不存在」——本檔第一版就是因此整條路徑 404。
    if (typeof sql !== "string" || !/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) {
      throw new Error(`夾具收到不是 SQL 的東西：${Object.prototype.toString.call(sql)}`);
    }
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    const stmt = mem.prepare(sql);
    const rows = stmt.all(...params);
    return { rows, rowCount: Number(mem.prepare("SELECT changes() AS n").get().n) || 0 };
  };
  exec.raw = mem;
  return exec;
}

// 只清與本批有關的表；`wish_offers` 不必清（hook 只會 UPDATE，且空集合本來就改 0 列）。
function clearDemand(h) {
  // 先刪子表再刪貼文（夾具開了 FK），最後清測試帳號。
  h.prepare("DELETE FROM demand_reports").run();
  h.prepare("DELETE FROM demand_replies").run();
  h.prepare("DELETE FROM demand_posts").run();
  h.prepare("DELETE FROM wish_room_example").run();
  h.prepare("DELETE FROM wish_offers").run();
  h.prepare("DELETE FROM users WHERE email LIKE 'demand%@example.com'").run();
  // ⚠️ user 1 是 `db.js` 開檔時建的 bootstrap 管理員，**不屬於**上面那批測試帳號，
  // 所以它不會被刪掉——而前面幾個測試會改它的 nickname。不還原的話，後面的測試會繼承
  // 前一個測試留下的狀態（第一版就是這樣在「作者暱稱」上紅的）。
  h.prepare("UPDATE users SET nickname = '' WHERE id = 1").run();
}

function seedUsers(h, ids) {
  for (const id of ids) {
    h.prepare(
      "INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?, ?, ?, 'member', 'free', ?)",
    ).run(id, `demand${id}@example.com`, `會員${id}`, OLD);
  }
}

function seedPost(h, { id, userId, status = "open", legacyNumericShare = 1 }) {
  // `public_token` 一定要自己給：沒有值時 `publicTokenFor()` 會**產生一個隨機 token**，
  // 於是同步版與 PG 版拿到的 token 不同，`deepEqual` 會紅在一個與本批無關的欄位上。
  h.prepare(
    "INSERT INTO demand_posts(id, user_id, districts, rent_max, housing_type, mrt_walk, body, status, created_at, expires_at, public_token, legacy_numeric_share) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, userId, "[]", 0, "any", 0, "找房的內容", status, NOW, EXPIRES, `tok-${id}`, legacyNumericShare);
}

function seedReply(h, { id, postId, userId }) {
  h.prepare(
    "INSERT INTO demand_replies(id, post_id, user_id, body, created_at, hidden) VALUES (?, ?, ?, ?, ?, 0)",
  ).run(id, postId, userId, "這是回覆", NOW);
}

function seedUserName(h, id, nickname) {
  h.prepare("UPDATE users SET nickname = ? WHERE id = ?").run(nickname, id);
}

// 磁碟與 PG 夾具都回到同一個起點，回傳 [disk, exec]。
function resetBoth(seedFn) {
  const disk = handle();
  clearDemand(disk);
  seedUsers(disk, [1, 2, 3, 4, 5, 6, 7, 8]);
  const exec = pgFixture();
  clearDemand(exec.raw);
  seedUsers(exec.raw, [1, 2, 3, 4, 5, 6, 7, 8]);
  if (seedFn) { seedFn(disk); seedFn(exec.raw); }
  return [disk, exec];
}

const postStatus = (h, id) => h.prepare("SELECT status FROM demand_posts WHERE id = ?").get(id)?.status;
// 副作用會**兩邊都寫**（PG 是真的來源，本機 handle 追上讓還沒搬完的讀取看到一致狀態），
// 所以夾具要把「真的落地的 status」與「本機 handle 上的 status」分開看。
const reportDiskStatus = (id) => handle().prepare("SELECT status FROM demand_posts WHERE id = ?").get(id)?.status;
const replyHidden = (h, id) => h.prepare("SELECT hidden FROM demand_replies WHERE id = ?").get(id)?.hidden;
const reportRows = (h) => h.prepare("SELECT target_type, target_id, user_id, reason FROM demand_reports ORDER BY id").all();

// ---------------------------------------------------------------------------

test("檢舉：第二筆達門檻要隱藏，而且落地的 status 兩邊必須相同", async () => {
  const [disk, exec] = resetBoth((h) => seedPost(h, { id: 501, userId: 1 }));

  // 同步版基準（第 1 筆）
  const s1 = syncMod.reportDemand(disk, 2, { targetType: "post", targetId: 501, reason: "廣告" }, new Date(NOW));
  assert.equal(s1.hidden, false, "第一筆檢舉不該隱藏");
  assert.equal(postStatus(disk, 501), "open", "第一筆之後仍必須是 open");
  const syncSecond = syncMod.reportDemand(disk, 3, { targetType: "post", targetId: 501, reason: "廣告" }, new Date(NOW));
  assert.equal(syncSecond.hidden, true, "同步版：第二筆必須隱藏");
  const syncStatus = postStatus(disk, 501);
  const syncReports = reportRows(disk);

  // PG 分支：磁碟回到同一起點再跑一次，比較「回傳值」與「落地狀態」
  clearDemand(disk);
  seedUsers(disk, [1, 2, 3, 4]);
  seedPost(disk, { id: 501, userId: 1 });

  const a1 = await asyncMod.reportDemandAsync(2, { targetType: "post", targetId: 501, reason: "廣告" }, { ...PG, exec, strict: true });
  assert.deepEqual(a1, s1, "第一筆的回傳值必須相同");
  assert.equal(postStatus(disk, 501), "open", "PG 分支的第一筆也不該隱藏");
  const a2 = await asyncMod.reportDemandAsync(3, { targetType: "post", targetId: 501, reason: "廣告" }, { ...PG, exec, strict: true });
  assert.deepEqual(a2, syncSecond, "第二筆的回傳值必須相同（門檻判斷）");
  assert.equal(postStatus(disk, 501), syncStatus, "PG 分支與同步版落地的 status 必須相同");
  assert.equal(postStatus(disk, 501), "hidden", "門檻到了就必須真的隱藏（否則這條測試沒鑑別力）");
  // ⚠️ 檢舉列落在 **PG**（`exec.raw`），不是磁碟——隱藏副作用才走本機 handle。
  // 這條斷言第一版寫成 disk，變異測試等級的錯誤：磁碟本來就不該有這兩列。
  assert.deepEqual(reportRows(exec.raw), syncReports, "PG 夾具上的檢舉列必須與同步版相同");
  assert.equal(reportRows(exec.raw).length, 2, "兩筆檢舉都必須落地到 PG");
  assert.equal(reportRows(disk).length, 0, "檢舉列不得落到本機 SQLite（那會是無聲的分歧）");
});

test("檢舉：同一人重複檢舉要回 already，且不得再寫入（PG 沒有唯一鍵，靠先查再寫）", async () => {
  const [disk, exec] = resetBoth((h) => seedPost(h, { id: 502, userId: 1 }));
  const syncFirst = syncMod.reportDemand(disk, 2, { targetType: "post", targetId: 502, reason: "廣告" }, new Date(NOW));
  const syncAgain = syncMod.reportDemand(disk, 2, { targetType: "post", targetId: 502, reason: "廣告" }, new Date(NOW));
  assert.deepEqual(syncAgain, { ok: true, already: true }, "同步版：同人第二次必須回 already");
  assert.equal(reportRows(disk).length, 1, "同步版：不得寫入第二列");

  clearDemand(disk);
  seedUsers(disk, [1, 2, 3, 4]);
  seedPost(disk, { id: 502, userId: 1 });
  const aFirst = await asyncMod.reportDemandAsync(2, { targetType: "post", targetId: 502, reason: "廣告" }, { ...PG, exec, strict: true });
  assert.deepEqual(aFirst, syncFirst, "第一筆的回傳值必須相同");
  const aAgain = await asyncMod.reportDemandAsync(2, { targetType: "post", targetId: 502, reason: "廣告" }, { ...PG, exec, strict: true });
  assert.deepEqual(aAgain, syncAgain, "重複檢舉的回傳值必須相同");
  assert.equal(reportRows(exec.raw).length, 1, "PG 分支不得寫入第二列");
});

test("檢舉回覆：達門檻把 hidden 設 1，兩邊落地值相同", async () => {
  const [disk, exec] = resetBoth((h) => {
    seedPost(h, { id: 503, userId: 1 });
    seedReply(h, { id: 601, postId: 503, userId: 1 });
  });
  syncMod.reportDemand(disk, 2, { targetType: "reply", targetId: 601, reason: "洗版" }, new Date(NOW));
  const syncSecond = syncMod.reportDemand(disk, 3, { targetType: "reply", targetId: 601, reason: "洗版" }, new Date(NOW));
  assert.equal(syncSecond.hidden, true, "同步版：回覆第二筆檢舉必須隱藏");
  assert.equal(replyHidden(disk, 601), 1);

  clearDemand(disk);
  seedUsers(disk, [1, 2, 3, 4]);
  seedPost(disk, { id: 503, userId: 1 });
  seedReply(disk, { id: 601, postId: 503, userId: 1 });
  await asyncMod.reportDemandAsync(2, { targetType: "reply", targetId: 601, reason: "洗版" }, { ...PG, exec, strict: true });
  assert.equal(replyHidden(disk, 601), 0, "第一筆還不該隱藏");
  const aSecond = await asyncMod.reportDemandAsync(3, { targetType: "reply", targetId: 601, reason: "洗版" }, { ...PG, exec, strict: true });
  assert.deepEqual(aSecond, syncSecond, "回傳值必須相同");
  assert.equal(replyHidden(disk, 601), 1, "PG 分支必須真的把 hidden 設成 1");
  assert.equal(postStatus(disk, 503), "open", "檢舉回覆不得動到許願房本身");
});

test("檢舉：目標不存在／未登入的錯誤形狀必須與同步版一致", async () => {
  const [, exec] = resetBoth((h) => seedPost(h, { id: 504, userId: 1 }));
  const cases = [
    { userId: 2, input: { targetType: "post", targetId: 999 }, why: "找不到貼文" },
    { userId: 2, input: { targetType: "reply", targetId: 998 }, why: "找不到回覆" },
    { userId: 2, input: { targetType: "post", targetId: 0 }, why: "沒指定內容" },
    { userId: 0, input: { targetType: "post", targetId: 504 }, why: "未登入" },
  ];
  for (const c of cases) {
    let syncErr = null;
    try { syncMod.reportDemand(handle(), c.userId, c.input, new Date(NOW)); } catch (e) { syncErr = e; }
    let asyncErr = null;
    try { await asyncMod.reportDemandAsync(c.userId, c.input, { ...PG, exec, strict: true }); } catch (e) { asyncErr = e; }
    assert.ok(syncErr, `同步版應該要丟錯（${c.why}）`);
    assert.ok(asyncErr, `PG 分支應該要丟錯（${c.why}）`);
    assert.equal(asyncErr.status, syncErr.status, `status 必須相同（${c.why}）`);
    assert.equal(asyncErr.message, syncErr.message, `訊息必須相同（${c.why}）`);
  }
});

test("回覆：內容、間隔與每小時上限的判斷要與同步版一致", async () => {
  const [disk, exec] = resetBoth((h) => seedPost(h, { id: 505, userId: 1 }));

  // 同步版基準
  const syncFirst = syncMod.addDemandReply(disk, 2, 505, "我看到一間可以參考", new Date(NOW));
  assert.equal(syncFirst.replies.length, 1);
  let syncErr = null;
  try { syncMod.addDemandReply(disk, 2, 505, "太快了吧", new Date(NOW)); } catch (e) { syncErr = e; }
  assert.ok(syncErr, "同步版：20 秒內第二則必須被擋");
  const syncDisk = disk.prepare("SELECT post_id, user_id, body, hidden FROM demand_replies WHERE post_id = 505").all();

  clearDemand(disk);
  seedUsers(disk, [1, 2, 3, 4]);
  seedPost(disk, { id: 505, userId: 1 });
  // ⚠️ 回傳封包**刻意**與同步版不同（見 demandAsync.js 的說明）：PG 分支只回最小封包，
  // 因為同步版回傳的整則許願房是 `getDemandPost()` 讀本機 handle 組出來的，在 PG 模式下
  // 會拿到「還沒寫進去的回覆」。所以要驗的是**落地狀態**，不是封包相等。
  const aFirst = await asyncMod.addDemandReplyAsync(2, 505, "我看到一間可以參考", { ...PG, exec, strict: true });
  assert.deepEqual(aFirst, { ok: true, id: 505, replied: true });
  // ⚠️ 這裡**不能**拿磁碟當對照組：磁碟在跑 PG 分支之前已經被清回起點，
  // 而回覆是寫進 PG 夾具的。要驗的是「PG 夾具上的那一列」與「磁碟上同步版留下的那一列」
  // 內容相同（下面用 syncFirst.replies 的值當基準）。
  assert.deepEqual(
    exec.raw.prepare("SELECT post_id, user_id, body, hidden FROM demand_replies WHERE post_id = 505").all()
      .map((r) => ({ ...r })),
    syncDisk.map((r) => ({ ...r })),
    "PG 分支寫入的回覆列必須與同步版寫入的內容相同",
  );
  assert.equal(syncDisk.length, 1, "同步版必須留下剛好一列（否則上面的比對沒有鑑別力）");
  assert.equal(
    exec.raw.prepare("SELECT body FROM demand_replies WHERE post_id = 505").get().body,
    "我看到一間可以參考",
    "回覆內容必須真的寫進 PG",
  );
  assert.equal(reportRows(disk).length + disk.prepare("SELECT COUNT(*) n FROM demand_replies").get().n, 0,
    "PG 分支不得把回覆寫回本機 SQLite（那會是無聲的分歧）");
  let asyncErr = null;
  try { await asyncMod.addDemandReplyAsync(2, 505, "太快了吧", { ...PG, exec, strict: true }); } catch (e) { asyncErr = e; }
  assert.ok(asyncErr, "PG 分支：20 秒內第二則必須被擋");
  assert.equal(asyncErr.status, syncErr.status, "間隔限制的 status 必須相同");
  assert.equal(asyncErr.message, syncErr.message, "間隔限制的訊息必須相同");
  // 磁碟在跑 PG 分支前已清空（同步版那一列是 syncDisk 快照），所以磁碟應該是 0；
  // 「被擋下的那一則不得落地」要看 **PG 夾具**——那裡才有一列。
  assert.equal(
    disk.prepare("SELECT COUNT(*) AS n FROM demand_replies").get().n, 0,
    "被擋下之後不得有任何回覆落到本機 SQLite",
  );
  const inPg = exec.raw.prepare("SELECT COUNT(*) AS n FROM demand_replies WHERE post_id = 505").get().n;
  assert.equal(inPg, 1, "PG 夾具上必須只有一則（間隔限制擋下的那一則不得落地）");
});

test("回覆：未登入／貼文已關閉／內容太短的錯誤形狀必須與同步版一致", async () => {
  const [, exec] = resetBoth((h) => {
    seedPost(h, { id: 506, userId: 1 });
    seedPost(h, { id: 507, userId: 1, status: "closed" });
  });
  const cases = [
    { userId: 0, postId: 506, body: "有內容的回覆", why: "未登入" },
    { userId: 2, postId: 999, body: "有內容的回覆", why: "找不到貼文" },
    { userId: 2, postId: 507, body: "有內容的回覆", why: "貼文已關閉" },
    { userId: 2, postId: 506, body: "短", why: "內容太短" },
  ];
  for (const c of cases) {
    let syncErr = null;
    try { syncMod.addDemandReply(handle(), c.userId, c.postId, c.body, new Date(NOW)); } catch (e) { syncErr = e; }
    let asyncErr = null;
    try { await asyncMod.addDemandReplyAsync(c.userId, c.postId, c.body, { ...PG, exec, strict: true }); } catch (e) { asyncErr = e; }
    assert.ok(syncErr, `同步版應該要丟錯（${c.why}）`);
    assert.ok(asyncErr, `PG 分支應該要丟錯（${c.why}）`);
    assert.equal(asyncErr.status, syncErr.status, `status 必須相同（${c.why}）`);
    assert.equal(asyncErr.message, syncErr.message, `訊息必須相同（${c.why}）`);
  }
});

test("關閉：狀態與 lifecycle 的落地結果兩邊相同，且非本人不得關閉", async () => {
  const [disk, exec] = resetBoth((h) => seedPost(h, { id: 508, userId: 1 }));

  const syncResult = syncMod.closeDemandPost(disk, 1, 508, {}, new Date(NOW));
  assert.equal(syncResult.status, "closed");
  const syncStatus = postStatus(disk, 508);
  const syncLifecycle = disk.prepare("SELECT lifecycle, closed_reason FROM demand_posts WHERE id = 508").get();
  assert.equal(syncLifecycle.lifecycle, "paused", "同步版必須寫入 lifecycle");

  clearDemand(disk);
  seedUsers(disk, [1, 2, 3, 4]);
  seedPost(disk, { id: 508, userId: 1 });

  // 非本人（也不是 admin）必須與同步版丟一樣的錯
  let syncErr = null;
  try { syncMod.closeDemandPost(handle(), 2, 508, {}, new Date(NOW)); } catch (e) { syncErr = e; }
  let asyncErr = null;
  try { await asyncMod.closeDemandPostAsync(2, 508, {}, { ...PG, exec, strict: true }); } catch (e) { asyncErr = e; }
  assert.ok(syncErr, "同步版：非本人不得關閉");
  assert.equal(asyncErr?.status, syncErr.status, "非本人的 status 必須相同");
  assert.equal(asyncErr?.message, syncErr.message, "非本人的訊息必須相同");
  assert.equal(postStatus(disk, 508), "open", "被擋下之後不得關閉");

  const aResult = await asyncMod.closeDemandPostAsync(1, 508, {}, { ...PG, exec, strict: true });
  assert.equal(postStatus(disk, 508), syncStatus, "PG 分支與同步版落地的 status 必須相同");
  assert.deepEqual(
    disk.prepare("SELECT lifecycle, closed_reason FROM demand_posts WHERE id = 508").get(),
    syncLifecycle,
    "PG 分支與同步版的 lifecycle／closed_reason 必須相同",
  );
  // 封包刻意不同（同 addDemandReplyAsync 的理由）
  assert.deepEqual(aResult, { ok: true, id: 508, status: "closed" });
  assert.equal(syncResult.status, "closed", "同步版照舊回整則許願房");
});

test("非 postgres 必須回退同步路徑（讀磁碟，不讀傳入的 exec）", async () => {
  const [disk, exec] = resetBoth((h) => seedPost(h, { id: 509, userId: 1 }));
  const a = await asyncMod.reportDemandAsync(2, { targetType: "post", targetId: 509, reason: "廣告" }, { driver: "sqlite", exec });
  assert.deepEqual(a, { ok: true, hidden: false });
  assert.equal(reportRows(disk).length, 1, "sqlite 模式必須寫磁碟");
  assert.equal(reportRows(exec.raw).length, 0, "sqlite 模式不得動到 PG 夾具");
});

test("寫入失敗時 fail-closed：PG 丟錯就往上丟，不得靜默回退 SQLite", async () => {
  const [disk] = resetBoth((h) => seedPost(h, { id: 510, userId: 1 }));
  const badExec = async () => { throw new Error("connection terminated unexpectedly"); };
  await assert.rejects(
    () => asyncMod.reportDemandAsync(2, { targetType: "post", targetId: 510, reason: "廣告" }, { ...PG, exec: badExec }),
    /connection terminated/,
  );
  assert.equal(reportRows(disk).length, 0, "fail-closed：不得偷偷寫回本機 SQLite");

  // strict:true 時即使讀取路徑也必須往上丟（fallback 會掩蓋錯誤）
  await assert.rejects(
    () => asyncMod.reportDemandAsync(2, { targetType: "post", targetId: 510 }, { ...PG, exec: badExec, strict: true }),
    /connection terminated/,
  );
});

test("檢舉達門檻：PG 與本機 handle 兩邊都變成 hidden（兩個 store 真的是分開的）", async () => {
  // 這條測試來自 CI 的 live PG 失敗：第一版只把隱藏寫進本機 handle，於是 PG 上那一列
  // 還是 `open`——在 PG 模式下等於完全沒有隱藏。反過來說，只寫 PG 也不行：
  // 還沒搬完的讀取（`listDemand`／`getDemandPost`）讀的是節點 SQLite。
  //
  // ⚠️ 第一版把「PG」用**磁碟**當替身，結果兩個 store 其實是同一個檔案 ⇒ 拿掉
  // PG 那一半的寫入也照樣綠（變異測試當場抓到）。所以這裡刻意讓兩個 store 分開：
  // PG 走記憶體夾具，本機 handle 走磁碟，並斷言**兩邊都變了**。
  const disk = handle();
  const [, exec] = resetBoth((h) => seedPost(h, { id: 520, userId: 1 }));

  await asyncMod.reportDemandAsync(2, { targetType: "post", targetId: 520, reason: "廣告" }, { ...PG, exec, strict: true });
  assert.equal(postStatus(exec.raw, 520), "open", "PG：第一筆還不該隱藏");
  assert.equal(reportDiskStatus(520), "open", "本機：第一筆還不該隱藏");

  const second = await asyncMod.reportDemandAsync(3, { targetType: "post", targetId: 520, reason: "廣告" }, { ...PG, exec, strict: true });
  assert.deepEqual(second, { ok: true, hidden: true });
  const pgRow = exec.raw.prepare("SELECT status, lifecycle, closed_reason FROM demand_posts WHERE id = 520").get();
  assert.equal(pgRow.status, "hidden", "PG 側那一列必須被隱藏（那才是真的來源）");
  assert.equal(pgRow.lifecycle, "blocked", "PG 側的 lifecycle 必須是 blocked");
  assert.equal(reportDiskStatus(520), "hidden", "本機 handle 也必須被隱藏（不然還沒搬完的讀取看不到）");
  assert.equal(
    disk.prepare("SELECT lifecycle FROM demand_posts WHERE id = 520").get()?.lifecycle, "blocked",
    "本機 handle 的 lifecycle 也必須是 blocked",
  );
});


// ─────────────────────────────────────────────────────────────────────────────
// 讀取路徑（`getDemandPost`／`listDemandPosts`）的 parity。
// 這一塊是 reply／close 能接線的前提：兩邊同源，新寫入的資料才不會「寫 PG、讀 SQLite」。

test("讀取：詳情的形狀與可見性判斷，PG 版必須與同步版相同", async () => {
  const [disk, exec] = resetBoth((h) => {
    seedUserName(h, 1, "屋主甲");
    seedUserName(h, 2, "路人乙");
    seedPost(h, { id: 530, userId: 1 });
    seedReply(h, { id: 630, postId: 530, userId: 2 });
  });

  const cases = [
    { opts: { viewerId: 1 }, why: "屋主看自己的" },
    { opts: { viewerId: 2 }, why: "別人看公開中" },
    { opts: { viewerId: 0 }, why: "訪客看公開中" },
    { opts: { viewerId: 0, publicOnly: true }, why: "公開頁" },
    { opts: { viewerId: 1, publicOnly: true }, why: "屋主走公開頁" },
    { opts: { viewerId: 2, includeActorReplies: true }, why: "含回覆" },
  ];
  for (const c of cases) {
    // 同步版每次都會跑過期掃描（會寫），所以每一輪都先把磁碟還原成起點。
    clearDemand(disk);
    seedUsers(disk, [1, 2, 3, 4]);
    seedUserName(disk, 1, "屋主甲");
    seedUserName(disk, 2, "路人乙");
    seedPost(disk, { id: 530, userId: 1 });
    seedReply(disk, { id: 630, postId: 530, userId: 2 });

    const syncView = syncMod.getDemandPost(disk, 530, c.opts);
    const asyncView = await asyncMod.getDemandPostAsync(530, c.opts, { ...PG, exec, strict: true });
    assert.deepEqual(asyncView, syncView, `詳情必須相同（${c.why}）`);
  }
  // 先確認兩個 store 的起點真的相同（否則 seeding bug 會偽裝成 parity bug）
  const diskAuthors = disk.prepare("SELECT id, nickname FROM users WHERE id IN (1,2) ORDER BY id").all().map((r) => `${r.id}:${r.nickname}`);
  const pgAuthors = exec.raw.prepare("SELECT id, nickname FROM users WHERE id IN (1,2) ORDER BY id").all().map((r) => `${r.id}:${r.nickname}`);
  assert.deepEqual(pgAuthors, diskAuthors, "兩個 store 的 nickname 必須一致（起點檢查）");

  // ⚠️ 公開視圖（`publicWishRoomView`）**刻意不含 `author`**，所以「作者暱稱」要在
  // **屋主視圖**上驗；在公開視圖上驗會永遠拿到 undefined（第一版就是這樣紅的）。
  const ownerView = await asyncMod.getDemandPostAsync(530, { viewerId: 1 }, { ...PG, exec, strict: true });
  assert.equal(ownerView.id, 530);
  assert.equal(ownerView.author, "屋主甲", "屋主視圖的作者暱稱必須從 users 取到");
  assert.equal(ownerView.replies.length, 1, "回覆必須被帶進詳情");
  assert.equal(ownerView.replies[0].author, "路人乙", "回覆作者暱稱必須取到");

  const view = await asyncMod.getDemandPostAsync(530, { viewerId: 2 }, { ...PG, exec, strict: true });
  assert.equal(view.id, 530);
  assert.equal(view.public_path, "/w/tok-530", "public_path 必須用既有的 token");
});

test("讀取：詳情的 404 條件（找不到／已關閉／隱藏／草稿）兩邊一致", async () => {
  const [disk, exec] = resetBoth((h) => {
    seedPost(h, { id: 531, userId: 5 });
    seedPost(h, { id: 532, userId: 6, status: "closed" });
    seedPost(h, { id: 533, userId: 7, status: "hidden" });
    seedPost(h, { id: 534, userId: 8, status: "draft" });
  });
  const cases = [
    { postId: 999, opts: { viewerId: 1 }, why: "找不到" },
    { postId: 532, opts: { viewerId: 2 }, why: "已關閉且非本人" },
    { postId: 533, opts: { viewerId: 2 }, why: "已隱藏且非本人" },
    { postId: 534, opts: { viewerId: 2 }, why: "草稿且非本人" },
  ];
  for (const c of cases) {
    let syncErr = null;
    try { syncMod.getDemandPost(disk, c.postId, c.opts); } catch (e) { syncErr = e; }
    let asyncErr = null;
    try { await asyncMod.getDemandPostAsync(c.postId, c.opts, { ...PG, exec, strict: true }); } catch (e) { asyncErr = e; }
    assert.ok(syncErr, `同步版應該要丟錯（${c.why}）`);
    assert.ok(asyncErr, `PG 版應該要丟錯（${c.why}）`);
    assert.equal(asyncErr.status, syncErr.status, `status 必須相同（${c.why}）`);
    assert.equal(asyncErr.message, syncErr.message, `訊息必須相同（${c.why}）`);
  }
  // 本人的已關閉／草稿要看得到（不是 404）
  for (const [id, owner] of [[532, 6], [534, 8]]) {
    const view = await asyncMod.getDemandPostAsync(id, { viewerId: owner }, { ...PG, exec, strict: true });
    assert.equal(view.id, id, `本人必須看得到自己的 ${id}`);
  }
});

test("讀取：非數字 ref 要用 public_token 查，兩邊一致", async () => {
  const [disk, exec] = resetBoth((h) => seedPost(h, { id: 535, userId: 1 }));
  const syncView = syncMod.getDemandPost(disk, "tok-535", { viewerId: 0, publicOnly: true });
  const asyncView = await asyncMod.getDemandPostAsync("tok-535", { viewerId: 0, publicOnly: true }, { ...PG, exec, strict: true });
  assert.deepEqual(asyncView, syncView, "用 token 查的結果必須相同");
  assert.equal(asyncView.id, 535, "必須真的查到那一筆");
});

test("讀取：列表（mine 與公開，含篩選條件）兩邊一致，且公開列表不含禁欄位", async () => {
  // 同一個人只能有一則 open ＋ 一則 draft（部分唯一索引），所以分給不同人。
  const seedList = (h) => {
    seedUserName(h, 1, "屋主甲");
    seedPost(h, { id: 540, userId: 1 });
    seedPost(h, { id: 541, userId: 2, status: "closed" });
    seedPost(h, { id: 542, userId: 3, status: "draft" });
  };
  const [disk, exec] = resetBoth(seedList);
  // mine 只回自己的：user 1 只有 540 那一筆。
  const syncMine = syncMod.listDemandPosts(disk, { viewerId: 1, mine: true });
  const asyncMine = await asyncMod.listDemandPostsAsync({ ...PG, exec, strict: true }, { viewerId: 1, mine: true });
  assert.deepEqual(asyncMine, syncMine, "mine 列表必須相同");
  assert.equal(asyncMine.length, 1, "user 1 只有一則");
  assert.equal(asyncMine[0].id, 540);

  clearDemand(disk);
  seedUsers(disk, [1, 2, 3, 4]);
  seedList(disk);
  const syncPublic = syncMod.listDemandPosts(disk, { viewerId: 0, mine: false });
  const asyncPublic = await asyncMod.listDemandPostsAsync({ ...PG, exec, strict: true }, { viewerId: 0, mine: false });
  assert.deepEqual(asyncPublic, syncPublic, "公開列表必須相同");
  assert.equal(asyncPublic.length, 1, "公開列表只該有 open 那一筆");
  assert.equal(asyncPublic[0].id, 540);

  // ⚠️ 一定要用**帶篩選條件**的查詢再比一次：不帶條件時 `matchesFilters` 永遠回 true，
  // 把它拿掉照樣過關（變異測試當場抓到這條測試沒有鑑別力）。
  for (const filters of [{ city: "臺北市" }, { district: "1-8" }, { housing_type: "apartment" }, { rent_min: 99999 }]) {
    const syncFiltered = syncMod.listDemandPosts(disk, { viewerId: 0, mine: false, ...filters });
    const asyncFiltered = await asyncMod.listDemandPostsAsync({ ...PG, exec, strict: true }, { viewerId: 0, mine: false, ...filters });
    assert.deepEqual(asyncFiltered, syncFiltered, `帶篩選的公開列表必須相同（${JSON.stringify(filters)}）`);
  }
  for (const banned of ["user_id", "email", "phone", "line_url", "replies", "author"]) {
    assert.ok(!(banned in asyncPublic[0]), `公開列表不得有 ${banned}（洩漏守衛）`);
  }
});

test("讀取：過期掃描會把過期的 open 收掉，且兩個 store 都改（分庫一致性）", async () => {
  const [disk, exec] = resetBoth((h) => {
    seedPost(h, { id: 550, userId: 1 });
    h.prepare("UPDATE demand_posts SET expires_at = ? WHERE id = ?").run("2020-01-01T00:00:00.000Z", 550);
  });
  await asyncMod.getDemandPostAsync(550, { viewerId: 1 }, { ...PG, exec, strict: true });
  const pgRow = exec.raw.prepare("SELECT status FROM demand_posts WHERE id = 550").get();
  assert.notEqual(pgRow.status, "open", "PG 側那一筆必須被收掉（這是真的來源）");
  assert.notEqual(postStatus(disk, 550), "open", "本機 handle 也必須被收掉");
  assert.equal(postStatus(disk, 550), pgRow.status, "兩個 store 的狀態必須相同");
});


test("屋主摘要：形狀（active／draft／can_create／has_example）與同步版相同", async () => {
  const seedOwner = (h) => {
    seedUserName(h, 5, "屋主戊");
    seedPost(h, { id: 560, userId: 5 });
    seedPost(h, { id: 561, userId: 6, status: "draft" });
  };
  const [disk, exec] = resetBoth(seedOwner);
  const syncMine = syncMod.wishRoomOwnerSummary(disk, 5);
  const asyncMine = await asyncMod.wishRoomOwnerSummaryAsync(5, { ...PG, exec, strict: true });
  assert.deepEqual(asyncMine, syncMine, "屋主摘要必須逐鍵相同");
  assert.equal(asyncMine.active?.id, 560, "active 必須是自己的 open 那一則");
  assert.equal(asyncMine.can_create, false, "已經有一則 open ⇒ 不能再建");

  // 沒有 open 的人：can_create 要是 true，且 draft 要被抓到
  const syncOther = syncMod.wishRoomOwnerSummary(disk, 6);
  const asyncOther = await asyncMod.wishRoomOwnerSummaryAsync(6, { ...PG, exec, strict: true });
  assert.deepEqual(asyncOther, syncOther, "沒有 open 的屋主摘要必須相同");
  assert.equal(asyncOther.active, null);
  assert.equal(asyncOther.draft?.id, 561, "draft 必須是自己的草稿");
  assert.equal(asyncOther.can_create, true, "沒有 open ⇒ 可以建");

  // 未登入（uid 0）
  const syncZero = syncMod.wishRoomOwnerSummary(disk, 0);
  const asyncZero = await asyncMod.wishRoomOwnerSummaryAsync(0, { ...PG, exec, strict: true });
  assert.deepEqual(asyncZero, syncZero, "uid 0 的空摘要必須相同");
});

test("屋主摘要：has_example 與待處理報價數要從 PG 讀到", async () => {
  const [disk, exec] = resetBoth((h) => {
    seedPost(h, { id: 570, userId: 5 });
    h.prepare("INSERT INTO wish_room_example(user_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(5, '{"rent_max":20000}', NOW, NOW);
  });
  const syncMine = syncMod.wishRoomOwnerSummary(disk, 5);
  const asyncMine = await asyncMod.wishRoomOwnerSummaryAsync(5, { ...PG, exec, strict: true });
  assert.equal(syncMine.has_example, true, "同步版必須看到範例（否則這條沒鑑別力）");
  assert.equal(asyncMine.has_example, true, "PG 版必須看到範例");
  assert.deepEqual(asyncMine, syncMine);

  // 待處理報價數（`wish_offers` 那張表；同步版在 db.js 的 wrapper 裡補上這兩個鍵）
  const pending = await asyncMod.pendingOfferCountAsync(
    async (sql, params = []) => exec(sql, params), 5,
  );
  assert.equal(pending, 0, "沒有 pending 報價時必須是 0");
  // 欄位從 PRAGMA 推導，必填的（NOT NULL 且沒有預設值）自己補上——`wish_offers` 有
  // `public_token NOT NULL` 這種欄位，漏了會直接違反約束（第一版就是這樣紅的）。
  const info = disk.prepare("PRAGMA table_info(wish_offers)").all();
  const provided = {
    id: 9001, wish_id: 570, owner_user_id: 5, tenant_user_id: 5, status: "pending",
    created_at: NOW, updated_at: NOW, public_token: "tok-offer-9001",
  };
  const required = info.filter((c) => c.notnull === 1 && c.dflt_value === null && c.pk === 0).map((c) => c.name);
  const names = info.map((c) => c.name).filter((n) => n in provided || required.includes(n));
  // ⚠️ 一定要同時種一筆**非 pending** 的：只有 pending 一筆時，「不篩 status」的變異
  // 照樣回 1 ⇒ 測試沒有鑑別力（變異測試當場抓到）。
  // ⚠️ `wish_offers` 有 `UNIQUE(owner_user_id, listing_id, wish_id)` 這一類的**表約束**
  // （隱式索引），所以第二筆要換一個 listing_id，不能只換 id／status。
  for (const row of [
    provided,
    { ...provided, id: 9002, status: "accepted", public_token: "tok-offer-9002", listing_id: 8801 },
  ]) {
    for (const h of [disk, exec.raw]) {
      h.prepare(`INSERT INTO wish_offers(${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
        .run(...names.map((n) => {
          if (n in row) return row[n];
          const col = info.find((c) => c.name === n);
          return /INT|REAL|NUM/i.test(col.type) ? 0 : `x-${n}`;
        }));
    }
  }
  assert.equal(
    await asyncMod.pendingOfferCountAsync(async (sql, params = []) => exec(sql, params), 5), 1,
    "PG 版必須數到待處理報價（兩筆裡只有一筆 pending）",
  );
  assert.equal(
    exec.raw.prepare("SELECT COUNT(*) AS n FROM wish_offers WHERE tenant_user_id = 5").get().n, 2,
    "夾具上必須真的有兩筆（否則上面的 1 沒有鑑別力）",
  );
});

test("夾具本身要真的拒絕 SQLite 專屬方言（否則上面的方言守衛是空的）", async () => {
  const exec = pgFixture();
  await assert.rejects(() => exec("SELECT IFNULL(body,'') FROM demand_posts"), /function ifnull/);
  await assert.rejects(() => exec("SELECT body FROM demand_posts LIMIT -1"), /LIMIT must not be negative/);
  await assert.doesNotReject(() => exec("SELECT COALESCE(body,'') AS b FROM demand_posts"), "COALESCE 必須放行");
});
