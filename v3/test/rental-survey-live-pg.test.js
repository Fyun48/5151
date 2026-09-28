// 完成問卷（completion survey）的 **live PG** 驗證（2026-09-28，第四十一批）。
//
// 離線 parity 用的是記憶體 SQLite 替身，證明不了三件事：
//
//   1. **`ensurePgSchema` 鏡射建表 ＋ 補 unique index 在真 PG 上真的跑得起來**。
//      離線夾具是自己 `CREATE TABLE`（從 SQLite 的 DDL 抄）的，完全沒走到 bootstrap；
//      而 `rental_completion_surveys` 的 `wish_id`／`public_token` 兩條唯一鍵在 SQLite 是
//      **表約束**，PG 鏡射抓不到——所以那兩條 index 是這個模組自己補的，必須在真 PG 上確認。
//   2. **唯一鍵真的擋得住**（不是只寫在常數裡）：直接對 PG 插第二列同一則許願房的問卷，
//      必須被 `rental_survey_wish_unique` 拒絕。
//   3. **`COUNT(*)` 的型別**：PG 回的是字串（bigint），admin 的 `survey_breakdown` 直接用，
//      所以要看 PG 版真的把它轉成數字。
//
// ⚠️ 安全設計照抄 `demand-live-pg.test.js`：**不吃 `PG_TEST_URL`**（本機那個指向
// `5151_shadow` 正式影子庫），只認 `PG_LIVE_REPRO_URL` 且資料库名要在允許清單內。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const RAW = String(process.env.PG_LIVE_REPRO_URL || "").trim();
const ALLOWED_DB = new Set(["repro", "tracker_test", "repro2"]);
const DB = (() => { try { return new URL(RAW).pathname.replace(/^\//, ""); } catch { return ""; } })();
const REFUSED = RAW && !ALLOWED_DB.has(DB);
const skip = !RAW ? "PG_LIVE_REPRO_URL 未設定（live PG 驗證需要隔離環境）"
  : REFUSED ? `拒絕執行：資料庫 "${DB}" 不在允許清單 ${[...ALLOWED_DB].join("/")}（正式庫 5151_shadow 一律拒絕）`
    : false;

const OLD = "2026-01-01T00:00:00.000Z";
const EXPIRES = "2099-01-01T00:00:00.000Z";
const TOKEN = "livetest-survey-token-0001";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-survey-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;

test("live PG：問卷的兩個唯一鍵真的存在、送出真的落地、already 與 COUNT 型別都正確", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const surveyAsync = await import("../src/rentalSurveyAsync.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  const who = (await query("SELECT current_database() AS db"))[0];
  assert.equal(who.db, DB, "連到的資料庫必須與 URL 一致");

  const syncSequence = async (table) => {
    await query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM ${table}), 1))`,
      [table],
    );
  };
  // 依「測試自己種的帳號」清理：不管上一次成功或中途失敗，起點都一樣。
  const cleanup = async () => {
    const users = await query("SELECT id FROM users WHERE email LIKE 'live-survey-%@example.com'");
    if (!users.length) return;
    const ids = users.map((r) => Number(r.id));
    const posts = await query("SELECT id FROM demand_posts WHERE user_id = ANY($1)", [ids]);
    const postIds = posts.map((r) => Number(r.id));
    if (postIds.length) {
      await query("DELETE FROM rental_completion_surveys WHERE wish_id = ANY($1)", [postIds]);
      await query("DELETE FROM demand_posts WHERE id = ANY($1)", [postIds]);
    }
    await query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  };
  // 共用資料庫：中途失敗留下的殘骸會讓後面依賴乾淨起點的 live 測試跟著紅。
  t.after(async () => {
    try { await cleanup(); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });

  await cleanup();
  await syncSequence("users");
  await syncSequence("demand_posts");
  await syncSequence("rental_completion_surveys");

  // 模組自己的 ensure：鏡射建表 ＋ 補兩條 unique index（正式路徑的第一個請求也會跑）。
  await surveyAsync.ensureSurveyStoreOnce(pgDriver);
  const idx = (await query(
    "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'rental_completion_surveys' ORDER BY indexname",
  )).map((r) => r.indexdef);
  const joined = idx.join("\n");
  assert.match(joined, /UNIQUE INDEX.*\(wish_id\)/i, `PG 上必須有 wish_id 的唯一索引（實際：${idx.join(" | ")}）`);
  assert.match(joined, /UNIQUE INDEX.*\(public_token\)/i, "PG 上必須有 public_token 的唯一索引");

  const [UID] = (await query(
    "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'屋主','member','free',$2) RETURNING id",
    ["live-survey-owner@example.com", OLD],
  )).map((r) => Number(r.id));
  const [OTHER] = (await query(
    "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'路人','member','free',$2) RETURNING id",
    ["live-survey-other@example.com", OLD],
  )).map((r) => Number(r.id));
  assert.ok(UID && OTHER);

  const WISH_ID = Number((await query(
    `INSERT INTO demand_posts(user_id, districts, rent_max, housing_type, mrt_walk, body, status, created_at, updated_at, expires_at, published_at, public_token, legacy_numeric_share, lifecycle, closed_reason)
     VALUES ($1,'["1-5"]',0,'any',0,'live PG 問卷驗證','closed',$2,$2,$3,$2,$4,1,'completed','') RETURNING id`,
    [UID, OLD, EXPIRES, TOKEN],
  ))[0].id);

  // 與其他 live 測試同一個理由：`options.exec` 有值時 `withFallback()` 不再套 `toPostgresSql`，
  // 所以注入的 runner 自己要套（正式路徑也是這樣）。
  const exec = async (sql, params = []) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  };
  const opts = { driver: "postgres", pgDriver, exec, strict: true };

  // 1) 送出：真的寫進 PG
  const submitted = await surveyAsync.submitCompletionSurveyAsync(UID, WISH_ID, {
    found_via_site: "yes", via_feature: "search", helpful: 5, detail: "live PG 的問卷",
  }, opts);
  assert.equal(submitted.submitted, true);
  assert.equal(submitted.already, false);
  assert.ok(submitted.survey_ref, "survey_ref 必須有值");
  const stored = (await query(
    "SELECT public_token, user_id, found_via_site, via_feature, helpful, detail FROM rental_completion_surveys WHERE wish_id = $1",
    [WISH_ID],
  ))[0];
  assert.ok(stored, "問卷必須真的寫進 PG");
  assert.equal(stored.public_token, submitted.survey_ref, "回傳的 ref 必須就是落地那一列的 token");
  assert.equal(stored.detail, "live PG 的問卷");
  assert.equal(Number(stored.helpful), 5);

  // 2) 重複送出：already，而且不得多一列
  const again = await surveyAsync.submitCompletionSurveyAsync(UID, WISH_ID, { found_via_site: "no" }, opts);
  assert.equal(again.already, true);
  assert.equal(again.found_via_site, "yes", "already 要回原本那一筆");
  assert.equal(
    (await query("SELECT COUNT(*)::int AS n FROM rental_completion_surveys WHERE wish_id = $1", [WISH_ID]))[0].n, 1,
    "重複送出不得寫出第二列",
  );

  // 3) 唯一鍵是真的在擋（不是只寫在常數裡）：直接插第二列必須被拒
  await assert.rejects(
    () => query(
      `INSERT INTO rental_completion_surveys(public_token, wish_id, user_id, found_via_site, via_feature, helpful, detail, created_at)
       VALUES ($1, $2, $3, 'no', '', NULL, '', $4)`,
      [`${TOKEN}-dup`, WISH_ID, OTHER, OLD],
    ),
    /rental_survey_wish_unique|duplicate key/i,
    "PG 的 wish_id 唯一索引必須真的擋下第二列",
  );

  // 4) 不是自己的許願房：PG 上也要擋（公開中的許願房會先回公開視圖）
  const [OPEN_ID] = [(await query(
    `INSERT INTO demand_posts(user_id, districts, rent_max, housing_type, mrt_walk, body, status, created_at, updated_at, expires_at, published_at, public_token, legacy_numeric_share, lifecycle, closed_reason)
     VALUES ($1,'["1-5"]',0,'any',0,'live PG 公開許願房','open',$2,$2,$3,$2,$4,1,'active','') RETURNING id`,
    [UID, OLD, EXPIRES, `${TOKEN}-open`],
  ))[0].id];
  await assert.rejects(
    () => surveyAsync.submitCompletionSurveyAsync(OTHER, OPEN_ID, { found_via_site: "yes" }, opts),
    /找不到這則許願房/,
    "不得替別人的許願房填問卷",
  );

  // 5) 彙總：PG 的 COUNT 是字串，PG 版必須回數字
  const rows = await surveyAsync.surveyAggregateAsync({ from: "2026-01-01T00:00:00.000Z", to: "2099-01-01T00:00:00.000Z" }, opts);
  const yes = rows.find((row) => row.found_via_site === "yes");
  assert.ok(yes, `彙總必須包含 yes（實際：${JSON.stringify(rows)}）`);
  assert.equal(typeof yes.n, "number", "COUNT 必須是數字（PG 的 bigint 是字串）");
  assert.ok(yes.n >= 1);
});
