// 行政區關係閉包「材料化分量」的 **live PG** 驗證。
//
// 離線測試（`member-district-closure-materialized.test.js`）用的是 PG 替身，證明的是**邏輯**；
// 這裡要證明的是「那些 SQL 在真 PG 上真的成立」：`CREATE TABLE IF NOT EXISTS` 真的冪等、
// `unnest($1::bigint[], $2::bigint[])` 真的收得下兩條陣列、`IS DISTINCT FROM` 的比對真的抓得到差異、
// `= ANY($1::text[])` 真的對得上 `split_part(source_key…)` 的結果。形狀照
// `reject-match-live-pg.test.js`（那一支的教訓：全離線測試讓「查詢在真 PG 上不成立」這種問題上了線）。
//
// ⚠️ 安全設計（照抄既有的兩道防護，不要簡化）：
//   * 只認明確的 `PG_LIVE_REPRO_URL`，並用 `assertPgTargetAllowed()`（fail-closed；
//     正式庫 `5151_shadow` 不在允許清單內）。
//   * 自己種列、自己收尾：只碰 `listings`／`user_same_house_members` 的**自有** post_id
//     （`dc1 ` 標題、9.5e9 起跳），以及本功能新建的兩張表。**不** DROP／TRUNCATE／ALTER 任何既有物件。
import { test } from "node:test";
import assert from "node:assert/strict";

const RAW = String(process.env.PG_LIVE_REPRO_URL || "").trim();
const skip = !RAW ? "PG_LIVE_REPRO_URL 未設定（live PG 驗證需要隔離環境）" : false;

const POST_BASE = 9_500_000_000; // 自有、遠離正式 id 範圍（正式最大約 2.7e9）
const TEST_UID = 999_501;

/** 只把「NOT NULL 又沒有 default」的欄位補齊（欄位清單從 information_schema 推導，不硬編）。 */
async function insertRequired(query, table, provided) {
  const required = (await query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ?
        AND is_nullable = 'NO' AND column_default IS NULL AND is_identity = 'NO'
      ORDER BY ordinal_position`,
    [table],
  )).rows;
  const names = [...new Set([...required.map((c) => c.column_name), ...Object.keys(provided)])];
  const values = names.map((name) => {
    if (name in provided) return provided[name];
    const col = required.find((c) => c.column_name === name);
    return /int|numeric|real|double|bigint|smallint/i.test(col?.data_type || "") ? 0 : "";
  });
  await query(
    `INSERT INTO ${table}(${names.map((n) => `"${n}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`,
    values,
  );
}

test("live PG：材料化分量的 DDL 冪等、重算是真 SQL、且與即時算逐筆相同", { skip }, async () => {
  const { assertPgTargetAllowed } = await import("../src/domainToolGuards.js");
  assertPgTargetAllowed("match-components-live-pg", RAW); // 不在允許清單 ⇒ 直接失敗（不是 skip）
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { districtKeyLists } = await import("../src/listDistrictSql.js");
  const { CITIES } = await import("../src/regions.js");
  const { districtClosureIds, districtClosureIdsLive } = await import("../src/listingSearchNodePg.js");
  const {
    loadMaterializedDistrictClosure, MATCH_COMPONENT_TABLE, MATCH_COMPONENT_STATE_TABLE, MATCH_GRAPH_STATE_KEY,
  } = await import("../src/listingMatchComponents.js");
  const { ensureMatchComponentsOnce, rebuildMatchComponents } = await import("../src/repository/writePath.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");

  const driver = await createPostgresDriver({ connectionString: RAW });
  const query = (sql, params = []) => driver.query(toPostgresSql(sql), params);
  const exec = async (sql, params = []) => (await query(sql, params)).rows;

  const district = CITIES[0].districts[0].name;
  const otherDistrict = CITIES[0].districts[1]?.name || district;
  const { allowed, allKeys } = districtKeyLists([district]);
  const OTHER_PREFIX = allKeys.find((key) => !allowed.includes(key));
  const ids = [0, 1, 2, 3, 4, 5, 6].map((n) => POST_BASE + n);
  const seeded = [];
  try {
    // 1) DDL 冪等：連跑兩次都不能拋錯，而且表真的存在。
    await ensureMatchComponentsOnce(driver);
    await ensureMatchComponentsOnce(driver);
    const tables = await exec(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ANY(?::text[])",
      [[MATCH_COMPONENT_TABLE, MATCH_COMPONENT_STATE_TABLE]],
    );
    assert.deepEqual(
      tables.map((row) => row.table_name).sort(),
      [MATCH_COMPONENT_TABLE, MATCH_COMPONENT_STATE_TABLE].sort(),
    );

    // 2) 自己種一族配對圖：分量 {0,1,2}、{3,4}、{5,6}；
    //    +0／+5 是 allowed 行政區、+4 是 unknown 前綴（舊契約把它當種子）、+2／+3 是別的行政區。
    const listingsFixture = [
      { post_id: ids[0], match_post_id: ids[1], source_key: `${allowed[0]}|x` },
      { post_id: ids[1], match_post_id: ids[2], source_key: `${OTHER_PREFIX}|x` },
      { post_id: ids[2], match_post_id: 0, source_key: `${OTHER_PREFIX}|w` },
      { post_id: ids[3], match_post_id: ids[4], source_key: `${OTHER_PREFIX}|x` },
      { post_id: ids[4], match_post_id: 0, source_key: "" }, // unknown 前綴 ⇒ 種子
      { post_id: ids[5], match_post_id: ids[6], source_key: `${allowed[0]}|y` },
      { post_id: ids[6], match_post_id: 0, source_key: `${OTHER_PREFIX}|z` },
    ];
    for (const row of listingsFixture) {
      await insertRequired(query, "listings", {
        post_id: row.post_id, match_post_id: row.match_post_id, source: "591",
        source_key: row.source_key, title: `dc1 ${row.post_id}`,
      });
      seeded.push(row.post_id);
    }
    // 3) 同屋源：把 +6（allowed 的那個分量）與 +3（另一分量）綁在同一群 ⇒ 兩組都必須被拉進來。
    await insertRequired(query, "user_same_house_members", { user_id: TEST_UID, post_id: ids[6], group_key: "dc1-g2" });
    await insertRequired(query, "user_same_house_members", { user_id: TEST_UID, post_id: ids[3], group_key: "dc1-g2" });

    // 4) 真的重算一次（帶 force：就算分量表已經有資料，也要以現況重建）。
    const rebuilt = await rebuildMatchComponents(driver, { reason: "live-test", force: true });
    assert.equal(rebuilt.skipped, undefined, `重算不該被跳過：${JSON.stringify(rebuilt)}`);
    assert.ok(rebuilt.nodes >= 7, `重算至少要看到自己種的 7 個節點，實際 ${rebuilt.nodes}`);
    const state = await exec(`SELECT * FROM ${MATCH_COMPONENT_STATE_TABLE} WHERE state_key = ?`, [MATCH_GRAPH_STATE_KEY]);
    assert.equal(state.length, 1, "狀態列應該只有一列");
    assert.equal(Number(state[0].node_count), rebuilt.nodes);

    // 5) 逐列等價：對外入口（材料化）與即時算在同一組輸入上必須逐筆相同。
    const cases = [
      { name: "member/relatedOnly + 明確行政區", names: [district], userId: TEST_UID, relatedOnly: true },
      { name: "member/relatedOnly + 別的行政區", names: [otherDistrict], userId: TEST_UID, relatedOnly: true },
      { name: "guest + 明確行政區", names: [district], userId: 0, relatedOnly: false },
      { name: "guest + 兩個行政區", names: [district, otherDistrict], userId: 0, relatedOnly: false },
    ];
    const sorted = (list) => [...(list || [])].sort((a, b) => a - b);
    for (const item of cases) {
      const keys = districtKeyLists(item.names);
      const live = await districtClosureIdsLive(exec, { districtNames: item.names, userId: item.userId, relatedOnly: item.relatedOnly });
      const materialized = await loadMaterializedDistrictClosure(exec, {
        allowed: keys.allowed, allKeys: keys.allKeys, userId: item.userId, relatedOnly: item.relatedOnly,
      });
      assert.ok(Array.isArray(materialized), `${item.name}：材料化應該要能回答（不是退回即時算）`);
      assert.deepEqual(sorted(materialized), sorted(live), `${item.name}：材料化與即時算不同`);
    }
    // 同屋源跨分量：+3 那一組必須被 +6 那一組拉進來（同一群）。
    const memberIds = await districtClosureIds(exec, { districtNames: [district], userId: TEST_UID, relatedOnly: true });
    for (const id of ids) assert.ok(memberIds.includes(id), `member 閉包少了 ${id}`);

    // 6) 表缺資料 ⇒ 一定退回即時算（不得把空表當成「空集合」回答）。
    await exec(`DELETE FROM ${MATCH_COMPONENT_TABLE}`, []);
    assert.equal(await loadMaterializedDistrictClosure(exec, {
      allowed, allKeys, userId: TEST_UID, relatedOnly: true,
    }), null, "表被清空之後必須回 null");
    const afterDelete = await districtClosureIds(exec, { districtNames: [district], userId: TEST_UID, relatedOnly: true });
    const liveAfterDelete = await districtClosureIdsLive(exec, { districtNames: [district], userId: TEST_UID, relatedOnly: true });
    assert.deepEqual(sorted(afterDelete), sorted(liveAfterDelete), "退回即時算的答案必須逐筆相同");
  } finally {
    // 收尾：只刪自己種的列與自己建的表的內容。
    try {
      await exec(`DELETE FROM ${MATCH_COMPONENT_TABLE} WHERE post_id = ANY(?::bigint[])`, [seeded]);
      await exec(`DELETE FROM ${MATCH_COMPONENT_STATE_TABLE} WHERE state_key = ?`, [MATCH_GRAPH_STATE_KEY]);
      await exec("DELETE FROM user_same_house_members WHERE user_id = ?", [TEST_UID]);
      await exec("DELETE FROM listings WHERE post_id = ANY(?::bigint[])", [seeded]);
    } catch {
      // 收尾失敗不掩蓋測試結果；列的特徵（title 以 "dc1 " 開頭）人工看得出來。
    }
    await driver.close();
  }
});

test("live PG：正式庫名一律被拒（fail-closed，不是靠 skip 掩蓋）", async () => {
  const { assertPgTargetAllowed } = await import("../src/domainToolGuards.js");
  // 明確傳空的 env：即使執行環境設了 `ALLOW_PRODUCTION_PG_TARGET=1`，這裡也要證明**預設**是拒絕的。
  assert.throws(
    () => assertPgTargetAllowed("match-components-live-pg", "postgres://postgres@127.0.0.1:5432/5151_shadow", { env: {} }),
    /不在允許清單/,
  );
});
