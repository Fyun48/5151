// Admin 營運分析的 **live PG** 驗證（2026-09-28，第四十二批）。
//
// 離線 parity（`rental-ops-async.test.js`）用的夾具是記憶體 SQLite，而中位數那一句是
// **方言分支**：夾具把 PG 的 `EXTRACT(EPOCH FROM (…))` 翻回 SQLite 的 `julianday()` 才能跑。
// 也就是說「PG 那一句本身對不對」在離線測試裡**看不到**——這一條就是為了補那個洞：
//
//   1. `EXTRACT(EPOCH FROM (accepted_at::timestamptz - created_at::timestamptz))` 在真 PG 上
//      真的能跑（兩個欄位是 TEXT，要轉型），而且算出來的秒數與 JS 用同一組 ISO 字串算的一致。
//   2. 奇數／偶數兩種母體各驗一次（兩條分支的取法不同）。
//   3. 明細的 `ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?` 在 PG 上真的能分頁
//      （`LIMIT ?` 帶參數是 PG 也接受的寫法，但這種事只有真 PG 能確認）。
//   4. `*_definition` 文案與其他鍵都在（整包形狀）。
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
const EXPIRES = "2099-01-01T00:00:00.000Z";
const TOKEN = "livetest-ops-token-0001";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-ops-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;

// 與同步版同一個演算法（母體中位數）：排序後奇數取中間、偶數取兩中間平均。
function medianSeconds(rows) {
  if (!rows.length) return null;
  const secs = rows
    .map((row) => (Date.parse(row.accepted_at) - Date.parse(row.created_at)) / 1000)
    .sort((a, b) => a - b);
  const n = secs.length;
  if (n % 2 === 1) return Math.round(secs[(n - 1) / 2]);
  return Math.round((secs[n / 2 - 1] + secs[n / 2]) / 2);
}

test("live PG：中位數的方言 SQL 真的算得對，明細也真的能分頁", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const opsAsync = await import("../src/rentalOpsAnalyticsAsync.js");
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
  const cleanup = async () => {
    const users = await query("SELECT id FROM users WHERE email LIKE 'live-ops-%@example.com'");
    if (!users.length) return;
    const ids = users.map((r) => Number(r.id));
    const offers = await query("SELECT id FROM wish_offers WHERE owner_user_id = ANY($1) OR tenant_user_id = ANY($1)", [ids]);
    const offerIds = offers.map((r) => Number(r.id));
    if (offerIds.length) await query("DELETE FROM wish_offers WHERE id = ANY($1)", [offerIds]);
    await query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  };
  t.after(async () => {
    try { await cleanup(); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });

  await cleanup();
  await syncSequence("users");
  await syncSequence("wish_offers");

  const [OWNER] = (await query(
    "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'屋主','member','free',$2) RETURNING id",
    ["live-ops-owner@example.com", OLD],
  )).map((r) => Number(r.id));
  const [TENANT] = (await query(
    "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'租客','member','free',$2) RETURNING id",
    ["live-ops-tenant@example.com", OLD],
  )).map((r) => Number(r.id));
  assert.ok(OWNER && TENANT);

  // 兩個區間：3 月放奇數母體（3 筆）、4 月放偶數母體（4 筆）。
  // 秒差刻意不相等（600／1200／1800／2400），奇偶兩種取法才分得出來。
  const seed = async (month, count) => {
    for (let i = 0; i < count; i += 1) {
      const day = String(i + 1).padStart(2, "0");
      const created = `2026-${month}-${day}T00:00:00.000Z`;
      const accepted = `2026-${month}-${day}T00:${String(10 * (i + 1)).padStart(2, "0")}:00.000Z`;
      await query(
        `INSERT INTO wish_offers(public_token, wish_id, listing_id, owner_user_id, tenant_user_id, status,
           created_at, updated_at, expires_at, accepted_at)
         VALUES ($1, 1, $2, $3, $4, 'accepted', $5, $5, $6, $7)`,
        // ⚠️ `listing_id` 一定要**跨月份**唯一：`idx_wish_offers_active_unique` 是
        // UNIQUE(owner_user_id, listing_id, wish_id) WHERE status IN ('pending','accepted')，
        // 兩個月都用 900000+i 的話第二個月會撞（CI 第一次跑就是這樣紅的）。
        [`${TOKEN}-${month}-${i}`, 900000 + (month === "03" ? 0 : 10) + i, OWNER, TENANT, created, EXPIRES, accepted],
      );
    }
  };
  await seed("03", 3);
  await seed("04", 4);

  // 與其他 live 測試同一個理由：`options.exec` 有值時 `withFallback()` 不再套 `toPostgresSql`，
  // 所以注入的 runner 自己要套（正式路徑也是這樣）。
  const exec = async (sql, params = []) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  };
  const opts = { driver: "postgres", pgDriver, exec, strict: true };

  // 1) 奇數母體（3 月）
  const oddRange = { from: "2026-03-01", to: "2026-03-31" };
  const oddRows = await query(
    "SELECT created_at, accepted_at FROM wish_offers WHERE accepted_at >= $1 AND accepted_at <= $2",
    [`${oddRange.from}T00:00:00.000Z`, `${oddRange.to}T23:59:59.999Z`],
  );
  const oddSummary = await opsAsync.rentalOpsSummaryAsync(oddRange, opts);
  assert.ok(oddSummary.offers.median_sample_size >= 3, "3 月的母體至少要包含剛種的 3 筆");
  assert.equal(
    oddSummary.offers.median_seconds_to_accept, medianSeconds(oddRows),
    "PG 的 EXTRACT(EPOCH …) 算出來的中位數必須與 JS 用同一組 ISO 字串算的一致（奇數母體）",
  );
  assert.ok(oddSummary.offers.median_definition.includes("母體中位秒數"), "文案（定義）必須在");

  // 2) 偶數母體（4 月）
  const evenRange = { from: "2026-04-01", to: "2026-04-30" };
  const evenRows = await query(
    "SELECT created_at, accepted_at FROM wish_offers WHERE accepted_at >= $1 AND accepted_at <= $2",
    [`${evenRange.from}T00:00:00.000Z`, `${evenRange.to}T23:59:59.999Z`],
  );
  const evenSummary = await opsAsync.rentalOpsSummaryAsync(evenRange, opts);
  assert.ok(evenSummary.offers.median_sample_size >= 4, "4 月的母體至少要包含剛種的 4 筆");
  assert.equal(
    evenSummary.offers.median_seconds_to_accept, medianSeconds(evenRows),
    "偶數母體要取兩中間值的平均（PG 與 JS 必須相同）",
  );
  // 形狀：整包該有的鍵都要在（PG 分支是同步版的轉錄，這裡確認沒有漏接）
  for (const key of ["range", "wish", "matching", "offers", "notifications", "growth", "series"]) {
    assert.ok(key in evenSummary, `summary 必須有 ${key}`);
  }
  assert.ok(evenSummary.growth.survey_breakdown !== undefined);
  assert.equal(typeof evenSummary.notifications.generated, "number");

  // 3) 明細：真的能在 PG 上分頁（每頁 2 筆，游標往後）
  const first = await opsAsync.rentalOpsDrilldownAsync({ ...evenRange, kind: "offers", limit: 2 }, opts);
  assert.equal(first.items.length, 2, "第一頁必須有 2 筆");
  assert.ok(first.next_cursor !== "", "還有下一頁時必須給游標");
  const second = await opsAsync.rentalOpsDrilldownAsync({ ...evenRange, kind: "offers", limit: 2, cursor: first.next_cursor }, opts);
  assert.ok(second.items.length >= 1, "第二頁必須拿得到剩下的");
  const refs = new Set([...first.items, ...second.items].map((row) => row.offer_ref));
  assert.equal(refs.size, first.items.length + second.items.length, "兩頁不得重複（keyset 分頁）");

  const surveys = await opsAsync.rentalOpsDrilldownAsync({ ...evenRange, kind: "surveys", limit: 5 }, opts);
  assert.equal(surveys.kind, "surveys");
  assert.ok(Array.isArray(surveys.items));
});
