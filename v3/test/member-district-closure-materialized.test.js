// 行政區關係閉包「材料化分量」的離線測試（紅字測試先行：本檔在 base 上會因為模組不存在而紅）。
//
// 這一檔固定三件契約：
//   1. **逐列等價**：材料化路徑與即時算在**同一組輸入**上必須逐筆相同
//      （含同屋源跨分量合併、未知前綴、只有同屋源邊的節點、單人小組不是節點、>2^31 的 id）。
//   2. **fail-safe**：缺表／缺狀態列／指紋過期／表被清空 ⇒ 一律退回即時算，不得少算。
//   3. **待機不寫**：`pg_is_in_recovery()` 為 true 時 `rebuildMatchComponents()` 一行寫入都不發；
//      而且「分量沒變」時連那一批 DELETE／INSERT 都不發（寫入放大）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MATCH_COMPONENT_TABLE,
  MATCH_COMPONENT_STATE_TABLE,
  MATCH_GRAPH_STATE_KEY,
  componentLabels,
  districtClosureMaterializedEnabled,
  graphRowDiffers,
  loadMaterializedDistrictClosure,
  resetRebuildScheduleForTest,
} from "../src/listingMatchComponents.js";
import { districtClosureIds, districtClosureIdsLive } from "../src/listingSearchNodePg.js";
import { districtKeyLists } from "../src/listDistrictSql.js";
import { rebuildMatchComponents } from "../src/repository/writePath.js";

const BIG_ID = 2507462476; // > 2^31-1（正式庫實測值）
const DISTRICT = "中山區";

const { allowed, allKeys } = districtKeyLists([DISTRICT]);
const ALLOWED_PREFIX = allowed[0];
const OTHER_PREFIX = allKeys.find((key) => !allowed.includes(key));
const UNKNOWN_PREFIX = "|"; // source_key 空 ⇒ 不屬於任何已知行政區鍵 ⇒ 舊契約把它當種子

/**
 * 一組同時具備「配對圖」與「同屋源群組」的輸入：
 *   • 配對分量：{10,11,12}、{20,21}、{30,31}、{BIG_ID,40}
 *   • 同屋源：g1={100,101,102}（都不在配對圖）／g2={12,30}（跨兩個配對分量）／
 *             g3={200,300}（只有同屋源邊的節點，200 是行政區列）／g4={999}（單人小組 ⇒ 不是節點）
 *   • 行政區列：10=allowed、21=unknown、200=allowed；其餘不是 allowed 也不是 unknown
 */
function fixture() {
  const edges = [[10, 11], [11, 12], [20, 21], [30, 31], [BIG_ID, 40]];
  const prefixOf = new Map([
    [10, ALLOWED_PREFIX], [12, OTHER_PREFIX], [20, OTHER_PREFIX], [21, UNKNOWN_PREFIX],
    [30, OTHER_PREFIX], [100, OTHER_PREFIX], [101, OTHER_PREFIX], [102, OTHER_PREFIX],
    [200, ALLOWED_PREFIX], [300, OTHER_PREFIX], [400, OTHER_PREFIX], [999, OTHER_PREFIX],
  ]);
  const members = [
    { post_id: 100, group_key: "g1" }, { post_id: 101, group_key: "g1" }, { post_id: 102, group_key: "g1" },
    { post_id: 12, group_key: "g2" }, { post_id: 30, group_key: "g2" },
    { post_id: 200, group_key: "g3" }, { post_id: 300, group_key: "g3" },
    { post_id: 999, group_key: "g4" },
  ];
  const edgeRows = edges.map(([post_id, match_post_id]) => ({ post_id, match_post_id }));
  const matchOf = new Map(edgeRows.map((row) => [row.post_id, row.match_post_id]));
  return { edges, edgeRows, members, prefixOf, matchOf };
}

function isDistrictSeed(prefix) {
  return prefix === ALLOWED_PREFIX || !allKeys.includes(prefix);
}

function seedRows(prefixOf) {
  return [...prefixOf.entries()].filter(([, prefix]) => isDistrictSeed(prefix)).map(([post_id]) => ({ post_id }));
}

/** 即時算（live）那一條路徑的 PG 替身：邊、同屋源、種子述詞。 */
function liveExec(fx) {
  return async (sql) => {
    if (/FROM listings WHERE match_post_id/.test(sql)) return fx.edgeRows;
    if (/FROM user_same_house_members/.test(sql)) return fx.members;
    if (/SELECT post_id FROM listings WHERE/.test(sql)) return seedRows(fx.prefixOf);
    throw new Error(`liveExec 不認得的 SQL：${sql}`);
  };
}

/**
 * 材料化那一條路徑的 PG 替身：從**同一組輸入**推出「已經算好的分量表」，
 * 再照 SQL 形狀回答（分量表、狀態列、逐列證明、同屋源）。
 */
function materializedExec(fx, { state: stateOverrides = {}, delta = null, verifyRows = null, emptyTable = false, stateMissing = false } = {}) {
  const components = new Map();
  for (const [postId, componentId] of componentLabels(fx.edges.map(([a, b]) => [a, b])).allLabels()) {
    components.set(postId, {
      post_id: postId,
      component_id: componentId,
      district_prefix: fx.prefixOf.get(postId) ?? null,
      match_post_id: fx.matchOf.get(postId) ?? null,
    });
  }
  const state = {
    built_at: Date.now(),
    round_marker: "|",
    revision_watermark: 100,
    stat_fingerprint: 7,
    node_count: components.size,
    covering: null,
    system_covering: null,
    covers_max: null,
    revision: 100,
    ...stateOverrides,
  };
  const calls = [];
  const exec = async (sql, params = []) => {
    calls.push(sql);
    if (/FROM listing_match_component_state/.test(sql)) {
      if (stateMissing) throw new Error('relation "listing_match_component_state" does not exist');
      return [state];
    }
    if (/FROM data_revision/.test(sql)) return delta || [];
    if (/FROM pg_stat_user_tables/.test(sql)) return [{ fingerprint: state.stat_fingerprint }];
    if (/SELECT EXISTS\(SELECT 1 FROM listing_match_component\)/.test(sql)) return [{ present: emptyTable ? false : components.size > 0 }];
    if (/AS cur_match/.test(sql)) return verifyRows || [];
    if (/SELECT DISTINCT s\.component_id/.test(sql)) {
      const [allow, all] = params;
      const out = new Set();
      for (const row of components.values()) {
        if (row.district_prefix == null) continue;
        if (allow.includes(row.district_prefix) || !all.includes(row.district_prefix)) out.add(row.component_id);
      }
      return [...out].map((component_id) => ({ component_id }));
    }
    if (/FROM listing_match_component WHERE component_id = ANY/.test(sql)) {
      const [ids] = params;
      return [...components.values()].filter((row) => ids.includes(row.component_id)).map((row) => ({ post_id: row.post_id }));
    }
    if (/SELECT post_id, component_id FROM listing_match_component WHERE post_id = ANY/.test(sql)) {
      const [ids] = params;
      return [...components.values()].filter((row) => ids.includes(row.post_id))
        .map((row) => ({ post_id: row.post_id, component_id: row.component_id }));
    }
    if (/SELECT post_id FROM listings WHERE post_id = ANY\(/.test(sql)) {
      const [ids] = params;
      return ids.filter((id) => {
        const prefix = fx.prefixOf.get(id);
        return prefix != null && isDistrictSeed(prefix);
      }).map((post_id) => ({ post_id }));
    }
    if (/SELECT post_id FROM listings WHERE/.test(sql)) return seedRows(fx.prefixOf);
    if (/FROM user_same_house_members/.test(sql)) return fx.members;
    throw new Error(`materializedExec 不認得的 SQL：${sql}`);
  };
  exec.calls = calls;
  return exec;
}

const sorted = (ids) => [...(ids || [])].sort((a, b) => a - b);

test("材料化路徑與即時算逐筆相同（會員：同屋源跨分量合併／未知前綴／只有同屋源邊的節點）", async () => {
  const fx = fixture();
  const live = await districtClosureIdsLive(liveExec(fx), { districtNames: [DISTRICT], userId: 1, relatedOnly: true });
  const materialized = await loadMaterializedDistrictClosure(materializedExec(fx), {
    allowed, allKeys, userId: 1, relatedOnly: true,
  });
  assert.deepEqual(sorted(materialized), sorted(live));
  // 「兩邊都是空集合」也算過，但這一組不是空的（避免用空集合掩蓋 bug）。
  assert.ok(sorted(live).length >= 8, `fixture 應該要有非平凡的結果，實際 ${JSON.stringify(sorted(live))}`);
  // 同屋源把 {10,11,12} 與 {30,31} 併起來 ⇒ 兩組都要出現（不是只出現種子那一組）。
  for (const id of [10, 11, 12, 30, 31, 21, 200, 300]) assert.ok(sorted(live).includes(id), `live 少了 ${id}`);
  // 單人小組的 999 不是邊的端點 ⇒ 不得被當成種子帶進來。
  assert.ok(!sorted(live).includes(999), "999 是單人小組，不是節點");
  // 不在配對圖、也不是同屋源端點、又不是 allowed／unknown 的行政區列（例如 400）不該出現。
  assert.ok(!sorted(live).includes(400));
  // 走對外入口時，同一組輸入也必須得到同一組答案（材料化真的被用上）。
  assert.deepEqual(sorted(await districtClosureIds(materializedExec(fx), {
    districtNames: [DISTRICT], userId: 1, relatedOnly: true,
  })), sorted(live));
});

test("材料化路徑與即時算逐筆相同（訪客：relatedOnly=false ⇒ 直接行政區列也在集合裡）", async () => {
  const fx = fixture();
  const live = await districtClosureIdsLive(liveExec(fx), { districtNames: [DISTRICT], userId: 0, relatedOnly: false });
  const materialized = await loadMaterializedDistrictClosure(materializedExec(fx), {
    allowed, allKeys, userId: 0, relatedOnly: false,
  });
  assert.deepEqual(sorted(materialized), sorted(live));
  assert.ok(sorted(live).includes(999) === false, "999 不屬於這組行政區列（prefix=OTHER）");
  // 訪客（userId=0）沒有同屋源邊 ⇒ 結果＝全部行政區列 ∪ 含種子的分量。
  assert.deepEqual(sorted(live), [10, 11, 12, 20, 21, 200]);
});

test("MEMBER_DISTRICT_CLOSURE_MATERIALIZED=0 ⇒ 一行都不經過材料化（逐字走即時算）", async () => {
  const fx = fixture();
  const previous = process.env.MEMBER_DISTRICT_CLOSURE_MATERIALIZED;
  process.env.MEMBER_DISTRICT_CLOSURE_MATERIALIZED = "0";
  try {
    assert.equal(districtClosureMaterializedEnabled(), false);
    const live = await districtClosureIdsLive(liveExec(fx), { districtNames: [DISTRICT], userId: 1, relatedOnly: true });
    // 這一組 exec 對任何材料化查詢都會拋錯 ⇒ 若開關沒有整條關掉，這個測試就會紅。
    const ids = await districtClosureIds(liveExec(fx), { districtNames: [DISTRICT], userId: 1, relatedOnly: true });
    assert.deepEqual(sorted(ids), sorted(live));
  } finally {
    if (previous == null) delete process.env.MEMBER_DISTRICT_CLOSURE_MATERIALIZED;
    else process.env.MEMBER_DISTRICT_CLOSURE_MATERIALIZED = previous;
  }
});

test("缺表（狀態列讀不到）⇒ 回 null、排重算、對外入口改用即時算且答案相同", async () => {
  const fx = fixture();
  const scheduled = [];
  assert.equal(await loadMaterializedDistrictClosure(materializedExec(fx, { stateMissing: true }), {
    allowed, allKeys, userId: 1, relatedOnly: true, scheduleRebuild: (reason) => { scheduled.push(reason); },
  }), null);
  assert.deepEqual(scheduled, ["state_unreadable"]);

  // 混合 exec：狀態列那條（表不存在）拋錯，其餘照即時算回答 ⇒ 對外入口必須逐筆等於即時算。
  const live = liveExec(fx);
  const hybrid = async (sql, params = []) => {
    if (/FROM listing_match_component_state/.test(sql)) throw new Error('relation "listing_match_component_state" does not exist');
    return live(sql, params);
  };
  const scheduled2 = [];
  const ids = await districtClosureIds(hybrid, {
    districtNames: [DISTRICT], userId: 1, relatedOnly: true,
    maintenance: { scheduleRebuild: (reason) => { scheduled2.push(reason); } },
  });
  const expected = await districtClosureIdsLive(liveExec(fx), { districtNames: [DISTRICT], userId: 1, relatedOnly: true });
  assert.deepEqual(sorted(ids), sorted(expected));
  assert.deepEqual(scheduled2, ["state_unreadable"]);
});

test("狀態列說有節點、表卻是空的 ⇒ 不採用材料化（表缺資料不得當成「空集合」回答）", async () => {
  const fx = fixture();
  const scheduled = [];
  const ids = await loadMaterializedDistrictClosure(materializedExec(fx, { emptyTable: true }), {
    allowed, allKeys, userId: 1, relatedOnly: true, scheduleRebuild: (reason) => { scheduled.push(reason); },
  });
  assert.equal(ids, null);
  assert.deepEqual(scheduled, ["table_missing_rows"]);
});

test("輪次標記換了、但逐列證明通過 ⇒ 照樣回答，只把水位往前推一句 CAS（不重算）", async () => {
  const fx = fixture();
  const advances = [];
  const scheduled = [];
  const ids = await loadMaterializedDistrictClosure(materializedExec(fx, { state: { round_marker: "舊的一輪|" } }), {
    allowed, allKeys, userId: 1, relatedOnly: true,
    scheduleRebuild: (reason) => { scheduled.push(reason); },
    advanceState: async (payload) => { advances.push(payload); return true; },
  });
  assert.ok(Array.isArray(ids), "證明通過就該回答，不因輪次標記換了就退回即時算");
  assert.deepEqual(scheduled, []);
  assert.equal(advances.length, 1);
  assert.equal(advances[0].reason, "round_marker");
  assert.equal(advances[0].roundMarker, "|");

  // 沒有提供 advanceState（例如離線測試）⇒ 一樣要回答，只是不推進。
  const noAdvance = await loadMaterializedDistrictClosure(materializedExec(fx, { state: { round_marker: "舊的一輪|" } }), {
    allowed, allKeys, userId: 1, relatedOnly: true,
  });
  assert.ok(Array.isArray(noAdvance));

  // 但「無法逐列證明」時，輪次標記換了就是真的過期 ⇒ 重算。
  const scheduled2 = [];
  const stale = await loadMaterializedDistrictClosure(materializedExec(fx, {
    state: { round_marker: "舊的一輪|", revision_watermark: 100, revision: 105 },
    delta: [{ id: 101, entity_id: null, event_type: "same_house_merge" }],
  }), {
    allowed, allKeys, userId: 1, relatedOnly: true,
    scheduleRebuild: (reason) => { scheduled2.push(reason); },
    advanceState: async () => { throw new Error("不該推進"); },
  });
  assert.equal(stale, null);
  assert.deepEqual(scheduled2, ["delta_unverifiable"]);
});

test("已登記為與圖無關的事件（listing_offline_confirmed）不必重算；其他 NULL entity_id 一律重算", async () => {
  const fx = fixture();
  const base = { revision_watermark: 100, revision: 105 };
  const irrelevant = materializedExec(fx, {
    state: base, delta: [{ id: 101, entity_id: null, event_type: "listing_offline_confirmed" }],
  });
  assert.ok(Array.isArray(await loadMaterializedDistrictClosure(irrelevant, {
    allowed, allKeys, userId: 1, relatedOnly: true,
  })), "批次下架不動 match_post_id／source_key ⇒ 不該逼出重算");
  const merge = materializedExec(fx, {
    state: base, delta: [{ id: 101, entity_id: null, event_type: "same_house_merge" }],
  });
  assert.equal(await loadMaterializedDistrictClosure(merge, {
    allowed, allKeys, userId: 1, relatedOnly: true,
  }), null, "同屋源合併會改 match_post_id ⇒ 必須重算");
});

test("逐列證明：被指名的列圖相關狀態沒變 ⇒ 仍然新鮮；變了 ⇒ 過期並排重算", async () => {
  const fx = fixture();
  const same = materializedExec(fx, {
    state: { revision_watermark: 100, revision: 105 },
    delta: [{ id: 101, entity_id: 10 }, { id: 102, entity_id: 11 }],
    verifyRows: [
      { post_id: 10, cur_match: 11, cur_prefix: ALLOWED_PREFIX, in_table: true, stored_match: 11, stored_prefix: ALLOWED_PREFIX },
      { post_id: 11, cur_match: 12, cur_prefix: OTHER_PREFIX, in_table: true, stored_match: 12, stored_prefix: OTHER_PREFIX },
    ],
  });
  const okIds = await loadMaterializedDistrictClosure(same, { allowed, allKeys, userId: 1, relatedOnly: true });
  assert.ok(Array.isArray(okIds), "圖相關狀態相同時應該可以採用材料化");

  const scheduled = [];
  const changed = materializedExec(fx, {
    state: { revision_watermark: 100, revision: 105 },
    delta: [{ id: 101, entity_id: 10 }],
    verifyRows: [
      { post_id: 10, cur_match: 99, cur_prefix: ALLOWED_PREFIX, in_table: true, stored_match: 11, stored_prefix: ALLOWED_PREFIX },
    ],
  });
  assert.equal(await loadMaterializedDistrictClosure(changed, {
    allowed, allKeys, userId: 1, relatedOnly: true, scheduleRebuild: (reason) => { scheduled.push(reason); },
  }), null);
  assert.deepEqual(scheduled, ["graph_changed"]);

  // 改名（source_key 換行政區）也會換掉種子資格 ⇒ 必須過期。
  const scheduled2 = [];
  const renamed = materializedExec(fx, {
    state: { revision_watermark: 100, revision: 105 },
    delta: [{ id: 101, entity_id: 10 }],
    verifyRows: [
      { post_id: 10, cur_match: 11, cur_prefix: OTHER_PREFIX, in_table: true, stored_match: 11, stored_prefix: ALLOWED_PREFIX },
    ],
  });
  assert.equal(await loadMaterializedDistrictClosure(renamed, {
    allowed, allKeys, userId: 1, relatedOnly: true, scheduleRebuild: (reason) => { scheduled2.push(reason); },
  }), null);
  assert.deepEqual(scheduled2, ["graph_changed"]);
});

test("graphRowDiffers：只在「圖相關狀態」真的不同時才算過期", () => {
  const base = { post_id: 5, cur_match: 7, cur_prefix: ALLOWED_PREFIX, in_table: true, stored_match: 7, stored_prefix: ALLOWED_PREFIX };
  assert.equal(graphRowDiffers(base), false);
  assert.equal(graphRowDiffers({ ...base, cur_match: 7 }), false);
  assert.equal(graphRowDiffers({ ...base, cur_match: 8 }), true);
  assert.equal(graphRowDiffers({ post_id: 5, cur_match: 7, cur_prefix: ALLOWED_PREFIX, in_table: false, stored_match: null, stored_prefix: null }), true);
  assert.equal(graphRowDiffers({ post_id: 5, cur_match: null, cur_prefix: OTHER_PREFIX, in_table: false, stored_match: null, stored_prefix: null }), false);
  assert.equal(graphRowDiffers({ ...base, cur_prefix: OTHER_PREFIX }), true);
  assert.equal(graphRowDiffers({ post_id: 5, cur_match: null, cur_prefix: null, in_table: true, stored_match: null, stored_prefix: ALLOWED_PREFIX }), true);
});

test("componentLabels：分量代表是分量內最小 post_id，且與邊的輸入順序無關", () => {
  const a = componentLabels([[30, 31], [10, 11], [11, 12]]);
  const b = componentLabels([[11, 12], [30, 31], [10, 11]]);
  assert.equal(a.repOf(10), 10);
  assert.equal(a.repOf(12), 10);
  assert.equal(a.repOf(31), 30);
  assert.equal(a.repOf(99), undefined);
  assert.deepEqual([...a.allLabels()].sort(), [...b.allLabels()].sort());
  assert.equal(a.edgeCount, 3);
});

test("待機不寫：pg_is_in_recovery()=true ⇒ 一行 SQL（更別說寫入）都不發", async () => {
  const issued = [];
  const driver = {
    query: async (sql) => {
      issued.push(sql);
      if (/pg_is_in_recovery/.test(sql)) return { rows: [{ in_recovery: true }] };
      throw new Error(`待機上不該再問任何 SQL：${sql}`);
    },
  };
  const result = await rebuildMatchComponents(driver, { reason: "test" });
  assert.deepEqual(result, { skipped: "in_recovery" });
  assert.equal(issued.length, 1);
});

test("寫入放大：分量沒變 ⇒ 不發 DELETE／INSERT，只更新狀態列；變了 ⇒ 一個交易內一批", async () => {
  const writes = [];
  const makeDriver = ({ diffCount, existingCount, incomingCount }) => ({
    query: async (sql) => {
      writes.push({ sql: sql.replace(/\s+/g, " ").trim().slice(0, 64) });
      if (/pg_is_in_recovery/.test(sql)) return { rows: [{ in_recovery: false }] };
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ ok: true }] };
      if (/pg_advisory_unlock/.test(sql)) return { rows: [{}] };
      if (/CREATE TABLE|CREATE INDEX/.test(sql)) return { rows: [] };
      if (/MAX\(id\), 0\) FROM data_revision/.test(sql)) {
        return { rows: [{ revision: 100, covering: null, system_covering: null, covers_max: null, stat_fingerprint: 7, built_db: "test" }] };
      }
      if (/FROM listings WHERE match_post_id > 0/.test(sql)) {
        return { rows: [{ post_id: 10, match_post_id: 11 }, { post_id: 11, match_post_id: 12 }] };
      }
      if (/AS diff_count/.test(sql)) return { rows: [{ existing_count: existingCount, incoming_count: incomingCount, diff_count: diffCount }] };
      if (/INSERT INTO listing_match_component_state/.test(sql)) return { rows: [] };
      throw new Error(`不認得的 SQL：${sql}`);
    },
    withTransaction: async (fn) => fn({
      query: async (sql) => { writes.push({ sql: sql.replace(/\s+/g, " ").trim().slice(0, 64), tx: true }); return { rows: [] }; },
    }),
  });

  writes.length = 0;
  const unchanged = await rebuildMatchComponents(makeDriver({ diffCount: 0, existingCount: 2, incomingCount: 2 }), { reason: "noop" });
  assert.equal(unchanged.changed, false);
  assert.equal(writes.filter((w) => w.tx).length, 0, "沒變就不該進交易");
  assert.equal(writes.filter((w) => /INSERT INTO listing_match_component_state/.test(w.sql)).length, 1);

  writes.length = 0;
  const changed = await rebuildMatchComponents(makeDriver({ diffCount: 3, existingCount: 2, incomingCount: 2 }), { reason: "diff" });
  assert.equal(changed.changed, true);
  const tx = writes.filter((w) => w.tx).map((w) => w.sql);
  assert.equal(tx.length, 3, `一個交易內只准 DELETE＋INSERT＋狀態（實際 ${JSON.stringify(tx)}）`);
  assert.match(tx[0], /^DELETE FROM listing_match_component/);
  assert.match(tx[1], /^INSERT INTO listing_match_component \(/);
  assert.match(tx[2], /^INSERT INTO listing_match_component_state/);
});

test("背景排程在非 PG driver 下是 no-op（離線測試不會去打 DB）", async () => {
  const { scheduleMatchComponentRebuild, advanceMatchComponentStateLazy } = await import("../src/listingMatchComponents.js");
  resetRebuildScheduleForTest();
  const previous = process.env.DB_DRIVER;
  delete process.env.DB_DRIVER;
  try {
    assert.deepEqual(await scheduleMatchComponentRebuild("test"), { skipped: "not_postgres" });
    assert.equal(await advanceMatchComponentStateLazy({ revision: 1, expectedRevision: 1 }), false);
  } finally {
    if (previous != null) process.env.DB_DRIVER = previous;
    resetRebuildScheduleForTest();
  }
});

test("advanceMatchComponentState：待機不寫、CAS 只有贏家回 true", async () => {
  const { advanceMatchComponentState } = await import("../src/repository/writePath.js");
  const recoveryOnly = [];
  assert.equal(await advanceMatchComponentState({
    query: async (sql) => { recoveryOnly.push(sql); return { rows: [{ in_recovery: true }] }; },
  }, { expectedRevision: 1, revision: 2, roundMarker: "x", statFingerprint: 3 }), false);
  assert.equal(recoveryOnly.length, 1, "待機上只准問 recovery 那一次，不得發出任何 UPDATE");

  const issued = [];
  const driverWith = (rowCount) => ({
    query: async (sql, params = []) => {
      issued.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      if (/pg_is_in_recovery/.test(sql)) return { rows: [{ in_recovery: false }] };
      return { rowCount };
    },
  });
  assert.equal(await advanceMatchComponentState(driverWith(1), {
    expectedRevision: 10, revision: 12, roundMarker: "a|b", statFingerprint: 7,
  }), true);
  const update = issued.find((entry) => /^UPDATE listing_match_component_state/.test(entry.sql));
  assert.ok(update, "應該要發一句 UPDATE");
  assert.match(update.sql, /WHERE state_key = \$4 AND revision_watermark = \$5/);
  assert.deepEqual(update.params, [12, "a|b", 7, MATCH_GRAPH_STATE_KEY, 10]);

  assert.equal(await advanceMatchComponentState(driverWith(0), {
    expectedRevision: 10, revision: 12, roundMarker: "a|b", statFingerprint: 7,
  }), false, "CAS 沒中（別的行程已經推過）⇒ 回 false");
});

test("材料化表名固定（改名就會讓舊表的資料被靜默忽略）", () => {
  assert.equal(MATCH_COMPONENT_TABLE, "listing_match_component");
  assert.equal(MATCH_COMPONENT_STATE_TABLE, "listing_match_component_state");
  assert.equal(MATCH_GRAPH_STATE_KEY, "match_graph");
});
