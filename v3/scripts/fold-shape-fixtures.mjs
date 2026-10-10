// (C) 4 種折疊邊形的合成列 fixture（repro 隔離庫，插入合成列 → Node vs SQL 折疊 → 斷言 → 清理）。
// 驗證 foldRoleCte 與 attachSameHouseRoles 對「危險邊形」逐位元一致：
//   ① 只有入邊（我沒有 match_post_id，別人指我）
//   ② 對端 match_verdict='no'
//   ③ 對端是 houseprice 且沒有 listing_prep 列（不顯示就緒）
//   ④ split 對（user_match_votes vote='split'）—— 訪客 uid=0 無 split，故只驗 Node 側語意標記。
// 用法：PG_URL=$PG_LIVE_REPRO_URL node v3/scripts/fold-shape-fixtures.mjs
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { attachSameHouseRoles } from "../src/db.js";
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

// SQL fold（foldRoleCte 演算法，scope 到合成 post_id）
const SQL_ROLE = `
WITH cand AS (
  SELECT post_id, source, source_id, url, last_seen_at, offline, match_post_id, match_verdict,
         fold_rent_num, fold_refresh_kind, fold_refresh_rel_ms, fold_refresh_abs_ms
  FROM listings WHERE post_id = ANY($1::bigint[])
),
extras AS (
  SELECT l.post_id, l.source, l.source_id, l.url, l.last_seen_at, l.offline, l.match_post_id, l.match_verdict,
         l.fold_rent_num, l.fold_refresh_kind, l.fold_refresh_rel_ms, l.fold_refresh_abs_ms
  FROM listings l
  WHERE l.post_id IN (SELECT match_post_id FROM cand WHERE match_post_id IS NOT NULL AND match_post_id > 0 AND COALESCE(match_verdict,'') <> 'no')
    AND l.post_id NOT IN (SELECT post_id FROM cand)
),
display AS (
  SELECT u.*,
    (u.source = ANY($2::text[]) AND (u.source <> 'houseprice' OR COALESCE(p.display_ready, 0) = 1)) AS display_ready,
    (CASE WHEN u.fold_refresh_kind = 1 THEN $3::bigint - u.fold_refresh_rel_ms ELSE u.fold_refresh_abs_ms END) AS refresh_ms,
    (u.source || ':' || COALESCE(NULLIF(u.source_id,''), NULLIF(u.url,''), NULLIF(u.post_id,0)::text, '') || ':' || u.post_id::text) AS tie_key
  FROM (SELECT * FROM cand UNION ALL SELECT * FROM extras) u
  LEFT JOIN listing_prep p ON p.post_id = u.post_id
),
edges AS (
  SELECT d.post_id AS src, d.match_post_id AS dst FROM display d
  WHERE d.match_post_id IS NOT NULL AND d.match_post_id > 0 AND COALESCE(d.match_verdict,'') <> 'no'
    AND d.post_id IN (SELECT post_id FROM cand)
),
eff AS (
  SELECT e.src, e.dst FROM edges e JOIN display s ON s.post_id = e.src JOIN display d ON d.post_id = e.dst
  WHERE s.display_ready AND d.display_ready AND COALESCE(d.match_verdict,'') <> 'no'
),
inc AS (
  SELECT src AS x, src AS ord, src, dst FROM eff
  UNION ALL
  SELECT dst AS x, src AS ord, src, dst FROM eff WHERE dst IN (SELECT post_id FROM cand)
),
rk AS (SELECT x, src, dst, row_number() OVER (PARTITION BY x ORDER BY ord ASC, dst ASC) AS rn FROM inc),
fe AS (SELECT x, src, dst FROM rk WHERE rn = 1),
winner AS (
  SELECT fe.x,
    CASE
      WHEN a.fold_rent_num IS NOT NULL AND b.fold_rent_num IS NULL THEN a.post_id
      WHEN b.fold_rent_num IS NOT NULL AND a.fold_rent_num IS NULL THEN b.post_id
      WHEN a.fold_rent_num IS NOT NULL AND b.fold_rent_num IS NOT NULL AND a.fold_rent_num <> b.fold_rent_num
        THEN CASE WHEN a.fold_rent_num < b.fold_rent_num THEN a.post_id ELSE b.post_id END
      WHEN a.refresh_ms <> b.refresh_ms THEN CASE WHEN a.refresh_ms > b.refresh_ms THEN a.post_id ELSE b.post_id END
      WHEN COALESCE(b.last_seen_at,'') <> COALESCE(a.last_seen_at,'')
        THEN CASE WHEN COALESCE(b.last_seen_at,'') < COALESCE(a.last_seen_at,'') THEN a.post_id ELSE b.post_id END
      WHEN a.tie_key <> b.tie_key THEN CASE WHEN a.tie_key < b.tie_key THEN a.post_id ELSE b.post_id END
      ELSE CASE WHEN a.post_id <= b.post_id THEN a.post_id ELSE b.post_id END
    END AS winner_id, a.offline AS a_offline, b.offline AS b_offline, fe.src AS src, fe.dst AS dst
  FROM fe JOIN display a ON a.post_id = fe.src JOIN display b ON b.post_id = fe.dst
)
SELECT x, (CASE WHEN winner_id = x THEN 'primary' ELSE 'affiliate' END) AS role
FROM (SELECT w.x, w.winner_id FROM winner w JOIN fe ON fe.x = w.x) w
`;
const sqlRows = (await drv.pool.query(SQL_ROLE, [all, enabledSources, provider.now])).rows;
const sqlRole = new Map(sqlRows.map((r) => [Number(r.x), r.role]));

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

for (const r of results) console.log(JSON.stringify(r));
const allOk = results.every((r) => r.ok);

// 清理合成列 + split 投票
await drv.pool.query("DELETE FROM user_match_votes WHERE post_id = ANY($1::bigint[]) OR peer_id = ANY($1::bigint[])", [all]);
await drv.pool.query("DELETE FROM listings WHERE post_id = ANY($1::bigint[])", [all]);

await drv.pool.end();
console.log(JSON.stringify({ allOk, total: results.length }));
process.exit(allOk ? 0 : 1);
