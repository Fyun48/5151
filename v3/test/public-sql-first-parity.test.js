import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildListingSearchSql, buildPublicListingSearchSql } from "../src/listingSearchSql.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

// 隔離子程序在 CI（Gitea runner：CPU 較慢且 node --test 會並行多個檔案）上可能遠超過 30s；
// 這是環境時序而非程式錯誤，因此只保留防卡死的寬鬆上限，可用 V3_ISOLATED_TEST_TIMEOUT_MS 覆寫。
const ISOLATED_TIMEOUT_MS = Math.max(30_000, Number(process.env.V3_ISOLATED_TEST_TIMEOUT_MS) || 180_000);
const dbUrl = JSON.stringify(pathToFileURL(path.join(dir, "../src/db.js")).href);
const projectionUrl = JSON.stringify(pathToFileURL(path.join(dir, "../src/listingSearchProjection.js")).href);

function runIsolated(body, { sqlFirst = false } = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-public-sqlfirst-"));
  const env = { ...process.env, DATA_DIR: dataDir };
  // guest SQL-first 目前是 opt-in（預設關閉），只有要驗證它本身的測試才打開。
  if (sqlFirst) env.PUBLIC_LISTINGS_SQL_FIRST = "1";
  else delete env.PUBLIC_LISTINGS_SQL_FIRST;
  const script = `
    import assert from "node:assert/strict";
    import * as app from ${dbUrl};
    import { backfillListingSearchProjectionStep, projectionCounts } from ${projectionUrl};
    const uid = app.defaultUserId();
    const memberSettingsBefore = JSON.stringify(app.getSettings(uid));
    const stamp = (i) => new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString();
    function seed(post_id, overrides = {}) {
      app.upsertListing({
        post_id, source: "591", source_id: String(post_id),
        source_key: "1|8|" + post_id, search_key: "https://example.test/search",
        title: "合成住宅 " + post_id, url: "https://example.test/listing/" + post_id,
        price: "20000元", price_num: 20000, extra_fee: 0, extra_fees: [],
        address: "台北市士林區測試路" + post_id + "號", area_name: "20坪",
        layout: "2房1廳1衛", floor_name: "5/12", kind_name: "整層住家/電梯大樓",
        role_name: "", cover: "https://example.test/cover.png", tags: "[]",
        refresh_time: stamp(post_id), first_seen_at: stamp(post_id),
        last_seen_at: stamp(post_id), last_event: "new",
        ...overrides,
      });
    }
    // 訪客查詢的 args：settings 由 publicSearchSettings 產生（與路由同一條路）。
    function guestArgs(query = {}, extra = {}) {
      return { ...query, settings: app.publicSearchSettings(query), ...extra };
    }
    ${body}
    // 訪客路徑不得動到會員設定（listPublicListings 的既有契約）。
    assert.equal(JSON.stringify(app.getSettings(uid)), memberSettingsBefore);
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", timeout: ISOLATED_TIMEOUT_MS, env,
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

// 涵蓋會被 JS 過濾器／排序特別處理的列：租金 0、別的行政區、低樓層、頂加、已確認下架、
// 同屋 yes、同屋 primary、不同來源、相同 updated_at（tie-break 靠 post_id）。
function seedTrickyPool() {
  return `
    seed(901);
    seed(902, { price: "15000元", price_num: 15000 });
    seed(903, { price: "0元", price_num: 0, extra_fee: 0 });
    seed(904, { source_key: "1|9|904", address: "台北市北投區測試路904號" });
    seed(905, { floor_name: "1/12" });
    seed(906, { kind_name: "整層住家/頂樓加蓋" });
    seed(907, { extra_fee: 3000, extra_fees: [{ label: "車位", amount: 3000 }], price: "28000元", price_num: 28000 });
    seed(908, { offline: 1, offline_confirmed: 1 });
    seed(909, { match_verdict: "yes" });
    seed(910, { match_post_id: 901, same_house_role: "primary" });
    seed(911, { source: "sinyi", source_key: "9|8|911" });
    seed(912, { refresh_time: stamp(901), first_seen_at: stamp(901), last_seen_at: stamp(901) });
    seed(913, { refresh_time: stamp(901), first_seen_at: stamp(901), last_seen_at: stamp(901) });
  `;
}

test("guest SQL-first 與 Node 路徑結果完全相同（排序／行政區／分頁／顯示篩選）", () => {
  runIsolated(`
    ${seedTrickyPool()}
    const matrix = [
      { label: "default", query: {} },
      { label: "newest+district", query: { districts: ["士林區"] } },
      { label: "price_asc+district", query: { districts: ["士林區"], sort: "price_asc" } },
      { label: "price_desc", query: { sort: "price_desc" } },
      { label: "price_desc+extras", query: { sort: "price_desc", priceMaxIncludesExtras: true } },
      { label: "keep rooftop/low-floor", query: { excludeRooftop: false, excludeLowFloors: false } },
      { label: "parking only", query: { hasParking: true } },
      { label: "offset page", query: { offset: 3, limit: 4 } },
      { label: "two districts", query: { districts: ["士林區", "北投區"] } },
    ];
    for (const { label, query } of matrix) {
      const old = app.listPublicListings(guestArgs(query));
      const neo = app.listPublicListingsSqlFirst(guestArgs(query));
      assert.ok(neo, "SQL-first 應支援：" + label);
      assert.deepEqual(
        neo.listings.map((row) => Number(row.post_id)),
        old.listings.map((row) => Number(row.post_id)),
        "順序不一致：" + label,
      );
      assert.equal(neo.totalMatched, old.totalMatched, "totalMatched 不一致：" + label);
      assert.equal(neo.hasMore, old.hasMore, "hasMore 不一致：" + label);
      assert.equal(neo.nextOffset, old.nextOffset, "nextOffset 不一致：" + label);
      assert.equal(neo.guest, true);
      assert.deepEqual(
        neo.listings.map((row) => [row.title, row.rent]),
        old.listings.map((row) => [row.title, row.rent]),
        "欄位內容不一致：" + label,
      );
    }
    // keyset（cursor）逐頁蒐集必須與 offset 分頁一致：無缺漏、不重複。
    for (const sort of ["newest", "price_asc", "price_desc"]) {
      const base = guestArgs({ districts: ["士林區"], sort, limit: 3 });
      const full = app.listPublicListingsSqlFirst({ ...base, limit: 50 }).listings.map((row) => Number(row.post_id));
      const collected = [];
      let cursor = null;
      for (let i = 0; i < 20; i += 1) {
        const page = cursor == null ? app.listPublicListingsSqlFirst(base) : app.listPublicListingsSqlFirst({ ...base, cursor });
        collected.push(...page.listings.map((row) => Number(row.post_id)));
        cursor = page.nextCursor;
        if (!page.hasMore || cursor == null) break;
      }
      assert.deepEqual(collected, full, "cursor 分頁不一致：" + sort);
    }
  `);
});

test("guest SQL-first 只在一模一樣的等價範圍內接手，其餘回退 Node 路徑", () => {
  runIsolated(`
    ${seedTrickyPool()}
    // 超出 envelope：SQL 端無法表達同樣的語意（關鍵字／房型／來源／fit 排序／屬性篩選／訪客直線距離）
    // 超出 envelope：SQL 端無法表達同樣的語意（關鍵字／房型／來源／fit 排序／價格上限變體／屬性篩選／訪客直線距離／已關注檢視）
    assert.equal(app.listPublicListingsSqlFirst(guestArgs({ q: "合成" })), null);
    assert.equal(app.listPublicListingsSqlFirst(guestArgs({ kind: "whole" })), null);
    assert.equal(app.listPublicListingsSqlFirst(guestArgs({ sources: "591" })), null);
    assert.equal(app.listPublicListingsSqlFirst(guestArgs({ sort: "fit_desc" })), null);
    assert.equal(app.listPublicListingsSqlFirst(guestArgs({ priceMax: 20000 })), null);
    assert.equal(app.listPublicListingsSqlFirst(guestArgs({ commuteKm: 5, workLat: 25.093, workLng: 121.525 })), null);
    assert.equal(app.listPublicListingsSqlFirst({ ...guestArgs({}), filter: "watched" }), null);
    // F3 依隔離實測全部關回外框外（areaMax=35 的 count 需 30,054ms 且逾時；見 listing-search-sql-sources.test.js）
    // ⇒ 訪客路徑的 areaMax 也改為回退 Node，不再走 SQL-first。
    assert.equal(app.listPublicListingsSqlFirst(guestArgs({ areaMax: 30 })), null);
    // 回退後仍拿得到結果（與改動前一樣走 Node 路徑）
    const fallback = app.listPublicListingsFast(guestArgs({ q: "合成" }));
    assert.ok(fallback.listings.length >= 1);
    assert.equal(fallback.guest, true);
    assert.equal(fallback.queryDetails?.sql_first, undefined);
    // 範圍內的查詢則確實走 SQL-first（前提是 projection 與 listings 已對齊）
    assert.equal(app.refreshPublicListingsProjectionReady(), true);
    assert.equal(app.listPublicListingsFast(guestArgs({})).queryDetails.sql_first, true);
  `, { sqlFirst: true });
});

test("公開 builder：行政區可留空、分頁 SQL 帶 LIMIT，會員路徑仍必須有行政區", () => {
  const deps = {
    resolveUserId: () => 0,
    getSettings: () => ({}),
    searchWhere: () => {},
    listingVisibilityClauses: () => {},
    appendDistrictCandidates: () => {},
    appendPriceCeilingCandidates: () => {},
    memberRegionDistrictNames: () => [],
  };
  const all = buildPublicListingSearchSql({ sort: "newest", districts: [], settings: {} }, deps);
  assert.equal(all.ok, true, "訪客不指定行政區應在 envelope 內");
  const allPlan = all.pageQuery({ limit: 20, offset: 0 });
  assert.match(allPlan.sql, /LIMIT \? OFFSET \?/);
  assert.doesNotMatch(allPlan.sql, /p\.district IN/);
  assert.match(all.countQuery.sql, /SELECT COUNT\(\*\) AS n/);

  const scoped = buildPublicListingSearchSql({ sort: "newest", districts: ["士林區"], settings: {} }, deps);
  assert.equal(scoped.ok, true);
  assert.match(scoped.pageQuery({ limit: 20 }).sql, /p\.district IN \(\?\)/);

  // 訪客直線距離篩選只有 Node 做得到 → 必須拒絕
  assert.equal(
    buildPublicListingSearchSql({ settings: { guestCommuteKm: 5, guestWorkLat: 25.093, guestWorkLng: 121.525 } }, deps).ok,
    false,
  );
  assert.equal(buildPublicListingSearchSql({ settings: { priceMax: 20000 } }, deps).ok, false);
  assert.equal(buildPublicListingSearchSql({ sort: "fit_desc", settings: {} }, deps).ok, false);

  // 共用 builder 的會員入口行為不變：沒有行政區（也沒有會員 regions）仍要拒絕
  assert.equal(buildListingSearchSql({ sort: "newest", districts: [], settings: {} }, deps).ok, false);
});

test("訪客路由走 SQL-first 分派，且 SQL-first 只抓一頁（不再全撈候選）", () => {
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  assert.match(server, /getCachedPublicListings\(query, \(\) => listPublicListingsFast\(\{/);
  const dbSrc = readFileSync(path.join(dir, "../src/db.js"), "utf8");
  assert.match(dbSrc, /return listPublicListingsSqlFirst\(args\) \|\| listPublicListings\(args\);/);
  const fast = dbSrc.slice(
    dbSrc.indexOf("export function listPublicListingsSqlFirst"),
    dbSrc.indexOf("/** Guest/public read of the shared listing pool"),
  );
  assert.match(fast, /built\.pageQuery\(/);
  assert.match(fast, /built\.countQuery\.sql/);
  assert.doesNotMatch(fast, /LIST_CANDIDATE_COLUMNS/);
});

test("projection 缺列時，啟動補建會把列補回來，且守門會先回退 Node 路徑", () => {
  runIsolated(`
    ${seedTrickyPool()}
    const scope = guestArgs({ districts: ["士林區"] });
    const full = app.listPublicListings(scope).totalMatched;
    // 模擬 Phase 7 之前建立、之後沒再被 upsert 的列：直接從 projection 刪掉
    app.sqliteHandle().prepare("DELETE FROM listing_search_projection WHERE post_id IN (901, 902)").run();
    assert.equal(projectionCounts(app.sqliteHandle()).missing, 2);
    // 守門：筆數不一致時，即使查詢在 envelope 內也要回退 Node 路徑（慢但完整）
    assert.equal(app.refreshPublicListingsProjectionReady(), false);
    const guarded = app.listPublicListingsFast(scope);
    assert.equal(guarded.totalMatched, full);
    assert.equal(guarded.queryDetails?.sql_first, undefined);
    // 補建：一次一步、可中斷、冪等
    assert.equal(backfillListingSearchProjectionStep(app.sqliteHandle()).added, 2);
    assert.equal(projectionCounts(app.sqliteHandle()).missing, 0);
    assert.equal(backfillListingSearchProjectionStep(app.sqliteHandle()).added, 0);
    // 對齊之後守門打開，SQL-first 接手且結果與 Node 路徑一致
    assert.equal(app.refreshPublicListingsProjectionReady(), true);
    const fast = app.listPublicListingsFast(scope);
    assert.equal(fast.queryDetails.sql_first, true);
    assert.equal(fast.totalMatched, full);
  `, { sqlFirst: true });
});

test("預設不啟用 guest SQL-first：PUBLIC_LISTINGS_SQL_FIRST 未設時一律走 Node 路徑", () => {
  runIsolated(`
    ${seedTrickyPool()}
    // 即使 projection 已對齊，預設仍是 Node 路徑（2026-09-23 正式站 A/B 發現兩條路徑列集不一致）
    assert.equal(app.refreshPublicListingsProjectionReady(), true);
    const scope = guestArgs({ districts: ["士林區"] });
    const listed = app.listPublicListingsFast(scope);
    assert.equal(listed.queryDetails?.sql_first, undefined);
    assert.equal(listed.totalMatched, app.listPublicListings(scope).totalMatched);
  `);
});
