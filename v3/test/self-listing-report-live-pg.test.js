// 檢舉站內刊登／後台隱藏的 **live PG** 驗證（2026-09-28，第四十六批）。
//
// 離線 parity 用的是記憶體 SQLite 替身，證明不了三件事：
//
//   1. **`listings` 的隱藏 UPDATE 與 `users.self_ban_until` 的 UPDATE** 在真 PG 上真的生效
//      （`hidden`／`hidden_at` 是 ALTER 加上去的欄位，`self_ban_until` 也是）。
//   2. **達門檻的計數**用的是 PG 上的 `listing_reports`（PG 沒有唯一鍵，靠先查再寫）。
//   3. **`selfBanStamp()` 的時間來源**：這一包把「餵 ISO 字串」的解析修好了（原本 `nowMs()`
//      只認 Date／數字，字串會**靜默地**退回當下），順便在真 PG 上看一次落地值。
//
// ⚠️ 安全設計照抄 `demand-live-pg.test.js`：**不吃 `PG_TEST_URL`**（本機那個指向
// `5151_shadow` 正式影子庫），只認 `PG_LIVE_REPRO_URL` 且資料庫名要在允許清單內。
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
const NOW = "2026-09-28T00:00:00.000Z";
const TOKEN = "livetest-selfreport";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-selfreport-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;

test("live PG：檢舉門檻與停權在真 PG 上生效", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const selfAsync = await import("../src/selfListingsAsync.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  const who = (await query("SELECT current_database() AS db"))[0];
  assert.equal(who.db, DB, "連到的資料庫必須與 URL 一致");

  const syncSequence = async (table, column = "id") => {
    await query(
      `SELECT setval(pg_get_serial_sequence($1, $2), GREATEST((SELECT COALESCE(MAX(${column}),0) FROM ${table}), 1))`,
      [table, column],
    );
  };
  // 依「測試自己種的帳號」清理（含檢舉列與刊登）。
  const cleanup = async () => {
    const users = await query("SELECT id FROM users WHERE email LIKE $1", [`${TOKEN}-%@example.com`]);
    const ids = users.map((r) => Number(r.id));
    const posts = ids.length
      ? await query("SELECT post_id FROM listings WHERE listed_by_user_id = ANY($1)", [ids])
      : [];
    const postIds = posts.map((r) => Number(r.post_id));
    if (postIds.length) await query("DELETE FROM listing_reports WHERE post_id = ANY($1)", [postIds]);
    await query("DELETE FROM listings WHERE title LIKE $1", [`${TOKEN}%`]);
    if (ids.length) await query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  };
  t.after(async () => {
    try { await cleanup(); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });

  await cleanup();
  await syncSequence("users");
  await syncSequence("listings");

  const mkUser = async (tag) => Number((await query(
    "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1, $2, 'member', 'free', $3) RETURNING id",
    [`${TOKEN}-${tag}@example.com`, tag, OLD],
  ))[0].id);
  const OWNER = await mkUser("owner");
  const REPORTER_A = await mkUser("reporter-a");
  const REPORTER_B = await mkUser("reporter-b");
  assert.ok(OWNER && REPORTER_A && REPORTER_B);

  const LISTING_ID = Number((await query(
    `INSERT INTO listings(source_key, title, url, source, listed_by_user_id, self_status, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, 'self', $4, 'open', $5, $5) RETURNING post_id`,
    [`self-${TOKEN}`, `${TOKEN} 的站內刊登`, `https://example.com/${TOKEN}`, OWNER, OLD],
  ))[0].post_id);

  const exec = async (sql, params = []) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  };
  const opts = { driver: "postgres", pgDriver, exec, strict: true, now: NOW };
  const listingOf = async () => (await query(
    "SELECT self_status, hidden, hidden_at FROM listings WHERE post_id = $1", [LISTING_ID],
  ))[0];
  const banOf = async () => (await query("SELECT self_ban_until FROM users WHERE id = $1", [OWNER]))[0]?.self_ban_until || "";

  // 1) 第一筆檢舉：只寫檢舉，不隱藏、不停權
  const first = await selfAsync.reportSelfListingAsync(REPORTER_A, LISTING_ID, "廣告", opts);
  assert.deepEqual(first, { ok: true, hidden: false });
  assert.equal((await listingOf()).self_status, "open", "第一筆不得隱藏");
  assert.equal(await banOf(), "", "第一筆不得停權");
  assert.equal(
    (await query("SELECT COUNT(*)::int AS n FROM listing_reports WHERE post_id = $1", [LISTING_ID]))[0].n, 1,
    "檢舉列必須真的寫進 PG",
  );

  // 2) 同一人重複：already，不得多一列
  const again = await selfAsync.reportSelfListingAsync(REPORTER_A, LISTING_ID, "廣告", opts);
  assert.deepEqual(again, { ok: true, already: true });
  assert.equal(
    (await query("SELECT COUNT(*)::int AS n FROM listing_reports WHERE post_id = $1", [LISTING_ID]))[0].n, 1,
    "同一人不得寫出第二列",
  );

  // 3) 第二個人：達門檻 → 隱藏＋停權（時間用注入的 NOW，所以可以精確比對）
  const second = await selfAsync.reportSelfListingAsync(REPORTER_B, LISTING_ID, "重複張貼", opts);
  assert.deepEqual(second, { ok: true, hidden: true });
  const hiddenRow = await listingOf();
  assert.equal(hiddenRow.self_status, "hidden", "達門檻必須在 PG 上真的隱藏");
  assert.equal(Number(hiddenRow.hidden), 1, "hidden 旗標也要設");
  assert.ok(hiddenRow.hidden_at, "hidden_at 必須有值");
  // 停權 14 天（`SELF_BAN_DAYS`）：2026-09-28 + 14 天 = 2026-10-12
  assert.equal(await banOf(), "2026-10-12T00:00:00.000Z", "停權時間必須由注入的 now 算出（不是當下時間）");

  // 4) 後台隱藏另一則刊登：立刻隱藏＋停權
  const SECOND_ID = Number((await query(
    `INSERT INTO listings(source_key, title, url, source, listed_by_user_id, self_status, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, 'self', $4, 'open', $5, $5) RETURNING post_id`,
    [`self-${TOKEN}-2`, `${TOKEN} 的第二則`, `https://example.com/${TOKEN}-2`, OWNER, OLD],
  ))[0].post_id);
  const hidden = await selfAsync.hideSelfListingAsync(SECOND_ID, opts);
  assert.deepEqual(hidden, { ok: true, post_id: SECOND_ID, hidden: true, ban_until: "2026-10-12T00:00:00.000Z" });
  assert.equal(
    (await query("SELECT self_status FROM listings WHERE post_id = $1", [SECOND_ID]))[0].self_status, "hidden",
    "後台隱藏必須在 PG 上生效",
  );
});
