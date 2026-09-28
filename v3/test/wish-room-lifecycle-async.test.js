// 許願房生命週期寫入（更新／刊登／重開）與範例儲存（PUT /api/wish-rooms/example）的
// PG parity（2026-09-28）。
//
// 這一條路徑要釘住五件事：
//
//   1. **正規化只有一份**：`normalizeWishFields()` 是同步版與 PG 版共用的純核心，
//      所以「送進去的欄位 → 落地的欄位」必須逐欄相同（含 `condition_choices` 與聯絡人快照）。
//   2. **行程內快取要先跟上 PG**：`normalizeWishFields()` 讀的是 `demand.js` 的模組變數
//      （`marketplaceFlags`／`catalogCacheV2`），而同步版的 `*For` 包裝是用
//      `getWishConditions()` 灌的。PG 分支若跳過 `getWishConditionsAsync()`，
//      會拿**空目錄**去正規化——這一項單獨驗（比對快取內容 ＋ 檢查真的對 `settings` 查過），
//      因為「條件選項整批消失」只有在目錄非預設時才看得出來。
//   3. **兩個 store 都要寫**：PG 是真的來源；本機 handle 也要追上，讓還沒搬完的讀取
//      （`aggregateDemand` 那幾支仍吃 handle）看到一致的狀態。
//   4. **回傳值與同步版相同**：這三支的生命週期寫入回傳整則許願房（前置條件
//      `getDemandPostAsync()` 已經在島上），不是最小封包。
//      `updated_at` 是「寫入當下」，兩個 driver 不可能同毫秒，所以比對前遮罩。
//   5. **沒有交易**：PG 走連線池，`withImmediate()` 沒有對應物；「同時只能有一則 open」
//      靠鏡射過去的部分唯一索引擋。撞到時兩個 driver 必須丟**同一個** `wish_active_limit`。
//
// 夾具刻意**拒絕 SQLite 專屬語法**：`withFallback()` 在注入 `exec` 時不經過
// `toPostgresSql`，所以夾具若不擋，寫錯的方言會一路過關到正式站才炸。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-wish-lifecycle-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const syncMod = await import("../src/demand.js");
const asyncMod = await import("../src/demandAsync.js");
const exampleMod = await import("../src/wishExampleAsync.js");
const dbMod = await import("../src/db.js");

const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");
const handle = () => dbMod.sqliteHandle();

const OLD = "2026-01-01T00:00:00.000Z"; // 遠早於 24 小時門檻
const NOW = "2026-09-28T00:00:00.000Z";

// PG 不接受的方言（SQLite 專屬）。夾具主動拒絕，否則寫錯照樣綠燈。
const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown, unknown) does not exist"],
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  // `ON CONFLICT(user_id) DO UPDATE` 靠的是 SQLite 的表約束；PG 鏡射過來的表沒有那個約束
  // （見 wishExampleAsync.js 檔頭），所以夾具直接擋掉這一種寫法。
  [/ON\s+CONFLICT\s*\(\s*user_id\s*\)\s*DO\s+UPDATE/i, "there is no unique or exclusion constraint matching the ON CONFLICT specification"],
];

const TABLES = [
  "users", "demand_posts", "demand_replies", "demand_reports", "demand_match_districts",
  "user_listing_flags", "wish_room_example", "wish_offers", "listing_contact_profile", "settings",
];

// PG 替身：記憶體 SQLite ＋ 從磁碟鏡射 DDL。回 { rows, rowCount }（與 crmOutboxAsync 同形狀），
// 另外把跑過的 SQL 記在 `exec.seen` 裡（用來驗「真的有去 PG 讀 settings」）。
function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  for (const t of TABLES) {
    const rows = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").all(t);
    assert.equal(rows.length, 1, `必須抓到 ${t} 的 DDL（夾具不自己寫表格定義）`);
    mem.exec(rows[0].sql);
  }
  disk.close();
  const seen = [];
  const exec = async (sql, params = []) => {
    if (typeof sql !== "string" || !/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) {
      throw new Error(`夾具收到不是 SQL 的東西：${Object.prototype.toString.call(sql)}`);
    }
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    seen.push(sql.replace(/\s+/g, " ").trim());
    const stmt = mem.prepare(sql);
    const rows = stmt.all(...params);
    // ⚠️ 形狀要跟**正式路徑**一致：`pgDriver.query(...).then((res) => res.rows)` 是裸陣列，
    // 而 `settingsKvAsync.getSiteSettingAsync()`／`wishExampleAsync` 直接吃那個形狀
    // （`rows?.[0]`）。若夾具改回 `{ rows, rowCount }`，這兩支會**靜默地**拿到 undefined
    // ——症狀是「PG 上的設定讀不到、於是旗標全用預設值」，非常難查。
    // `rowCount` 掛在陣列上，讓兩種讀法都成立（`dataRevision`／`crmOutboxAsync` 的
    // `normalizeResult()` 也會讀它）。
    rows.rowCount = Number(mem.prepare("SELECT changes() AS n").get().n) || 0;
    return rows;
  };
  exec.raw = mem;
  exec.seen = seen;
  return exec;
}

function clearWorld(h) {
  h.prepare("DELETE FROM demand_reports").run();
  h.prepare("DELETE FROM demand_replies").run();
  h.prepare("DELETE FROM demand_posts").run();
  h.prepare("DELETE FROM wish_room_example").run();
  h.prepare("DELETE FROM wish_offers").run();
  h.prepare("DELETE FROM listing_contact_profile").run();
  h.prepare("DELETE FROM users WHERE email LIKE 'lifecycle%@example.com'").run();
  // user 1 是 db.js 開檔時建的 bootstrap 管理員，不屬於上面那批測試帳號（與 demand-async 同）。
  h.prepare("UPDATE users SET nickname = '' WHERE id = 1").run();
}

function seedUsers(h, ids) {
  for (const id of ids) {
    h.prepare(
      "INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?, ?, ?, 'member', 'free', ?)",
    ).run(id, `lifecycle${id}@example.com`, `會員${id}`, OLD);
  }
}

function seedPost(h, { id, userId, status = "open", lifecycle = null, closedReason = "", publishedAt = null, continuousFrom = null, updatedAt = NOW }) {
  h.prepare(
    `INSERT INTO demand_posts(id, user_id, districts, rent_max, housing_type, mrt_walk, body, status,
       created_at, updated_at, expires_at, published_at, public_token, legacy_numeric_share, lifecycle, closed_reason, continuous_active_from)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, '["1-5"]', 30000, "any", 0, "找房的內容", status,
    NOW, updatedAt, "2099-01-01T00:00:00.000Z", publishedAt, `tok-${id}`, 1, lifecycle, closedReason, continuousFrom);
}

// 磁碟與 PG 夾具都回到同一個起點。
function resetBoth(seedFn) {
  const disk = handle();
  clearWorld(disk);
  seedUsers(disk, [1, 2, 3, 4, 5]);
  const exec = pgFixture();
  clearWorld(exec.raw);
  seedUsers(exec.raw, [1, 2, 3, 4, 5]);
  if (seedFn) { seedFn(disk); seedFn(exec.raw); }
  // ⚠️ user 1 在磁碟上是 bootstrap 管理員（`INSERT OR IGNORE` 對它無效），但在 PG 夾具裡是
  // 全新的一列——兩邊的暱稱會不一樣，視圖就會紅在 `author`。明確寫死，讓起點相同。
  // `created_at` 也要：本機的 user 1 是**今天**建的 bootstrap 管理員，不覆蓋的話
  // `assertMatureAccount()` 會說「新帳號註冊滿 24 小時後才能刊登」——而 PG 夾具裡那一列是
  // 剛用 OLD 插進去的（兩邊對成熟度的判斷會不同）。
  for (const h of [disk, exec.raw]) {
    h.prepare("UPDATE users SET nickname = ?, created_at = ? WHERE id = 1").run("屋主甲", OLD);
  }
  return [disk, exec];
}

// 把本機的某個 settings 鍵原封不動抄進 PG 夾具（兩邊的**起點**必須相同，
// 否則 parity 會紅在「夾具不一致」而不是真的漂移）。
function mirrorSetting(disk, exec, key) {
  const row = disk.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  exec.raw.prepare("DELETE FROM settings WHERE key = ?").run(key);
  if (row) exec.raw.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run(key, row.value);
}

const postRow = (h, id) => h.prepare("SELECT * FROM demand_posts WHERE id = ?").get(id);
// `updated_at` 是「寫入當下」的時間戳，兩個 driver 不可能同毫秒——比對前遮罩。
const errorShape = async (fn) => {
  try { await fn(); return null; } catch (error) { return { status: error.status, message: error.message, code: error.code || "" }; }
};
const syncErrorShape = (fn) => {
  try { fn(); return null; } catch (error) { return { status: error.status, message: error.message, code: error.code || "" }; }
};

// ---------------------------------------------------------------------------

test("更新：正規化的欄位與落地狀態，PG 版必須與同步版相同（順便驗回傳整則許願房）", async () => {
  const input = {
    districts: ["1-5", "1-7"],
    rent_min: 20000,
    rent_max: 32000,
    body: "  需要電梯大樓，近捷運  ",
    phone: "0912-345-678",
    contact_name: "王小明",
    mrt_walk: true,
    location_note: "近象山",
  };
  const [disk, exec] = resetBoth((h) => seedPost(h, { id: 601, userId: 1 }));

  const syncView = syncMod.updateWishRoom(disk, 1, 601, input, new Date(NOW));
  const syncRow = postRow(disk, 601);

  // 磁碟回到同一起點，再跑 PG 分支。
  clearWorld(disk);
  seedUsers(disk, [1, 2, 3, 4, 5]);
  seedPost(disk, { id: 601, userId: 1 });

  const asyncView = await asyncMod.updateWishRoomAsync(1, 601, input, { ...PG, exec, strict: true, now: NOW });
  const pgRow = postRow(exec.raw, 601);
  const diskRow = postRow(disk, 601);

  assert.deepEqual(asyncView, syncView, "回傳的許願房必須相同");
  for (const key of ["districts", "rent_min", "rent_max", "body", "phone", "contact_name", "mrt_walk", "location_note", "city", "status"]) {
    assert.equal(pgRow[key], syncRow[key], `PG 上的 ${key} 必須與同步版相同`);
    assert.equal(diskRow[key], syncRow[key], `本機 handle 的 ${key} 必須與同步版相同（兩個 store 都要寫）`);
  }
  assert.equal(pgRow.body, "需要電梯大樓，近捷運", "頭尾空白必須被正規化掉（否則這條測試沒有鑑別力）");
  assert.equal(pgRow.phone, "0912345678", "電話必須正規化成純數字");
});

test("更新：所有權／不存在的錯誤形狀必須與同步版相同，而且 PG 不得被寫入", async () => {
  const [disk, exec] = resetBoth((h) => {
    seedPost(h, { id: 602, userId: 1 });
    // ⚠️ 已隱藏的那一則**必須是自己的**：否則所有權檢查會先擋下來，
    // 「已隱藏不能再改」那條分支永遠走不到（於是拿掉它也照樣全綠）。
    seedPost(h, { id: 604, userId: 1, status: "hidden" });
  });
  const cases = [
    { userId: 2, postId: 602, input: { body: "偷改別人的" }, why: "不是自己的" },
    { userId: 1, postId: 999, input: { body: "不存在" }, why: "找不到" },
    { userId: 1, postId: 604, input: { body: "已隱藏" }, why: "已隱藏不能再改" },
    { userId: 1, postId: 602, input: { districts: [], body: "只剩三個字" }, why: "open 的許願房改到不合格" },
    { userId: 0, postId: 602, input: { body: "未登入" }, why: "未登入" },
  ];
  for (const c of cases) {
    const before = JSON.stringify(postRow(exec.raw, c.postId) || null);
    const syncErr = syncErrorShape(() => syncMod.updateWishRoom(disk, c.userId, c.postId, c.input, new Date(NOW)));
    const asyncErr = await errorShape(() => asyncMod.updateWishRoomAsync(c.userId, c.postId, c.input, { ...PG, exec, strict: true, now: NOW }));
    assert.ok(syncErr, `同步版應該要丟錯（${c.why}）`);
    assert.deepEqual(asyncErr, syncErr, `錯誤形狀必須相同（${c.why}）`);
    assert.equal(JSON.stringify(postRow(exec.raw, c.postId) || null), before, `PG 不得被寫入（${c.why}）`);
  }
});

test("刊登：draft → open，兩個 store 的狀態、lifecycle 與期限都必須相同", async () => {
  const [disk, exec] = resetBoth((h) => seedPost(h, { id: 611, userId: 1, status: "draft" }));

  const syncView = syncMod.publishWishRoom(disk, 1, 611, { districts: ["1-5"], body: "想找大安區的房子" }, new Date(NOW));
  const syncRow = postRow(disk, 611);
  assert.equal(syncRow.status, "open", "同步版：草稿要變 open");
  assert.equal(syncRow.lifecycle, "active", "同步版：lifecycle 要變 active");

  clearWorld(disk);
  seedUsers(disk, [1, 2, 3, 4, 5]);
  seedPost(disk, { id: 611, userId: 1, status: "draft" });

  const asyncView = await asyncMod.publishWishRoomAsync(1, 611, { districts: ["1-5"], body: "想找大安區的房子" }, { ...PG, exec, strict: true, now: NOW });
  const pgRow = postRow(exec.raw, 611);
  const diskRow = postRow(disk, 611);

  assert.deepEqual(asyncView, syncView, "回傳的許願房必須相同");
  for (const key of ["status", "lifecycle", "closed_reason", "expires_at", "body", "districts"]) {
    assert.equal(pgRow[key], syncRow[key], `PG 上的 ${key} 必須與同步版相同`);
    assert.equal(diskRow[key], syncRow[key], `本機 handle 的 ${key} 必須與同步版相同`);
  }
  assert.equal(pgRow.status, "open", "PG 上必須真的變成 open（不是只寫本機）");
  assert.ok(pgRow.published_at, "刊登要蓋 published_at");
});

test("刊登：已 open 的冪等回傳、以及非草稿狀態的錯誤，兩個 driver 必須一致", async () => {
  const [disk, exec] = resetBoth((h) => {
    // ⚠️ `updated_at` 刻意用舊值：刊登是冪等的（已 open 就原樣回傳），若 PG 版漏了那個
    // 早退分支而重新刊登一次，`updated_at` 會被蓋成 NOW——這條測試才抓得到。
    seedPost(h, { id: 612, userId: 1, status: "open", publishedAt: NOW, updatedAt: OLD });
    seedPost(h, { id: 613, userId: 1, status: "closed", lifecycle: "paused" });
    seedPost(h, { id: 614, userId: 1, status: "hidden", lifecycle: "blocked" });
  });
  // 已 open → 冪等
  const syncOpen = syncMod.publishWishRoom(disk, 1, 612, {}, new Date(NOW));
  const asyncOpen = await asyncMod.publishWishRoomAsync(1, 612, {}, { ...PG, exec, strict: true, now: NOW });
  assert.deepEqual(asyncOpen, syncOpen, "已 open 的冪等回傳必須相同");
  assert.equal(postRow(exec.raw, 612).status, "open");

  // 已暫停／已封鎖 → 各自的錯誤
  for (const [postId, why] of [[613, "已暫停"], [614, "已封鎖"]]) {
    const syncErr = syncErrorShape(() => syncMod.publishWishRoom(disk, 1, postId, {}, new Date(NOW)));
    const asyncErr = await errorShape(() => asyncMod.publishWishRoomAsync(1, postId, {}, { ...PG, exec, strict: true, now: NOW }));
    assert.ok(syncErr, `同步版應該要丟錯（${why}）`);
    assert.deepEqual(asyncErr, syncErr, `錯誤形狀必須相同（${why}）`);
  }
});

test("刊登：PG 的競態（部分唯一索引 23505）要轉成 wish_active_limit，其他錯誤不得被吞掉", async () => {
  const [disk, exec] = resetBoth((h) => seedPost(h, { id: 622, userId: 1, status: "draft" }));
  const before = JSON.stringify(postRow(exec.raw, 622));
  const patch = { districts: ["1-5"], body: "同時刊登的第二則" }; // body 至少要 4 個字（assertPublishable）

  // 為什麼要「注入一個會丟 23505 的 runner」而不是塞第二則 mutable：`idx_demand_one_mutable`
  // 是 UNIQUE(user_id) WHERE status IN ('open','draft')，所以「同一人有兩則 mutable」這個狀態
  // **在資料庫裡根本不存在**——`countMutable()` 的早退檢查只是防禦性的，真正會撞到的是
  // 兩個請求同時刊登同一則草稿的競態。PG 上那個競態丟的是 23505，錯誤形狀必須與同步版相同。
  const racingExec = async (sql, params = []) => {
    if (/^UPDATE demand_posts SET\s+districts/i.test(String(sql).replace(/\s+/g, " "))) {
      const error = new Error('duplicate key value violates unique constraint "idx_demand_one_open"');
      error.code = "23505";
      throw error;
    }
    return exec(sql, params);
  };
  const raceErr = await errorShape(() => asyncMod.publishWishRoomAsync(1, 622, patch, { ...PG, exec: racingExec, strict: true, now: NOW }));
  assert.equal(raceErr?.code, "wish_active_limit", "23505 必須轉成與同步版相同的 wish_active_limit");
  assert.equal(raceErr?.status, 409);
  assert.equal(JSON.stringify(postRow(exec.raw, 622)), before, "被擋下來時 PG 不得留下半套寫入");
  assert.equal(postRow(disk, 622).status, "draft", "被擋下來時本機 handle 也不得被寫入");

  // 反向：不是「一人一則」的錯（例如連線中斷）**不能**被當成 active limit 吞掉。
  const brokenExec = async (sql, params = []) => {
    if (/^UPDATE demand_posts SET\s+districts/i.test(String(sql).replace(/\s+/g, " "))) {
      const error = new Error("connection terminated unexpectedly");
      error.code = "08006";
      throw error;
    }
    return exec(sql, params);
  };
  const otherErr = await errorShape(() => asyncMod.publishWishRoomAsync(1, 622, patch, { ...PG, exec: brokenExec, strict: true, now: NOW }));
  assert.equal(otherErr?.code, "08006", "非 23505 的錯誤必須原樣往外丟（不得被轉成 wish_active_limit）");
  assert.match(otherErr?.message || "", /connection terminated/, "原始錯誤訊息必須保留");
});

test("重開：closed → open；draft／hidden／completed 的錯誤與同步版相同", async () => {
  const [disk, exec] = resetBoth((h) => {
    seedPost(h, { id: 631, userId: 1, status: "closed", lifecycle: "paused", closedReason: "paused", publishedAt: NOW, continuousFrom: NOW });
    // ⚠️ 用別的帳號：同一人若有 draft，`countMutable()` 會先擋下「重開成功」那一條
    // （closed ＋ draft ＝ 一則 mutable），於是測不到重開本身。
    seedPost(h, { id: 632, userId: 2, status: "draft" });
    seedPost(h, { id: 633, userId: 3, status: "hidden", lifecycle: "blocked" });
    // lifecycle=blocked 但 status 是 closed：`hidden` 那條檢查攔不到，走的是 mapLegacyLifecycle。
    seedPost(h, { id: 634, userId: 4, status: "closed", lifecycle: "blocked" });
    // 已封存的舊草稿（closed_reason = legacy_collapsed）：`assertNotCollapsed()` 要擋。
    seedPost(h, { id: 635, userId: 5, status: "closed", closedReason: "legacy_collapsed" });
  });

  const syncView = syncMod.reopenWishRoom(disk, 1, 631, new Date(NOW));
  const syncRow = postRow(disk, 631);

  clearWorld(disk);
  seedUsers(disk, [1, 2, 3, 4, 5]);
  seedPost(disk, { id: 631, userId: 1, status: "closed", lifecycle: "paused", closedReason: "paused", publishedAt: NOW, continuousFrom: NOW });
  seedPost(disk, { id: 632, userId: 2, status: "draft" });
  seedPost(disk, { id: 633, userId: 3, status: "hidden", lifecycle: "blocked" });
  seedPost(disk, { id: 634, userId: 4, status: "closed", lifecycle: "blocked" });
  seedPost(disk, { id: 635, userId: 5, status: "closed", closedReason: "legacy_collapsed" });

  const asyncView = await asyncMod.reopenWishRoomAsync(1, 631, { ...PG, exec, strict: true, now: NOW });
  const pgRow = postRow(exec.raw, 631);
  assert.deepEqual(asyncView, syncView, "回傳的許願房必須相同");
  for (const key of ["status", "lifecycle", "closed_reason", "closed_at", "expires_at", "continuous_active_from"]) {
    assert.equal(pgRow[key], syncRow[key], `PG 上的 ${key} 必須與同步版相同`);
    assert.equal(postRow(disk, 631)[key], syncRow[key], `本機 handle 的 ${key} 必須與同步版相同`);
  }
  assert.equal(pgRow.status, "open", "PG 上必須真的重開");

  for (const [postId, owner, why] of [
    [632, 2, "草稿請改用刊登"],
    [633, 3, "status=hidden 不能重開"],
    [634, 4, "lifecycle=blocked 不能重開"],
    [635, 5, "已封存的舊草稿不能重開"],
  ]) {
    const syncErr = syncErrorShape(() => syncMod.reopenWishRoom(disk, owner, postId, new Date(NOW)));
    const asyncErr = await errorShape(() => asyncMod.reopenWishRoomAsync(owner, postId, { ...PG, exec, strict: true, now: NOW }));
    assert.ok(syncErr, `同步版應該要丟錯（${why}）`);
    assert.deepEqual(asyncErr, syncErr, `錯誤形狀必須相同（${why}）`);
  }
});

test("重開：生命週期開啟時「已找到房」不能重開（旗標讀的是 PG 的 settings）", async () => {
  const [disk, exec] = resetBoth((h) => seedPost(h, { id: 641, userId: 1, status: "closed", lifecycle: "completed" }));
  // 同步版讀本機 settings，PG 分支讀 PG 的——兩邊都打開，起點才一致。
  dbMod.saveRentalMarketplaceFlags({ wish: { lifecycle_enabled: true } });
  mirrorSetting(disk, exec, "rentalMarketplaceFlags");

  const syncErr = syncErrorShape(() => syncMod.reopenWishRoom(disk, 1, 641, new Date(NOW)));
  assert.equal(syncErr?.code, "wish_completed", "同步版：已找到房要擋（否則這條測試沒有鑑別力）");

  const asyncErr = await errorShape(() => asyncMod.reopenWishRoomAsync(1, 641, { ...PG, exec, strict: true, now: NOW }));
  assert.deepEqual(asyncErr, syncErr, "PG 版必須丟同一個錯誤");
  assert.equal(postRow(exec.raw, 641).status, "closed", "擋下來的時候 PG 不得被寫入");
  // 收尾：把旗標關回去，免得後面的測試繼承。
  dbMod.saveRentalMarketplaceFlags({ wish: { lifecycle_enabled: false } });
  mirrorSetting(disk, exec, "rentalMarketplaceFlags");
});

test("正規化前的行程內快取必須先用 PG 的資料灌好（否則會拿空目錄正規化）", async () => {
  const [disk, exec] = resetBoth((h) => seedPost(h, { id: 651, userId: 1 }));
  // 先把行程內快取清成「空」，模擬一條剛啟動、還沒讀過 settings 的節點。
  syncMod.setRentalCatalogCache(null);
  syncMod.setRentalMarketplaceFlags({});
  assert.equal(syncMod.currentRentalCatalogCache(), null, "起點：快取必須是空的");

  await asyncMod.updateWishRoomAsync(1, 651, { districts: ["1-5"], body: "快取測試" }, { ...PG, exec, strict: true, now: NOW });

  // 兩件事都要成立：(1) 真的對 PG 查過 settings；(2) 快取被灌成非空。
  assert.ok(
    exec.seen.some((sql) => /FROM settings\b/i.test(sql)),
    "PG 分支必須對 settings 發出查詢（getWishConditionsAsync）——拿掉它就會用空目錄正規化",
  );
  assert.notEqual(syncMod.currentRentalCatalogCache(), null, "目錄快取必須被灌好");
  assert.equal(syncMod.currentRentalMarketplaceFlags()?.wish?.lifecycle_enabled, false, "旗標快取必須與 PG 的 settings 一致");
});

test("範例：第一次寫入是 INSERT、第二次是 UPDATE，兩個 store 的 payload 都相同", async () => {
  const [disk, exec] = resetBoth();
  const first = { districts: ["1-5"], rent_max: 25000, body: "第一次的範例", contact_name: "小明" };
  const second = { districts: ["1-7"], rent_max: 31000, body: "第二次的範例", contact_name: "小明" };

  const syncFirst = syncMod.saveWishExample(disk, 1, first, new Date(NOW));
  const syncSecond = syncMod.saveWishExample(disk, 1, second, new Date(NOW));
  const syncRow = disk.prepare("SELECT * FROM wish_room_example WHERE user_id = 1").get();

  clearWorld(disk);
  seedUsers(disk, [1, 2, 3, 4, 5]);

  const asyncFirst = await exampleMod.saveWishExampleAsync(1, first, { ...PG, exec, strict: true, now: NOW });
  const afterFirst = exec.raw.prepare("SELECT * FROM wish_room_example WHERE user_id = 1").get();
  const asyncSecond = await exampleMod.saveWishExampleAsync(1, second, { ...PG, exec, strict: true, now: NOW });
  const pgRow = exec.raw.prepare("SELECT * FROM wish_room_example WHERE user_id = 1").get();
  const diskRow = disk.prepare("SELECT * FROM wish_room_example WHERE user_id = 1").get();

  assert.deepEqual(asyncFirst, syncFirst, "第一次的回傳值必須相同");
  assert.deepEqual(asyncSecond, syncSecond, "第二次的回傳值必須相同");
  assert.equal(afterFirst.created_at, syncRow.created_at, "INSERT 的 created_at 必須與同步版相同");
  assert.equal(pgRow.created_at, syncRow.created_at, "UPDATE 不得改寫 created_at");
  assert.equal(pgRow.payload, syncRow.payload, "PG 上的 payload 必須與同步版逐字相同");
  assert.equal(diskRow.payload, syncRow.payload, "本機 handle 的 payload 必須追上（兩個 store 都要寫）");
  assert.ok(pgRow.payload.includes("第二次的範例"), "第二次必須覆蓋第一次");
  assert.ok(pgRow.updated_at >= pgRow.created_at, "updated_at 不得早於 created_at");
});

test("範例：未登入與別人的聯絡人，錯誤形狀必須與同步版相同且不得寫入", async () => {
  const [disk, exec] = resetBoth((h) => {
    h.prepare("INSERT INTO listing_contact_profile(id, user_id, label, contact_name, phone, line_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(701, 2, "預設", "別人的聯絡人", "0911111111", "", NOW, NOW);
  });
  const cases = [
    { userId: 0, input: { body: "未登入" }, why: "未登入" },
    { userId: 1, input: { contact_profile_id: 701 }, why: "用別人的聯絡人" },
    { userId: 1, input: { contact_profile_id: 799 }, why: "聯絡人不存在" },
    { userId: 1, input: { phone: "123" }, why: "電話太短" },
  ];
  for (const c of cases) {
    const syncErr = syncErrorShape(() => syncMod.saveWishExample(disk, c.userId, c.input, new Date(NOW)));
    const asyncErr = await errorShape(() => exampleMod.saveWishExampleAsync(c.userId, c.input, { ...PG, exec, strict: true, now: NOW }));
    assert.ok(syncErr, `同步版應該要丟錯（${c.why}）`);
    assert.deepEqual(asyncErr, syncErr, `錯誤形狀必須相同（${c.why}）`);
    assert.equal(
      exec.raw.prepare("SELECT COUNT(*) AS n FROM wish_room_example").get().n, 0,
      `PG 不得被寫入（${c.why}）`,
    );
  }
  // 自己的聯絡人可以過，而且快照的是「那一列」的值（user 2 用自己的）。
  const ok = await exampleMod.saveWishExampleAsync(2, { contact_profile_id: 701 }, { ...PG, exec, strict: true, now: NOW });
  assert.equal(ok.contact_name, "別人的聯絡人");
});

test("範例：注入式 exec 的兩種形狀（裸陣列／{ rows, rowCount }）都要讀得到", async () => {
  // 這一條釘住的是**形狀**：`pgExec()` 走正式路徑時回裸陣列，而 `crmOutboxAsync` 起的
  // 注入慣例是 `{ rows, rowCount }`。模組若只認其中一種，餵另一種時會**靜默地**回 null
  // ——症狀是「範例明明存進去了，GET 卻說沒有」，而且不會有任何錯誤。
  const [disk, exec] = resetBoth();
  await exampleMod.saveWishExampleAsync(1, { districts: ["1-5"], body: "形狀測試用" }, { ...PG, exec, strict: true, now: NOW });
  const stored = exec.raw.prepare("SELECT * FROM wish_room_example WHERE user_id = 1").get();

  const asArray = await exampleMod.getWishExampleAsync(1, { ...PG, exec, strict: true });
  const wrapped = async (sql, params = []) => {
    const rows = await exec(sql, params);
    return { rows, rowCount: rows.rowCount ?? rows.length };
  };
  const asObject = await exampleMod.getWishExampleAsync(1, { ...PG, exec: wrapped, strict: true });

  assert.ok(asArray && asObject, "兩種形狀都必須讀到範例（讀不到會是靜默的 null）");
  assert.deepEqual(asObject, asArray, "兩種形狀的回傳值必須相同");
  assert.equal(asArray.updated_at, stored.updated_at, "回傳的 updated_at 必須是落地的那一列");
  assert.equal(disk.prepare("SELECT COUNT(*) AS n FROM wish_room_example").get().n, 1, "本機 handle 也要有一列");
});

test("範例：本機沒有這個帳號時仍要成功（PG 已寫入，不得被本機 FK 變成 500）", async () => {
  // 這一條是 CI 的 PG job 抓到的：本機 `wish_room_example` 有
  // `FOREIGN KEY(user_id) REFERENCES users(id)`，但 PG 模式的帳號可能是在**別的節點**
  // 建立的。第一版無條件寫本機 → 一個已經在 PG 寫成功的請求變成
  // `FOREIGN KEY constraint failed` 的 500。
  const [disk, exec] = resetBoth();
  const stranger = 4242; // 只存在於 PG 夾具，本機 users 沒有這一列
  exec.raw.prepare(
    "INSERT INTO users(id, email, nickname, role, plan, created_at) VALUES (?, ?, ?, 'member', 'free', ?)",
  ).run(stranger, `lifecycle${stranger}@example.com`, "別節點的會員", OLD);
  assert.equal(
    disk.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?").get(stranger).n, 0,
    "起點：本機必須沒有這個帳號（否則這條測試沒有鑑別力）",
  );

  const saved = await exampleMod.saveWishExampleAsync(stranger, { districts: ["1-5"], body: "別節點的範例" }, { ...PG, exec, strict: true, now: NOW });
  assert.equal(saved.body, "別節點的範例", "PG 寫入必須成功");
  assert.equal(
    exec.raw.prepare("SELECT COUNT(*) AS n FROM wish_room_example WHERE user_id = ?").get(stranger).n, 1,
    "PG 上必須有一列",
  );
  assert.equal(
    disk.prepare("SELECT COUNT(*) AS n FROM wish_room_example WHERE user_id = ?").get(stranger).n, 0,
    "本機沒有這個帳號時不必（也不能）寫本機那一份",
  );
});
