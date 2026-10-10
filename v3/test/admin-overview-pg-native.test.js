// SQLite 退場 P2：後台總覽／資料健康度的「PG 原生聚合」驗收（2026-10-11）。
//
// 驗的三件事（對應 PR 的驗收 2a／2b／2c）：
//   (a) `DB_DRIVER=postgres` 下 `getAdminOverviewAsync()`／`getAdminDataHealthAsync()` 的每個數字
//       都來自 PG 的 exec stub（斷言 SQL 被呼叫）；**不回退 SQLite**。
//   (b) 開閘 probe：`DB_DRIVER=postgres` ＋ `PG_NO_SQLITE_OPEN=1`（節點根本不開業務 SQLite）時，
//       匯入 `adminOverview.js` 並呼叫兩個 async 入口（用 stub options）不得出現
//       `business SQLite is closed`。
//   (c) 失敗不再變成 0：stub 拋錯時端點要**拋**，不可以回一個看起來正常的 0。
//
// 為什麼一定要在**子程序**裡跑：`PG_NO_SQLITE_OPEN`／`DB_DRIVER` 是 db.js 在 import 時讀的，
// 同一個行程內改不了；這也是既有 `admin-overview.test.js` 的作法。
//
// ⚠️ 這裡的 stub 一律回**裸陣列**（不是 `{rows}`）：`pgExec()` 會把兩種形狀都正規化成裸陣列，
// 而 stub 看到的是**未經 `toPostgresSql()` 的原始語句**，所以斷言用的字串就是原始 SQL。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const ISOLATED_TIMEOUT_MS = Math.max(30_000, Number(process.env.V3_ISOLATED_TEST_TIMEOUT_MS) || 180_000);
const modUrl = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);

// 子程序共用的 stub：以「SQL 片段 → 假資料」的順序表實作（先命中先回）。
// 沒命中的一律回 `[]`（等同「這一支沒有資料」），所以測試只需要列出真正在意的聚合。
const STUB = `
const calls = [];
const CANNED = [
  ["missing_address", [{
    total: 30, missing_address: 1, missing_coords: 2, missing_floor: 3,
    missing_area: 4, missing_layout: 5, missing_fees: 6, missing_furnish: 7,
  }]],
  ["FROM listing_groups WHERE confirmation_level = ?", [{ n: 3 }]],
  ["GROUP BY confirmation_level", [
    { level: "suspected", n: 3 },
    { level: "auto_confirmed", n: 2 },
    { level: "admin_confirmed", n: 1 },
  ]],
  ["FROM listing_group_members m", [{ n: 5 }]],
  ["first_seen_at >= ?", [{ n: 2 }]],
  ["COALESCE(offline_confirmed, 0) = 1", [{ n: 4 }]],
  ["post_id > ?", [{ n: 6 }]],
  ["match_post_id, 0) > 0", [{ n: 9 }]],
  ["FROM listing_import WHERE status IN", [{ n: 8 }]],
  ["FROM system_announcements", [{ n: 3 }]],
  ["FROM listing_prep WHERE display_ready = 0", [{ n: 7 }]],
  ["FROM listing_prep WHERE display_ready = 1", [{ n: 1 }]],
  ["AS waiting,", [{ waiting: 1, running: 0, oldest: "2026-10-01T00:00:00.000Z", last_success: "2026-10-01T01:00:00.000Z" }]],
  ["COUNT(*) AS n FROM listings", [{ n: 12 }]],
];
function makeStub({ throwOn = null } = {}) {
  return async (sql, params = []) => {
    calls.push({ sql, params });
    if (throwOn && sql.includes(throwOn)) throw new Error("stub PG 失敗：" + throwOn);
    for (const [needle, rows] of CANNED) if (sql.includes(needle)) return rows;
    return [];
  };
}
function sqlSeen(needle) {
  return calls.filter((c) => c.sql.includes(needle));
}
// 來源連續失敗（診斷欄位）走的是 crawlScheduleAsync.scheduleTransaction()：它**不吃** options.exec，
// 只吃 pgDriver.withTransaction()（模組自己的既有形狀），所以 stub 也要提供一個。
function makePgDriver(rows = []) {
  return { withTransaction: async (fn) => fn({ query: async () => ({ rows, rowCount: 0 }) }) };
}
`;

function runGate(body) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-admin-pg-"));
  const script = `
    import assert from "node:assert/strict";
    const { getAdminOverviewAsync, getAdminDataHealthAsync } = await import(${modUrl("../src/adminOverview.js")});
    const { buildAdminOverviewAsync, buildAdminDataHealthAsync } = await import(${modUrl("../src/adminOverviewAsync.js")});
    ${STUB}
    ${body}
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: ISOLATED_TIMEOUT_MS,
      // 開閘：節點不開業務 SQLite。任何還想回退 SQLite 的路徑都會直接拋
      // 「business SQLite is closed」⇒ 這兩個測試同時就是「不回退 SQLite」的證明。
      env: { ...process.env, DATA_DIR: dataDir, DB_DRIVER: "postgres", PG_NO_SQLITE_OPEN: "1" },
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    return result.stdout;
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("2a/2b｜開閘 ＋ driver=postgres：總覽的每個數字都來自 PG exec stub，且不出現 business SQLite is closed", () => {
  const out = runGate(`
    const PREP = { pendingPrep: 7, readyPrep: 1 };
    const exec = makeStub();
    const options = { driver: "postgres", exec, pgDriver: makePgDriver() };

    let overview;
    try {
      // 公開入口（server.js 的 /api/admin/overview 走這一個）。
      overview = await getAdminOverviewAsync(options);
    } catch (error) {
      assert.ok(!/business SQLite is closed/.test(String(error?.message || "")), "不得出現開閘錯誤：" + error?.message);
      throw error;
    }

    // ---- 每個數字都必須等於 stub 給的值（不是 0、也不是 SQLite 的值）----
    assert.equal(overview.readOnly, true);
    assert.equal(overview.listings.total, 12);
    assert.equal(overview.listings.todayNew, 2);
    assert.equal(overview.listings.offlineConfirmed, 4);
    assert.equal(overview.listings.suspectedSameHouse, 3);
    assert.equal(overview.listings.sameHouseGroups, 3, "auto_confirmed 2 ＋ admin_confirmed 1");
    assert.equal(overview.listings.pendingReconcile, 6);
    assert.equal(overview.sameHouse.ungrouped, 5);
    assert.equal(overview.inbox.importPending, 8, "listing_import 待處理");
    assert.equal(overview.inbox.announcementDrafts, 3);
    assert.equal(overview.inbox.suspectedSameHouse, 3);
    assert.equal(overview.catalog, null, "settings 沒有快照時與同步版相同：null（不是 0）");
    assert.deepEqual(overview.sameHouse.backfill.cursor, 0, "回填游標來自 PG settings（stub 沒有值 ⇒ 0）");

    // ---- 直接呼叫 builder（不經過 listingPrep 的補抓統計）也要一致 ----
    const direct = await buildAdminOverviewAsync(PREP, options);
    assert.deepEqual(direct.listings, overview.listings);

    // ---- 斷言 SQL 真的被送到 PG stub ----
    assert.ok(calls.some((c) => c.sql.includes("SELECT COUNT(*) AS n FROM listings")), "listings 總數要走 PG");
    const todayCall = sqlSeen("first_seen_at >= ?")[0];
    assert.ok(todayCall, "first_seen_at >= ? 必須被呼叫");
    assert.equal(todayCall.params.length, 1, "今日新增要帶一個參數（todayStartIso）");
    assert.equal(sqlSeen("GROUP BY confirmation_level").length, 2, "呼叫兩次（入口＋builder）就該跑兩次");
    assert.equal(sqlSeen("FROM listing_import WHERE status IN")[0].params.length, 3);
    assert.equal(sqlSeen("missing_address").length, 0, "總覽不該跑資料健康度那條大查詢");
    console.log("OVERVIEW_CALLS=" + calls.length);
  `);
  assert.match(out, /OVERVIEW_CALLS=\d+/);
});

test("2b｜開閘 ＋ driver=postgres：資料健康度也走 PG stub（big 查詢與疑似重複計數）", () => {
  runGate(`
    const PREP = { pendingPrep: 0, readyPrep: 0 };
    const exec = makeStub();
    const options = { driver: "postgres", exec };
    const health = await getAdminDataHealthAsync(options);
    assert.equal(health.total, 30);
    assert.equal(health.missingAddress, 1);
    assert.equal(health.missingCoords, 2);
    assert.equal(health.missingFloor, 3);
    assert.equal(health.missingArea, 4);
    assert.equal(health.missingLayout, 5);
    assert.equal(health.missingFees, 6);
    assert.equal(health.missingFurnish, 7);
    assert.equal(health.suspectedDuplicate, 3, "listing_groups 那一支先算，非 0 就不查 listings 的近似值");
    assert.ok(health.listingPrep && typeof health.listingPrep === "object", "listingPrep 由呼叫端帶入（補抓統計）");
    assert.ok(sqlSeen("missing_address").length === 1);
    const direct = await buildAdminDataHealthAsync(PREP, options);
    assert.deepEqual({ ...direct, listingPrep: null }, { ...health, listingPrep: null });
  `);
});

test("2c｜stub 拋錯時要往上丟（不可靜默變成 0）", () => {
  runGate(`
    const exec = makeStub({ throwOn: "COUNT(*) AS n FROM listings" });
    await assert.rejects(
      () => getAdminOverviewAsync({ driver: "postgres", exec }),
      /stub PG 失敗/,
      "PG 讀不到時必須把錯誤往上丟，讓端點明確失敗",
    );

    // 資料健康度那一條也要丟（big 查詢失敗）。
    const exec2 = makeStub({ throwOn: "missing_address" });
    await assert.rejects(
      () => getAdminDataHealthAsync({ driver: "postgres", exec: exec2 }),
      /stub PG 失敗/,
    );

    // 形狀不對（沒有 n）同樣要丟，不可以被當成 0。
    const badShape = async () => [];
    await assert.rejects(
      () => buildAdminOverviewAsync({}, { driver: "postgres", exec: badShape }),
      /沒有回傳資料列/,
    );
  `);
});

// SQLite 模式（`DB_DRIVER` 沒有設／設 sqlite）的 async 入口在這次搬家後必須與同步入口**逐欄相同**。
// 這是「搬家不改變行為」的回歸護欄：`adminOverview.js` 只留入口，實作搬到 `adminOverviewSqlite.js`。
function runSqlite(body) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-admin-lite-"));
  const script = `
    import assert from "node:assert/strict";
    const db = await import(${modUrl("../src/db.js")});
    const sync = await import(${modUrl("../src/adminOverview.js")});
    ${body}
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: ISOLATED_TIMEOUT_MS,
      env: { ...process.env, DATA_DIR: dataDir, DB_DRIVER: "sqlite", PG_NO_SQLITE_OPEN: "0" },
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    return result.stdout;
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("SQLite 模式：async 入口與同步入口逐欄相同（搬家不改變行為）", () => {
  runSqlite(`
    const now = new Date().toISOString();
    const seed = (post_id, first_seen_at) => db.upsertListing({
      post_id, source: "591", source_id: String(post_id), source_key: "1|8|" + post_id,
      search_key: "https://example.test/search", title: "P2 parity " + post_id,
      url: "https://example.test/" + post_id, price: "20000元", price_num: 20000, extra_fees: [],
      address: "台北市士林區測試路" + post_id + "號", area_name: "20坪", layout: "2房1廳",
      floor_name: "5/12", kind_name: "整層住家/電梯大樓", role_name: "", cover: "", tags: "[]",
      refresh_time: "2026-10-01T00:00:00.000Z",
      // 第一筆用「現在」⇒ todayNew 非 0，數字才不是全部 0（避免測試自己騙自己）。
      first_seen_at, last_seen_at: first_seen_at, last_event: "new",
    });
    seed(9301, now);
    seed(9302, "2026-09-01T00:00:00.000Z");
    db.writeSettingKey(db.SITE_CATALOG_STATS_KEY, { at: now, total: 2, bySource: { "591": 2 } });

    const overviewSync = sync.getAdminOverview();
    const overviewAsync = await sync.getAdminOverviewAsync();
    assert.equal(overviewSync.listings.total, 2, "夾具必須真的有 2 筆，否則這個測試沒有意義");
    assert.equal(overviewSync.listings.todayNew, 1);
    assert.deepEqual(overviewAsync, overviewSync);

    const healthSync = sync.getAdminDataHealth();
    const healthAsync = await sync.getAdminDataHealthAsync();
    assert.equal(healthSync.total, 2);
    assert.deepEqual(healthAsync, healthSync);
  `);
});
