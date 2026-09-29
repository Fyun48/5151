// 開關（rental-marketplace-flags）寫入 ＋ 啟用時的許願遷移：**live PG** 驗證（第六十三批）。
//
// 離線 parity 用的是記憶體 SQLite 替身，證明不了這四件事，而它們正好都是這一條路由的風險：
//
//   1. **欄位探測在真 PG 上跑得起來**：`hasColumnAsync()` 用的是
//      `SELECT <column> FROM demand_posts WHERE 1 = 0`。PG 會在有欄位時回空集合、沒有時丟 42703；
//      離線夾具是 SQLite 在回 `no such column`，兩邊的錯誤字串／SQLSTATE 不同。
//   2. **兩句 UPDATE 的 `?` → `$n` 轉譯與欄位順序在真 PG 上真的能寫**（打錯欄名、參數個數不對
//      都只會在真 PG 上炸；替身照單全收）。
//   3. **「遷移 ＋ 寫開關」真的在同一個交易**：這裡用一個「settings UPSERT 一定失敗」的 driver
//      從**同一個交易物件**注入失敗 ⇒ 若遷移其實跑在交易外（自動提交），失敗後許願仍然會被改；
//      交易正確時整批回滾。這是同步版 `BEGIN`／`COMMIT` 的語意，離線測試看不到。
//   4. **`publicRentalMarketplaceFlags()` 的公開形狀與 settings 落地值一致**（公開形狀刻意只露出
//      `lifecycle_enabled`，其餘一律 false；寫入端不能被它誤導）。
//
// ⚠️ 安全設計照抄 `demand-live-pg.test.js`：**不吃 `PG_TEST_URL`**（本機那個指向 `5151_shadow`
// 正式影子庫），只認 `PG_LIVE_REPRO_URL` 且資料庫名要在允許清單內。
import { after, test } from "node:test";
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

const FAR = "9999-12-31T00:00:00.000Z";
const SOON = "2027-01-01T00:00:00.000Z";
// 這一組 id 只給這個檔案用（其他 live 測試用的是 9xxx 區段，這裡刻意錯開）。
const WISH_FAR = 771001;
const WISH_SOON = 771002;
const WISH_CLOSED = 771003;
const WISH_MARKED = 771004;
const USER_BASE = 771000;

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-rflags-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;

test("live PG：開關寫入與啟用時的許願遷移（同一交易、公開形狀一致）", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const flagsAsync = await import("../src/rentalCatalogAsync.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  const who = (await query("SELECT current_database() AS db"))[0];
  assert.equal(who.db, DB, "連到的資料庫必須與 URL 一致");

  // `settings`／`demand_posts` 是共用狀態 ⇒ 先記下原值，收尾一定要還原。
  const savedFlags = (await query("SELECT value FROM settings WHERE key = 'rentalMarketplaceFlags'"))[0]?.value ?? null;
  const wishIds = [WISH_FAR, WISH_SOON, WISH_CLOSED, WISH_MARKED];
  const userIds = wishIds.map((_, i) => USER_BASE + i);
  const cleanup = async () => {
    if (savedFlags == null) await query("DELETE FROM settings WHERE key = 'rentalMarketplaceFlags'");
    else await query("UPDATE settings SET value = $1 WHERE key = 'rentalMarketplaceFlags'", [savedFlags]);
    await query("DELETE FROM demand_posts WHERE id = ANY($1)", [wishIds]);
    await query("DELETE FROM users WHERE id = ANY($1)", [userIds]);
  };
  t.after(async () => {
    try { await cleanup(); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });

  await cleanup();
  // `demand_posts.id` 與 `users.id` 都是 identity（`ensurePgSchema` 把 INTEGER PRIMARY KEY 翻成
  // identity）⇒ 明確寫入 id 不會推進序列，之後的請求會撞主鍵。健檢項目，這裡先補上。
  for (const [table, column] of [["users", "id"], ["demand_posts", "id"]]) {
    await query(`SELECT setval(pg_get_serial_sequence($1, $2), GREATEST((SELECT COALESCE(MAX(${column}),0) FROM ${table}), 1))`, [table, column]);
  }
  // ⚠️ 只能放**一個** `unnest`：目標列裡再放一個會變成 4×4 的笛卡兒積（4 個 id 各 4 列 ⇒ 撞主鍵）。
  await query(
    "INSERT INTO users(id, email, created_at) SELECT u, 'live-rflags-' || u || '@example.com', '2026-01-01T00:00:00.000Z' FROM unnest($1::bigint[]) AS u",
    [userIds],
  );
  const seedWish = (id, userId, status, expiresAt, migratedAt) => query(
    `INSERT INTO demand_posts(id, user_id, districts, rent_max, housing_type, mrt_walk, body, status, created_at, expires_at, lifecycle_migrated_at)
     VALUES ($1, $2, '[]', 0, 'any', 0, '', $3, '2026-01-01T00:00:00.000Z', $4, $5)`,
    [id, userId, status, expiresAt, migratedAt],
  );
  // 起點：一個沒開的旗標要能被保留，一個遠期到期的 open 要能被遷移，另外三列都不能被動。
  await query(
    "INSERT INTO settings(key, value) VALUES ('rentalMarketplaceFlags', $1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [JSON.stringify({ rental_catalog_v2: { enabled: true }, wish: { notifications_enabled: true, lifecycle_enabled: false } })],
  );
  await seedWish(WISH_FAR, userIds[0], "open", FAR, null);
  await seedWish(WISH_SOON, userIds[1], "open", SOON, null);
  await seedWish(WISH_CLOSED, userIds[2], "closed", FAR, null);
  await seedWish(WISH_MARKED, userIds[3], "open", FAR, "2026-03-01T00:00:00.000Z");

  const rowOf = async (id) => (await query(
    "SELECT status, lifecycle, expires_at, last_confirmed_at, lifecycle_migrated_at FROM demand_posts WHERE id = $1", [id]))[0];
  const blob = async () => JSON.parse((await query("SELECT value FROM settings WHERE key = 'rentalMarketplaceFlags'"))[0].value);

  // ---- 1) 正常路徑：遷移 ＋ 開關都落地 ----
  const before = { soon: await rowOf(WISH_SOON), closed: await rowOf(WISH_CLOSED), marked: await rowOf(WISH_MARKED) };
  const saved = await flagsAsync.saveRentalMarketplaceFlagsAsync(
    { wish: { lifecycle_enabled: true, offer_enabled: true } }, { driver: "postgres", pgDriver });
  assert.equal(saved.wish.lifecycle_enabled, true, "公開形狀必須回報生命週期已開");
  assert.equal(saved.wish.offer_enabled, false, "公開形狀刻意不公開其他旗標（不能被它誤導）");
  assert.equal(saved.rental_catalog_v2.enabled, true, "沒帶到的區塊要保留");

  const landed = await blob();
  assert.equal(landed.wish.lifecycle_enabled, true, "開關要落地");
  assert.equal(landed.wish.offer_enabled, true, "這次開的旗標要落地");
  assert.equal(landed.wish.notifications_enabled, true, "沒帶到的旗標不得被關掉");

  const migrated = await rowOf(WISH_FAR);
  assert.equal(migrated.lifecycle, "active", "遠期到期的 open 要遷移");
  assert.ok(migrated.expires_at < FAR, `到期時間必須被改成 TTL，實際 ${migrated.expires_at}`);
  assert.ok(migrated.lifecycle_migrated_at, "遷移標記必須寫入");
  assert.deepEqual({ soon: await rowOf(WISH_SOON), closed: await rowOf(WISH_CLOSED), marked: await rowOf(WISH_MARKED) },
    before, "只有遠期到期的 open 能被改動");

  // ---- 2) 冪等：再存一次不會把已遷移的列往後推 ----
  const afterFirst = (await rowOf(WISH_FAR)).expires_at;
  await flagsAsync.saveRentalMarketplaceFlagsAsync({ wish: { lifecycle_enabled: true } }, { driver: "postgres", pgDriver });
  assert.equal((await rowOf(WISH_FAR)).expires_at, afterFirst, "第二次儲存不得再遷移（標記已存在）");

  // ---- 3) 交易：settings 寫入失敗時，同一批的遷移必須一起回滾 ----
  // 用同一條連線的**真交易**，只把 settings 的 UPSERT 換成拒絕 ⇒ 失敗點在遷移之後。
  await query("UPDATE demand_posts SET status = 'open', lifecycle = NULL, expires_at = $1, last_confirmed_at = NULL, last_active_at = NULL, continuous_active_from = NULL, lifecycle_migrated_at = NULL WHERE id = $2", [FAR, WISH_FAR]);
  const refusingDriver = {
    query: (sql, params) => pgDriver.query(sql, params),
    withTransaction: (fn) => pgDriver.withTransaction((client) => fn({
      query: (sql, params) => (/INSERT\s+INTO\s+settings/i.test(sql)
        ? Promise.reject(new Error("live-probe: settings upsert refused"))
        : client.query(toPostgresSql(sql), params)),
    })),
  };
  await assert.rejects(
    () => flagsAsync.saveRentalMarketplaceFlagsAsync({ wish: { lifecycle_enabled: true } }, { driver: "postgres", pgDriver: refusingDriver }),
    /settings upsert refused/,
  );
  const rolledBack = await rowOf(WISH_FAR);
  assert.equal(rolledBack.lifecycle_migrated_at, null,
    "settings 寫入失敗時，同一交易的遷移必須回滾（沒有回滾＝遷移跑在交易外）");
  assert.equal(rolledBack.expires_at, FAR, "到期時間也要回滾");
  assert.equal((await blob()).wish.lifecycle_enabled, true, "前一輪已經落地的開關不得被這一輪改壞");
});

after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });
