// (C) 5 種折疊邊形的合成列 fixture（repro 隔離庫，插入合成列 → Node vs SQL 折疊 → 斷言 → 清理）。
// 驗證 foldRoleCte（Owner 2026-10-12 准 (B)：讀 fold_component_root ＋分量內排名）與
// attachSameHouseRoles 對「危險邊形」逐位元一致：
//   ① 只有入邊（我沒有 match_post_id，別人指我）
//   ② 對端 match_verdict='no'
//   ③ 對端是 houseprice 且沒有 listing_prep 列（不顯示就緒）
//   ④ split 對（user_match_votes vote='split'）—— 訪客 uid=0 無 split，故只驗 Node 側語意標記。
//   ⑤ 鏈狀 P–Q–R：舊的 first-incident-edge 會產生兩個 primary，現在兩條路徑都必須只有 R。
// root 由 foldComponentRoot.js 的同一份 union-find 在「這組合成列」上算出（與 Node 同一個 universe），
// 以參數餵給 SQL（rootSource）⇒ 不寫任何列、也不依賴回填狀態。
// 用法：PG_URL=$PG_LIVE_REPRO_URL node v3/scripts/fold-shape-fixtures.mjs
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { attachSameHouseRoles } from "../src/db.js";
import { componentRootMap } from "../src/foldComponentRoot.js";
import { foldRoleCte } from "../src/listingSearchSql.js";
import { normalizeCrawlSources } from "../src/crawlSources.js";

assertPgTargetAllowed("fold-shape-fixtures", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });
const drv = await createPostgresDriver({ env: process.env });

// 用一個高區段、碰撞機率低的 post_id 命名空間。
const BASE = 9_100_000_000;
const ids = {
  A: BASE + 1,      // 只有入邊目標（無 match_post_id）
  B: BASE + 2,      // B → A（普通邊）
  C: BASE + 3,      // C → D，D.match_verdict='no'
  D: BASE + 4,      // verdict='no' 的對端
  E: BASE + 5,      // E → H，H 是 houseprice 且無 prep
  H: BASE + 6,      // houseprice、無 prep 列
  F: BASE + 7,      // split 對：F ↔ G，user_match_votes 有 vote='split'
  G: BASE + 8,
  P: BASE + 11,     // 鏈狀 P → Q → R（Q 與 R 都比 P 便宜 ⇒ 舊演算法會出兩個 primary）
  Q: BASE + 12,
  R: BASE + 13,
};
const all = Object.values(ids);

const enabledSources = ["591", "hbhousing", "sinyi", "houseprice", "ddroom", "housefun", "self"];

function listing(post_id, overrides = {}) {
  return {
    post_id, source: "591", source_id: `s${post_id}`, url: `u${post_id}`, match_post_id: null, match_verdict: null,
    offline: 0, offline_confirmed: 0, hidden: 0, last_seen_at: "2026-10-01T00:00:00.000Z",
    fold_rent_num: 20000, fold_refresh_kind: 1, fold_refresh_rel_ms: 3600_000, fold_refresh_abs_ms: null,
    price_num: 20000, price: "20000元", refresh_time: "1 小時前", first_seen_at: "2026-10-01T00:00:00.000Z",
    title: `t${post_id}`, ...overrides,
  };
}

const shapeRows = [
  // ① only-in-edge: B → A（A 無 match_post_id）
  listing(ids.A),
  listing(ids.B, { match_post_id: ids.A }),
  // ② 對端 verdict='no': C → D，D.match_verdict='no'
  listing(ids.C, { match_post_id: ids.D }),
  listing(ids.D, { match_verdict: "no" }),
  // ③ 對端 houseprice 且無 prep: E → H
  listing(ids.E, { match_post_id: ids.H }),
  listing(ids.H, { source: "houseprice", source_id: "hp" + ids.H, url: "" }),
  // ④ split 對: F ↔ G（訪客 uid=0 無 splitPairs ⇒ 兩邊都照常折疊；釘住現行「split 被忽略」語意，
  //    避免將來有人修 loadUserSplitPairSet 時悄悄改變訪客顯示）。
  listing(ids.F, { match_post_id: ids.G }),
  listing(ids.G, { match_post_id: ids.F }),
  // ⑤ 鏈狀：P → Q → R，租金 R < Q < P ⇒ 唯一主卡應該是 R
  listing(ids.P, { match_post_id: ids.Q, fold_rent_num: 20000, price_num: 20000 }),
  listing(ids.Q, { match_post_id: ids.R, fold_rent_num: 18000, price_num: 18000 }),
  listing(ids.R, { fold_rent_num: 16000, price_num: 16000 }),
];

// 插入合成列（listings 的 NOT NULL 欄由 information_schema 推導）。
const client = await drv.pool.connect();
try {
  const required = (await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema='public' AND table_name='listings' AND is_nullable='NO' AND column_default IS NULL AND is_identity='NO'
     ORDER BY ordinal_position`,
  )).rows;
  const reqByName = new Map(required.map((c) => [c.column_name, c.data_type]));
  const insertCols = (row) => {
    const names = [...new Set([...required.map((c) => c.column_name), ...Object.keys(row)])];
    const values = names.map((name) => {
      if (name in row) return row[name];
      return /int|numeric|real|double|bigint|smallint/i.test(reqByName.get(name) || "") ? 0 : "";
    });
    return { names, values };
  };
  await client.query("BEGIN");
  try {
    for (const row of shapeRows) {
      const { names, values } = insertCols(row);
      await client.query(
        `INSERT INTO listings(${names.map((n) => `"${n}"`).join(",")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(",")})`,
        values,
      );
    }
    // ④ split 投票（user_id=1 的 split 票，訪客 uid=0 不會讀到）
    await client.query(
      "INSERT INTO user_match_votes (user_id, post_id, peer_id, vote, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)",
      [1, ids.F, ids.G, "split", new Date().toISOString()],
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  }
} finally {
  client.release();
}

// 讀回 + prep（H 刻意不建 prep 列）
const readBack = (await drv.pool.query(
  `SELECT post_id, source, source_id, url, match_post_id, match_verdict, offline, offline_confirmed, hidden, last_seen_at,
          fold_rent_num, fold_refresh_kind, fold_refresh_rel_ms, fold_refresh_abs_ms, price_num, price, refresh_time, first_seen_at
   FROM listings WHERE post_id = ANY($1::bigint[]) ORDER BY post_id`,
  [all],
)).rows;
const byId = new Map(readBack.map((r) => [Number(r.post_id), r]));
const prepById = new Map((await drv.pool.query("SELECT post_id, display_ready FROM listing_prep WHERE post_id = ANY($1::bigint[])", [all])).rows.map((r) => [Number(r.post_id), r]));

const provider = {
  driver: "postgres", now: 1_800_000_000_000,
  sourceEnabled: (s) => enabledSources.includes(s),
  prep: (id) => prepById.get(Number(id) || 0) || null,
  personalIndex: () => ({ size: 0, peers: () => [], groupKey: () => "" }),
  splitPairs: () => new Set(),
  extras: (ids2) => new Map((ids2 || []).map((id) => [Number(id), byId.get(Number(id))]).filter(([, v]) => v)),
};

// Node ground truth
const nodeRows = readBack.map((r) => ({ ...r }));
attachSameHouseRoles(nodeRows, 0, provider, provider.now);
const nodeRole = new Map(nodeRows.map((r) => [Number(r.post_id), r.same_house_role || null]));

// root：用讀取端／刷新端同一份 union-find，在「這組合成列」上算（universe 與 Node 相同）。
const gidOf = new Map(); // 這組 fixture 沒有 listing_group_members
const rootMap = componentRootMap({
  rows: readBack.map((r) => ({ ...r, prep_display_ready: Number(prepById.get(Number(r.post_id))?.display_ready) === 1 ? 1 : 0 })),
  groupIdOf: (pid) => gidOf.get(Number(pid)) || "",
  splits: new Set(),
  isNotDisplayReady: (row) => {
    if (!enabledSources.includes(String(row.source || "591"))) return true;
    if (String(row.source) !== "houseprice") return false;
    return Number(row.prep_display_ready) === 1 ? false : true;
  },
});

// SQL fold：**用生產路徑的同一支 foldRoleCte**（root 以參數餵入；不寫任何列）
const rootIds = all.map((id) => Number(id));
const rootVals = all.map((id) => (rootMap.get(Number(id)) == null ? null : Number(rootMap.get(Number(id)))));
const cte = foldRoleCte("WHERE post_id = ANY(?::bigint[])", { rootSource: "unnest(?::bigint[], ?::bigint[]) AS t(post_id, fold_component_root)" })
  + "\nSELECT post_id, role, primary_offline, primary_id FROM fold_role";
const sqlRows = (await drv.pool.query(toPostgresSql(cte), [rootIds, rootVals, all, enabledSources, provider.now])).rows;
const sqlRole = new Map(sqlRows.map((r) => [Number(r.post_id), r.role || null]));

// 斷言 4 形狀
const results = [];
const assertRole = (postId, label) => {
  const n = nodeRole.get(postId) ?? null;
  const s = sqlRole.get(postId) ?? null;
  const ok = n === s;
  results.push({ label, post_id: postId, node: n, sql: s, ok });
};

assertRole(ids.A, "① only-in-edge: A(no match_post_id, B→A)");
assertRole(ids.B, "① only-in-edge: B(src)");
assertRole(ids.C, "② peer verdict=no: C(src, D=no)");
assertRole(ids.D, "② peer verdict=no: D(peer, verdict=no)");
assertRole(ids.E, "③ peer houseprice no-prep: E(src)");
assertRole(ids.H, "③ peer houseprice no-prep: H(houseprice, no prep)");
assertRole(ids.F, "④ split pair (guest ignores split): F");
assertRole(ids.G, "④ split pair (guest ignores split): G");
assertRole(ids.P, "⑤ chain P-Q-R: P (cheapest is R)");
assertRole(ids.Q, "⑤ chain P-Q-R: Q");
assertRole(ids.R, "⑤ chain P-Q-R: R (single primary)");
const nodePrimaries = nodeRows.filter((r) => r.same_house_role === "primary").map((r) => Number(r.post_id)).sort();
const sqlPrimaries = sqlRows.filter((r) => r.role === "primary").map((r) => Number(r.post_id)).sort();
results.push({ label: "⑤ exactly one primary in the chain component", node: nodePrimaries.join(","), sql: sqlPrimaries.join(","), ok: String(nodePrimaries) === String(sqlPrimaries) && nodePrimaries.includes(ids.R) });

for (const r of results) console.log(JSON.stringify(r));
const allOk = results.every((r) => r.ok);

// 清理合成列 + split 投票
await drv.pool.query("DELETE FROM user_match_votes WHERE post_id = ANY($1::bigint[]) OR peer_id = ANY($1::bigint[])", [all]);
await drv.pool.query("DELETE FROM listings WHERE post_id = ANY($1::bigint[])", [all]);

await drv.pool.end();
console.log(JSON.stringify({ allOk, total: results.length, roots: Object.fromEntries(all.map((id) => [id, rootVals[all.indexOf(id)]])) }));
process.exit(allOk ? 0 : 1);
