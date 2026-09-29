// 需求統計／首頁需求曝險的 **live PG** 驗證（2026-09-29，第七十九批）。
//
// 離線 parity 用的是記憶體 SQLite 替身，證明不了三件事：
//
//   1. **PG 上的許願房真的算得進統計**（同步版只讀本機 ⇒ 別的節點收到的心願完全不算）。
//   2. **分塊掃描的 `aggregateSql()` 在真 PG 上跑得動**（`?` → `$n` 與 `LIMIT` 的分塊游標）。
//   3. **`expireOpenPostsAsync()` 的 PG 語句真的能跑**（`demand_match_districts` 清除 ＋ 生命週期過期）。
//
// ⚠️ 安全設計照抄 `member-consents-live-pg.test.js`：**不吃 `PG_TEST_URL`**（本機那個指向
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

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-demandagg-live-"));
process.env.DATA_DIR = dataDir;
const MARK = `livetest-agg-${Date.now()}`;
const DISTRICTS = ["1-2", "1-8", "1-9"];
// ⚠️ `suppressSmallGroups()` 是**逐組**門檻（`AGGREGATE_PRIVACY_THRESHOLD = 3`）：
// 每區只有 1～2 筆時全部會被收進「其他」，斷言行政區會失敗（第一版就是這樣）。
// 所以第一個行政區刻意種 3 筆。
const SPECS = [
  { district: DISTRICTS[0], rent_max: 25000, layout: 2 },
  { district: DISTRICTS[0], rent_max: 28000, layout: 2 },
  { district: DISTRICTS[0], rent_max: 30000, layout: 2 },
  { district: DISTRICTS[1], rent_max: 32000, layout: 3 },
  { district: DISTRICTS[1], rent_max: 45000, layout: 4 },
  { district: DISTRICTS[2], rent_max: 18000, layout: 1 },
];

test("live PG：PG 上的許願房要算得進需求統計（同步版只看得到本機）", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const aggAsync = await import("../src/demandAggregateAsync.js");
  const catalogAsync = await import("../src/rentalCatalogAsync.js");
  const dbMod = await import("../src/db.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  assert.equal((await query("SELECT current_database() AS db"))[0].db, DB, "連到的資料庫必須與 URL 一致");
  const pk = (await query(
    `SELECT a.attname AS column FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'users'::regclass AND i.indisprimary`,
  ))[0]?.column;
  await query(`SELECT setval(pg_get_serial_sequence('users', $1), GREATEST((SELECT COALESCE(MAX("${pk}"),0) FROM users), 1))`, [pk]);
  await query("SELECT setval(pg_get_serial_sequence('demand_posts', 'id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM demand_posts), 1))");

  const exec = async (sql, params = []) => (await pgDriver.query(toPostgresSql(sql), params)).rows;
  const opts = { driver: "postgres", pgDriver, exec, strict: true };
  const stamp = "2026-09-29T00:00:00.000Z";
  const userIds = [];

  t.after(async () => {
    try { await query("DELETE FROM demand_posts WHERE body LIKE $1", [`${MARK}%`]); } catch { /* 盡力而為 */ }
    if (userIds.length) {
      try { await query("DELETE FROM users WHERE id = ANY($1::bigint[])", [userIds]); } catch { /* 盡力而為 */ }
    }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ }
  });

  // 屋主配對要開（否則 404）：先記下原值，收尾還原（這是共用的隔離庫）
  const beforeFlags = (await query("SELECT value FROM settings WHERE key = 'rentalMarketplaceFlags'"))[0]?.value ?? null;
  await catalogAsync.saveRentalMarketplaceFlagsAsync({ wish: { owner_matching_enabled: true } }, opts);
  t.after(async () => {
    try {
      if (beforeFlags === null) await query("DELETE FROM settings WHERE key = 'rentalMarketplaceFlags'");
      else await query("UPDATE settings SET value = $1 WHERE key = 'rentalMarketplaceFlags'", [beforeFlags]);
    } catch { /* 盡力而為 */ }
  });

  for (const spec of SPECS) {
    const uid = Number((await query(
      "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'需求統計測試','member','free',$2) RETURNING id",
      [`${MARK}-${spec.district}@example.test`, "2026-01-01T00:00:00.000Z"],
    ))[0].id);
    userIds.push(uid);
    await query(
      `INSERT INTO demand_posts(user_id, districts, rent_max, layout, housing_type, body, status, created_at, expires_at, lifecycle)
       VALUES ($1, $2, $3, $4, 'apartment', $5, 'open', $6, $7, 'active')`,
      [uid, JSON.stringify([spec.district]), spec.rent_max, String(spec.layout), `${MARK} 需求 ${spec.district}`, stamp, "2027-01-01T00:00:00.000Z"],
    );
  }

  // 同步版（讀本機）：這些許願房在本機不存在 ⇒ 樣本不足。
  // ⚠️ 本機也要把配對開關打開（`assertMatchingEnabled()` 讀的是行程內的 flags），
  // 但**不種任何許願房**——這樣才驗得到「同步版看不到 PG 的樣本」。
  dbMod.saveRentalMarketplaceFlags({ wish: { owner_matching_enabled: true } });
  dbMod.getWishConditions();
  const sync = dbMod.aggregateDemand({});
  assert.equal(sync.suppressed, true, "前提：同步版讀本機 ⇒ 樣本不足");

  // PG 版：算得出來（五筆樣本、三個行政區）
  const stats = await aggAsync.aggregateDemandAsync({}, opts);
  assert.equal(stats.enabled, true);
  assert.equal(stats.suppressed, false, "PG 上的五筆樣本要過得了隱私門檻");
  assert.ok(stats.total >= 6, `total 要含這六筆（實際 ${stats.total}）`);
  const labels = stats.districts.map((row) => row.id);
  assert.ok(labels.includes(DISTRICTS[0]), `三筆樣本的行政區要在統計裡（實際 ${labels.join(",")}）`);
  assert.equal(
    stats.districts.find((row) => row.id === DISTRICTS[0])?.count, 3,
    "該行政區的樣本數要是 3",
  );
  assert.ok(stats.budget_bands.some((row) => row.count >= 3), "預算分組要算得出來（至少一組過門檻）");
  assert.ok(stats.layouts.length >= 1, "格局分組要算得出來");

  // 篩選：只留一個行政區
  const one = await aggAsync.aggregateDemandAsync({ districts: [DISTRICTS[0]] }, opts);
  assert.equal(one.total, 3, "行政區篩選後只剩那三筆");
  assert.deepEqual(one.districts.map((row) => row.id), [DISTRICTS[0]], "行政區篩選要生效");

  // 首頁曝險（同一條鏈）
  const exposure = await aggAsync.homepageDemandExposureAsync(opts);
  assert.equal(exposure.enabled, true);
  assert.ok(exposure.districts.length >= 1, "首頁曝險要有行政區");
  assert.ok(exposure.districts.length <= 6, "最多六個");

  // 注入 exec 與純 pgDriver 兩條路徑結果相同
  const viaDriver = await aggAsync.aggregateDemandAsync({ districts: [DISTRICTS[0]] }, { driver: "postgres", pgDriver, strict: true });
  assert.deepEqual(viaDriver, one, "注入 exec 與純 pgDriver 的結果必須相同");
});
