// 會員列表版本化快取的 **live PG** 驗證（2026-10-11）。
//
// 離線測試用替身驅動，證明不了兩件事：
//   1. **版本號查詢 SQL 在真 PG 上跑得起來**（`pg_stat_user_tables` 的聚合、`to_regclass` 探測、
//      `string_agg(... ORDER BY ...)` 的 md5 簽章；替身永遠不會發現語法／型別錯誤）。
//   2. **三條路徑在同一份真資料上真的逐筆相同**（`post_id` 序列、`matched`、分頁欄位）。
//
// ⚠️ 這一檔**只讀**（`withPgReadSnapshot` 是 `READ ONLY` 交易），但仍加資料庫名允許清單：
//   本機的 `PG_TEST_URL` 指的是 `5151_shadow`（正式影子庫），gate 在它上面會讓誤寫有機會發生。
//   只認 `PG_TEST_URL`（CI 的拋棄式 `tracker_test` 與 `repro` 在清單內）；
//   清單外的資料庫一律拒絕執行。`PG_LIVE_REPRO_URL` 也接受（兩者指同一個隔離庫時等價）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const RAW = String(process.env.PG_TEST_URL || process.env.PG_LIVE_REPRO_URL || "").trim();
const ALLOWED_DB = new Set(["repro", "tracker_test", "repro2", "crawl_sandbox"]);
const DB = (() => { try { return new URL(RAW).pathname.replace(/^\//, ""); } catch { return ""; } })();
const REFUSED = RAW && !ALLOWED_DB.has(DB);
const skip = !RAW ? "PG_TEST_URL／PG_LIVE_REPRO_URL 未設定（live PG 驗證需要隔離環境）"
  : REFUSED ? `拒絕執行：資料庫 "${DB}" 不在允許清單 ${[...ALLOWED_DB].join("/")}（正式庫 5151_shadow 一律拒絕）`
    : false;

process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "v3-member-cache-live-"));

const idsOf = (page) => page.listings.map((item) => item.post_id);

async function withFixture(run) {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const exec = (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
  try {
    return await run({ pgDriver, exec, toPostgresSql });
  } finally {
    await pgDriver.close();
  }
}

function memberArgs(uid) {
  return {
    filter: "all", kind: "", sources: "", q: "", sort: "newest", limit: 20, offset: 0,
    districts: [], userId: uid, matchVoteUserId: uid, sameHouse: true,
  };
}

test("live PG：三條路徑（未命中／命中／作廢後）的 post_id 序列與計數完全相同", { skip }, async () => {
  const { loadListingPage } = await import("../src/listingSearchPage.js");
  const cache = await import("../src/memberListingCachePg.js");
  await withFixture(async ({ pgDriver, exec }) => {
    const uid = Number((await exec("SELECT user_id FROM user_settings ORDER BY user_id LIMIT 1"))[0]?.user_id) || 1;
    const args = memberArgs(uid);
    // 這一條走「注入版本號」的確定性路徑：不受其他測試同時寫入影響，空 `data_revision`
    // 的拋棄式庫（CI）也跑得動。`load()` 本身是真的 `loadListingPage`（真 PG、真快照、真管線），
    // 而且刻意把閘關掉 ⇒ 三條路徑比較的是**真實算出來的兩份頁面**。
    process.env.MEMBER_LISTING_CACHE = "0";
    cache.resetMemberListingCache();
    let calls = 0;
    const load = async () => { calls += 1; return loadListingPage({ ...args }, { driver: "postgres", pgDriver }); };
    let gen = { revision: 1, dataVersion: 1, signature: "live:s1" };
    const deps = { readGeneration: async () => gen };

    const miss = await cache.loadMemberListingPage({ pgDriver, args, load, deps });
    const hit = await cache.loadMemberListingPage({ pgDriver, args, load, deps });
    gen = { revision: 2, dataVersion: 2, signature: "live:s2" }; // 作廢：版本換代
    const revalidated = await cache.loadMemberListingPage({ pgDriver, args, load, deps });

    console.log(`[cache-live-equivalence] miss=${JSON.stringify(idsOf(miss))} hit=${JSON.stringify(idsOf(hit))} `
      + `revalidated=${JSON.stringify(idsOf(revalidated))} matched=${miss.stats.matched}/${hit.stats.matched}/${revalidated.stats.matched}`);

    assert.equal(calls, 2, "命中那一次不可以再現算");
    assert.deepEqual(idsOf(hit), idsOf(miss));
    assert.deepEqual(idsOf(revalidated), idsOf(miss));
    assert.deepEqual(hit.stats, miss.stats);
    assert.deepEqual(revalidated.stats, miss.stats);
    assert.equal(hit.hasMore, miss.hasMore);
    assert.equal(revalidated.nextOffset, miss.nextOffset);
    assert.equal(revalidated.nextCursor, miss.nextCursor);
    assert.equal(hit.timing.query_ms, 0);
    assert.equal(hit.timing.stats_ms, 0);
    assert.equal(hit.timing.stages.cache_hit, true);
    // 這個庫**有資料**時，量測對象必須是非空頁面（否則這條等價是空的）；
    // 拋棄式 CI 庫（`pg-integration-setup.mjs` 鏡射出來的 schema、0 筆 listings）沒有資料，
    // 那就只驗空頁等價 —— 不要用「必須有資料」把 CI 弄紅。
    const listingCount = Number((await exec("SELECT COUNT(*)::int AS n FROM listings"))[0]?.n) || 0;
    if (listingCount > 0) {
      assert.equal(miss.listings.length > 0, true, "有資料的庫必須量到非空頁面");
    } else {
      console.log("[cache-live] 這個庫沒有 listings（拋棄式 CI 庫）⇒ 這一條只驗空頁等價與三條路徑一致");
    }
    assert.equal(Number.isFinite(Number(miss.stats.matched)), true);
  });
});

test("live PG：真版本號讀得到就命中；讀不到（空 data_revision）就 fail-closed 不快取", { skip }, async () => {
  const { loadListingPage } = await import("../src/listingSearchPage.js");
  const cache = await import("../src/memberListingCachePg.js");
  await withFixture(async ({ pgDriver, exec }) => {
    const uid = Number((await exec("SELECT user_id FROM user_settings ORDER BY user_id LIMIT 1"))[0]?.user_id) || 1;
    const args = memberArgs(uid);
    const load = () => loadListingPage({ ...args }, { driver: "postgres", pgDriver });

    // ① SQL 真的跑得起來（語法／型別錯誤在替身上看不到）。
    const before = await cache.readMemberListingGeneration(exec, uid);
    if (before) {
      assert.equal(Number.isFinite(Number(before.revision)), true);
      assert.equal(Number.isFinite(Number(before.dataVersion)), true);
      assert.equal(typeof before.signature, "string");
    }

    cache.resetMemberListingCache();
    process.env.MEMBER_LISTING_CACHE = "1";
    try {
      const first = await load();
      const countersAfterFirst = cache.memberListingCacheCounters();
      const second = await load();
      const after = await cache.readMemberListingGeneration(exec, uid);
      assert.deepEqual(idsOf(second), idsOf(first), "快取命中不得改變回傳的 post_id 序列");
      assert.deepEqual(second.stats, first.stats);
      if (!before) {
        // 空表／沒有 data_revision ⇒ 契約是「不讀也不寫、每次現算」。
        assert.equal(cache.memberListingCacheSize(), 0, "沒有可靠版本號時不得寫入");
        assert.equal(countersAfterFirst.bypasses, 1);
        assert.equal(countersAfterFirst.stores, 0);
        console.log("[cache-live] 這個庫沒有可用的 data_revision ⇒ 已驗證 fail-closed（每次現算、不快取）");
      } else if (JSON.stringify(before) === JSON.stringify(after)) {
        // 版本沒變 ⇒ 第二次必須是命中。
        assert.equal(second.timing.query_ms, 0);
        assert.equal(second.timing.stages.cache_hit, true);
        assert.equal(cache.memberListingCacheCounters().hits >= 1, true);
        console.log(`[cache-live] 真版本號命中：revision=${before.revision} dataVersion=${before.dataVersion} `
          + `first_query_ms=${Math.round(first.timing.query_ms)} second_query_ms=${Math.round(second.timing.query_ms)}`);
      } else {
        // 同一個 node --test 批次裡有別的測試在寫 listings ⇒ 版本換代，這是**正確**的未命中。
        assert.equal(second.timing.stages.cache_hit === true, false);
        console.log("[cache-live] 版本在兩次之間換代（同批測試正在寫入）⇒ 只驗等價與正確失效");
      }
    } finally {
      process.env.MEMBER_LISTING_CACHE = "0";
      cache.resetMemberListingCache();
    }
  });
});
