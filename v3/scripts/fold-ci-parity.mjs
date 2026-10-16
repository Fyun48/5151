// CI 守門（Owner 2026-10-12 裁決）：在**合成種子資料**上驗「同屋源折疊」兩條路徑語意一致。
//
// 為什麼要有這一支：端點級 35/35 全量 parity 需要 18.4 萬列的凍結快照（人工 merge 前步驟），
// CI 不能用正式資料。這一支把**會分歧的形狀**縮成幾十列合成資料（線狀鏈 ≥15 列同群、橋式／
// 非橋式、代表列隨篩選變動），兩條路徑只要語意分岔就會紅。
//
// 兩種層級都驗（同一支生產程式碼，不另抄一份）：
//   1. 角色級：SQL `foldRoleCte`（讀實體欄）vs Node `attachSameHouseRoles`（provider.foldRoot）。
//   2. 端點級：`buildPublicListingsFoldSql` vs `buildPublicListingsRowsAsync` 的
//      totalMatched ＋ 完整有序 post_id 序列 ＋ 逐列對稱差（只有 Node／只有 SQL）。
//
// 資料主權：**所有列都由本腳本插入、跑完刪除**；`PG_URL` 必須是拋棄式／隔離庫
// （`assertPgTargetAllowed` 白名單）。
// 用法：PG_URL=<disposable> node v3/scripts/fold-ci-parity.mjs
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { withPgReadSnapshot, readPgRows } from "../src/pgReadSnapshot.js";
import {
  attachSameHouseRoles, listingSearchBuildContext, buildListRequestContextFromPg, publicSearchSettings,
  buildPublicListingsClauses, buildPublicListingsRowsAsync, preloadDecorationProviderAsync,
} from "../src/db.js";
import { districtClosureIds } from "../src/listingSearchNodePg.js";
import { buildPublicListingsFoldSql, foldRoleCte } from "../src/listingSearchSql.js";
import { componentRootMap, bumpFoldRootWriteGen } from "../src/foldComponentRoot.js";
import { createDecorationDataLoader, loadFoldRoots, loadGroupIds } from "../src/repository/decorationData.js";
import { refreshListingProjection } from "../src/listingSearchProjection.js";
import { normalizeCrawlSources } from "../src/crawlSources.js";

assertPgTargetAllowed("fold-ci-parity", process.env.PG_URL || "", { allow: ["tracker_test", "crawl_sandbox", "repro", "repro2"] });
const drv = await createPostgresDriver({ env: process.env });
const results = [];
const check = (label, ok, detail = {}) => results.push({ label, ok, ...detail });

// ── 合成種子 ─────────────────────────────────────────────────────────────
// 用高區段、碰撞機率低的 post_id 命名空間（與 fold-shape-fixtures.mjs 不同區段，兩者可並存）。
const BASE = 9_200_000_000;
const CHAIN = BASE + 1000;
const chainA = Array.from({ length: 16 }, (_, i) => CHAIN + 1 + i);      // ⑥ 非橋式純鏈（每條邊都是橋）
const chainB1 = Array.from({ length: 8 }, (_, i) => CHAIN + 101 + i);    // ⑦ 橋式子鏈 1
const chainB2 = Array.from({ length: 8 }, (_, i) => CHAIN + 201 + i);    // ⑦ 橋式子鏈 2
const MARK = "FOLDCI";
const bridgeGroupId = `foldci-bridge-${CHAIN}`;
// ── §6.10 的兩條軸 ＋ collation 軸（Owner 2026-10-12 最後一輪：合成種子必須擋得住）──
// ⑫ tie-break 軸：同群、source=''／source_id・url 皆空、post_id 位數不同（10 位 vs 9 位）、
//    租金／更新時間／last_seen_at 全平手 ⇒ 勝負只由 tie-break key 決定。
//    Node 的 key：'591:9200000041:9200000041' < '591:920000041:920000041'（第 11 字元 '0' < '4'）。
//    舊 SQL（raw `source || ':'`）的 key 是 ':9200000041:…' vs '591:…'，':' (0x3A) > '5' (0x35) ⇒ 選錯列。
const CI_TB_A = BASE + 41;      // 10 位、source=''
const CI_TB_B = 920_000_041;    // 9 位、source='591'（與 CI_TB_A 不同位數）
// ⑬ 資格軸：source='' 且 source_id 有值、租金 10000（對端 30000）⇒ 勝負由租金決定，
//    tie-break 永遠不會被諮詢 ⇒ 這一組只測「資格」那一條（舊 SQL 把 source='' 踢出 elig ⇒ 改選貴的）。
const CI_EL_A = BASE + 51;
const CI_EL_B = BASE + 52;
// ⑭ collation 軸：租金／更新時間／last_seen_at 全平手，source_id 只差一個標點
//    （'A-B' vs 'AB'、'x.y' vs 'xy'）——這是 localeCompare 與 DB collation 最容易分岔的形狀。
const CI_PN_A = BASE + 61; const CI_PN_B = BASE + 62;
const CI_PN_C = BASE + 63; const CI_PN_D = BASE + 64;
// ⑮ Owner 2026-10-16 的單列裁示：代表列「暫離」（offline=1、offline_confirmed=0）＋ 線上 affiliate。
//    這一組就是正式庫 2026-10-16 截圖案例的形狀（591 代表列 offline=1 未確認、另一家來源還在線）：
//    舊的補償條款會讓兩列**同時**出現在清單（同群兩列），移除後端點必須恰好 1 列＝代表列。
//    租金刻意不同（12000 vs 18000）⇒ 勝負由租金先決定，不依賴 tie-break 的細節。
const CI_OFF_A = BASE + 71;   // 591、offline=1 未確認、租金 12000 ⇒ 代表列（且照樣顯示）
const CI_OFF_B = BASE + 72;   // 別家來源、還在線、租金 18000 ⇒ 次卡（只在展開面板）
const axisIds = [CI_TB_A, CI_TB_B, CI_EL_A, CI_EL_B, CI_PN_A, CI_PN_B, CI_PN_C, CI_PN_D, CI_OFF_A, CI_OFF_B];
const all = [...chainA, ...chainB1, ...chainB2, ...axisIds];

// kind 只用於「代表列隨篩選變動」那一組：鏈尾四列是整層住家，其餘是套房 ⇒ 換 kind 篩選會換代表。
const kindName = (pid) => (chainA.indexOf(pid) === chainA.length - 2 ? "整層住家" : "套房");

function seedRow(post_id, overrides = {}) {
  return {
    post_id,
    source: "591",
    source_id: `foldci${post_id}`,
    url: `https://example.test/foldci/${post_id}`,
    title: `${MARK} ${post_id}`,
    address: `測試市測試區同屋源路 ${post_id} 號`,
    kind_name: kindName(post_id),
    area_name: "20坪",
    layout: "2房1廳",
    floor_name: "5/12",
    price: "20000元",
    price_num: 20000,
    extra_fees: "[]",
    extra_fee: 0,
    extra_fee_text: "",
    tags: "[]",
    refresh_time: "",
    first_seen_at: "2026-10-01T00:00:00.000Z",
    last_seen_at: "2026-10-01T00:00:00.000Z",
    match_post_id: null,
    match_verdict: null,
    offline: 0,
    offline_confirmed: 0,
    hidden: 0,
    // 折疊排名用的固化值（與寫入端 computeFoldColumns 同義：這裡直接給，省一次重算）
    fold_rent_num: 20000,
    fold_refresh_kind: 1,
    fold_refresh_rel_ms: 3_600_000,
    fold_refresh_abs_ms: null,
    ...overrides,
  };
}

const seedRows = [
  ...chainA.map((pid, i) => seedRow(pid, {
    match_post_id: i + 1 < chainA.length ? chainA[i + 1] : null,
    // 讀取端兩條路徑的排名輸入必須同義：Node 用列自己的 price／extra_fees，SQL 用固化欄。
    // 生產路徑由寫入端 computeFoldColumns() 保證一致；fixture 這裡手動保持一致。
    fold_rent_num: 30000 - i * 100,
    price: `${30000 - i * 100}元`,
    price_num: 30000 - i * 100,
  })),
  ...chainB1.map((pid, i) => seedRow(pid, {
    match_post_id: i + 1 < chainB1.length ? chainB1[i + 1] : null,
    fold_rent_num: 26000 - i * 100,
    price: `${26000 - i * 100}元`,
    price_num: 26000 - i * 100,
  })),
  ...chainB2.map((pid, i) => seedRow(pid, {
    match_post_id: i + 1 < chainB2.length ? chainB2[i + 1] : null,
    fold_rent_num: 25000 - i * 100,
    price: `${25000 - i * 100}元`,
    price_num: 25000 - i * 100,
  })),
  // ⑫ tie-break 軸：source_id／url 皆空 ⇒ key 的 origin 段退回 post_id，勝負只看 post_id 位數。
  seedRow(CI_TB_A, { source: "", source_id: "", url: "", match_post_id: CI_TB_B }),
  seedRow(CI_TB_B, { source_id: "", url: "" }),
  // ⑬ 資格軸：source='' 但 source_id 有值；租金 10000 vs 30000 ⇒ 租金先分勝負。
  seedRow(CI_EL_A, { source: "", source_id: `foldci-el-${CI_EL_A}`, url: "", match_post_id: CI_EL_B, fold_rent_num: 10000, price: "10000元", price_num: 10000 }),
  seedRow(CI_EL_B, { source_id: `foldci-el-${CI_EL_B}`, url: "", fold_rent_num: 30000, price: "30000元", price_num: 30000 }),
  // ⑭ collation 軸：只差一個標點。
  seedRow(CI_PN_A, { source_id: "A-B", url: "", match_post_id: CI_PN_B, fold_rent_num: 15000, price: "15000元", price_num: 15000 }),
  seedRow(CI_PN_B, { source_id: "AB", url: "", fold_rent_num: 15000, price: "15000元", price_num: 15000 }),
  seedRow(CI_PN_C, { source_id: "x.y", url: "", match_post_id: CI_PN_D, fold_rent_num: 15000, price: "15000元", price_num: 15000 }),
  seedRow(CI_PN_D, { source_id: "xy", url: "", fold_rent_num: 15000, price: "15000元", price_num: 15000 }),
  // ⑮ 代表列暫離（offline=1、offline_confirmed=0）＋ 線上次卡：端點必須恰好 1 列（＝CI_OFF_A）。
  seedRow(CI_OFF_A, {
    source: "591", source_id: `foldci-off-${CI_OFF_A}`, url: `https://example.test/foldci/${CI_OFF_A}`,
    match_post_id: CI_OFF_B, offline: 1, offline_confirmed: 0,
    fold_rent_num: 12000, price: "12000元", price_num: 12000,
  }),
  seedRow(CI_OFF_B, {
    source: "hbhousing", source_id: `foldci-off-${CI_OFF_B}`, url: `https://example.test/foldci/${CI_OFF_B}`,
    match_post_id: null, offline: 0, offline_confirmed: 0,
    fold_rent_num: 18000, price: "18000元", price_num: 18000,
  }),
];

let columnExisted = true;      // 「本來就有這一欄」⇒ 不還原（步驟不得改變別人的 schema）
const client = await drv.pool.connect();
try {
  // 拋棄式 PG：schema 由 SQLite 鏡射而來 ⇒ 沒有 fold_component_root（migration 007 走 CONCURRENTLY、
  // 屬正式庫動作）。CI 這裡用等價的 plain DDL 補上（欄位、型別與 007 相同）。
  // 只在「本來沒有這一欄」時才建，並在 finally 還原（步驟之間**不得留下 schema 變更**：
  // CI 實測踩過——留下的欄位讓後續 prb-search-benchmark 的 fixture 走進「欄位存在」的
  // 讀取分支，對它自己的 listings 查 fold_component_root ⇒ 42703 紅）。
  columnExisted = (await client.query(
    "SELECT 1 AS ok FROM pg_attribute WHERE attrelid = to_regclass('listings') AND attname = 'fold_component_root' AND attnum > 0 AND NOT attisdropped LIMIT 1",
  )).rows.length > 0;
  if (!columnExisted) await client.query("ALTER TABLE listings ADD COLUMN fold_component_root bigint");
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
    for (const row of seedRows) {
      const { names, values } = insertCols(row);
      await client.query(
        `INSERT INTO listings(${names.map((n) => `"${n}"`).join(",")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(",")})`,
        values,
      );
    }
    // ⑦ 的橋邊：兩個子鏈各一列掛在同一個 group_id（群內兩兩連通 ⇒ 16 列只有一個分量）
    await client.query(
      `INSERT INTO listing_group_members (post_id, group_id, source, match_evidence, joined_at)
       VALUES ($1, $2, '', '{}', $3), ($4, $2, '', '{}', $3)`,
      [chainB1[chainB1.length - 1], bridgeGroupId, new Date().toISOString(), chainB2[0]],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
} finally {
  client.release();
}

let exitCode = 1;
try {
  const exec = (sql, params = []) => drv.pool.query(toPostgresSql(sql), params).then((r) => r.rows);
  // 投影列（端點 SQL 走 listing_search_projection；Node 走裝飾後的列）——用生產路徑同一支寫入器。
  for (const row of seedRows) await refreshListingProjection(exec, row.post_id, { now: Date.parse("2026-10-01T00:00:00.000Z") });

  const readBack = await exec(
    `SELECT post_id, source, source_id, url, match_post_id, match_verdict, offline, offline_confirmed, hidden,
            last_seen_at, fold_rent_num, fold_refresh_kind, fold_refresh_rel_ms, fold_refresh_abs_ms,
            price_num, price, refresh_time, first_seen_at, kind_name
     FROM listings WHERE post_id = ANY($1::bigint[]) ORDER BY post_id`,
    [all],
  );
  const prepById = new Map((await exec("SELECT post_id, display_ready FROM listing_prep WHERE post_id = ANY($1::bigint[])", [all])).map((r) => [Number(r.post_id), r]));
  const gidOf = await loadGroupIds(exec, all, "postgres");

  // 寫入端分量（＝固化欄該有的值；與刷新端同一支 union-find）
  const enabledSources = ["591", "hbhousing", "sinyi", "houseprice", "ddroom", "housefun", "self"];
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
  // root UPDATE ＋ 世代鍵 bump 收進**同一條連線的顯式交易**，且 **bump 在前**（round 11）：
  // ・`exec` 走 `drv.pool.query`，每次查詢都可能換到不同連線 ⇒ 不能拿它當交易邊界，要另借一條 client。
  // ・bump 在前：就算哪天交易被拿掉，斷點也只會讓世代**超前**（fail-closed：舊戳記被拒），
  //   不會出現「root 已寫、世代未動」那種 fail-open 窗口。
  // ・合成種子也改到 `fold_component_root` ⇒ 一樣要 bump，否則「戳記 vs 世代」的語意在 CI 的
  //   資料上不成立（本腳本自己不寫戳記）。
  {
    const wx = await drv.pool.connect();
    const wexec = (sql, params = []) => wx.query(toPostgresSql(sql), params).then((r) => r.rows);
    try {
      await wx.query("BEGIN");
      await bumpFoldRootWriteGen(wexec);
      for (const [pid, root] of rootMap) {
        if (!all.includes(Number(pid))) continue;
        await wexec("UPDATE listings SET fold_component_root = ? WHERE post_id = ?", [root == null ? null : Number(root), Number(pid)]);
      }
      await wx.query("COMMIT");
    } catch (error) {
      await wx.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      wx.release();
    }
  }
  const foldRootRows = await loadFoldRoots(exec, all, "postgres");
  check("⑧ 固化欄寫入＝寫入端分量（逐列）", all.every((id) => (foldRootRows.get(Number(id)) ?? null) === (rootMap.get(Number(id)) == null ? null : Number(rootMap.get(Number(id))))));

  const provider = {
    driver: "postgres", now: 1_800_000_000_000,
    sourceEnabled: (s) => enabledSources.includes(s),
    prep: (id) => prepById.get(Number(id) || 0) || null,
    personalIndex: () => ({ size: 0, peers: () => [], groupKey: () => "" }),
    splitPairs: () => new Set(),
    extras: (ids) => new Map((ids || []).map((id) => [Number(id), readBack.find((r) => Number(r.post_id) === Number(id))]).filter(([, v]) => v)),
    groupId: (pid) => gidOf.get(Number(pid)) || "",
    foldRoot: (pid) => (foldRootRows.get(Number(pid)) == null ? null : Number(foldRootRows.get(Number(pid)))),
  };

  // ── 1. 角色級：SQL foldRoleCte（讀實體欄）vs Node attachSameHouseRoles ──
  const nodeRows = readBack.map((r) => ({ ...r }));
  attachSameHouseRoles(nodeRows, 0, provider, provider.now);
  const nodeRole = new Map(nodeRows.map((r) => [Number(r.post_id), r.same_house_role || null]));
  const cte = foldRoleCte("WHERE post_id = ANY(?::bigint[])") + "\nSELECT post_id, role, primary_offline, primary_id FROM fold_role";
  const sqlRows = await exec(cte, [all, enabledSources, provider.now]);
  const sqlRole = new Map(sqlRows.map((r) => [Number(r.post_id), r.role || null]));
  const roleDiffs = all.filter((id) => (nodeRole.get(id) ?? null) !== (sqlRole.get(id) ?? null));
  check("角色級：合成種子逐列 role 一致", roleDiffs.length === 0, { roleDiffs });
  const primariesIn = (m, ids) => ids.filter((id) => m.get(id) === "primary");
  // R2：除了代表列 id，還要斷言**群成員集合**（role ∈ {primary, affiliate} 的候選列集合）。
  const memberSet = (m, ids) => ids.filter((id) => m.get(id) != null);
  const sameSet = (a, b) => a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);
  const bridgedIds = [...chainB1, ...chainB2];
  check("⑥ 純線狀鏈（16 列同群）：群成員集合＝鏈上 16 列、代表列＝最便宜那列",
    sameSet(memberSet(nodeRole, chainA), chainA) && sameSet(memberSet(sqlRole, chainA), chainA)
    && primariesIn(nodeRole, chainA).join(",") === String(chainA[chainA.length - 1])
    && primariesIn(sqlRole, chainA).join(",") === String(chainA[chainA.length - 1]),
    { nodeMembers: memberSet(nodeRole, chainA), sqlMembers: memberSet(sqlRole, chainA),
      nodeRep: primariesIn(nodeRole, chainA), sqlRep: primariesIn(sqlRole, chainA) });
  check("⑥ 非橋式的鏈上每一列都是同一個成員集合（16 列，逐一列出）",
    memberSet(nodeRole, chainA).length === 16 && chainA.every((id) => nodeRole.get(id) != null),
    { chainA });
  check("⑦ 橋式鏈（16 列同群、單一 group 橋邊）：群成員集合＝兩個子鏈、代表列＝最便宜那列",
    sameSet(memberSet(nodeRole, bridgedIds), bridgedIds) && sameSet(memberSet(sqlRole, bridgedIds), bridgedIds)
    && primariesIn(nodeRole, bridgedIds).join(",") === String(chainB2[chainB2.length - 1])
    && primariesIn(sqlRole, bridgedIds).join(",") === String(chainB2[chainB2.length - 1]),
    { nodeMembers: memberSet(nodeRole, bridgedIds), sqlMembers: memberSet(sqlRole, bridgedIds),
      nodeRep: primariesIn(nodeRole, bridgedIds), sqlRep: primariesIn(sqlRole, bridgedIds) });

  // ── 2. 端點級：完整管線（totalMatched ＋ 有序序列 ＋ 逐列對稱差）──
  const combos = [
    { name: "q=FOLDCI", kind: "", sort: "newest" },
    // 候選層（折疊之前）的篩選：把最便宜那列（鏈尾）篩掉 ⇒ 同群必須重新選代表。
    { name: "q=FOLDCI+priceMin=28600", kind: "", sort: "newest", priceMin: 28600 },
    { name: "q=FOLDCI+kind=whole", kind: "whole", sort: "newest" },
    { name: "q=FOLDCI+sort=price_asc", kind: "", sort: "price_asc" },
  ];
  const endpoint = [];
  for (const combo of combos) {
    const built = await withPgReadSnapshot(drv, async (snapshot) => {
      const snapExec = (sql, params = [], { batch = false } = {}) => batch
        ? readPgRows(snapshot, toPostgresSql(sql), params)
        : snapshot.query(toPostgresSql(sql), params).then((r) => r.rows);
      const ASOF = new Date().toISOString();
      const context = await buildListRequestContextFromPg(snapExec, { asOf: ASOF });
      const deps = { ...listingSearchBuildContext({ asOf: ASOF }), resolveUserId: () => 0, visibilityContext: context };
      const settings = publicSearchSettings({ q: MARK, kind: combo.kind, sort: combo.sort, priceMin: combo.priceMin || 0 });
      const cols = listingSearchBuildContext().candidateColumns;
      const clauses = buildPublicListingsClauses({ districts: [], settings, q: MARK, context, districtIds: null }, { sqliteDb: null });
      const raw = await readPgRows(snapshot, toPostgresSql(`SELECT ${cols} FROM listings ${clauses.where} ORDER BY post_id`), clauses.params);
      const loader = createDecorationDataLoader({ exec: snapExec, driver: "postgres" });
      const nodeProvider = await preloadDecorationProviderAsync({
        exec: snapExec, loader, rows: raw, settings, userId: 0, matchVoteUserId: 0, peers: false,
        foldGroups: true, requestContext: context,
      });
      const survivors = await buildPublicListingsRowsAsync(raw, {
        settings, kind: combo.kind, sources: "", sort: combo.sort, districtSet: clauses.districtSet,
        provider: nodeProvider, now: context.now, requireProvider: true,
      });
      const nodeOrder = survivors.map((r) => Number(r.post_id));
      const closure = await districtClosureIds(snapExec, { districtNames: [], userId: 0 });
      const enabled = normalizeCrawlSources(context.crawlSources.items).filter((x) => x.enabled).map((x) => x.id);
      const sqlBuilt = buildPublicListingsFoldSql({
        kind: combo.kind, q: MARK, districts: [], districtIds: closure ?? null, sort: combo.sort, settings,
        enabledSources: enabled, now: context.now,
      }, deps);
      if (!sqlBuilt.ok) return { name: combo.name, ok: false, reason: sqlBuilt.reason, nodeOrder };
      const countRes = await snapshot.query(toPostgresSql(sqlBuilt.countQuery.sql), sqlBuilt.countQuery.params);
      const fullRes = await snapshot.query(toPostgresSql(sqlBuilt.fullQuery.sql), sqlBuilt.fullQuery.params);
      const sqlOrder = fullRes.rows.map((r) => Number(r.post_id));
      const nodeSet = new Set(nodeOrder);
      const sqlSet = new Set(sqlOrder);
      return {
        name: combo.name,
        nodeTotal: nodeOrder.length,
        sqlTotal: Number(countRes.rows[0]?.n) || 0,
        nodeOrder,
        sqlOrder,
        onlyNode: nodeOrder.filter((id) => !sqlSet.has(id)),
        onlySql: sqlOrder.filter((id) => !nodeSet.has(id)),
      };
    });
    const ok = built.nodeTotal === built.sqlTotal
      && JSON.stringify(built.nodeOrder) === JSON.stringify(built.sqlOrder)
      && (built.onlyNode || []).length === 0 && (built.onlySql || []).length === 0;
    endpoint.push({ ...built, ok });
    check(`端點級 ${built.name}：totalMatched＋順序＋對稱差`, ok, {
      nodeTotal: built.nodeTotal, sqlTotal: built.sqlTotal, onlyNode: built.onlyNode, onlySql: built.onlySql,
    });
  }

  // 代表列隨篩選變動（新增語意的核心）：q=FOLDCI 與 q=FOLDCI+kind=whole 對「整層住家鏈尾」的代表不同。
  const repAll = (endpoint[0].nodeOrder || []).filter((id) => chainA.includes(id));
  const repFiltered = (endpoint[1].nodeOrder || []).filter((id) => chainA.includes(id));
  check("⑨ 代表列隨篩選變動（priceMin 篩掉鏈尾 ⇒ 同群改由下一列代表）",
    repAll.length === 1 && repAll[0] === chainA[chainA.length - 1]
    && repFiltered.length === 1 && repFiltered[0] === chainA[chainA.length - 2],
    { repAll, repFiltered });
  // R2「篩掉原代表」也要同時斷言**群成員集合**（候選層篩選後剩下的成員）與**代表列 id**。
  {
    const subset = chainA.filter((_, i) => 30000 - i * 100 >= 28600);   // priceMin=28600 之後的候選列
    const subsetRows = readBack.filter((r) => subset.includes(Number(r.post_id)));
    const subsetNodeRows = subsetRows.map((r) => ({ ...r }));
    attachSameHouseRoles(subsetNodeRows, 0, provider, provider.now);
    const subsetNodeRole = new Map(subsetNodeRows.map((r) => [Number(r.post_id), r.same_house_role || null]));
    const subsetCte = foldRoleCte("WHERE post_id = ANY(?::bigint[])") + "\nSELECT post_id, role FROM fold_role";
    const subsetSqlRows = await exec(subsetCte, [subset, enabledSources, provider.now]);
    const subsetSqlRole = new Map(subsetSqlRows.map((r) => [Number(r.post_id), r.role || null]));
    check("⑩ 篩掉原代表：群成員集合＝篩選後的候選列、代表列＝下一個最便宜列（Node＝SQL）",
      sameSet(memberSet(subsetNodeRole, subset), subset) && sameSet(memberSet(subsetSqlRole, subset), subset)
      && primariesIn(subsetNodeRole, subset).join(",") === String(chainA[chainA.length - 2])
      && primariesIn(subsetSqlRole, subset).join(",") === String(chainA[chainA.length - 2]),
      { subset, nodeMembers: memberSet(subsetNodeRole, subset), sqlMembers: memberSet(subsetSqlRole, subset),
        nodeRep: primariesIn(subsetNodeRole, subset), sqlRep: primariesIn(subsetSqlRole, subset) });
  }
  // 端點級：每個 combo 的結果裡，每一群的成員集合（＝只出代表那一列）與代表列 id 必須逐群一致。
  {
    const groups = [{ name: "⑥chainA", ids: chainA }, { name: "⑦bridged", ids: bridgedIds }];
    const perGroup = [];
    let ok = true;
    for (const g of groups) {
      for (const e of endpoint) {
        const nodeHit = (e.nodeOrder || []).filter((id) => g.ids.includes(id));
        const sqlHit = (e.sqlOrder || []).filter((id) => g.ids.includes(id));
        const same = nodeHit.join(",") === sqlHit.join(",");
        if (!same) ok = false;
        perGroup.push({ group: g.name, combo: e.name, node: nodeHit, sql: sqlHit, same });
      }
    }
    check("⑪ 端點級逐群：(集合只含代表列) 且 Node＝SQL（每個 combo 逐群列出）", ok, { perGroup });
  }

  // ── 3. §6.10 兩條軸 ＋ collation 軸（合成種子；Node 代表列 id 必須＝SQL 代表列 id）──
  {
    const axes = [
      { label: "⑫ tie-break 軸：source=''／source_id・url 皆空／post_id 位數不同（10 位 vs 9 位）", pair: [CI_TB_A, CI_TB_B], expect: CI_TB_A },
      { label: "⑬ 資格軸：source='' 且 source_id 有值、租金較低（租金先分勝負，碰不到 tie-break）", pair: [CI_EL_A, CI_EL_B], expect: CI_EL_A },
      { label: "⑭ collation 軸：key 只差一個標點（source_id 'A-B' vs 'AB'）", pair: [CI_PN_A, CI_PN_B], expect: null },
      { label: "⑭ collation 軸：key 只差一個標點（source_id 'x.y' vs 'xy'）", pair: [CI_PN_C, CI_PN_D], expect: null },
    ];
    for (const a of axes) {
      const rows2 = readBack.filter((r) => a.pair.includes(Number(r.post_id))).map((r) => ({ ...r }));
      attachSameHouseRoles(rows2, 0, provider, provider.now);
      const nodeRole2 = new Map(rows2.map((r) => [Number(r.post_id), r.same_house_role || null]));
      const sqlRows2 = await exec(cte, [a.pair, enabledSources, provider.now]);
      const sqlRole2 = new Map(sqlRows2.map((r) => [Number(r.post_id), r.role || null]));
      const nodeRep = primariesIn(nodeRole2, a.pair);
      const sqlRep = primariesIn(sqlRole2, a.pair);
      check(`${a.label}：Node 代表列 id ＝ SQL 代表列 id`, nodeRep.length === 1 && sqlRep.length === 1
        && nodeRep.join(",") === sqlRep.join(",")
        && sameSet(memberSet(nodeRole2, a.pair), a.pair) && sameSet(memberSet(sqlRole2, a.pair), a.pair)
        && (a.expect == null || nodeRep[0] === a.expect),
      { pair: a.pair, nodeRep, sqlRep, expect: a.expect, nodeRole: [...nodeRole2], sqlRole: [...sqlRole2] });
    }
  }

  // ── 4. ⑮ Owner 2026-10-16：代表列暫離（offline=1 未確認）＋ 線上次卡 ⇒ 端點恰好 1 列 ──
  //    舊的補償條款會讓這一群在清單出現 2 列（代表列 ＋ 線上次卡）；移除後必須只剩代表列。
  //    同時釘住「代表列自己照樣顯示」（2026-10-12 定案 3b）與「Node＝SQL 逐列一致」。
  {
    const pair = [CI_OFF_A, CI_OFF_B];
    const rows3 = readBack.filter((r) => pair.includes(Number(r.post_id))).map((r) => ({ ...r }));
    attachSameHouseRoles(rows3, 0, provider, provider.now);
    const nodeRole3 = new Map(rows3.map((r) => [Number(r.post_id), r.same_house_role || null]));
    const sqlRows3 = await exec(cte, [pair, enabledSources, provider.now]);
    const sqlRole3 = new Map(sqlRows3.map((r) => [Number(r.post_id), r.role || null]));
    const roleOk = nodeRole3.get(CI_OFF_A) === "primary" && nodeRole3.get(CI_OFF_B) === "affiliate"
      && sqlRole3.get(CI_OFF_A) === "primary" && sqlRole3.get(CI_OFF_B) === "affiliate";
    const perCombo = [];
    let ok = roleOk;
    let nonEmpty = 0;
    for (const e of endpoint) {
      const nodeHit = (e.nodeOrder || []).filter((id) => pair.includes(id));
      const sqlHit = (e.sqlOrder || []).filter((id) => pair.includes(id));
      const same = nodeHit.join(",") === sqlHit.join(",");
      // 同群最多 1 列，而且那一列只能是代表列（CI_OFF_B 出現在清單就是補償條款復辟）。
      const single = nodeHit.length <= 1 && nodeHit.every((id) => id === CI_OFF_A);
      if (nodeHit.length === 1) nonEmpty += 1;
      if (!same || !single) ok = false;
      perCombo.push({ combo: e.name, node: nodeHit, sql: sqlHit, same, single });
    }
    if (nonEmpty === 0) ok = false;   // 這一組必須真的進過候選集，否則這條斷言是空的
    check("⑮ 代表列暫離＋線上次卡：端點恰好 1 列＝代表列，且 Node＝SQL", ok, { roleOk, nonEmpty, perCombo });
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(JSON.stringify(r));
  console.log(JSON.stringify({ script: "fold-ci-parity", total: results.length, failed: failed.map((r) => r.label), allOk: failed.length === 0 }));
  exitCode = failed.length === 0 ? 0 : 1;
} finally {
  // 清理：所有合成列／群組／投影列（只碰本腳本的 post_id 命名空間）
  try {
    await drv.pool.query("DELETE FROM listing_search_projection WHERE post_id = ANY($1::bigint[])", [all]);
    await drv.pool.query("DELETE FROM listing_group_members WHERE post_id = ANY($1::bigint[]) OR group_id = $2", [all, bridgeGroupId]);
    await drv.pool.query("DELETE FROM listings WHERE post_id = ANY($1::bigint[])", [all]);
  } finally {
    // schema 還原（本步驟自己加的欄位自己拿掉）＋ 清掉合成列
    if (!columnExisted) {
      await drv.pool.query("ALTER TABLE listings DROP COLUMN IF EXISTS fold_component_root").catch((e) => {
        console.error(`[fold-ci-parity] 還原欄位失敗（後續步驟可能受影響）: ${String(e?.message || e).slice(0, 160)}`);
      });
    }
    await drv.pool.end();
  }
}
process.exit(exitCode);
