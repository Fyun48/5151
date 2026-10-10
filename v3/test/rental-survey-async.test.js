// 許願房完成問卷（completion survey）PG 分支的 parity（2026-09-28，第四十一批）。
//
// 這一條路徑要釘住四件事：
//
//   1. **PG 上沒有 `wish_id`／`public_token` 的唯一鍵**（SQLite 那兩條是**表約束**，
//      `ensurePgSchema()` 只從 `PRAGMA table_info` 重建欄位，抓不到隱式索引）。
//      少了它們，「一人一則」與「token 不重複」在 PG 上會整個失效而且**不會有任何錯誤**，
//      所以 `SURVEY_UNIQUE_INDEXES` 是**功能**、不是設定；這裡要單獨驗它有沒有被列進去。
//   2. **重複送出**：同步版靠 UNIQUE 例外吞掉，PG 版除了先查再寫，還要認得 23505。
//      兩邊的回應都必須是 `{submitted:true, already:true}`。
//   3. **計數要兩個 store 都記**：PG 是真的來源，而本機 handle 上還有**同步**的讀者
//      （`/api/admin/rental-ops` 還沒搬）。少了本機那一次，admin 的數字會少一筆；
//      多記一次則會多一筆——所以要「各一次」。
//   4. **`COUNT(*)` 的型別**：PG 的 bigint 回來是字串、SQLite 是數字，同步版把列原樣往外送
//      （admin 的 `survey_breakdown` 直接用），所以 PG 版必須正規化。
//
// 夾具刻意**拒絕 SQLite 專屬語法**（`withFallback()` 在注入 `exec` 時不經過 `toPostgresSql`）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-survey-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const syncMod = await import("../src/rentalSurvey.js");
const asyncMod = await import("../src/rentalSurveyAsync.js");
const dbMod = await import("../src/db.js");

const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");
const handle = () => dbMod.sqliteHandle();

const OLD = "2026-01-01T00:00:00.000Z";
const NOW = "2026-09-28T00:00:00.000Z";
const EXPIRES = "2099-01-01T00:00:00.000Z";

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown, unknown) does not exist"],
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  [/julianday\s*\(/i, "function julianday(text) does not exist"],
];

const TABLES = [
  "users", "demand_posts", "demand_replies", "demand_match_districts",
  "user_listing_flags", "wish_room_example", "settings",
  "rental_completion_surveys", "rental_analytics_daily",
];

// PG 替身：記憶體 SQLite ＋ 從磁碟鏡射 DDL。回**裸陣列**（正式路徑 `pgDriver.query()`
// 的形狀），`rowCount` 掛在陣列上；`asPgTypes` 可以模擬「PG 的 COUNT 是字串」。
function pgFixture({ asPgTypes = false } = {}) {
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
    let rows = stmt.all(...params);
    if (asPgTypes && /\bCOUNT\s*\(\s*\*\s*\)\s+AS\s+n\b/i.test(sql)) rows = rows.map((row) => ({ ...row, n: String(row.n) }));
    rows.rowCount = Number(mem.prepare("SELECT changes() AS n").get().n) || 0;
    return rows;
  };
  exec.raw = mem;
  return exec;
}

function clearWorld(h) {
  h.prepare("DELETE FROM rental_completion_surveys").run();
  h.prepare("DELETE FROM rental_analytics_daily").run();
  h.prepare("DELETE FROM demand_replies").run();
  h.prepare("DELETE FROM demand_posts").run();
  h.prepare("DELETE FROM users WHERE email LIKE 'survey%@example.com'").run();
}

function seedUsers(h, ids) {
  for (const id of ids) {
    h.prepare(
      "INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?, ?, ?, 'member', 'free', ?)",
    ).run(id, `survey${id}@example.com`, `會員${id}`, OLD);
    h.prepare("UPDATE users SET nickname = ?, created_at = ? WHERE id = ?").run(`會員${id}`, OLD, id);
  }
}

function seedWish(h, { id, userId, lifecycle = "completed", status = "closed" }) {
  h.prepare(
    `INSERT INTO demand_posts(id, user_id, districts, rent_max, housing_type, mrt_walk, body, status,
       created_at, updated_at, expires_at, published_at, public_token, legacy_numeric_share, lifecycle, closed_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, '["1-5"]', 30000, "any", 0, "找房的內容", status, NOW, NOW, EXPIRES, NOW, `tok-${id}`, 1, lifecycle, "");
}

function seedSurvey(h, { id, wishId, userId, found = "yes", createdAt = NOW }) {
  h.prepare(
    `INSERT INTO rental_completion_surveys(id, public_token, wish_id, user_id, found_via_site, via_feature, helpful, detail, created_at)
     VALUES (?, ?, ?, ?, ?, '', NULL, '', ?)`,
  ).run(id, `survey-token-${id}`, wishId, userId, found, createdAt);
}

function resetBoth(seedFn) {
  const disk = handle();
  clearWorld(disk);
  seedUsers(disk, [1, 2, 3]);
  const exec = pgFixture();
  clearWorld(exec.raw);
  seedUsers(exec.raw, [1, 2, 3]);
  if (seedFn) { seedFn(disk); seedFn(exec.raw); }
  return [disk, exec];
}

const analyticsRows = (h) => h.prepare("SELECT day, metric, value FROM rental_analytics_daily ORDER BY metric").all();
// `survey_ref` 是 `randomBytes(16)` 產生的（同步版也是）——兩個 driver 不可能同一個值，
// 所以比對前遮罩；另外單獨確認「有值」而且與落地那一列相同。
const maskRef = (view) => (view && typeof view === "object" ? { ...view, survey_ref: view.survey_ref ? "«ref»" : view.survey_ref } : view);
// node:sqlite 回的是 null-prototype 物件、PG 回的是普通物件；JSON 出去一模一樣，
// 但 deepStrictEqual 會比 prototype，所以比對前先正規化。
const plain = (rows) => JSON.parse(JSON.stringify(rows));
const surveyCount = (h) => h.prepare("SELECT COUNT(*) AS n FROM rental_completion_surveys").get().n;
const errorShape = async (fn) => {
  try { await fn(); return null; } catch (error) { return { status: error.status, message: error.message, code: error.code || "" }; }
};
const syncErrorShape = (fn) => {
  try { fn(); return null; } catch (error) { return { status: error.status, message: error.message, code: error.code || "" }; }
};

// ---------------------------------------------------------------------------

test("索引清單：PG 少了這兩條 unique index 就等於沒有去重（表約束不會被鏡射）", () => {
  const sql = asyncMod.SURVEY_UNIQUE_INDEXES.join("\n");
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS \S+ ON rental_completion_surveys\(wish_id\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS \S+ ON rental_completion_surveys\(public_token\)/);
  assert.deepEqual(asyncMod.SURVEY_TABLES, ["rental_completion_surveys"]);
});

test("讀取：沒有問卷回 submitted:false、有問卷逐鍵相同、別人的問卷看不到", async () => {
  // ⚠️ `wish_id` 是**全域**唯一（SQLite 的 `wish_id INTEGER NOT NULL UNIQUE`），
  // 不是 `(wish_id, user_id)`——所以「同一則許願房有兩個人的問卷」這種狀態不存在。
  const [disk, exec] = resetBoth((h) => {
    seedWish(h, { id: 801, userId: 1 });
    seedWish(h, { id: 802, userId: 1 });
    seedWish(h, { id: 803, userId: 2 });
    seedSurvey(h, { id: 901, wishId: 801, userId: 1, found: "yes" });
    seedSurvey(h, { id: 902, wishId: 803, userId: 2, found: "no" });
  });

  for (const [wishId, userId, why] of [[801, 1, "自己的問卷"], [802, 1, "還沒填"]]) {
    const syncView = syncMod.publicSurvey(syncMod.getCompletionSurvey(disk, userId, wishId));
    const asyncView = await asyncMod.getCompletionSurveyAsync(userId, wishId, { ...PG, exec, strict: true });
    assert.deepEqual(asyncView, syncView, `讀取必須逐鍵相同（${why}）`);
  }
  // 同步版的路由包裝（`getCompletionSurveyFor`）才是正式的比對對象：它會先解析許願房。
  const syncRoute = dbMod.getCompletionSurveyFor(1, 801);
  const asyncRoute = await asyncMod.getCompletionSurveyAsync(1, 801, { ...PG, exec, strict: true });
  assert.deepEqual(asyncRoute, syncRoute, "與 db.js 的包裝逐鍵相同");

  // 別人的許願房／不存在的許願房：兩邊都要同一個 404（可見性由 `getDemandPostAsync` 決定）
  for (const [wishId, why] of [[803, "別人的許願房"], [999, "不存在"]]) {
    const syncErr = syncErrorShape(() => dbMod.getCompletionSurveyFor(1, wishId));
    const asyncErr = await errorShape(() => asyncMod.getCompletionSurveyAsync(1, wishId, { ...PG, exec, strict: true }));
    assert.ok(syncErr, `同步版應該要丟 404（${why}）`);
    assert.deepEqual(asyncErr, syncErr, `錯誤形狀必須相同（${why}）`);
  }
});

test("送出：只寫 PG（本機那一列不得被動到），計數只記一次", async () => {
  const [disk, exec] = resetBoth((h) => seedWish(h, { id: 811, userId: 1 }));
  const input = { found_via_site: "yes", via_feature: "search", helpful: 4, detail: "  很好用  " };

  const syncView = dbMod.submitCompletionSurveyFor(1, 811, input, new Date(NOW));
  const syncRow = disk.prepare("SELECT found_via_site, via_feature, helpful, detail, created_at FROM rental_completion_surveys WHERE wish_id = 811").get();
  const syncAnalytics = analyticsRows(disk);

  clearWorld(disk);
  seedUsers(disk, [1, 2, 3]);
  seedWish(disk, { id: 811, userId: 1 });

  const asyncView = await asyncMod.submitCompletionSurveyAsync(1, 811, input, { ...PG, exec, strict: true, now: NOW });
  const pgRow = exec.raw.prepare("SELECT found_via_site, via_feature, helpful, detail, created_at FROM rental_completion_surveys WHERE wish_id = 811").get();
  const diskRow = disk.prepare("SELECT found_via_site, via_feature, helpful, detail, created_at FROM rental_completion_surveys WHERE wish_id = 811").get();

  assert.deepEqual(maskRef(asyncView), maskRef(syncView), "回傳值必須相同（survey_ref 是隨機值）");
  assert.ok(asyncView.survey_ref, "survey_ref 必須有值");
  assert.equal(
    exec.raw.prepare("SELECT public_token FROM rental_completion_surveys WHERE wish_id = 811").get().public_token,
    asyncView.survey_ref,
    "回傳的 survey_ref 必須就是落地那一列的 token",
  );
  assert.deepEqual(pgRow, syncRow, "PG 上的那一列必須與同步版相同");
  // 🚫 P5a（2026-10-10）：本機鏡射已刪 ⇒ 本機**不得**有這一列（原本的斷言是「本機 handle 也要追上」，
  // 正式站開閘時那幾句必拋 `business SQLite is closed` ⇒ 會員送出問卷收到 400）。
  assert.equal(diskRow, undefined, "本機那一列不得被 async 版寫入（PG 是唯一來源）");
  assert.equal(pgRow.detail, "很好用", "detail 必須被淨化（頭尾空白去掉）");
  assert.deepEqual(analyticsRows(exec.raw), syncAnalytics, "PG 的計數必須與同步版相同");
  assert.equal(analyticsRows(disk).length, 0, "本機不得再計數（原本斷言各記一次）");
  assert.equal(analyticsRows(exec.raw).length, 1, "PG 只記一次、不是兩次");
  assert.equal(analyticsRows(exec.raw)[0].metric, "survey_submitted");
});

test("送出：跳過要記成 survey_skipped，不合法的值一律降級", async () => {
  const [disk, exec] = resetBoth((h) => seedWish(h, { id: 812, userId: 1 }));
  const input = { found_via_site: "亂寫", via_feature: "亂寫", helpful: 99, detail: "" };

  dbMod.submitCompletionSurveyFor(1, 812, input, new Date(NOW));
  const syncRow = disk.prepare("SELECT found_via_site, via_feature, helpful FROM rental_completion_surveys WHERE wish_id = 812").get();
  const syncAnalytics = analyticsRows(disk);

  clearWorld(disk);
  seedUsers(disk, [1, 2, 3]);
  seedWish(disk, { id: 812, userId: 1 });
  const asyncView = await asyncMod.submitCompletionSurveyAsync(1, 812, input, { ...PG, exec, strict: true, now: NOW });
  const pgRow = exec.raw.prepare("SELECT found_via_site, via_feature, helpful FROM rental_completion_surveys WHERE wish_id = 812").get();

  assert.equal(syncRow.found_via_site, "skipped", "不合法的值要降級成 skipped");
  assert.deepEqual(pgRow, syncRow, "PG 上的降級結果必須相同");
  assert.equal(asyncView.found_via_site, "skipped");
  assert.equal(syncAnalytics[0].metric, "survey_skipped", "跳過要記在 survey_skipped");
  assert.deepEqual(analyticsRows(exec.raw), syncAnalytics, "PG 的計數鍵必須相同");
  // 🚫 P5a：本機不得再計數（原本斷言「本機的計數鍵必須相同」）。
  assert.equal(analyticsRows(disk).length, 0, "本機不得被計數");
});

test("送出：重複送出回 already:true，而且不得再寫一列、不得再計數", async () => {
  const [disk, exec] = resetBoth((h) => seedWish(h, { id: 813, userId: 1 }));
  dbMod.submitCompletionSurveyFor(1, 813, { found_via_site: "yes" }, new Date(NOW));
  const syncAgain = dbMod.submitCompletionSurveyFor(1, 813, { found_via_site: "no" }, new Date(NOW));
  assert.equal(syncAgain.already, true, "同步版：第二次必須回 already");

  clearWorld(disk);
  seedUsers(disk, [1, 2, 3]);
  seedWish(disk, { id: 813, userId: 1 });
  await asyncMod.submitCompletionSurveyAsync(1, 813, { found_via_site: "yes" }, { ...PG, exec, strict: true, now: NOW });
  const before = surveyCount(exec.raw);
  const asyncAgain = await asyncMod.submitCompletionSurveyAsync(1, 813, { found_via_site: "no" }, { ...PG, exec, strict: true, now: NOW });
  assert.deepEqual(maskRef(asyncAgain), maskRef(syncAgain), "第二次的回應必須相同（survey_ref 是原本那一筆的）");
  assert.equal(asyncAgain.found_via_site, "yes", "already 時要回**原本**那一筆，不是新的");
  assert.equal(surveyCount(exec.raw), before, "不得再寫一列");
  assert.equal(surveyCount(exec.raw), 1);
  assert.equal(analyticsRows(exec.raw).length, 1, "already 不得再計數");
  // 🚫 P5a：本機那一列／計數都不得被動到（原本斷言本機也不得再計數，前提是它本來會被寫）。
  assert.equal(analyticsRows(disk).length, 0, "本機不得被計數（PG 是唯一來源）");
  assert.equal(surveyCount(disk), 0, "本機不得有那一列");
});

test("送出：競態（23505）要當成 already，其他錯誤不得被吞掉", async () => {
  const [disk, exec] = resetBoth((h) => {
    seedWish(h, { id: 814, userId: 1 });
    seedWish(h, { id: 818, userId: 1 }); // 給「非唯一鍵錯誤」那一段用（那一段必須真的走到 INSERT）
  });
  // 模擬「另一條請求搶先寫入」：INSERT 丟 23505，但查詢看得到那一列（PG 的 unique index）。
  const racingExec = async (sql, params = []) => {
    if (/^INSERT INTO rental_completion_surveys/i.test(sql)) {
      exec.raw.prepare(
        `INSERT INTO rental_completion_surveys(id, public_token, wish_id, user_id, found_via_site, via_feature, helpful, detail, created_at)
         VALUES (903, 'race-token', 814, 1, 'no', '', NULL, '', ?)`,
      ).run(NOW);
      const error = new Error('duplicate key value violates unique constraint "rental_survey_wish_unique"');
      error.code = "23505";
      throw error;
    }
    return exec(sql, params);
  };
  const raced = await asyncMod.submitCompletionSurveyAsync(1, 814, { found_via_site: "yes" }, { ...PG, exec: racingExec, strict: true, now: NOW });
  assert.equal(raced.already, true, "撞到唯一鍵要回 already");
  assert.equal(raced.found_via_site, "no", "要回搶先寫入的那一筆");
  assert.equal(analyticsRows(exec.raw).length, 0, "already 不得計數");

  const brokenExec = async (sql, params = []) => {
    if (/^INSERT INTO rental_completion_surveys/i.test(sql)) {
      const error = new Error("connection terminated unexpectedly");
      error.code = "08006";
      throw error;
    }
    return exec(sql, params);
  };
  const broken = await errorShape(() => asyncMod.submitCompletionSurveyAsync(1, 818, { found_via_site: "yes" }, { ...PG, exec: brokenExec, strict: true, now: NOW }));
  assert.equal(broken?.code, "08006", "非唯一鍵的錯誤必須原樣往外丟");
  assert.equal(disk.prepare("SELECT COUNT(*) AS n FROM rental_completion_surveys").get().n, 0, "失敗時本機不得被寫入");
});

test("送出：生命週期不是 completed、不是自己的許願房、不安全標記都要擋", async () => {
  const [disk, exec] = resetBoth((h) => {
    seedWish(h, { id: 815, userId: 1, lifecycle: "active" });
    seedWish(h, { id: 816, userId: 2 });
    // 公開中但不是自己的：`getDemandPost()` 會回公開視圖（不丟錯），所以「這不是你的許願房」
    // 必須由**所有權檢查**擋下來。少了它，任何人（含訪客）都能替別人的許願房填問卷。
    seedWish(h, { id: 817, userId: 2, lifecycle: "active", status: "open" });
    // 已完成、還沒有問卷：不安全標記那一條要走到 `surveyFields()` 才測得到
    // （掛在 lifecycle=active 的那一則會被生命週期檢查先擋掉）。
    seedWish(h, { id: 819, userId: 1 });
  });
  const cases = [
    { userId: 1, wishId: 815, input: { found_via_site: "yes" }, why: "還沒完成找房" },
    { userId: 1, wishId: 816, input: { found_via_site: "yes" }, why: "不是自己的許願房" },
    { userId: 1, wishId: 817, input: { found_via_site: "yes" }, why: "別人的公開許願房" },
    { userId: 0, wishId: 817, input: { found_via_site: "yes" }, why: "訪客" },
    { userId: 1, wishId: 899, input: { found_via_site: "yes" }, why: "許願房不存在" },
    { userId: 1, wishId: 819, input: { found_via_site: "yes", detail: "<script>alert(1)</script>" }, why: "不安全標記" },
  ];
  for (const c of cases) {
    const syncErr = syncErrorShape(() => dbMod.submitCompletionSurveyFor(c.userId, c.wishId, c.input, new Date(NOW)));
    const asyncErr = await errorShape(() => asyncMod.submitCompletionSurveyAsync(c.userId, c.wishId, c.input, { ...PG, exec, strict: true, now: NOW }));
    assert.ok(syncErr, `同步版應該要丟錯（${c.why}）`);
    assert.deepEqual(asyncErr, syncErr, `錯誤形狀必須相同（${c.why}）`);
    assert.equal(surveyCount(exec.raw), 0, `PG 不得被寫入（${c.why}）`);
    assert.equal(analyticsRows(exec.raw).length, 0, `PG 不得被計數（${c.why}）`);
  }
});

test("彙總：逐列相同，而且 COUNT 的型別要正規化成數字（PG 的 bigint 是字串）", async () => {
  const [disk, exec] = resetBoth((h) => {
    seedWish(h, { id: 821, userId: 1 });
    seedWish(h, { id: 822, userId: 2 });
    seedSurvey(h, { id: 911, wishId: 821, userId: 1, found: "yes", createdAt: "2026-09-01T00:00:00.000Z" });
    seedSurvey(h, { id: 912, wishId: 822, userId: 2, found: "no", createdAt: "2026-09-02T00:00:00.000Z" });
  });
  const range = { from: "2026-09-01T00:00:00.000Z", to: "2026-09-30T23:59:59.999Z" };
  const byKey = (a, b) => String(a.found_via_site).localeCompare(String(b.found_via_site));
  const syncRows = plain(syncMod.surveyAggregate(disk, range)).sort(byKey);
  const asyncRows = plain(await asyncMod.surveyAggregateAsync(range, { ...PG, exec, strict: true })).sort(byKey);
  assert.deepEqual(asyncRows, syncRows, "彙總必須逐列相同");
  assert.equal(asyncRows.length, 2);
  assert.equal(typeof asyncRows[0].n, "number", "COUNT 必須是數字（PG 回來是字串）");

  // 模擬 PG 的 bigint：夾具把 COUNT 轉成字串，PG 版仍必須回數字。
  const pgTyped = pgFixture({ asPgTypes: true });
  clearWorld(pgTyped.raw);
  seedUsers(pgTyped.raw, [1, 2, 3]);
  seedWish(pgTyped.raw, { id: 821, userId: 1 });
  seedWish(pgTyped.raw, { id: 822, userId: 2 });
  seedSurvey(pgTyped.raw, { id: 911, wishId: 821, userId: 1, found: "yes", createdAt: "2026-09-01T00:00:00.000Z" });
  seedSurvey(pgTyped.raw, { id: 912, wishId: 822, userId: 2, found: "no", createdAt: "2026-09-02T00:00:00.000Z" });
  const typedRows = plain(await asyncMod.surveyAggregateAsync(range, { ...PG, exec: pgTyped, strict: true })).sort(byKey);
  assert.deepEqual(typedRows, syncRows, "PG 的 COUNT 是字串時，回傳值仍必須與同步版相同");
  assert.equal(typeof typedRows[0].n, "number");
});

test("非 postgres 模式必須走同步路徑（不碰傳入的 exec）", async () => {
  const [disk, exec] = resetBoth((h) => seedWish(h, { id: 831, userId: 1 }));
  let touched = 0;
  const counting = async (sql, params = []) => { touched += 1; return exec(sql, params); };
  const view = await asyncMod.submitCompletionSurveyAsync(1, 831, { found_via_site: "yes" }, { driver: "sqlite", exec: counting, now: NOW });
  assert.equal(touched, 0, "SQLite 模式不得碰 PG runner");
  assert.equal(view.submitted, true);
  assert.equal(surveyCount(disk), 1, "要走同步路徑寫本機");
  assert.equal(surveyCount(exec.raw), 0, "不得寫 PG 夾具");
});
