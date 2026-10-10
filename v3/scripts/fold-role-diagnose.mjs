// (A) fold role 逐筆定讞（唯讀，打正式庫）。對指定 post_id 指出「被哪一條條件擋掉」並比對
// Node attachSameHouseRoles 與 SQL fold_role 的結果。
//
// 用法：set -a; . /home/cline/.secrets/apps/5151-prod-casaos.env; set +a;
//       node v3/scripts/fold-role-diagnose.mjs [post_id ...]
// 預設診斷 #694 round-2 記錄的 19 筆不一致列。**只做 SELECT，不寫任何資料**（不用 assertPgTargetAllowed，
// 也不設定 ALLOW_PRODUCTION_PG_TARGET）。
import pg from "pg";
import { normalizeCrawlSources } from "./../src/crawlSources.js";
import { attachSameHouseRoles } from "./../src/db.js";

const DEFAULT_IDS = [
  21968016, 21982894, 21982920, 21982930, 21985034, 22000015, 22070310, 22070327,
  22070496, 22070629, 22075097, 22124983, 22134031, 22140281, 22152379, 2402587270,
  2408037408, 2424694113, 2445156575,
];
const IDS = (process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_IDS).map(Number).filter(Boolean);

const client = new pg.Client({ connectionString: process.env.PG_URL });
await client.connect();

const gRows = (await client.query("SELECT key, value FROM settings")).rows;
const crawlRow = gRows.find((r) => String(r?.key) === "crawlSources");
const value = crawlRow?.value == null ? null : (typeof crawlRow.value === "string" ? JSON.parse(crawlRow.value) : crawlRow.value);
const enabledSources = normalizeCrawlSources(value).filter((x) => x.enabled).map((x) => x.id);

const COLS = "post_id, source, source_id, url, match_post_id, match_verdict, offline, offline_confirmed, hidden, last_seen_at, fold_rent_num, fold_refresh_kind, fold_refresh_rel_ms, fold_refresh_abs_ms, price_num, price, refresh_time, first_seen_at, self_status, self_expires_at, fixture_namespace";

const seed = (await client.query(`SELECT ${COLS} FROM listings WHERE post_id = ANY($1::bigint[])`, [IDS])).rows;
const inEdges = (await client.query(`SELECT ${COLS} FROM listings WHERE match_post_id = ANY($1::bigint[])`, [IDS])).rows;
const outPeerIds = [...new Set(seed.map((r) => Number(r.match_post_id)).filter((n) => n > 0))];
const outPeers = outPeerIds.length ? (await client.query(`SELECT ${COLS} FROM listings WHERE post_id = ANY($1::bigint[])`, [outPeerIds])).rows : [];

const raw = [...seed, ...inEdges, ...outPeers];
const byId = new Map(raw.map((r) => [Number(r.post_id), r]));
const allIds = [...byId.keys()];
const prepById = new Map((await client.query("SELECT post_id, display_ready FROM listing_prep WHERE post_id = ANY($1::bigint[])", [allIds])).rows.map((r) => [Number(r.post_id), r]));

const provider = {
  driver: "postgres", now: 1_800_000_000_000,
  sourceEnabled: (s) => enabledSources.includes(s),
  prep: (id) => prepById.get(Number(id) || 0) || null,
  personalIndex: () => ({ size: 0, peers: () => [], groupKey: () => "" }),
  splitPairs: () => new Set(),
  extras: (ids) => new Map((ids || []).map((id) => [Number(id), byId.get(Number(id))]).filter(([, v]) => v)),
};

// Node ground truth
attachSameHouseRoles(raw, 0, provider, provider.now);
const nodeRole = new Map(raw.map((r) => [Number(r.post_id), r.same_house_role || null]));

// SQL fold（全表，與 fold-role-parity-prod.mjs 同語意；scope 會改變折疊邊的視野，不可拿來比對）。
const SQL_ROLE = `
WITH fold AS (
  SELECT l.post_id, l.source, l.source_id, l.url, l.last_seen_at, l.offline, l.match_post_id, l.match_verdict,
         l.fold_rent_num, l.fold_refresh_kind, l.fold_refresh_rel_ms, l.fold_refresh_abs_ms,
         (l.source = ANY($1::text[]) AND (l.source <> 'houseprice' OR COALESCE(p.display_ready, 0) = 1)) AS display_ready,
         (CASE WHEN l.fold_refresh_kind = 1 THEN $2::bigint - l.fold_refresh_rel_ms ELSE l.fold_refresh_abs_ms END) AS refresh_ms,
         (l.source || ':' || COALESCE(NULLIF(l.source_id,''), NULLIF(l.url,''), NULLIF(l.post_id,0)::text, '') || ':' || l.post_id::text) AS tie_key
  FROM listings l
  LEFT JOIN listing_prep p ON p.post_id = l.post_id
),
edges AS (
  SELECT post_id AS src, match_post_id AS dst FROM fold
  WHERE match_post_id IS NOT NULL AND match_post_id > 0 AND COALESCE(match_verdict,'') <> 'no'
),
eff AS (
  SELECT e.src, e.dst
  FROM edges e JOIN fold s ON s.post_id = e.src JOIN fold d ON d.post_id = e.dst
  WHERE s.display_ready AND d.display_ready AND COALESCE(d.match_verdict,'') <> 'no'
),
inc AS (
  SELECT src AS x, src AS ord, src, dst FROM eff
  UNION ALL
  SELECT dst AS x, src AS ord, src, dst FROM eff
),
rk AS (
  SELECT x, src, dst, row_number() OVER (PARTITION BY x ORDER BY ord ASC, dst ASC) AS rn FROM inc
),
fe AS (SELECT x, src, dst FROM rk WHERE rn = 1),
winner AS (
  SELECT fe.x,
    CASE
      WHEN a.fold_rent_num IS NOT NULL AND b.fold_rent_num IS NULL THEN a.post_id
      WHEN b.fold_rent_num IS NOT NULL AND a.fold_rent_num IS NULL THEN b.post_id
      WHEN a.fold_rent_num IS NOT NULL AND b.fold_rent_num IS NOT NULL AND a.fold_rent_num <> b.fold_rent_num
        THEN CASE WHEN a.fold_rent_num < b.fold_rent_num THEN a.post_id ELSE b.post_id END
      WHEN a.refresh_ms <> b.refresh_ms
        THEN CASE WHEN a.refresh_ms > b.refresh_ms THEN a.post_id ELSE b.post_id END
      WHEN COALESCE(b.last_seen_at,'') <> COALESCE(a.last_seen_at,'')
        THEN CASE WHEN COALESCE(b.last_seen_at,'') < COALESCE(a.last_seen_at,'') THEN a.post_id ELSE b.post_id END
      WHEN a.tie_key <> b.tie_key
        THEN CASE WHEN a.tie_key < b.tie_key THEN a.post_id ELSE b.post_id END
      ELSE CASE WHEN a.post_id <= b.post_id THEN a.post_id ELSE b.post_id END
    END AS winner_id,
    a.offline AS a_offline, b.offline AS b_offline,
    fe.src AS src, fe.dst AS dst
  FROM fe
  JOIN fold a ON a.post_id = fe.src
  JOIN fold b ON b.post_id = fe.dst
)
SELECT x, (CASE WHEN winner_id = x THEN 'primary' ELSE 'affiliate' END) AS role
FROM (SELECT w.x, w.winner_id FROM winner w JOIN fe ON fe.x = w.x) w
`;
const sqlRows = (await client.query(SQL_ROLE, [enabledSources, provider.now])).rows;
const sqlRole = new Map(sqlRows.map((r) => [Number(r.x), r.role]));

// 判定被擋條件（Node 側）
function housepriceNotDisplayReady(r) {
  const source = String(r?.source || "591") || "591";
  if (!enabledSources.includes(source)) return true;
  if (String(r?.source || "") !== "houseprice") return false;
  const prep = prepById.get(Number(r.post_id));
  return Number(prep?.display_ready) !== 1;
}

console.log("post_id\tpeer(match_post_id)\tblockedBy\tNode\tSQL\tmismatch");
let mismatchCount = 0;
for (const id of IDS) {
  const r = byId.get(Number(id));
  if (!r) { console.log(`${id}\t-\tMISSING\t-\t-\t-`); continue; }
  const mid = Number(r.match_post_id) || 0;
  const peer = mid ? byId.get(mid) : null;
  const linked = mid > 0 && String(r.match_verdict || "") !== "no";
  let blocked = "-";
  if (!linked) blocked = "C0(無出邊/只有入邊)";
  else if (!peer || String(peer.match_verdict || "") === "no") blocked = "C1(對端 verdict=no/不存在)";
  else if (housepriceNotDisplayReady(peer) || housepriceNotDisplayReady(r)) blocked = "C2(display_ready 兩側)";
  const n = nodeRole.get(Number(id)) ?? null;
  const s = sqlRole.get(Number(id)) ?? null;
  const mismatch = n !== s;
  if (mismatch) mismatchCount += 1;
  console.log(`${id}\t${mid || "-"}\t${blocked}\t${n ?? "null"}\t${s ?? "null"}\t${mismatch ? "YES" : ""}`);
}
console.log(`mismatchCount=${mismatchCount}`);
await client.end();
