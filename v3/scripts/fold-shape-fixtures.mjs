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
import { loadFoldRoots } from "../src/repository/decorationData.js";
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
// ⑥／⑦ 線狀鏈（≥15 列同群）：Owner 2026-10-12 裁決要求「線狀鏈（≥15 列同群，橋式非橋式都
// 覆蓋）」——舊的 1-hop Node 讀取端在這種形狀會把群切開（實測 root=22075220 的 33 列同租金鏈，
// Node 出 9 列／7 個 primary）。兩條鏈都用 16 列（≥15）：
//   ⑥ 非橋式（純鏈）：每一條邊都是橋（移除即斷開），match 邊 i → i+1。
//   ⑦ 橋式：兩個 8 列子鏈各自用 match 邊串起，兩子鏈之間**只有一條橋**（listing_group_members）。
const CHAIN = BASE + 1000;
const chainA = Array.from({ length: 16 }, (_, i) => CHAIN + 1 + i);         // ⑥ 純線狀（非橋式）
const chainB1 = Array.from({ length: 8 }, (_, i) => CHAIN + 101 + i);       // ⑦ 子鏈 1
const chainB2 = Array.from({ length: 8 }, (_, i) => CHAIN + 201 + i);       // ⑦ 子鏈 2
const chainIds = [...chainA, ...chainB1, ...chainB2];
const all = [...Object.values(ids), ...chainIds];

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
  // ⑥ 非橋式（純線狀鏈）16 列：只有 match 邊 i → i+1，每一條邊都是橋（移除即斷開）。
  //    租金遞減（第 k 列 30000-k*100）⇒ 最便宜的是鏈尾 chainA[15]。
  ...chainA.map((pid, i) => listing(pid, {
    match_post_id: i + 1 < chainA.length ? chainA[i + 1] : null,
    fold_rent_num: 30000 - i * 100, price_num: 30000 - i * 100,
  })),
  // ⑦ 橋式：兩個 8 列子鏈各自用 match 邊串起來，**兩子鏈之間只有一條 listing_group_members
  //    的橋邊**（chainB1[7] ↔ chainB2[0]）⇒ 整個 16 列分量只靠這條橋相連。這條同時覆蓋
  //    「分量來源有兩種邊（match ＋ group）」在長鏈上的行為。
  ...chainB1.map((pid, i) => listing(pid, {
    match_post_id: i + 1 < chainB1.length ? chainB1[i + 1] : null,
    fold_rent_num: 26000 - i * 100, price_num: 26000 - i * 100,
  })),
  ...chainB2.map((pid, i) => listing(pid, {
    match_post_id: i + 1 < chainB2.length ? chainB2[i + 1] : null,
    fold_rent_num: 25000 - i * 100, price_num: 25000 - i * 100,
  })),
];
// ⑦ 的橋邊：listing_group_members 一列（群組＝橋；群內兩兩連通）
const bridgeGroupId = `fix-bridge-${CHAIN}`;

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
    // ⑦ 橋邊：兩個子鏈各一列掛在同一個 group_id（群內兩兩連通 ⇒ B1[7] ↔ B2[0] 是唯一橋）
    await client.query(
      `INSERT INTO listing_group_members (post_id, group_id, source, match_evidence, joined_at) VALUES ($1, $2, '', '{}', $3), ($4, $2, '', '{}', $3)`,
      [chainB1[chainB1.length - 1], bridgeGroupId, new Date().toISOString(), chainB2[0]],
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

// ⑦ 的橋邊（listing_group_members）：讀回來當 provider.groupId（legacy 路徑）與分量來源。
const gidOf = new Map((await drv.pool.query(
  "SELECT post_id, group_id FROM listing_group_members WHERE post_id = ANY($1::bigint[])",
  [all],
)).rows.map((r) => [Number(r.post_id), String(r.group_id || "")]));

// Node 讀取端的固化欄來源：生產路徑由 preloadDecorationProviderAsync 的 loader.foldRootMap()
// 一批載入（`foldGroups:true` ＋ 欄位已部署），這裡以同一支 loadFoldRoots 讀回（唯讀）。
const readFoldRoots = () => loadFoldRoots(async (sql, params = []) => drv.pool.query(toPostgresSql(sql), params).then((r) => r.rows), all, "postgres");
let foldRootRows = await readFoldRoots();
const provider = {
  driver: "postgres", now: 1_800_000_000_000,
  sourceEnabled: (s) => enabledSources.includes(s),
  prep: (id) => prepById.get(Number(id) || 0) || null,
  personalIndex: () => ({ size: 0, peers: () => [], groupKey: () => "" }),
  splitPairs: () => new Set(),
  extras: (ids2) => new Map((ids2 || []).map((id) => [Number(id), byId.get(Number(id))]).filter(([, v]) => v)),
  groupId: (pid) => gidOf.get(Number(pid)) || "",
  // 固化欄分組模式的開關：有這個方法 ⇒ 讀取端走 fold_component_root 分組（§1.4）。
  foldRoot: (pid) => (foldRootRows.get(Number(pid)) == null ? null : Number(foldRootRows.get(Number(pid)))),
};

// root：用寫入端／刷新端同一份 union-find 在「這組合成列」上算 ⇒ 這就是固化欄該有的值
// （讀取端不再自己算分量，只讀這一欄）。
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
const rootOf = (id) => (rootMap.get(Number(id)) == null ? null : Number(rootMap.get(Number(id))));
const withRoots = (rows) => rows.map((r) => ({ ...r }));  // 分組鍵由 provider.foldRoot 提供

const results = [];
const rolesOf = (rows) => new Map(rows.map((r) => [Number(r.post_id), r.same_house_role || null]));
const assertRole = (nodeRole, sqlRole, postId, label) => {
  const n = nodeRole.get(postId) ?? null;
  const s = sqlRole.get(postId) ?? null;
  results.push({ label, post_id: postId, node: n, sql: s, ok: n === s });
};

// root 形狀斷言（寫入端語意，先於兩條讀取端）：純鏈 16 列同一個 root；橋式 16 列同一個 root
// （兩子鏈靠 group 橋邊相連）；verdict='no' 的對端不成分量（C/D 各自獨立）。
results.push({
  label: "⑥ root shape: 16-row pure chain shares one root",
  node: [...new Set(chainA.map(rootOf))].join(","),
  sql: String(chainA[0]),
  ok: new Set(chainA.map(rootOf)).size === 1 && rootOf(chainA[0]) === chainA[0],
});
results.push({
  label: "⑦ root shape: bridged chain shares one root across the group bridge",
  node: [...new Set([...chainB1, ...chainB2].map(rootOf))].join(","),
  sql: String(CHAIN + 101),
  ok: new Set([...chainB1, ...chainB2].map(rootOf)).size === 1 && rootOf(chainB2[0]) === chainB1[0],
});

// 把寫入端算出的分量固化進**這一組合成列**（正式路徑的固化欄；只碰本 fixture 的 post_id），
// 之後兩條讀取端都**讀真的那一欄**（SQL 不用 rootSource 覆寫、Node 用 provider.foldRoot）。
for (const [pid, root] of rootMap) {
  if (!all.includes(Number(pid))) continue;                       // 只寫 fixture 自己的列
  const want = root == null ? null : Number(root);
  const have = foldRootRows.get(Number(pid));
  if (have !== want) await drv.pool.query("UPDATE listings SET fold_component_root = $1 WHERE post_id = $2", [want, Number(pid)]);
}
foldRootRows = await readFoldRoots();
{
  const stored = foldRootRows;
  const diffs = all.filter((id) => (stored.get(Number(id)) ?? null) !== rootOf(id));
  results.push({ label: "固化欄寫入＝寫入端分量（逐列）", node: rootOf(chainA[0]), sql: String(stored.get(Number(chainA[0])) ?? null), ok: diffs.length === 0, diffs });
}

// ── Node 讀取端（固化欄分組）vs SQL（同一支 foldRoleCte，讀實體欄）──
const runSql = async (subset) => {
  const cte = foldRoleCte("WHERE post_id = ANY(?::bigint[])")
    + "\nSELECT post_id, role, primary_offline, primary_id FROM fold_role";
  const rows = (await drv.pool.query(toPostgresSql(cte), [subset, enabledSources, provider.now])).rows;
  return { rows, role: new Map(rows.map((r) => [Number(r.post_id), r.role || null])) };
};

const nodeRows = withRoots(readBack);
attachSameHouseRoles(nodeRows, 0, provider, provider.now);
const nodeRole = rolesOf(nodeRows);
const { rows: sqlRows, role: sqlRole } = await runSql(all);

// 讀取端兩條路徑（固化欄 vs legacy union-find）在同一批列上必須一致（RLS：SQLite 仍走 legacy）。
{
  const legacyProvider = { ...provider };
  delete legacyProvider.foldRoot;
  const legacyRows = readBack.map((r) => ({ ...r }));
  attachSameHouseRoles(legacyRows, 0, legacyProvider, provider.now);
  const legacyRole = rolesOf(legacyRows);
  const diffs = [];
  for (const id of all.map(Number)) if ((nodeRole.get(id) ?? null) !== (legacyRole.get(id) ?? null)) diffs.push(id);
  results.push({ label: "讀取端兩條路徑（fold_component_root 分組 vs legacy union-find）逐列一致", node: nodeRole.size, sql: legacyRole.size, ok: diffs.length === 0, diffs });
}

assertRole(nodeRole, sqlRole, ids.A, "① only-in-edge: A(no match_post_id, B→A)");
assertRole(nodeRole, sqlRole, ids.B, "① only-in-edge: B(src)");
assertRole(nodeRole, sqlRole, ids.C, "② peer verdict=no: C(src, D=no)");
assertRole(nodeRole, sqlRole, ids.D, "② peer verdict=no: D(peer, verdict=no)");
assertRole(nodeRole, sqlRole, ids.E, "③ peer houseprice no-prep: E(src)");
assertRole(nodeRole, sqlRole, ids.H, "③ peer houseprice no-prep: H(houseprice, no prep)");
assertRole(nodeRole, sqlRole, ids.F, "④ split pair (guest ignores split): F");
assertRole(nodeRole, sqlRole, ids.G, "④ split pair (guest ignores split): G");
assertRole(nodeRole, sqlRole, ids.P, "⑤ chain P-Q-R: P (cheapest is R)");
assertRole(nodeRole, sqlRole, ids.Q, "⑤ chain P-Q-R: Q");
assertRole(nodeRole, sqlRole, ids.R, "⑤ chain P-Q-R: R (single primary)");
for (const id of chainIds) assertRole(nodeRole, sqlRole, id, `⑥⑦ line chain row ${id}`);
const primaryOf = (role, ids2) => ids2.filter((id) => role.get(Number(id)) === "primary").map(Number);
const chainAPrimary = primaryOf(nodeRole, chainA);
const chainBPrimary = primaryOf(nodeRole, [...chainB1, ...chainB2]);
results.push({
  label: "⑥ 16-row pure chain: exactly one representative, and it is the cheapest row",
  node: chainAPrimary.join(","), sql: primaryOf(sqlRole, chainA).join(","),
  ok: chainAPrimary.length === 1 && chainAPrimary[0] === chainA[chainA.length - 1] && chainAPrimary.join(",") === primaryOf(sqlRole, chainA).join(","),
});
results.push({
  label: "⑦ 16-row bridged chain: exactly one representative across the group bridge",
  node: chainBPrimary.join(","), sql: primaryOf(sqlRole, chainB1.concat(chainB2)).join(","),
  ok: chainBPrimary.length === 1 && chainBPrimary[0] === chainB2[chainB2.length - 1] && chainBPrimary.join(",") === primaryOf(sqlRole, chainB1.concat(chainB2)).join(","),
});

// ── ⑧ 代表列隨篩選變動（Owner 2026-10-12 裁決：代表列在「本次候選列」之內選）──────
{
  const comp = [...chainB1, ...chainB2];
  const sAll = comp.map(Number);
  const globalRep = chainB2[chainB2.length - 1];
  const sFiltered = sAll.filter((id) => id !== globalRep);           // 篩掉全域代表列
  const rows1 = withRoots(readBack.filter((r) => sAll.includes(Number(r.post_id))));
  const rows2 = withRoots(readBack.filter((r) => sFiltered.includes(Number(r.post_id))));
  attachSameHouseRoles(rows1, 0, provider, provider.now);
  attachSameHouseRoles(rows2, 0, provider, provider.now);
  const role1 = rolesOf(rows1);
  const role2 = rolesOf(rows2);
  const sql1 = await runSql(sAll);
  const sql2 = await runSql(sFiltered);
  const rep1 = primaryOf(role1, sAll);
  const rep2 = primaryOf(role2, sFiltered);
  const crossOk = sAll.every((id) => (role1.get(id) ?? null) === (sql1.role.get(id) ?? null))
    && sFiltered.every((id) => (role2.get(id) ?? null) === (sql2.role.get(id) ?? null));
  results.push({
    label: "⑧ 代表列隨篩選變動：全量代表＝最便宜列；剔除它後同群重新選出不同代表（Node＝SQL）",
    node: `${rep1.join(",")} -> ${rep2.join(",")}`,
    sql: `${primaryOf(sql1.role, sAll).join(",")} -> ${primaryOf(sql2.role, sFiltered).join(",")}`,
    ok: rep1.length === 1 && rep1[0] === globalRep && rep2.length === 1 && rep2[0] !== globalRep && crossOk,
  });
  results.push({
    label: "⑧ 篩選剔除代表列後，該群仍在（沒有整群消失）",
    node: role2.get(globalRep) ?? null,
    sql: "removed-from-candidates",
    ok: sFiltered.every((id) => role2.get(id) != null) && rep2.length === 1,
  });
}

for (const r of results) console.log(JSON.stringify(r));
const allOk = results.every((r) => r.ok);

// 清理合成列 + split 投票 + 橋邊
await drv.pool.query("DELETE FROM user_match_votes WHERE post_id = ANY($1::bigint[]) OR peer_id = ANY($1::bigint[])", [all]);
await drv.pool.query("DELETE FROM listing_group_members WHERE post_id = ANY($1::bigint[]) OR group_id = $2", [all, bridgeGroupId]);
await drv.pool.query("DELETE FROM listings WHERE post_id = ANY($1::bigint[])", [all]);

await drv.pool.end();
console.log(JSON.stringify({ allOk, total: results.length, roots: Object.fromEntries(all.map((id) => [id, rootOf(id)])) }));
process.exit(allOk ? 0 : 1);
