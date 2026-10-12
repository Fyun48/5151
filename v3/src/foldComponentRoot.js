// 同屋源「連通分量」的**唯一一份** union-find 計算器（Owner 2026-10-12 准 (B)）。
//
// 這個模組有三個角色，全部共用同一段 union-find（不新增第二套演算法）：
//   1. 讀取端（Node）：db.js 的 attachSameHouseRoleSteps 以 `buildSameHouseComponents`
//      併出分量，再用 match.js 的比較式選主。
//   2. 刷新端（PG）：`refreshFoldComponentRoot(exec, postId)` 從髒列出發抓出整個分量的
//      閉包，用同一段 union-find 重算 `listings.fold_component_root`，只寫有差的列。
//      呼叫點只有一個：match.js 的 fold 刷新漏斗（refreshFoldColumns）——不准另開刷新鏈。
//   3. 回填端：`v3/scripts/fold-root-backfill.mjs` 用同一支計算器全表重算（分批、冪等）。
//
// `listings.fold_component_root` 的形狀＝**分量的 canonical label（成員中最小 post_id）**，
// 取捨見 docs/same-house-fold-spec.md §6.4：
//   - 當分組鍵：同分量每一列的欄值相同 ⇒ 讀取端 `WHERE fold_component_root = ANY(...)`
//     是一條索引查詢（idx_listings_fold_component_root），SQL 端不再算連通分量。
//   - 不存「贏家 post_id」當 root 的原因：選主要用 match.js 的比較式，其中相對更新時間
//     （fold_refresh_kind=1）要和絕對時間列比大小 ⇒ 固化「贏家」會隨時間過期；固化
//     「分量標籤」＋讀取端用同一組 fold_* 輸入排名則不受請求時間影響。
//   - NULL ＝ 單節點分量（沒有同屋源關係）、已被 split 的列、或尚未回填。
//
// `fold_component_root` 只固化**全域關係邊**（match 邊 ＋ listing_group_members）；
// 個人範圍的輸入（user_same_house_members／user_match_votes 的 split）依 B-plan 不固化，
// 理由與正確性論證見 docs/same-house-fold-spec.md §6.5／§6.6。
import { normalizeCrawlSources, publicCrawlSources, defaultCrawlSources } from "./crawlSources.js";
import { votePairKey } from "./matchVotes.js";

export const LABEL_NONE = null;

/** 無向圖的 union-find（路徑壓縮）。根的選擇取決於 union 順序，但**分量的成員集合**與順序無關。 */
export function createUnionFind() {
  const parent = new Map();
  const ensure = (x) => { if (!parent.has(x)) parent.set(x, x); };
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    let c = x;
    while (parent.get(c) !== c) { const next = parent.get(c); parent.set(c, r); c = next; }
    return r;
  };
  const union = (a, b) => {
    ensure(a); ensure(b);
    const ra = find(a); const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  return { parent, ensure, find, union, has: (x) => parent.has(x) };
}

/**
 * 併出同屋源連通分量（**唯一的 union-find 實作**；db.js 的讀取端以 `yield*` 直接呼叫）。
 *
 * 規則逐條與舊版 db.js 相同：
 *   ① match 邊：`match_post_id` 有值、對端 verdict <> 'no'、兩端都不是「未就緒」、該對未被 split
 *   ② listing_group_members：同一 group_id 的可用成員兩兩連通
 *   ③ user_same_house_members：同一 group_key 的宇宙成員連通（只有 uid>0）
 *
 * @returns {{compFind:(id:number)=>number, comps:Map<number, Array<{id:number,row:object}>>}}
 *          comps 只含 |C| ≥ 2 的分量（單節點分量不列入 ⇒ 沒有 role、留在主列表）。
 */
export function* buildSameHouseComponents({
  universe,
  linked,
  resolve,
  splits,
  isNotDisplayReady,
  groupIdOf = null,
  personal = null,
  grouped = null,
  hasPersonal = false,
}) {
  const splitsHas = (key) => (typeof splits?.has === "function" ? splits.has(key) : false);
  const notReady = (row) => (typeof isNotDisplayReady === "function" ? Boolean(isNotDisplayReady(row)) : false);
  // split 的 pair key **必須**用 matchVotes 的 votePairKey（有序化 `${lo}:${hi}`）：寫入端
  // 用同一支（db.js `loadUserSplitPairSet` → `votePairKey`），用未排序的 key 會漏掉反向的票。
  const pairKey = (a, b) => votePairKey(a, b);
  const { ensure: compEnsure, find: compFind, union: compUnion } = createUnionFind();

  for (const id of universe.keys()) compEnsure(id);

  let visited = 0;
  for (const row of linked) {
    if (visited && visited % 256 === 0) yield { label: "relations.pairs", units: 256 };
    visited++;
    const mid = Number(row.match_post_id) || 0;
    const peer = resolve(mid);
    if (!peer || String(peer.match_verdict || "") === "no") continue;
    if (notReady(peer) || notReady(row)) continue;
    if (splitsHas(pairKey(row.post_id, mid))) {
      row.same_house_split = true;
      continue;
    }
    compUnion(Number(row.post_id), mid);
  }
  if (visited) yield { label: "relations.pairs", units: (visited - 1) % 256 + 1 };

  // ② 系統同屋源群組：同一 group_id 的可用成員兩兩連通（鏈式 union 即可）。
  if (typeof groupIdOf === "function") {
    visited = 0;
    const byGroupId = new Map();
    for (const [id, row] of universe) {
      if (row.same_house_split) continue;
      // 已被明確否決（`match_verdict='no'`）的列不得再由 `listing_group_members` 黏回同一群。
      if (String(row.match_verdict || "") === "no") continue;
      if (notReady(row)) continue;
      let gid = "";
      try { gid = String(groupIdOf(id) || ""); } catch { gid = ""; }
      if (!gid) {
        if (++visited % 256 === 0) yield { label: "relations.groups", units: 256 };
        continue;
      }
      if (!byGroupId.has(gid)) byGroupId.set(gid, []);
      byGroupId.get(gid).push(id);
      if (++visited % 256 === 0) yield { label: "relations.groups", units: 256 };
    }
    for (const members of byGroupId.values()) {
      for (let i = 1; i < members.length; i++) compUnion(members[0], members[i]);
    }
    if (visited % 256) yield { label: "relations.groups", units: visited % 256 };
  }

  // ③ 會員自己的併組（user_same_house_members）：同 group_key 的宇宙成員連通。
  if (hasPersonal && personal) {
    visited = 0;
    for (const members of (grouped || new Map()).values()) {
      const ids = [];
      const add = (item) => {
        const id = Number(item?.post_id) || 0;
        if (!id || item.same_house_split || !universe.has(id)) return;
        if (String(item.match_verdict || "") === "no") return;
        if (notReady(item)) return;
        if (ids.includes(id)) return;
        ids.push(id);
      };
      for (const row of members) {
        add(row);
        if (++visited % 256 === 0) yield { label: "relations.groups", units: 256 };
        for (const pid of personal.peers(row.post_id)) {
          add(resolve(pid));
          if (++visited % 256 === 0) yield { label: "relations.groups", units: 256 };
        }
      }
      for (let i = 1; i < ids.length; i++) compUnion(ids[0], ids[i]);
    }
    if (visited % 256) yield { label: "relations.groups", units: visited % 256 };
  }

  // 分量 → 成員（只處理 |C| ≥ 2；單節點分量維持「無 role」＝留在主列表）。
  visited = 0;
  const comps = new Map();
  for (const [id, row] of universe) {
    if (row.same_house_split) continue;
    const root = compFind(id);
    if (!comps.has(root)) comps.set(root, []);
    comps.get(root).push({ id, row });
    if (++visited % 256 === 0) yield { label: "relations.groups", units: 256 };
  }
  if (visited % 256) yield { label: "relations.groups", units: visited % 256 };
  return { compFind, comps };
}

/** 分量 → canonical label（成員中最小 post_id；與 union 順序無關）。 */
export function componentLabels(comps) {
  const labels = new Map();
  for (const [root, members] of comps) {
    if (members.length < 2) continue;
    let min = 0;
    for (const { id } of members) if (!min || id < min) min = id;
    labels.set(root, min);
  }
  return labels;
}

/** 把 generator 跑到完，回傳它的 return 值（回填／測試用；讀取端走 runStepsSync）。 */
export function drain(gen) {
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
}

/**
 * `post_id → fold_component_root` 映射（不碰 DB，輸入自己給）。
 * 單節點分量與 split 列 = null，與 SQL 的 `CASE WHEN root IS NULL THEN NULL` 對應。
 * 這是回填腳本與 fold-freshness-check 的入口。
 */
export function componentRootMap({ rows, groupIdOf = null, splits = new Set(), isNotDisplayReady = () => false, personal = null, grouped = null }) {
  const universe = new Map();
  for (const row of rows || []) {
    const id = Number(row?.post_id) || 0;
    if (!id) continue;
    universe.set(id, row);
  }
  const linked = [];
  for (const row of universe.values()) {
    if (Number(row.match_post_id) && String(row.match_verdict || "") !== "no") linked.push(row);
  }
  const resolve = (id) => universe.get(Number(id) || 0) || null;
  const { comps } = drain(buildSameHouseComponents({
    universe, linked, resolve, splits, isNotDisplayReady, groupIdOf,
    personal, grouped, hasPersonal: Boolean(personal && grouped),
  }));
  const labels = componentLabels(comps);
  const out = new Map();
  for (const id of universe.keys()) out.set(id, LABEL_NONE);
  for (const [root, members] of comps) {
    const label = labels.get(root);
    if (label == null) continue;
    for (const { id } of members) out.set(id, label);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 刷新端（PG）
// ---------------------------------------------------------------------------

export const FOLD_ROOT_MAX_NODES = 20000;

// 「這條 exec 是 PG，而且 listings.fold_component_root 已經部署」的探測（每個行程只探一次）。
// 這是**明確的部署閘門**，不是吞錯：欄位還沒部署（例如正式庫在 Owner 跑 DDL 之前）時，
// fold 漏斗不去讀它，寫入路徑照舊成功；DDL 一跑完，下一次寫入就自動開始刷新 root。
let foldRootReady = null;
export async function foldRootRefreshReady(exec) {
  if (foldRootReady !== null) return foldRootReady;
  try {
    await exec("SELECT 1 FROM pg_catalog.pg_class LIMIT 1", []);
    await exec("SELECT fold_component_root FROM listings LIMIT 1", []);
    foldRootReady = true;
  } catch {
    foldRootReady = false;
  }
  return foldRootReady;
}

/** 測試用：清掉探測記憶（同一行程先後接不同 driver 時才需要）。 */
export function resetFoldRootRefreshProbe() { foldRootReady = null; }

/** 從 PG 讀「哪些來源是開啟的」（`settings` 的 `crawlSources` 鍵；與請求期同一個來源）。 */
export async function enabledSourcesFromPg(exec) {
  const rows = await exec("SELECT value FROM settings WHERE key = ?", ["crawlSources"]);
  const list = Array.isArray(rows) ? rows : rows?.rows;
  const raw = list?.[0]?.value;
  let parsed = null;
  try { parsed = raw == null ? defaultCrawlSources() : (typeof raw === "string" ? JSON.parse(raw) : raw); } catch { parsed = defaultCrawlSources(); }
  const items = publicCrawlSources(normalizeCrawlSources(parsed)).items;
  return new Set(items.filter((row) => row.enabled).map((row) => String(row.id)));
}

/**
 * 髒列 → 分量閉包 → 用同一份 union-find 重算 root，只寫有差的列（冪等）。
 *
 * 髒事件（spec §6.4）：群組成員進出、match 邊新增／撤銷（含 verdict 變 no）、
 * offline_confirmed 變化。閉包種子刻意取三者聯集：舊分量的全部成員（邊**撤銷**導致分裂時
 * 才抓得到另一側，否則會留下過期 root）＋ 新舊 match 對端（邊**新增**時抓到另一側）＋
 * 自己與鄰居的群組成員。
 *
 * 回傳 { touched, changed, capped }：capped＝閉包超過 maxNodes 而放棄（呼叫端應改跑全表
 * 回填；分量大小在 repro 實測最大 107，正常不會觸發）。
 */
export async function refreshFoldComponentRoot(exec, postId, { maxNodes = FOLD_ROOT_MAX_NODES, dryRun = false } = {}) {
  const id = Number(postId) || 0;
  if (!id) return { touched: 0, changed: 0, capped: false };
  const rowsOf = (raw) => (Array.isArray(raw) ? raw : raw?.rows) || [];
  const SELECT_ROW = `SELECT l.post_id, l.source, l.match_post_id, l.match_verdict, l.fold_component_root,
                             COALESCE(p.display_ready, 0) AS prep_display_ready
                        FROM listings l LEFT JOIN listing_prep p ON p.post_id = l.post_id
                       WHERE l.post_id = ANY(?)`;

  const nodes = new Map(); // pid → row（含 prep_display_ready）
  const gidsOf = new Map(); // pid → Set<gid>
  const queue = [];
  let capped = false;

  const pushRows = (rows) => {
    for (const row of rowsOf(rows)) {
      const pid = Number(row?.post_id) || 0;
      if (!pid || nodes.has(pid)) continue;
      nodes.set(pid, row);
      queue.push(pid);
    }
  };

  const first = rowsOf(await exec(SELECT_ROW, [[id]]));
  if (!first.length) return { touched: 0, changed: 0, capped: false };
  pushRows(first);
  const oldRoot = Number(first[0].fold_component_root) || 0;
  // 舊分量的成員（邊撤銷 ⇒ 分裂時的另一側）。
  if (oldRoot) pushRows(await exec("SELECT post_id FROM listings WHERE fold_component_root = ?", [oldRoot]));

  const expanded = new Set();
  while (queue.length) {
    if (nodes.size > maxNodes) { capped = true; break; }
    const batch = queue.splice(0, queue.length).filter((pid) => !expanded.has(pid));
    if (!batch.length) break;
    for (const pid of batch) expanded.add(pid);
    const [reverse, gidRows] = await Promise.all([
      exec("SELECT l.post_id, l.source, l.match_post_id, l.match_verdict, l.fold_component_root, COALESCE(p.display_ready,0) AS prep_display_ready FROM listings l LEFT JOIN listing_prep p ON p.post_id = l.post_id WHERE l.match_post_id = ANY(?)", [batch]),
      exec("SELECT post_id, group_id FROM listing_group_members WHERE post_id = ANY(?)", [batch]),
    ]);
    pushRows(reverse);
    const gids = new Set();
    for (const row of rowsOf(gidRows)) {
      const pid = Number(row.post_id) || 0;
      const gid = String(row.group_id || "");
      if (!pid || !gid) continue;
      if (!gidsOf.has(pid)) gidsOf.set(pid, new Set());
      gidsOf.get(pid).add(gid);
      gids.add(gid);
    }
    // 自己的 match 對端。
    const forward = [...new Set(batch.map((pid) => Number(nodes.get(pid)?.match_post_id) || 0).filter(Boolean))];
    if (forward.length) pushRows(await exec(SELECT_ROW, [forward]));
    // 群組其餘成員。
    if (gids.size) {
      const memberRows = rowsOf(await exec("SELECT post_id, group_id FROM listing_group_members WHERE group_id = ANY(?)", [[...gids]]));
      const memberIds = [];
      for (const row of memberRows) {
        const pid = Number(row.post_id) || 0;
        const gid = String(row.group_id || "");
        if (!pid || !gid) continue;
        if (!gidsOf.has(pid)) gidsOf.set(pid, new Set());
        gidsOf.get(pid).add(gid);
        memberIds.push(pid);
      }
      if (memberIds.length) pushRows(await exec(SELECT_ROW, [[...new Set(memberIds)]]));
    }
    // 已經有 root 的列：同分量的成員全部拉進來（否則會漏算別的成員）。
    const roots = [...new Set([...nodes.values()].map((r) => Number(r.fold_component_root) || 0).filter(Boolean))]
      .filter((root) => !nodes.has(root) || Number(nodes.get(root).fold_component_root) === root);
    for (const root of roots) {
      const members = rowsOf(await exec("SELECT post_id FROM listings WHERE fold_component_root = ?", [root]));
      const missing = members.map((r) => Number(r.post_id) || 0).filter((pid) => pid && !nodes.has(pid));
      if (missing.length) pushRows(await exec(SELECT_ROW, [missing]));
    }
  }
  if (capped) return { touched: nodes.size, changed: 0, capped: true };

  const enabled = await enabledSourcesFromPg(exec);
  const isNotDisplayReady = (row) => {
    const source = String(row?.source || "591") || "591";
    if (!enabled.has(source)) return true;
    if (source !== "houseprice") return false;
    return Number(row?.prep_display_ready) === 1 ? false : true;
  };
  const groupIdOf = (pid) => {
    const set = gidsOf.get(Number(pid) || 0);
    if (!set || !set.size) return "";
    return [...set].sort()[0];
  };
  // ⚠️ 一定要用**完整欄位**的列來算與比對：閉包擴張時「舊 root 的成員」只選了 post_id
  // （只用來擴張，不足以算分量，也沒有現值可比）⇒ 這裡統一重讀全部 touched 的完整列。
  const touchedIds = [...nodes.keys()].filter((pid) => pid);
  const fullRows = rowsOf(await exec(
    `SELECT l.post_id, l.source, l.match_post_id, l.match_verdict, l.fold_component_root,
            COALESCE(p.display_ready, 0) AS prep_display_ready
       FROM listings l LEFT JOIN listing_prep p ON p.post_id = l.post_id
      WHERE l.post_id = ANY(?)`,
    [touchedIds],
  ));
  const fullById = new Map(fullRows.map((row) => [Number(row.post_id) || 0, row]));
  const list = touchedIds.map((pid) => fullById.get(pid)).filter(Boolean);
  const roots = componentRootMap({ rows: list, groupIdOf, splits: new Set(), isNotDisplayReady });
  const writes = [];
  for (const row of list) {
    const pid = Number(row.post_id) || 0;
    const before = row.fold_component_root == null ? null : Number(row.fold_component_root);
    const after = roots.get(pid) == null ? null : Number(roots.get(pid));
    if (before !== after) writes.push([after, pid]);
  }
  if (!dryRun) {
    for (const [root, pid] of writes) {
      await exec("UPDATE listings SET fold_component_root = ? WHERE post_id = ?", [root, pid]);
    }
  }
  // dryRun＝新鮮度檢查用：算但不寫，回傳閉包內每個成員「重算後應該是什麼」。
  const computed = new Map();
  for (const row of list) {
    const pid = Number(row.post_id) || 0;
    computed.set(pid, roots.get(pid) == null ? null : Number(roots.get(pid)));
  }
  return { touched: list.length, changed: dryRun ? 0 : writes.length, capped: false, computed, storedDiff: writes.length };
}
