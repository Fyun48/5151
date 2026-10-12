// 行政區關係閉包（`districtClosureIds`）的「配對圖連通分量」材料化 —— **讀取端**。
//
// 動機（2026-10-12 靶上逐項實測）：`districtClosureIds()` 每個請求都要把 7.4 萬條 match 邊
// （`SELECT post_id, match_post_id FROM listings WHERE match_post_id > 0 OR match_post_id < 0`
// ＝ 74,592 列／10 趟 FETCH 184ms）搬回 Node、建 edges 陣列（87ms）、再對 10 萬個節點跑
// union-find（201ms），加上種子述詞 184ms ⇒ **單獨 869–927ms**。同一段時間這張圖幾乎不動
// （有 match 邊的列數 27 秒只變 1 次），所以「每請求重算」是純浪費。
//
// ── 材料化形狀（**不是答案快取，是預先算好的圖**）────────────────────────────────
// 每個配對圖節點一列 `listing_match_component(post_id, component_id, district_prefix, match_post_id)`：
//   • `component_id`＝所屬連通分量的代表（分量內**最小 post_id**；與輸入順序無關 ⇒ 重算可以逐列比對）；
//   • `district_prefix`＝**同一個**種子述詞表達式（`districtKeyPrefixExpression("pg")`）在該列的值；
//   • `match_post_id`＝該列自己的邊值（`NULL`＝自己沒有 match 邊，但可能是別條邊的端點）。
//   閉包因此變成一句 SQL（分量表內篩 prefix → 取那些分量的全部節點）：
//   **不再搬 7 萬列、不再在 Node 跑 union-find**。
//   為什麼把 `district_prefix` 也材料化：種子述詞那兩條查詢本身就是 184ms（152ms＋32ms），
//   那是這條路徑最後一塊大成本；材料化之後它變成同一張表上的一個索引條件。
//
// ── 維護時機（**不准每寫一列就重算**）──────────────────────────────────────────
// 常態路徑**根本不重算**：逐列證明通過時只把水位往前推一句 CAS UPDATE
// （`advanceMatchComponentState`，跨行程只有一個贏家）——爬蟲每輪結束都會換輪次標記，
// 但配對圖幾乎不動，為此重算 7 萬條邊是純浪費。
// **只有「證明無法維持」時才重算**：狀態列／表不存在或表被清空、版本水位讀不到、
// 一次變更超過 `MEMBER_DISTRICT_CLOSURE_DELTA_CAP`、出現無法逐列驗證的 bump、
// 逐列證明發現圖真的變了、列被刪掉（計數器）、超過 `MEMBER_DISTRICT_CLOSURE_MAX_STALE_MS`。
// 重算由 `scheduleMatchComponentRebuild()` 排（行程內去抖 ＋ `pg_try_advisory_lock`），
// 一次只寫**一批**（一個交易內一句 DELETE ＋ 一句 `INSERT … SELECT unnest(...)`）；
// 逐列比對完全相同時連那一批都不寫。
//
// ⚠️ **成本與預算（實測，2026-10-12）**：一次完整重算在 18.4 萬列的靶上實測
// **3.9 秒**（7.4 萬條邊讀取 0.44s／10 萬節點 union-find 0.48s／10 萬列寫入 1.9–3.1s），
// 超過 Owner 定的「每輪 ≤2 秒」⇒ 這一版把重算的**頻率**壓在「每個爬蟲輪次最多一次」
// （`MEMBER_DISTRICT_CLOSURE_REBUILD_MIN_INTERVAL_MS` 預設 60 秒＋同一輪次不會重複），
// 並在證明失敗時**退回即時算**（正確但慢）。
// 生產待機庫 60 秒實測（2026-10-12 20:5x，20 次取樣）：配對圖**每分鐘約變 4 次** ⇒
// 「圖一直小改」是常態，證明失敗的次數會遠多於重算次數 ⇒ **命中率取決於兩次重算之間的安靜程度**。
// 要讓它在活躍爬蟲下也持續命中，下一步必須是「把新增的邊**增量吸收**進分量表」
// （合併用一句 `UPDATE … SET component_id`，只有「邊消失」才需要完整重算）——**這一版沒有做**，
// 留給 Owner 裁決（見 PR 描述的「設計短評」）。
//
// ── 過期偵測（每一道都是便宜的讀；**不准**用每請求重算來偵測）────────────────────
//   1. **逐列證明**（主要那道）：材料化記下 `data_revision.MAX(id)` 水位，之後只對
//      `(水位, 現在]` 之間**被 data_revision 指名變更且 `entity_type='listing'`** 的 post_id，
//      逐筆比對「現在的 `match_post_id`／`district_prefix`」與表內存的值。
//      `listingMatchAsync.setListingMatch()` 改 `match_post_id` 時**會** bump data_revision
//      （`listingMatchAsync.js:126`），所以這道證明對「配對變更」是**逐列確定的**，不是抽樣、
//      不是加總恒等式。變更列數超過上限（預設 2000）⇒ 不硬撐，直接視為過期。
//      `entity_id` 是 NULL／0 的 bump（實測：`same_house_merge`／`same_house_split`／
//      `listing_offline_confirmed`）**無法**逐列驗證，而合併／拆分會改 `match_post_id`
//      ⇒ 一律視為過期（寧可重算，不可少算）；只有 `GRAPH_IRRELEVANT_EVENTS` 這張
//      已登記的例外清單（證明過不動 `match_post_id`／`source_key`）可以放行。
//   2. **輪次標記**（`settings.lastCoveringAt` ＋ `crawl_covers.MAX(last_run_at)`）：
//      它只是**提示該重新證明**，本身不是過期理由 —— 證明通過就照樣回答，並把水位往前推。
//   3. **列刪除計數器**兜底：`pg_stat_user_tables` 對 `listings` 的 `n_tup_del`，
//      只在「版本沒前進、狀態列已建好 5 秒（避開統計落地延遲）、計數卻變了」時觸發。
//      新增列**不靠它**（有邊的會被逐列證明抓到，沒邊的對閉包無影響）。
//   4. **硬上界** `MEMBER_DISTRICT_CLOSURE_MAX_STALE_MS`（預設 30 分鐘）：超過就重算。
//      沒有輪次、版本號、列增減的變更（例如帶外 `UPDATE listings SET match_post_id=…`、
//      `deleteListingRow` 造成的分量分裂）只在這個窗口內不會被發現 ⇒ **殘留風險明列於此**：
//      與 `listingDistrictPrefilter` 的 5 分鐘全掃窗口是同一類取捨，窗口內只可能讓新的配對關係
//      晚一點出現（方向偏好「多算」：多出來的 id 不存在於 `listings`，或被判定鏈的行政區
//      條件濾掉），不會讓既有結果少算。
//
// ── fail-safe 方向＝回到「正確但慢」的路徑（**不准回成「少算」**）──────────────────
//   • `MEMBER_DISTRICT_CLOSURE_MATERIALIZED=0` ⇒ 逐字走原本的即時算（原路徑不刪）。
//   • 表不存在／狀態列讀不到／狀態列缺欄／證明讀不到／版本號倒退／表內沒有資料
//     ⇒ 一律回 `null` ⇒ 呼叫端走即時算（不猜、不靜默少算）。
//   • 重算失敗（含**待機不寫**）⇒ 只是下一個請求仍然走即時算。
import { districtKeyPrefixExpression } from "./listDistrictSql.js";

/** 可整條關掉的開關（A/B 用）。`=0` ⇒ 一行都不經過，逐字走即時算。 */
export const MEMBER_DISTRICT_CLOSURE_ENV = "MEMBER_DISTRICT_CLOSURE_MATERIALIZED";
/** 「圖變了」的證明做不到時，最多沿用多久（毫秒）。 */
export const MAX_STALE_MS_ENV = "MEMBER_DISTRICT_CLOSURE_MAX_STALE_MS";
/** 一次驗證最多接受幾個被指名的變更列（超過就直接重算）。 */
export const DELTA_CAP_ENV = "MEMBER_DISTRICT_CLOSURE_DELTA_CAP";
/** 同一個行程內兩次重算之間的最小間隔（毫秒）；跨行程另有 advisory lock。 */
export const REBUILD_MIN_INTERVAL_ENV = "MEMBER_DISTRICT_CLOSURE_REBUILD_MIN_INTERVAL_MS";
/** 逐列證明要往前推幾列才寫一次狀態列（見 `advanceMinDelta()`）。 */
export const ADVANCE_MIN_DELTA_ENV = "MEMBER_DISTRICT_CLOSURE_ADVANCE_MIN_DELTA";

export const MATCH_COMPONENT_TABLE = "listing_match_component";
export const MATCH_COMPONENT_STATE_TABLE = "listing_match_component_state";
export const MATCH_GRAPH_STATE_KEY = "match_graph";
export const MATCH_COMPONENT_LOCK_KEY = 51510011;

export const DEFAULT_MAX_STALE_MS = 30 * 60 * 1000;
export const DEFAULT_DELTA_CAP = 2000;
export const DEFAULT_REBUILD_MIN_INTERVAL_MS = 60 * 1000;
export const DEFAULT_ADVANCE_MIN_DELTA = 128;

/** 關閉開關（A/B 等價證據用）；預設開啟。形狀同 `districtPrefilterEnabled()`。 */
export function districtClosureMaterializedEnabled() {
  const raw = process.env[MEMBER_DISTRICT_CLOSURE_ENV];
  if (raw == null || raw === "") return true;
  return !["0", "false", "off", "no"].includes(String(raw).trim().toLowerCase());
}

function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function maxStaleMs() {
  return positiveInt(process.env[MAX_STALE_MS_ENV], DEFAULT_MAX_STALE_MS);
}
export function deltaCap() {
  return positiveInt(process.env[DELTA_CAP_ENV], DEFAULT_DELTA_CAP);
}
export function rebuildMinIntervalMs() {
  return positiveInt(process.env[REBUILD_MIN_INTERVAL_ENV], DEFAULT_REBUILD_MIN_INTERVAL_MS);
}
/** 逐列證明要推得多遠才值得寫一次狀態列（避免「每個請求都寫一行」）。 */
export function advanceMinDelta() {
  return positiveInt(process.env[ADVANCE_MIN_DELTA_ENV], DEFAULT_ADVANCE_MIN_DELTA);
}

/**
 * 配對圖的連通分量標記。
 *
 * ⚠️ 這支是**即時算（live）與材料化（rebuild）共用的同一份演算法** —— 兩邊各寫一份就會漂移，
 * 而漂移只能靠逐筆比對才看得出來。
 *
 * 為什麼不是 Map union-find：`astra6 2026-09-25 §3.2` 實測沒有 path compression／union-by-size
 * 時，1,000 節點的鏈要 999,000 次 parent 走訪。
 * 為什麼邊表不能是 `Int32Array`：`post_id` 已超過 2^31-1（實測 2,507,462,476），
 * `Int32Array` 會**靜默截斷成負數**（實測 onlyNew=6,362）⇒ 邊表用 `Float64Array`，
 * 只有 0..n-1 的緊湊索引才進 `Int32Array`。
 *
 * @param {Array<[number, number]>} pairs 邊（兩端都是非 0 整數；端點集合即「節點」）
 */
export function componentLabels(pairs) {
  const edgeCount = Array.isArray(pairs) ? pairs.length : 0;
  const ea = new Float64Array(edgeCount);
  const eb = new Float64Array(edgeCount);
  const nodeIndex = new Map();
  for (let i = 0; i < edgeCount; i += 1) {
    const a = pairs[i][0];
    const b = pairs[i][1];
    if (!nodeIndex.has(a)) nodeIndex.set(a, nodeIndex.size);
    if (!nodeIndex.has(b)) nodeIndex.set(b, nodeIndex.size);
    ea[i] = a;
    eb[i] = b;
  }
  const n = nodeIndex.size;
  const parent = new Int32Array(n);
  const size = new Int32Array(n);
  for (let i = 0; i < n; i += 1) { parent[i] = i; size[i] = 1; }
  const find = (x) => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    let cur = x;
    while (parent[cur] !== root) { const next = parent[cur]; parent[cur] = root; cur = next; }
    return root;
  };
  const union = (a, b) => {
    let ra = find(a);
    let rb = find(b);
    if (ra === rb) return;
    if (size[ra] < size[rb]) { const t = ra; ra = rb; rb = t; }
    parent[rb] = ra;
    size[ra] += size[rb];
  };
  for (let i = 0; i < edgeCount; i += 1) union(nodeIndex.get(ea[i]), nodeIndex.get(eb[i]));
  // 分量代表＝分量內最小 post_id：與邊的**輸入順序無關**，所以「重算後有沒有變」可以逐列比對，
  // 沒變就不必寫那 7 萬列（寫入放大）。
  const repByRoot = new Map();
  for (const [id, idx] of nodeIndex) {
    const root = find(idx);
    const cur = repByRoot.get(root);
    if (cur === undefined || id < cur) repByRoot.set(root, id);
  }
  const repOfIndex = (idx) => repByRoot.get(find(idx));
  return {
    edgeCount,
    nodeIndex,
    // 邊的兩端（`Float64Array`，與 `nodeIndex` 的索引空間分開；見上面 Int32Array 的說明）。
    ea,
    eb,
    find,
    repOfIndex,
    /** 該 id 所屬分量的代表；不在圖裡回 undefined。 */
    repOf: (id) => {
      const idx = nodeIndex.get(id);
      return idx === undefined ? undefined : repOfIndex(idx);
    },
    /** 全部節點 → 分量代表（重算寫入用）。 */
    allLabels: () => {
      const out = new Map();
      for (const [id, idx] of nodeIndex) out.set(id, repOfIndex(idx));
      return out;
    },
  };
}

// ── 讀取端 ────────────────────────────────────────────────────────────────────

const num = (value) => (value == null ? null : Number(value));
/** 這條列自己有沒有 match 邊（與 SQL 的 `match_post_id > 0 OR match_post_id < 0` 同義）。 */
function edgeValue(value) {
  const n = num(value);
  return n == null || !Number.isFinite(n) || n === 0 ? null : n;
}

function liveRoundMarker(row) {
  const covering = row?.covering == null ? "" : String(row.covering);
  const coversMax = row?.covers_max == null ? "" : String(row.covers_max);
  return `${covering}|${coversMax}`;
}

const STATE_PROBE_SQL = `
SELECT s.built_at AS built_at,
       s.round_marker AS round_marker,
       s.revision_watermark AS revision_watermark,
       s.listings_stat_fingerprint AS stat_fingerprint,
       s.node_count AS node_count,
       (SELECT value FROM settings WHERE key = 'lastCoveringAt') AS covering,
       (SELECT value FROM settings WHERE key = 'lastSystemCoveringAt') AS system_covering,
       CAST((SELECT MAX(last_run_at) FROM crawl_covers) AS text) AS covers_max,
       (SELECT COALESCE(MAX(id), 0) FROM data_revision) AS revision
  FROM ${MATCH_COMPONENT_STATE_TABLE} s
 WHERE s.state_key = ?`;

const REVISION_DELTA_SQL = `
SELECT id, entity_id, event_type FROM data_revision
 WHERE id > ? AND id <= ? AND entity_type = 'listing'
 ORDER BY id`;

// 已登記的「與配對圖無關」事件（**唯一**的例外清單，形狀照 L-0503：入欄、判定點名、交付暴露）。
//
// `listing_offline_confirmed`（`crawlerWrites.EXPIRED_OFFLINE_SQL`）只寫
// `offline_confirmed／last_event／last_checked_at`，**不碰** `match_post_id`／`source_key`
// ⇒ 對閉包的輸入（配對邊、行政區前綴）沒有影響。它的 `entity_id` 是 NULL（批次下架，無法指名列），
// 若沒有這張清單，每一次批次下架都會逼出一次完整重算。
//
// ⚠️ 加新事件進來之前必須先證明它不改 `listings.match_post_id` 與 `source_key`；
// 其他任何 `entity_id` 為 NULL 的 bump 一律視為「無法驗證 ⇒ 重算」（fail-safe）。
export const GRAPH_IRRELEVANT_EVENTS = Object.freeze(["listing_offline_confirmed"]);
const GRAPH_IRRELEVANT_EVENT_SET = new Set(GRAPH_IRRELEVANT_EVENTS);

// ⚠️ 只計 `n_tup_del`（列消失），**不**計 `n_tup_ins`／`n_tup_upd`：
//   • 新增列只要沒有 match 邊就對閉包無影響，有了邊就會被 `data_revision` 逐列證明抓到
//     （`entity_id` 指名得到）⇒ 不需要靠計數器。
//   • `n_tup_upd` 每秒都在動（爬蟲 upsert），計入就等於每請求重算（同 se-p8 的結論）。
//   • 真正只有計數器能發現的是「列被刪掉、又沒有 bump」；刪除很少見，所以誤判成本可控。
//   • `pg_stat_user_tables` 有約 1 秒的落地延遲 ⇒ 這一條只在狀態列建好 5 秒後才比對
//     （`settled`），否則會把「還沒落地的自己那批寫入」誤判成帶外寫入。
const LISTINGS_STAT_SQL =
  "SELECT COALESCE(SUM(n_tup_del), 0) AS fingerprint FROM pg_stat_user_tables WHERE relname = 'listings'";

const VERIFY_SQL = `
SELECT x.post_id AS post_id,
       l.match_post_id AS cur_match,
       ${districtKeyPrefixExpression("pg")} AS cur_prefix,
       (c.post_id IS NOT NULL) AS in_table,
       c.match_post_id AS stored_match,
       c.district_prefix AS stored_prefix
  FROM unnest(?::bigint[]) AS x(post_id)
  LEFT JOIN listings l ON l.post_id = x.post_id
  LEFT JOIN ${MATCH_COMPONENT_TABLE} c ON c.post_id = x.post_id`;

/**
 * 這一列的「圖相關狀態」是否與材料化當時相同。
 *
 * 圖相關狀態＝（自己有沒有邊、邊值）＋（自己是節點時的 district 前綴）。
 * 只比 `match_post_id` 不夠：`source_key` 改了會換掉種子資格，而種子集合決定閉包。
 */
export function graphRowDiffers(row) {
  const curEdge = edgeValue(row?.cur_match);
  const storedEdge = edgeValue(row?.stored_match);
  if ((curEdge == null) !== (storedEdge == null)) return true;
  if (curEdge != null && curEdge !== storedEdge) return true;
  const isNode = row?.in_table === true || curEdge != null;
  if (!isNode) return false;
  const curPrefix = row?.cur_prefix == null ? null : String(row.cur_prefix);
  const storedPrefix = row?.stored_prefix == null ? null : String(row.stored_prefix);
  return curPrefix !== storedPrefix;
}

async function tableHasRows(exec) {
  const rows = await exec(`SELECT EXISTS(SELECT 1 FROM ${MATCH_COMPONENT_TABLE}) AS present`, []);
  return rows?.[0]?.present === true;
}

async function seededComponentIds(exec, { allowed, allKeys }) {
  const rows = await exec(
    `SELECT DISTINCT s.component_id AS component_id FROM ${MATCH_COMPONENT_TABLE} s
      WHERE s.district_prefix IS NOT NULL
        AND (s.district_prefix = ANY(?::text[]) OR NOT (s.district_prefix = ANY(?::text[])))`,
    [allowed, allKeys],
  );
  const out = [];
  for (const row of rows || []) {
    const id = Number(row?.component_id);
    if (Number.isFinite(id)) out.push(id);
  }
  return out;
}

async function componentMemberIds(exec, componentIds) {
  if (!componentIds.length) return [];
  const rows = await exec(
    `SELECT post_id FROM ${MATCH_COMPONENT_TABLE} WHERE component_id = ANY(?::bigint[])`,
    [componentIds],
  );
  const out = [];
  for (const row of rows || []) {
    const id = Number(row?.post_id);
    if (Number.isFinite(id) && id !== 0) out.push(id);
  }
  return out;
}

async function userSameHouseRows(exec, userId) {
  return (await exec("SELECT post_id, group_key FROM user_same_house_members WHERE user_id = ?", [userId])) || [];
}

async function districtSeedIdsAmong(exec, { allowed, allKeys, ids }) {
  if (!ids.length) return [];
  const prefix = districtKeyPrefixExpression("pg");
  const rows = await exec(
    `SELECT post_id FROM listings WHERE post_id = ANY(?::bigint[])
       AND (${prefix} = ANY(?::text[]) OR NOT (${prefix} = ANY(?::text[])))`,
    [ids, allowed, allKeys],
  );
  return (rows || []).map((row) => Number(row?.post_id)).filter((id) => Number.isFinite(id) && id !== 0);
}

/** 全部行政區列（**含不在配對圖裡的**）：`relatedOnly=false` 的舊契約要把它們一起回傳。 */
async function districtSeedIds(exec, { allowed, allKeys }) {
  const prefix = districtKeyPrefixExpression("pg");
  const known = await exec(`SELECT post_id FROM listings WHERE ${prefix} = ANY(?::text[])`, [allowed]);
  const unknown = await exec(`SELECT post_id FROM listings WHERE NOT (${prefix} = ANY(?::text[]))`, [allKeys]);
  const out = [];
  for (const row of [...(known || []), ...(unknown || [])]) {
    const id = Number(row?.post_id);
    if (Number.isFinite(id) && id !== 0) out.push(id);
  }
  return out;
}

/**
 * 材料化分量 → 閉包 id 集合。
 *
 * 與即時算的關係：即時算是 `seeds ∪ { v ∈ 節點 : comp(v) ∈ comp(seeds ∩ 節點) }`，
 * 這裡的 `seeds ∩ 節點` 由分量表的 `district_prefix` 直接表達（表內只有節點），
 * 使用者同屋源（`user_same_house_members`）**每次照樣即時讀**，只是在「分量 id」上做 union-find
 * ——分量的數目比節點少好幾個數量級。這樣同屋源的變更不必讓材料化過期。
 */
async function closureIdsFromComponents(exec, { allowed, allKeys, userId, relatedOnly }) {
  const seeded = await seededComponentIds(exec, { allowed, allKeys });
  const members = userId > 0 ? await userSameHouseRows(exec, userId) : [];
  const ids = members.length
    ? await memberClosureIds(exec, { allowed, allKeys, seeded, members })
    : await componentMemberIds(exec, seeded);
  // `relatedOnly=false`（訪客）的舊契約是「**全部**行政區列 ∪ 含種子的分量」：
  // 不在配對圖裡的行政區列不在分量表內，必須照舊從 listings 取回來，否則就是**少算**。
  const result = relatedOnly ? ids : [...ids, ...await districtSeedIds(exec, { allowed, allKeys })];
  return [...new Set(result)];
}

async function memberClosureIds(exec, { allowed, allKeys, seeded, members }) {
  // 舊版把同屋源群組建成「完全圖（以第一筆為代表連出）」⇒ 一群人裡只有**群組大小 ≥ 2** 的成員
  // 才是邊的端點（單人小組不產生任何邊，因此不是節點，也不可能當種子）。
  const groupSizes = new Map();
  for (const row of members) {
    const key = String(row?.group_key || "");
    if (!key) continue;
    groupSizes.set(key, (groupSizes.get(key) || 0) + 1);
  }
  const memberIds = [];
  for (const row of members) {
    const key = String(row?.group_key || "");
    const id = Number(row?.post_id) || 0;
    if (!key || !id || (groupSizes.get(key) || 0) < 2) continue;
    memberIds.push(id);
  }
  if (!memberIds.length) return componentMemberIds(exec, seeded);

  const inTable = new Map();
  const rows = await exec(
    `SELECT post_id, component_id FROM ${MATCH_COMPONENT_TABLE} WHERE post_id = ANY(?::bigint[])`,
    [memberIds],
  );
  for (const row of rows || []) {
    const id = Number(row?.post_id);
    const cid = Number(row?.component_id);
    if (Number.isFinite(id) && Number.isFinite(cid)) inTable.set(id, cid);
  }
  const memberSeeds = new Set(await districtSeedIdsAmong(exec, { allowed, allKeys, ids: memberIds }));

  // 在「分量 id／只有同屋源邊的 post_id」這個小空間上做 union-find（與節點層同一套語意）。
  const ufParent = new Map();
  const ufSize = new Map();
  const keys = [];
  const keyOf = (postId) => {
    const cid = inTable.get(postId);
    return cid === undefined ? `p${postId}` : `c${cid}`;
  };
  const ensure = (key) => {
    if (!ufParent.has(key)) { ufParent.set(key, key); ufSize.set(key, 1); keys.push(key); }
    return key;
  };
  const find = (key) => {
    let root = ensure(key);
    while (ufParent.get(root) !== root) root = ufParent.get(root);
    let cur = key;
    while (ufParent.get(cur) !== root) { const next = ufParent.get(cur); ufParent.set(cur, root); cur = next; }
    return root;
  };
  const union = (a, b) => {
    let ra = find(a);
    let rb = find(b);
    if (ra === rb) return;
    if (ufSize.get(ra) < ufSize.get(rb)) { const t = ra; ra = rb; rb = t; }
    ufParent.set(rb, ra);
    ufSize.set(ra, ufSize.get(ra) + ufSize.get(rb));
  };
  const groupHub = new Map();
  for (const row of members) {
    const key = String(row?.group_key || "");
    const id = Number(row?.post_id) || 0;
    if (!key || !id || (groupSizes.get(key) || 0) < 2) continue;
    if (!groupHub.has(key)) groupHub.set(key, id);
    else union(keyOf(groupHub.get(key)), keyOf(id));
  }
  const seedKeys = new Set();
  for (const cid of seeded) seedKeys.add(ensure(`c${cid}`));
  // 只有同屋源邊、不在配對圖裡的節點：它們的「分量」就是該 post 自己，只有在本身符合行政區時當種子。
  for (const id of memberSeeds) if (!inTable.has(id)) seedKeys.add(ensure(`p${id}`));

  const activated = new Set();
  for (const key of seedKeys) activated.add(find(key));
  const componentIds = [];
  const onlyUserPostIds = [];
  for (const key of keys) {
    if (!activated.has(find(key))) continue;
    if (key[0] === "c") componentIds.push(Number(key.slice(1)));
    else onlyUserPostIds.push(Number(key.slice(1)));
  }
  const ids = await componentMemberIds(exec, componentIds);
  for (const id of onlyUserPostIds) if (Number.isFinite(id) && id !== 0) ids.push(id);
  return ids;
}

/**
 * 材料化路徑的入口。
 *
 * @returns {Promise<number[]|null>} `null` ＝「證不出新鮮度」⇒ 呼叫端走即時算（fail-safe）。
 */
export async function loadMaterializedDistrictClosure(exec, {
  allowed, allKeys, userId = 0, relatedOnly = false, scheduleRebuild = null, advanceState = null, now = Date.now(),
} = {}) {
  if (typeof exec !== "function") return null;
  if (!Array.isArray(allowed) || !allowed.length) return null;
  if (!Array.isArray(allKeys) || !allKeys.length) return null;

  let state = null;
  try {
    const rows = await exec(STATE_PROBE_SQL, [MATCH_GRAPH_STATE_KEY]);
    state = rows?.[0] ?? null;
  } catch {
    // 表還沒建（第一次）／讀不到狀態列：不猜，退回即時算，並在背景排一次重算。
    notify(scheduleRebuild, "state_unreadable");
    return null;
  }
  if (!state || state.built_at == null || state.revision_watermark == null) {
    notify(scheduleRebuild, "state_missing");
    return null;
  }

  const maxMs = maxStaleMs();
  const builtAt = Number(state.built_at) || 0;
  const watermark = Number(state.revision_watermark) || 0;
  const revision = Number(state.revision) || 0;
  const cap = deltaCap();
  let reason = "";
  let deltaClean = true;
  let deltaCount = 0;

  const markerChanged = liveRoundMarker(state) !== String(state.round_marker ?? "");
  if (revision < watermark) reason = "revision_rewound";
  if (!reason && revision > watermark) {
    let delta = null;
    try {
      delta = await exec(REVISION_DELTA_SQL, [watermark, revision]);
    } catch {
      reason = "delta_unreadable";
    }
    if (!reason) {
      if (!Array.isArray(delta)) reason = "delta_unreadable";
      else { deltaCount = delta.length; }
    }
    if (!reason && deltaCount > cap) reason = "delta_too_big";
    if (!reason && deltaCount) {
        // 逐列證明：只對「被 data_revision 指名、且 `entity_type='listing'`」的列比對
        // `match_post_id`／`district_prefix` 是否與表內存的一致。
        //
        // `entity_id` 是 NULL／0 的 bump 無法逐列驗證（實測：`same_house_merge`／
        // `same_house_split`／`listing_offline_confirmed`，約占 0.6%）。合併／拆分**會**改
        // `match_post_id` ⇒ 一律視為過期（重算）；只有已登記為「與圖無關」的事件例外
        // （見 `GRAPH_IRRELEVANT_EVENTS`）。
        let unverifiable = false;
        const ids = [];
        for (const row of delta) {
          const eventType = String(row?.event_type || "");
          if (GRAPH_IRRELEVANT_EVENT_SET.has(eventType)) continue;
          const id = Number(row?.entity_id);
          if (Number.isFinite(id) && id > 0) ids.push(id);
          else unverifiable = true;
        }
        if (unverifiable) { reason = "delta_unverifiable"; deltaClean = false; }
        else if (ids.length) {
          const unique = [...new Set(ids)];
          let compared = null;
          try {
            compared = await exec(VERIFY_SQL, [unique]);
          } catch {
            reason = "verify_unreadable";
          }
          if (!reason && (!Array.isArray(compared) || compared.length !== unique.length)) reason = "verify_incomplete";
          if (!reason && compared.some((row) => graphRowDiffers(row))) reason = "graph_changed";
          if (reason) deltaClean = false;
        }
    }
    // 任何「讀不到／說不出所以然」的失敗都不得當成「圖沒變」（fail-safe 方向＝重算）。
    if (reason) deltaClean = false;
  }
  let liveFingerprint = null;
  try {
    const fp = await exec(LISTINGS_STAT_SQL, []);
    const value = Number(fp?.[0]?.fingerprint);
    if (Number.isFinite(value)) liveFingerprint = value;
  } catch {
    // 統計讀不到只是少一道兜底，不因此宣告過期（版本水位那道仍然有效）。
  }
  if (!reason && revision === watermark && liveFingerprint != null) {
    // 只有在「版本沒有前進」時才看列增減指紋（同 se-p8）：爬蟲正常寫入時版本一直前進，
    // 每次都當成帶外寫入會變成每請求重算。
    // ⚠️ 另外要求狀態列至少 5 秒前才建的：`pg_stat_user_tables` 的計數有 ~1 秒的落地延遲，
    // 剛建完就比會把「還沒落地的自己那批寫入」誤判成帶外寫入（實測會讓整條材料化路徑永遠退回即時算）。
    const settled = builtAt > 0 && now - builtAt > 5000;
    if (settled && Number(liveFingerprint) !== Number(state.stat_fingerprint)) reason = "stat_fingerprint";
  }
  if (!reason && Number(state.node_count) > 0) {
    // 「表缺資料」：狀態列說有節點，表卻是空的（被清掉／只還原了一半）⇒ 不准拿它回答。
    let present = null;
    try {
      present = await tableHasRows(exec);
    } catch {
      present = null;
    }
    if (present !== true) reason = "table_missing_rows";
  }
  if (!reason && maxMs > 0 && builtAt > 0 && now - builtAt > maxMs) reason = "max_age";

  // ── 逐列證明通過 ⇒ 材料化的那一份就是現在的圖，可以照樣回答 ─────────────────────
  // **輪次標記單獨變了不算過期**：爬蟲每輪結束都會換標記，而配對圖幾乎不動；
  // 標記的用途只是「提示該重新證明」，證明（上面那段逐列比對）通過就照樣回答，
  // 並把證明的水位往後推一格（一句 CAS UPDATE，跨行程只有一個贏家），
  // 免得下一個請求重做同一段。證明失敗或無法證明 ⇒ `reason` 已被設成對應的失敗原因 ⇒ 重算。
  if (!reason && deltaClean && typeof advanceState === "function"
      && (markerChanged || (revision > watermark && deltaCount >= advanceMinDelta()))) {
    try {
      await advanceState({
        expectedRevision: watermark,
        revision,
        roundMarker: liveRoundMarker(state),
        statFingerprint: liveFingerprint == null ? Number(state.stat_fingerprint) || 0 : liveFingerprint,
        reason: markerChanged ? "round_marker" : "delta_verified",
      });
    } catch {
      // 推進失敗只是下一個請求重驗一次同一段（答案不受影響）。
    }
  }

  if (reason) {
    notify(scheduleRebuild, reason);
    return null;
  }

  try {
    const ids = await closureIdsFromComponents(exec, { allowed, allKeys, userId, relatedOnly });
    return Array.isArray(ids) ? ids : null;
  } catch {
    notify(scheduleRebuild, "closure_unreadable");
    return null;
  }
}

function notify(scheduleRebuild, reason) {
  if (typeof scheduleRebuild !== "function") return;
  try {
    const out = scheduleRebuild(reason);
    if (out && typeof out.catch === "function") out.catch(() => {});
  } catch {
    // 排程失敗不影響正確性：這一個請求已經要退回即時算。
  }
}

// ── 背景重算的排程（fail-soft：失敗只是下次仍走即時算）────────────────────────────
let rebuildInFlight = null;
let lastRebuildStartedAt = 0;

/** 測試用：把行程內的排程狀態清乾淨。 */
export function resetRebuildScheduleForTest() {
  rebuildInFlight = null;
  lastRebuildStartedAt = 0;
}

/**
 * 把「逐列證明」的水位往前推（材料化**不動**）。這是常態路徑：爬蟲每輪結束都換輪次標記，
 * 而配對圖幾乎不動 ⇒ 只要一句 CAS UPDATE，不必重算 7 萬條邊。
 *
 * **不在請求路徑上等它**：推失敗（待機／沒有權限／沒有 postgres driver）時這一個請求
 * 照樣拿已經證明過的材料化結果回答，下一個請求再重驗一次同一段。
 */
export async function advanceMatchComponentStateLazy(payload, { pgDriver = null } = {}) {
  try {
    const { resolveDbDriver } = await import("./dbDriver.js");
    if (resolveDbDriver() !== "postgres") return false;
    let driver = pgDriver;
    if (!driver) {
      const { sharedPgDriver } = await import("./pgSharedDriver.js");
      driver = await sharedPgDriver();
    }
    const { advanceMatchComponentState } = await import("./repository/writePath.js");
    return await advanceMatchComponentState(driver, payload);
  } catch {
    return false;
  }
}

/**
 * 生產用的維護入口（兩個呼叫點把它整包傳進 `districtClosureIds()`）：
 *   • `scheduleRebuild`：證明失敗時排一次背景重算（去抖＋advisory lock＋待機不寫）。
 *   • `advanceState`：證明通過時只推進水位。
 * 測試要的是「完全不出網」⇒ 不傳就等於兩者都不做（fail-safe 方向＝退回即時算）。
 */
export const matchComponentMaintenance = Object.freeze({
  scheduleRebuild: scheduleMatchComponentRebuild,
  advanceState: advanceMatchComponentStateLazy,
});

/**
 * 背景重算的排程（去抖＋單飛）。**不在請求路徑上等它**：這一個請求已經拿即時算回答了，
 * 重算只是讓下一個請求吃得到材料化的結果。
 */
export function scheduleMatchComponentRebuild(reason = "stale", { now = Date.now() } = {}) {
  if (rebuildInFlight) return rebuildInFlight;
  if (lastRebuildStartedAt && now - lastRebuildStartedAt < rebuildMinIntervalMs()) return null;
  lastRebuildStartedAt = now;
  rebuildInFlight = (async () => {
    try {
      const { resolveDbDriver } = await import("./dbDriver.js");
      if (resolveDbDriver() !== "postgres") return { skipped: "not_postgres" };
      const [{ sharedPgDriver }, { rebuildMatchComponents }] = await Promise.all([
        import("./pgSharedDriver.js"),
        import("./repository/writePath.js"),
      ]);
      const driver = await sharedPgDriver();
      return await rebuildMatchComponents(driver, { reason });
    } catch (error) {
      return { skipped: "failed", error: String(error?.message || error) };
    } finally {
      rebuildInFlight = null;
    }
  })();
  return rebuildInFlight;
}
