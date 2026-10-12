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
    // ⚠️ 一定要用「不會失敗的查詢」探測：`SELECT fold_component_root FROM listings LIMIT 1`
    // 在欄位不存在時會拋 42703，而**在呼叫端的 PG 交易裡一句失敗的 SELECT 會讓整個交易進
    // aborted（25P02）**⇒ 後續同交易的寫入全部回滾（CI 的 listing-state-writes 就是這樣紅的）。
    // 用 `pg_attribute` ＋ `to_regclass('listings')`：不拋錯（找不到回 0 列）且**跟著 search_path**
    // 解析「這次查詢真正會打到的那張 listings」。
    // 為什麼不能只查 information_schema 的 table_name：那是**跨 schema** 的（CI 實測踩到）——
    // 同一個資料庫裡 `public.listings` 有欄位、fixture 自己建的另一個 schema 的 `listings` 沒有，
    // 探測就會說「有」而後續查詢在 fixture 的 listings 上 42703（prb-search-benchmark 就是這樣紅的）。
    // 在 SQLite 上 `pg_attribute` 不存在會拋錯 ⇒ 直接當作「不是 PG／沒有這一欄」。
    const rows = await exec(
      "SELECT 1 AS ok FROM pg_attribute WHERE attrelid = to_regclass(?) AND attname = ? AND attnum > 0 AND NOT attisdropped LIMIT 1",
      ["listings", "fold_component_root"],
    );
    const list = Array.isArray(rows) ? rows : rows?.rows;
    foldRootReady = Array.isArray(list) && list.length > 0;
  } catch {
    foldRootReady = false;
  }
  return foldRootReady;
}

/** 測試用：清掉探測記憶（同一行程先後接不同 driver 時才需要）。 */
export function resetFoldRootRefreshProbe() { foldRootReady = null; }

// ---------------------------------------------------------------------------
// 開閘前檢（訪客 SQL-first；Owner 2026-10-12 R3：fail-closed，禁止自動降級）
// ---------------------------------------------------------------------------

/** 開閘前檢的穩定原因碼（拒開閘 ⇒ 呼叫端必須回 503 並告警，不得退回舊路徑）。 */
export const FOLD_SQL_GATE_REASON = Object.freeze({
  NO_COLUMN: "fold_component_root_missing",
  NO_DRIFT_STAMP: "fold_root_drift_stamp_missing",
  DRIFT_STAMP_DIRTY: "fold_root_drift_stamp_mismatch",
  // 戳記存在且零差，但**對不上當前資料版本**（升級層 2026-10-12 21:24 加嚴：「僅有 stamp 不足」）。
  DRIFT_STAMP_STALE: "fold_root_drift_stamp_stale",
});

// `fold-root-drift-check.mjs --stamp` 在「全量重算 vs 固化欄」逐列零差時寫入的 settings 鍵。
// 為什麼用戳記而不是即時抽樣：NULL 是**合法值**（單節點分量／被三道閘否決的邊），
// 所以「有邊卻沒有 root」不能當不完整；而全量重算不可能每請求做一次（見 runbook §1／§5）。
export const FOLD_DRIFT_STAMP_KEY = "foldRootDriftStamp";

/**
 * 戳記綁定的資料版本：**線上**（每請求走這條）只比對列數與 `max(post_id)`——兩者都吃 PK 索引，
 * 成本固定且小。任一個變了（爬蟲新增／刪除／批次重寫）⇒ 戳記立即失效（fail-closed）。
 *
 * 離線複核（runbook §1 步驟 3c，人工）另比對 **root 聚合 md5**（全表聚合，太貴、不進每請求路徑）：
 *   SELECT count(*) AS n, max(post_id) AS max_post_id,
 *          md5(string_agg(post_id::text || '|' || COALESCE(fold_component_root::text, '-'), '' ORDER BY post_id)) AS roots_md5
 *     FROM listings;
 *
 * 已知限制（明文，不得含糊）：只改 `fold_component_root` 值、卻既沒改列數也沒改 `max(post_id)` 的
 * 原地更新（刷新鏈），線上這兩個值抓不到 ⇒ 刷新／回填**之後必須重跑 `--stamp`**（runbook §2 的
 * 髒事件清單），`roots_md5` 是離線複核那一條。
 */
export const FOLD_DATA_VERSION_SQL = "SELECT count(*) AS n, max(post_id) AS max_post_id FROM listings";

// 成功判定可快取多久（毫秒；0＝每請求都重驗）。失敗**永遠**記憶（fail-closed 快路徑：修好依賴後
// 要重啟行程，這是刻意的）；成功只記這麼久，讓「資料一變就失效」在 TTL 內生效。
const FOLD_SQL_GATE_OK_TTL_MS = (() => {
  const raw = Number(process.env.FOLD_SQL_GATE_OK_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
})();

let foldSqlGateCache = null;

/** 測試用：清掉開閘前檢的記憶（同一行程先後接不同 driver／不同戳記時才需要）。 */
export function resetFoldSqlGate() { foldSqlGateCache = null; }

/**
 * 訪客 SQL-first 折疊的**開閘前檢**（fail-closed）。
 *
 * 在哪裡做：`preloadDecorationProviderAsync` 之外的**讀取入口**——`publicListingSearchAsync.js`
 * 的 `searchPublicListingsAsync()`，在 `PUBLIC_LISTINGS_SQL_FIRST === "1"` 之後、任何折疊 SQL
 * 之前呼叫。用的是**這一個請求自己的連線／交易**（`withPgReadSnapshot` 的 snapshot client），
 * 不另開連線、不碰寫入路徑的交易。
 *
 * 依賴（三項都必須成立）：
 *   1. 欄位存在：`pg_attribute` ＋ `to_regclass('listings')`（與 `foldRootRefreshReady` 同一條探測；
 *      缺欄時回 0 列、**不拋錯** ⇒ 不會讓交易進 aborted（25P02））。**不用** `information_schema`：
 *      它是跨 schema 的（同庫別的 schema 有同名表就會誤判，L-0869）。
 *   2. 回填已驗證零差：`settings.foldRootDriftStamp`（由 `fold-root-drift-check.mjs --stamp`
 *      在全量重算逐列零差時寫入）存在且 `mismatches === 0`。
 *   3. **戳記綁定當前資料版本**：戳記內的 `dataVersion {rows, maxPostId}` 必須等於線上
 *      `FOLD_DATA_VERSION_SQL` 的實測值；不符（或缺欄位）⇒ 拒開閘，reason=`DRIFT_STAMP_STALE`。
 *      升級層 2026-10-12 21:24：「僅有 stamp 不足」。資料變了就要重跑 `--stamp`（runbook §1）。
 *
 * 回傳 `{ ok, reason, detail }`。快取：**失敗永遠記**（修好依賴後需重啟行程，刻意的 fail-closed）；
 * **成功只記 `FOLD_SQL_GATE_OK_TTL_MS`**（預設 60s，可用環境變數調；0＝每請求重驗），
 * 否則「資料一變就失效」會被行程內快取永久蓋住。呼叫端**不得**在 `ok:false` 時退回 Node 路徑。
 */
export async function foldSqlGateReady(exec) {
  if (foldSqlGateCache) {
    const age = Date.now() - foldSqlGateCache.at;
    if (!foldSqlGateCache.result.ok || age < FOLD_SQL_GATE_OK_TTL_MS) return foldSqlGateCache.result;
  }
  let result;
  try {
    if (!(await foldRootRefreshReady(exec))) {
      result = { ok: false, reason: FOLD_SQL_GATE_REASON.NO_COLUMN, detail: null };
    } else {
      const rows = await exec("SELECT value FROM settings WHERE key = ?", [FOLD_DRIFT_STAMP_KEY]);
      const list = Array.isArray(rows) ? rows : rows?.rows;
      const raw = list?.[0]?.value;
      let stamp = null;
      try { stamp = raw == null ? null : (typeof raw === "string" ? JSON.parse(raw) : raw); } catch { stamp = null; }
      if (!stamp || Number.isFinite(Number(stamp.mismatches)) === false) {
        result = { ok: false, reason: FOLD_SQL_GATE_REASON.NO_DRIFT_STAMP, detail: null };
      } else if (Number(stamp.mismatches) !== 0) {
        result = { ok: false, reason: FOLD_SQL_GATE_REASON.DRIFT_STAMP_DIRTY, detail: { mismatches: Number(stamp.mismatches), at: stamp.at || null } };
      } else if (!Number.isFinite(Number(stamp?.dataVersion?.rows)) || !Number.isFinite(Number(stamp?.dataVersion?.maxPostId))) {
        // 舊式戳記（沒有 dataVersion）＝身分不明 ⇒ 拒開閘，重跑 --stamp 即可修好。
        result = {
          ok: false,
          reason: FOLD_SQL_GATE_REASON.DRIFT_STAMP_STALE,
          detail: { missing: "dataVersion", at: stamp.at || null, fix: "node v3/scripts/fold-root-drift-check.mjs --stamp" },
        };
      } else {
        const liveRowsRaw = await exec(FOLD_DATA_VERSION_SQL, []);
        const liveList = Array.isArray(liveRowsRaw) ? liveRowsRaw : liveRowsRaw?.rows;
        const live = liveList?.[0] || {};
        const liveRows = Number(live.n);
        const liveMax = Number(live.max_post_id);
        const stampedRows = Number(stamp.dataVersion.rows);
        const stampedMax = Number(stamp.dataVersion.maxPostId);
        if (!Number.isFinite(liveRows) || !Number.isFinite(liveMax) || liveRows !== stampedRows || liveMax !== stampedMax) {
          result = {
            ok: false,
            reason: FOLD_SQL_GATE_REASON.DRIFT_STAMP_STALE,
            detail: { stamped: { rows: stampedRows, maxPostId: stampedMax }, live: { rows: liveRows, maxPostId: liveMax }, at: stamp.at || null },
          };
        } else {
          result = {
            ok: true,
            reason: null,
            detail: { at: stamp.at || null, rows: liveRows, maxPostId: liveMax, rootsMd5: stamp.dataVersion.rootsMd5 || null },
          };
        }
      }
    }
  } catch (error) {
    // 讀不到戳記（表不存在／連線壞）⇒ 一樣拒開閘。
    result = { ok: false, reason: FOLD_SQL_GATE_REASON.NO_DRIFT_STAMP, detail: { error: String(error?.message || error).slice(0, 160) } };
  }
  foldSqlGateCache = { result, at: Date.now() };
  return result;
}

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
