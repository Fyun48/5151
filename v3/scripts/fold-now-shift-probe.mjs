// (C) `fold_refresh_kind=1`（相對更新時間）的 `now` 平移探針（唯讀）。
//
// 要回答的問題（dossier §7 缺口二；規格 docs/same-house-fold-spec.md 結尾的「未防到的殘餘」）：
//   「`fold_refresh_kind=1` 的相對更新時間隨請求時間平移，但同群內一起平移、不改相對序；
//     只有 kind=1 與絕對時間列混用時才會變。」
// 這支探針把那句話變成數字：找出「kind=1 與絕對時間列混用」的群，把 `now` 平移三個時點，
// 分別算 SQL 側（`listingSearchSql.js` 的 `foldRoleCte`，**原樣**）與 Node 側
// （`match.js` 的 `sortGroupListings`／`preferPrimaryListing`，**原樣**）選出的代表 post_id：
//   ① 三時點兩側「選同一個 post_id」的比率；
//   ② 代表列會不會隨 `now` 換人（＝殘餘風險的實測規模）；
//   ③ 分歧樣本（群／時點／兩側各選誰）。
//
// `now` 的三個時點＝`NOW∓Δ` 與 `NOW`，Δ 取「能把群內 kind=1 與絕對列的先後翻轉」的距離：
// 對每個（kind=1 成員 r、絕對成員 a）配對，翻轉臨界點是 `now = absMs(a) + relMs(r)`；
// 取距離 NOW 最近的那個臨界距離 +1s。**全域用同一個 Δ**（＝可翻轉群的最大值，且有上限），
// 這樣 SQL 只要跑三次原樣查詢；每個群是否真的翻轉仍逐群統計。
//
// 全程只 SELECT（腳本自我掃描會把結果印在 `writesSql`）；不寫任何表、不建 temp table。
//
// 用法：
//   set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
//   PG_URL="${PG_LIVE_REPRO_URL}" node v3/scripts/fold-now-shift-probe.mjs
//   … --window-ms 21600000 --delta-cap-ms 21600000 --max-groups 500 --json
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { buildListRequestContextFromPg } from "../src/db.js";
import { normalizeCrawlSources } from "../src/crawlSources.js";
import { foldRoleCte } from "../src/listingSearchSql.js";
import { sortGroupListings, listingRefreshParts, comparableRent } from "../src/match.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const argNum = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && Number.isFinite(Number(argv[i + 1])) ? Number(argv[i + 1]) : dflt;
};
const WINDOW_MS = argNum("window-ms", 6 * 3_600_000);      // 「更新時間落在 now 附近」的窗口
const DELTA_CAP_MS = argNum("delta-cap-ms", 6 * 3_600_000); // Δ 上限（超過就不算「可翻轉」）
const MAX_GROUPS = argNum("max-groups", 500);               // 逐群結果的輸出上限
const JSON_ONLY = argv.includes("--json");

// 唯讀自我掃描：這支腳本不得出現任何寫入語句。（關鍵字以片段串接，避免掃到本行自己。）
const J = (...p) => p.join("");
const WRITE_RE = new RegExp(
  `\\b(${[
    J("INSERT", "\\s+INTO"), J("UPDATE", "\\s+\\w+\\s+SET"), J("DELETE", "\\s+FROM"),
    J("TRUN", "CATE"), J("DROP", "\\s+"), J("ALTER", "\\s+TABLE"), J("CREATE", "\\s+(TEMP|TABLE)"),
  ].join("|")})\\b`, "gi");
const SELF = readFileSync(fileURLToPath(import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .split("\n").map((l) => l.replace(/--.*$/, "").replace(/\/\/.*$/, "")).join("\n");
const WRITE_HITS = SELF.match(WRITE_RE) || [];

assertPgTargetAllowed("fold-now-shift-probe", process.env.PG_URL || "", { allow: ["repro", "repro2", "crawl_sandbox", "tracker_test"] });
const drv = await createPostgresDriver({ env: process.env });
const exec = (sql, params = []) => drv.pool.query(toPostgresSql(sql), params).then((r) => r.rows);

const context = await buildListRequestContextFromPg(exec, { asOf: new Date().toISOString() });
const enabledSources = normalizeCrawlSources(context.crawlSources.items).filter((x) => x.enabled).map((x) => x.id);
const NOW = Number(context.now);

const out = {
  probe: "fold-now-shift-probe",
  target: { database: new URL(process.env.PG_URL).pathname.replace(/^\//, ""), host_port: new URL(process.env.PG_URL).host },
  generated_at: new Date().toISOString(),
  now: NOW,
  enabledSources,
  window_ms: WINDOW_MS,
  delta_cap_ms: DELTA_CAP_MS,
  writesSql: WRITE_HITS.length,
  writeKeywordsFound: WRITE_HITS,
};

// 合格候選（資格軸與 SQL 的 elig 逐字同一條；source 正規化見 spec §6.10）
const ELIG_SQL = `
  SELECT l.post_id, l.fold_component_root AS croot, l.source, l.source_id, l.url,
         l.last_seen_at, l.refresh_time, l.price, l.price_num, l.extra_fee, l.extra_fees,
         l.extra_fee_text, l.tags, l.offline, l.fold_rent_num, l.fold_refresh_kind,
         l.fold_refresh_rel_ms, l.fold_refresh_abs_ms,
         COALESCE(CASE WHEN l.fold_refresh_kind = 1 THEN ?::bigint - l.fold_refresh_rel_ms
                       ELSE l.fold_refresh_abs_ms END, 0) AS refreshv
  FROM listings l
  LEFT JOIN listing_prep p ON p.post_id = l.post_id
  WHERE l.fold_component_root IS NOT NULL
    AND l.offline_confirmed IS DISTINCT FROM 1
    AND (COALESCE(NULLIF(l.source, ''), '591') = ANY(?::text[])
         AND (COALESCE(NULLIF(l.source, ''), '591') <> 'houseprice' OR COALESCE(p.display_ready, 0) = 1))`;

// ── 步驟 1：找「命中群」＝成員數 ≥2、含 kind=1、且至少一個成員的還原更新時間落在 NOW±WINDOW ──
const hitGroups = await exec(
  `WITH cand AS (${ELIG_SQL})
   SELECT croot, count(*) AS n, count(*) FILTER (WHERE fold_refresh_kind = 1) AS k1,
          count(*) FILTER (WHERE abs(refreshv - ?::bigint) <= ?::bigint) AS near_now
   FROM cand GROUP BY 1
   HAVING count(*) >= 2
      AND count(*) FILTER (WHERE fold_refresh_kind = 1) > 0
      AND count(*) FILTER (WHERE abs(refreshv - ?::bigint) <= ?::bigint) > 0
   ORDER BY croot`,
  [NOW, enabledSources, NOW, WINDOW_MS, NOW, WINDOW_MS],
);
out.groups_total = hitGroups.length;

if (!hitGroups.length) {
  out.hits = 0;
  out.note = `沒有命中群：沒有「成員 ≥2、含 fold_refresh_kind=1、且有成員更新時間落在 now±${WINDOW_MS}ms」的群；三時點比較與比率不適用（不是通過）。`;
  if (!JSON_ONLY) console.log(`[fold-now-shift-probe] 命中群 0 ⇒ 無資料可比（不是通過）。${out.note}`);
  console.log(JSON.stringify(out, null, 2));
  await drv.pool.end();
  process.exit(0);
}

// ── 步驟 2：抓命中群的成員列（只抓這些群；排名是群內獨立，所以語意與全表相同）──
const crootList = hitGroups.map((r) => Number(r.croot));
const rows = await exec(`${ELIG_SQL} AND l.fold_component_root = ANY(?::bigint[]) ORDER BY l.fold_component_root, l.post_id`,
  [NOW, enabledSources, crootList]);
const byGroup = new Map();
for (const r of rows) {
  const k = String(r.croot);
  if (!byGroup.has(k)) byGroup.set(k, []);
  byGroup.get(k).push(r);
}

// ── 步驟 3：逐群算「翻轉臨界距離」→ 全域 Δ ────────────────────────────────
const num = (v) => (v == null ? null : Number(v));
const refreshAt = (r, now) => (num(r.fold_refresh_kind) === 1 ? now - num(r.fold_refresh_rel_ms) : num(r.fold_refresh_abs_ms));
const groupDelta = new Map();
let foldColumnMismatch = 0, rentMismatch = 0;
for (const [k, members] of byGroup) {
  const rel = members.filter((m) => num(m.fold_refresh_kind) === 1);
  const abs = members.filter((m) => num(m.fold_refresh_kind) !== 1);
  let best = null;
  for (const r of rel) for (const a of abs) {
    const critical = num(a.fold_refresh_abs_ms) + num(r.fold_refresh_rel_ms);
    if (!Number.isFinite(critical)) continue;
    const d = Math.abs(critical - NOW);
    if (best == null || d < best) best = d;
  }
  groupDelta.set(k, best == null ? null : best + 1000);
  // 完整性交叉檢查：固化欄 vs 既有解析函式（讀取端真正用的那兩支）
  for (const m of members) {
    const p = listingRefreshParts(m);
    const kind = p.kind === "relative" ? 1 : p.kind === "absolute" ? 2 : 0;
    if (kind !== num(m.fold_refresh_kind)
      || (kind === 1 && p.relMs !== num(m.fold_refresh_rel_ms))
      || (kind !== 1 && p.absMs !== num(m.fold_refresh_abs_ms))) foldColumnMismatch += 1;
    const cr = comparableRent(m);
    const stored = num(m.fold_rent_num);
    if ((cr == null) !== (stored == null) || (cr != null && Math.abs(cr - stored) > 1e-6)) rentMismatch += 1;
  }
}
const reachable = [...groupDelta.entries()].filter(([, d]) => d != null && d <= DELTA_CAP_MS).map(([, d]) => d);
const DELTA = reachable.length ? Math.max(...reachable) : WINDOW_MS;
// 驗證 Δ 真的「翻了某一對的先後」：對每個可翻轉群，取距離 NOW 最近的那個（kind=1, 絕對）配對，
// 比較 now−Δ 與 now+Δ 時兩者的還原更新時間誰大 —— 必須反號，否則 Δ 沒有達成宣稱的平移。
const pairFlipCheck = [];
for (const [k, members] of byGroup) {
  const d = groupDelta.get(k);
  if (d == null || d > DELTA_CAP_MS) continue;
  const rel = members.filter((m) => num(m.fold_refresh_kind) === 1);
  const abs = members.filter((m) => num(m.fold_refresh_kind) !== 1);
  let bestPair = null;
  for (const r of rel) for (const a of abs) {
    const critical = num(a.fold_refresh_abs_ms) + num(r.fold_refresh_rel_ms);
    if (!Number.isFinite(critical)) continue;
    const dist = Math.abs(critical - NOW);
    if (!bestPair || dist < bestPair.dist) bestPair = { r, a, dist, critical };
  }
  if (!bestPair) continue;
  const sign = (nowK) => Math.sign(refreshAt(bestPair.r, nowK) - refreshAt(bestPair.a, nowK));
  pairFlipCheck.push({
    croot: k, rel_post_id: Number(bestPair.r.post_id), abs_post_id: Number(bestPair.a.post_id),
    critical_ms: bestPair.critical, dist_ms: bestPair.dist,
    sign_before: sign(NOW - DELTA), sign_after: sign(NOW + DELTA),
    pair_order_flipped: sign(NOW - DELTA) !== sign(NOW + DELTA),
  });
}
out.group_delta = {
  flip_pair_reachable_groups: reachable.length,
  flip_pair_unreachable_within_cap: groupDelta.size - reachable.length,
  delta_ms: DELTA,
  delta_min_ms: reachable.length ? Math.min(...reachable) : null,
  delta_max_ms: reachable.length ? Math.max(...reachable) : null,
  pair_order_flipped_groups: pairFlipCheck.filter((x) => x.pair_order_flipped).length,
  pair_flip_check: pairFlipCheck.slice(0, 10),
};
out.integrity = { foldColumnMismatch, rentMismatch, rows_scanned: rows.length };

// ── 步驟 4：三個時點，SQL（原樣 foldRoleCte）vs Node（原樣 sortGroupListings）──
const at = (nowK) => ({
  now: nowK,
  delta_from_now: nowK - NOW,
  sql: (async () => {
    const cte = foldRoleCte("WHERE listings.fold_component_root = ANY(?::bigint[])");
    const r = await exec(`${cte} SELECT post_id, primary_id, role FROM fold_role WHERE role = 'primary'`,
      [crootList, enabledSources, nowK]);
    return new Map(r.map((x) => [Number(x.post_id), Number(x.primary_id)]));
  })(),
  node: new Map([...byGroup.entries()].map(([k, members]) => {
    const w = sortGroupListings(members, nowK)[0];
    return [Number(k), w ? Number(w.post_id) : null];
  })),
});
const points = [];
for (const nowK of [NOW - DELTA, NOW, NOW + DELTA]) {
  const p = at(nowK);
  p.sql = await p.sql;
  points.push(p);
}
// SQL 回傳的欄位裡沒有 croot ⇒ 用步驟 2 的 post_id→croot 對照補回群鍵
const idToCroot = new Map(rows.map((r) => [Number(r.post_id), String(r.croot)]));
const sqlRepByGroup = points.map((p) => new Map([...p.sql.entries()].map(([pid, prim]) => [idToCroot.get(pid) ?? `?${pid}`, prim])));
const nodeRepByGroup = points.map((p) => p.node);

const perPoint = points.map((p, i) => {
  const sqlMap = sqlRepByGroup[i], nodeMap = nodeRepByGroup[i];
  const groups = [...nodeMap.keys()];
  let agree = 0; const divergences = [];
  for (const g of groups) {
    const s = sqlMap.get(String(g)) ?? null;
    const n = nodeMap.get(g) ?? null;
    if (s != null && n != null && s === n) agree += 1;
    else if (s != null || n != null) divergences.push({ croot: String(g), now: p.now, sql_primary: s, node_primary: n });
  }
  return {
    now: p.now, delta_from_now: p.delta_from_now,
    groups: groups.length, agree, agree_ratio: groups.length ? agree / groups.length : null,
    divergence_count: divergences.length, divergences: divergences.slice(0, 20),
  };
});
const flipByGroup = (maps) => maps[0] && [...maps[0].keys()].filter((g) => new Set(maps.map((m) => String(m.get(g)))).size > 1).length;
const nodeFlips = flipByGroup(nodeRepByGroup);
const sqlFlips = flipByGroup(sqlRepByGroup);
const flipSamples = [...(nodeRepByGroup[0]?.keys() ?? [])]
  .map((g) => ({
    croot: String(g),
    node: nodeRepByGroup.map((m) => m.get(g) ?? null),
    sql: sqlRepByGroup.map((m) => m.get(g) ?? null),
  }))
  .filter((x) => new Set(x.node.map(String)).size > 1 || new Set(x.sql.map(String)).size > 1)
  .slice(0, 20);

out.result = {
  groups: byGroup.size,
  points: perPoint,
  representative_flips: { node: nodeFlips, sql: sqlFlips },
  flip_samples: flipSamples,
  total_divergences: perPoint.reduce((a, x) => a + x.divergence_count, 0),
  any_hit: byGroup.size > 0,
};

if (!JSON_ONLY) {
  const [lo, mid, hi] = perPoint;
  console.log(`[fold-now-shift-probe] 目標 ${out.target.database}@${out.target.host_port}，now=${new Date(NOW).toISOString()}`);
  console.log(`  命中群 ${byGroup.size}／多成員合格群 ${out.groups_total}（窗口 ±${WINDOW_MS / 3_600_000}h）；可翻轉群 ${out.group_delta.flip_pair_reachable_groups}，Δ=${DELTA / 1000}s`);
  console.log(`  兩側一致率：now−Δ ${(lo.agree_ratio * 100).toFixed(4)}%（${lo.agree}/${lo.groups}）｜now ${(mid.agree_ratio * 100).toFixed(4)}%（${mid.agree}/${mid.groups}）｜now+Δ ${(hi.agree_ratio * 100).toFixed(4)}%（${hi.agree}/${hi.groups}）`);
  console.log(`  代表列隨 now 換人：Node ${nodeFlips} 群／SQL ${sqlFlips} 群；兩側分歧樣本合計 ${out.result.total_divergences}`);
  console.log(`  Δ 有效性：可翻轉群 ${out.group_delta.flip_pair_reachable_groups} 中，配對先後真的被翻轉 ${out.group_delta.pair_order_flipped_groups} 群（其餘距離 > 上限 ${DELTA_CAP_MS / 1000}s）`);
  console.log(`  完整性：fold 欄 vs 解析函式不符 ${foldColumnMismatch} 列、租金不符 ${rentMismatch} 列（掃 ${rows.length} 列）；writesSql=${out.writesSql}`);
  if (!byGroup.size) console.log("  ⚠️ 沒有命中群 ⇒ 比率不適用（不是通過）");
}
console.log(JSON.stringify(out, null, 2));
await drv.pool.end();
