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
  for (const t of ["users", "demand_posts", "demand_replies", "demand_reports"]) {
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
  h.prepare("DELETE FROM demand_reports").run();
  h.prepare("DELETE FROM demand_replies").run();
  h.prepare("DELETE FROM demand_posts").run();
  h.prepare("DELETE FROM users WHERE email LIKE 'demand%@example.com'").run();
}

function seedUsers(h, ids) {
  for (const id of ids) {
    h.prepare(
      "INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?, ?, ?, 'member', 'free', ?)",
    ).run(id, `demand${id}@example.com`, `會員${id}`, OLD);
  }
}

function seedPost(h, { id, userId, status = "open" }) {
  // `public_token` 一定要自己給：沒有值時 `publicTokenFor()` 會**產生一個隨機 token**，
  // 於是同步版與 PG 版拿到的 token 不同，`deepEqual` 會紅在一個與本批無關的欄位上。
  h.prepare(
    "INSERT INTO demand_posts(id, user_id, districts, rent_max, housing_type, mrt_walk, body, status, created_at, expires_at, public_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, userId, "[]", 0, "any", 0, "找房的內容", status, NOW, EXPIRES, `tok-${id}`);
}

function seedReply(h, { id, postId, userId }) {
  h.prepare(
    "INSERT INTO demand_replies(id, post_id, user_id, body, created_at, hidden) VALUES (?, ?, ?, ?, ?, 0)",
  ).run(id, postId, userId, "這是回覆", NOW);
}

// 磁碟與 PG 夾具都回到同一個起點，回傳 [disk, exec]。
function resetBoth(seedFn) {
  const disk = handle();
  clearDemand(disk);
  seedUsers(disk, [1, 2, 3, 4]);
  const exec = pgFixture();
  clearDemand(exec.raw);
  seedUsers(exec.raw, [1, 2, 3, 4]);
  if (seedFn) { seedFn(disk); seedFn(exec.raw); }
  return [disk, exec];
}

const postStatus = (h, id) => h.prepare("SELECT status FROM demand_posts WHERE id = ?").get(id)?.status;
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

  const a1 = await asyncMod.reportDemandAsync(2, { targetType: "post", targetId: 501, reason: "廣告" }, { ...PG, exec });
  assert.deepEqual(a1, s1, "第一筆的回傳值必須相同");
  assert.equal(postStatus(disk, 501), "open", "PG 分支的第一筆也不該隱藏");
  const a2 = await asyncMod.reportDemandAsync(3, { targetType: "post", targetId: 501, reason: "廣告" }, { ...PG, exec });
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
  const aFirst = await asyncMod.reportDemandAsync(2, { targetType: "post", targetId: 502, reason: "廣告" }, { ...PG, exec });
  assert.deepEqual(aFirst, syncFirst, "第一筆的回傳值必須相同");
  const aAgain = await asyncMod.reportDemandAsync(2, { targetType: "post", targetId: 502, reason: "廣告" }, { ...PG, exec });
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
  await asyncMod.reportDemandAsync(2, { targetType: "reply", targetId: 601, reason: "洗版" }, { ...PG, exec });
  assert.equal(replyHidden(disk, 601), 0, "第一筆還不該隱藏");
  const aSecond = await asyncMod.reportDemandAsync(3, { targetType: "reply", targetId: 601, reason: "洗版" }, { ...PG, exec });
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
    try { await asyncMod.reportDemandAsync(c.userId, c.input, { ...PG, exec }); } catch (e) { asyncErr = e; }
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
  const aFirst = await asyncMod.addDemandReplyAsync(2, 505, "我看到一間可以參考", { ...PG, exec });
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
  try { await asyncMod.addDemandReplyAsync(2, 505, "太快了吧", { ...PG, exec }); } catch (e) { asyncErr = e; }
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
    try { await asyncMod.addDemandReplyAsync(c.userId, c.postId, c.body, { ...PG, exec }); } catch (e) { asyncErr = e; }
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
  try { await asyncMod.closeDemandPostAsync(2, 508, {}, { ...PG, exec }); } catch (e) { asyncErr = e; }
  assert.ok(syncErr, "同步版：非本人不得關閉");
  assert.equal(asyncErr?.status, syncErr.status, "非本人的 status 必須相同");
  assert.equal(asyncErr?.message, syncErr.message, "非本人的訊息必須相同");
  assert.equal(postStatus(disk, 508), "open", "被擋下之後不得關閉");

  const aResult = await asyncMod.closeDemandPostAsync(1, 508, {}, { ...PG, exec });
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

test("夾具本身要真的拒絕 SQLite 專屬方言（否則上面的方言守衛是空的）", async () => {
  const exec = pgFixture();
  await assert.rejects(() => exec("SELECT IFNULL(body,'') FROM demand_posts"), /function ifnull/);
  await assert.rejects(() => exec("SELECT body FROM demand_posts LIMIT -1"), /LIMIT must not be negative/);
  await assert.doesNotReject(() => exec("SELECT COALESCE(body,'') AS b FROM demand_posts"), "COALESCE 必須放行");
});
