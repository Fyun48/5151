// 同屋源群結構統計（union-find 並查集，可終止、帶環；迭代式避免遞迴爆棧）。
// 只連隔離庫，唯讀。用法：PG_URL=$PG_LIVE_REPRO_URL node v3/scripts/fold-group-stats.mjs
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";

assertPgTargetAllowed("fold-group-stats", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });
const drv = await createPostgresDriver({ env: process.env });

const rows = await drv.pool.query(`SELECT post_id, match_post_id, match_verdict FROM listings`);
const adj = new Map(); const indeg = new Map();
const uf = new Map();
const find = (x) => { let r = x; while (uf.get(r) !== r) r = uf.get(r); while (uf.get(x) !== x) { const n = uf.get(x); uf.set(x, r); x = n; } return r; };
const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) uf.set(ra, rb); };
for (const r of rows.rows) {
  const id = Number(r.post_id); const mid = Number(r.match_post_id) || 0;
  if (mid && String(r.match_verdict || "") !== "no") {
    if (!uf.has(id)) uf.set(id, id);
    if (!uf.has(mid)) uf.set(mid, mid);
    union(id, mid);
    if (!adj.has(id)) adj.set(id, []);
    adj.get(id).push(mid);
    indeg.set(mid, (indeg.get(mid) || 0) + 1);
  }
}
const comps = new Map();
for (const n of uf.keys()) { const root = find(n); if (!comps.has(root)) comps.set(root, []); comps.get(root).push(n); }

function analyze(members) {
  // Kahn 拓樸排序（只走成員的邊），環偵測
  const indeg2 = new Map();
  for (const n of members) indeg2.set(n, indeg.get(n) || 0);
  const queue = members.filter(n => (indeg2.get(n) || 0) === 0);
  let qi = 0;
  while (qi < queue.length) {
    const n = queue[qi++];
    for (const m of (adj.get(n) || [])) { indeg2.set(m, indeg2.get(m) - 1); if (indeg2.get(m) === 0) queue.push(m); }
  }
  const cyclic = queue.length < members.length;
  let maxDepth = 0;
  if (!cyclic) {
    const indeg3 = new Map();
    for (const n of members) indeg3.set(n, indeg.get(n) || 0);
    const dist = new Map();
    const q2 = members.filter(n => (indeg3.get(n) || 0) === 0);
    let q2i = 0;
    while (q2i < q2.length) {
      const n = q2[q2i++];
      for (const m of (adj.get(n) || [])) {
        const nd = (dist.get(n) || 0) + 1;
        if (nd > (dist.get(m) || 0)) dist.set(m, nd);
        if (nd > maxDepth) maxDepth = nd;
        indeg3.set(m, indeg3.get(m) - 1);
        if (indeg3.get(m) === 0) q2.push(m);
      }
    }
  }
  return { size: members.length, cyclic, maxDepth };
}

const stats = [];
for (const [root, members] of comps) stats.push({ root, ...analyze(members) });
stats.sort((a, b) => b.size - a.size);
const cyclicComps = stats.filter(s => s.cyclic);
const acyclicMaxDepth = stats.filter(s => !s.cyclic).reduce((m, s) => Math.max(m, s.maxDepth), 0);

console.log(JSON.stringify({
  groupsWithLinks: stats.length,
  maxGroupSize: stats[0]?.size || 0,
  maxAcyclicDepth: acyclicMaxDepth,
  cyclicGroupCount: cyclicComps.length,
  cyclicLargestSize: cyclicComps[0]?.size || 0,
  cyclicSamples: cyclicComps.slice(0, 30).map(s => ({ size: s.size, cyclic: s.cyclic })),
  sizeHistogram: (() => {
    const h = {};
    for (const s of stats) { const k = s.size <= 2 ? "2" : s.size <= 5 ? "3-5" : s.size <= 10 ? "6-10" : s.size <= 50 ? "11-50" : "51+"; h[k] = (h[k] || 0) + 1; }
    return h;
  })(),
}, null, 2));

await drv.pool.end();
