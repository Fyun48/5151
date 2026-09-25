// PG 端事實量測（唯讀）：某行政區在「SQL 路徑 envelope」下的候選數，
// 以及其中帶 peer 指標（primary_listing_id ＝ match_post_id，astra6 更正：這只是 peer 指標、不是已選 primary）
// 且 peer 也落在同一候選集合內的列數。
//
// 目的：astra6 指出先前的 4,259/6,023 是「生產 SQLite 快照」上的兩條管線比較，不能當成 PG 的直接測量。
// 本腳本只量 PG 事實，不做任何角色推導（角色需 Node 管線，避免近似）。
import { createPostgresDriver } from "/app/src/dbDriverPostgres.js";

const drv = await createPostgresDriver({ env: process.env });
const district = process.env.DISTRICT
  || (await drv.query(`SELECT district FROM listing_search_projection WHERE district <> '' GROUP BY district ORDER BY COUNT(*) DESC LIMIT 1`)).rows[0]?.district;

const sql = `
WITH env AS (
  SELECT p.post_id, p.primary_listing_id
  FROM listing_search_projection p
  JOIN listings l ON l.post_id = p.post_id
  WHERE p.district = $1 AND p.low_floor = 0 AND p.rooftop = 0
    AND NOT (COALESCE(l.offline,0) = 1 AND COALESCE(l.offline_confirmed,0) = 1)
    AND COALESCE(l.match_verdict,'') <> 'yes'
    AND NOT EXISTS (SELECT 1 FROM user_listing_flags f WHERE f.post_id = l.post_id AND f.user_id = 0 AND f.hidden = 1)
    AND COALESCE((SELECT watched FROM user_listing_flags f WHERE f.post_id = l.post_id AND f.user_id = 0), 0) = 0
)
SELECT
  COUNT(*)::int AS candidates,
  COUNT(*) FILTER (WHERE primary_listing_id IS NOT NULL AND primary_listing_id <> 0)::int AS with_peer,
  COUNT(*) FILTER (WHERE primary_listing_id IS NOT NULL AND primary_listing_id <> 0
                     AND primary_listing_id IN (SELECT post_id FROM env))::int AS peer_in_candidates
FROM env`;

const r = (await drv.query(sql, [district])).rows[0];
const total = Number(r.candidates) || 0;
console.log(`PGFACTS ${JSON.stringify({
  district,
  candidates: total,
  withPeerPointer: Number(r.with_peer),
  peerInCandidates: Number(r.peer_in_candidates),
  pctWithPeer: total ? Math.round((Number(r.with_peer) / total) * 1000) / 10 : null,
  pctPeerInCandidates: total ? Math.round((Number(r.peer_in_candidates) / total) * 1000) / 10 : null,
  note: "peerInCandidates 是「同源配對可能被 Node 排除」的必要條件上界，不等於實際被排除數（需 Node 角色推導）",
})}`);
await drv.pool.end();
