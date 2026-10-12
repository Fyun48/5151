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
//   • **不准把呼叫端的交易弄壞**：讀取端在 `withPgReadSnapshot()` 的 REPEATABLE READ 交易內，
//     PG 只要一句失敗就整條 abort（後續一律回 25P02）。所以「表在不在」先用 `to_regclass()`
//     這句唯一不會失敗的目錄查詢判斷，確認存在才查資料表 —— 不能靠「查了再 catch」
//     （2026-10-12 CI 的 `prb-search-benchmark` 就是被這個坑炸到的）。
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

// ⚠️ **探測不准把呼叫端的交易弄壞**：讀取端是在 `withPgReadSnapshot()` 的 REPEATABLE READ 交易裡
// 被呼叫的，而 PostgreSQL 只要有一句失敗就**整條交易 abort**（後續任何句子都回 25P02
// `current transaction is aborted`）。所以「表不存在」不能靠『查了再 catch』處理 ——
// 那會讓後面退回的即時算也在死掉的交易裡跑（2026-10-12 CI 實測就是這樣炸的：
// `listingSearchPage → prepareListScope → districtClosureIdsLive → 25P02`）。
// 這一句只用目錄函式（`to_regclass`），引用缺表也不會失敗，是唯一可以先跑的東西。
const TABLE_GUARD_SQL = `
SELECT to_regclass('${MATCH_COMPONENT_STATE_TABLE}') IS NOT NULL AS state_table,
       to_regclass('${MATCH_COMPONENT_TABLE}') IS NOT NULL AS component_table,
       to_regclass('settings') IS NOT NULL AS settings_table,
       to_regclass('crawl_covers') IS NOT NULL AS covers_table,
       to_regclass('data_revision') IS NOT NULL AS revision_table`;

/**
 * **一句**拿齊所有探測用的東西（Owner 要求「能合就合，別拆成 5–6 條往返」）。
 *
 * 依據 guard 決定要不要引用可能不存在的表（缺表時用 NULL／0 常數代替）⇒ 這一句永遠合法，
 * 所以它在呼叫端的讀取快照交易裡不會失敗、也不會把交易弄死。
 * 回傳：狀態列欄位 ＋ `delta_count`／`delta_json`（被指名的變更列）＋
 * `verify_json`（逐列證明的比對結果）＋ 刪除計數 ＋ 「分量表有沒有資料」。
 */
function combinedProbeSql(guard) {
  const scalar = (sql, fallback) => (sql ? `(${sql})` : fallback);
  const deltaCte = guard.revision_table === true
    ? `, dv AS (
    SELECT entity_id, event_type FROM data_revision
     WHERE id > (SELECT revision_watermark FROM st) AND id <= (SELECT revision FROM st)
       AND entity_type = 'listing'
     ORDER BY id
     LIMIT $2
  )`
    : `, dv AS (SELECT NULL::bigint AS entity_id, NULL::text AS event_type WHERE false)`;
  const verifyCte = guard.revision_table === true
    ? `, ver AS (
    SELECT x.post_id AS post_id,
           l.match_post_id AS cur_match,
           ${districtKeyPrefixExpression("pg")} AS cur_prefix,
           (c.post_id IS NOT NULL) AS in_table,
           c.match_post_id AS stored_match,
           c.district_prefix AS stored_prefix
      FROM (SELECT DISTINCT entity_id AS post_id FROM dv) x
      LEFT JOIN listings l ON l.post_id = x.post_id
      LEFT JOIN ${MATCH_COMPONENT_TABLE} c ON c.post_id = x.post_id
  )`
    : `, ver AS (SELECT NULL::bigint AS post_id, NULL::bigint AS cur_match, NULL::text AS cur_prefix,
                        false AS in_table, NULL::bigint AS stored_match, NULL::text AS stored_prefix WHERE false)`;
  return `
WITH st AS (
  SELECT built_at, round_marker, revision_watermark, listings_stat_fingerprint, node_count,
         ${scalar(guard.settings_table ? "SELECT value FROM settings WHERE key = 'lastCoveringAt'" : "", "NULL::text")} AS covering,
         ${scalar(guard.settings_table ? "SELECT value FROM settings WHERE key = 'lastSystemCoveringAt'" : "", "NULL::text")} AS system_covering,
         ${scalar(guard.covers_table ? "CAST((SELECT MAX(last_run_at) FROM crawl_covers) AS text)" : "", "NULL::text")} AS covers_max,
         ${scalar(guard.revision_table ? "SELECT COALESCE(MAX(id), 0) FROM data_revision" : "", "0::bigint")} AS revision
    FROM ${MATCH_COMPONENT_STATE_TABLE}
   WHERE state_key = $1
)${deltaCte}${verifyCte}
SELECT st.built_at AS built_at,
       st.round_marker AS round_marker,
       st.revision_watermark AS revision_watermark,
       st.listings_stat_fingerprint AS stat_fingerprint,
       st.node_count AS node_count,
       st.covering AS covering,
       st.system_covering AS system_covering,
       st.covers_max AS covers_max,
       st.revision AS revision,
       (SELECT count(*) FROM dv) AS delta_count,
       (SELECT json_agg(json_build_object('entity_id', entity_id, 'event_type', event_type)) FROM dv) AS delta_json,
       (SELECT json_agg(json_build_object(
            'post_id', post_id, 'cur_match', cur_match, 'cur_prefix', cur_prefix,
            'in_table', in_table, 'stored_match', stored_match, 'stored_prefix', stored_prefix)) FROM ver) AS verify_json,
       COALESCE((SELECT SUM(n_tup_del) FROM pg_stat_user_tables WHERE relname = 'listings'), 0) AS stat_fingerprint_live,
       EXISTS(SELECT 1 FROM ${MATCH_COMPONENT_TABLE}) AS table_has_rows
  FROM st`;
}

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
 * 新增邊的吸收計畫（純函式；讀取端的 overlay 與寫入端的吸收共用同一份）：
 * 在「分量 id／不在表裡的 post_id」這個小空間上做 union-find，回傳要合併的類別。
 *
 * `component_id` 的定義是「分量內最小 post_id」⇒ 合併後的代表就是類別裡最小的那個值
 * （分量代表或新節點 id 都算），所以「誰併進誰」是**確定的**、不必看輸入順序。
 *
 * @param {Array<[number, number]>} edges 新增邊（兩端都是非 0 整數）
 * @param {Map<number, number>} tableComponents post_id → component_id（不在表裡的不要放）
 */
export function planAddedEdgeMerges(edges, tableComponents) {
  const parent = new Map();
  const size = new Map();
  const value = new Map();
  const keyOf = (id) => {
    const cid = tableComponents.get(id);
    return cid === undefined ? `p${id}` : `c${cid}`;
  };
  const ensure = (key, val) => {
    if (!parent.has(key)) { parent.set(key, key); size.set(key, 1); value.set(key, val); }
    return key;
  };
  const find = (key) => {
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    let cur = key;
    while (parent.get(cur) !== root) { const next = parent.get(cur); parent.set(cur, root); cur = next; }
    return root;
  };
  const union = (a, b) => {
    const ra = find(ensure(a, valueOfKey(a)));
    const rb = find(ensure(b, valueOfKey(b)));
    if (ra === rb) return;
    if (size.get(ra) < size.get(rb)) { parent.set(ra, rb); size.set(rb, size.get(rb) + size.get(ra)); }
    else { parent.set(rb, ra); size.set(ra, size.get(ra) + size.get(rb)); }
  };
  const valueOfKey = (key) => (key[0] === "c" ? Number(key.slice(1)) : Number(key.slice(1)));
  for (const [a, b] of edges || []) {
    if (!a || !b) continue;
    ensure(keyOf(a), valueOfKey(keyOf(a)));
    ensure(keyOf(b), valueOfKey(keyOf(b)));
    union(keyOf(a), keyOf(b));
  }
  const classes = new Map();
  for (const key of parent.keys()) {
    const root = find(key);
    if (!classes.has(root)) classes.set(root, { rep: Number.POSITIVE_INFINITY, comps: new Set(), nodes: new Set() });
    const entry = classes.get(root);
    const val = valueOfKey(key);
    if (Number.isFinite(val) && val < entry.rep) entry.rep = val;
    if (key[0] === "c") entry.comps.add(val); else entry.nodes.add(val);
  }
  return [...classes.values()].filter((entry) => entry.comps.size + entry.nodes.size > 1);
}

/**
 * 材料化分量 → 閉包 id 集合（**含增量 overlay**）。
 *
 * 與即時算的關係：即時算是 `seeds ∪ { v ∈ 節點 : comp(v) ∈ comp(seeds ∩ 節點) }`。
 * 這裡把三種輸入放進**同一個小空間**（`c<component_id>`／`p<post_id>`）做一次 union-find：
 *   1. 表內分量（`seeded` 由 `district_prefix` 決定）；
 *   2. 使用者同屋源群組（每次照樣即時讀，所以同屋源變更不必讓材料化過期）；
 *   3. **本次新增邊的 overlay**（`overlay.addedEdges`）：新邊只會把分量**併起來**，
 *      所以在分量層加一條 union 就等價於全量重算 —— 這就是「只增不減不必重算」的依據。
 * 分量的數目比節點少好幾個數量級，所以這一趟永遠是小的。
 *
 * `overlay.deSeedChanges`（前綴由「是種子」變成「不是」）是唯一需要**減**的情形：
 * 用一次有界的查詢確認該分量裡還有沒有別的節點仍然符合，沒有才把它從種子集合拿掉。
 */
async function closureIdsFromComponents(exec, { allowed, allKeys, userId, relatedOnly, overlay = null }) {
  const addedEdges = overlay?.addedEdges || [];
  const prefixChanges = overlay?.prefixChanges || [];
  const seededBase = await seededComponentIds(exec, { allowed, allKeys });

  // 需要查表才知道分量的節點：使用者同屋源成員 ＋ overlay 帶進來的節點。
  const members = userId > 0 ? await userSameHouseRows(exec, userId) : [];
  const lookup = new Set();
  for (const row of members) {
    const id = Number(row?.post_id) || 0;
    if (id) lookup.add(id);
  }
  for (const [a, b] of addedEdges) { lookup.add(a); lookup.add(b); }
  for (const change of prefixChanges) if (change.post_id) lookup.add(change.post_id);

  const inTable = new Map();
  if (lookup.size) {
    const ids = [...lookup];
    const rows = await exec(
      `SELECT post_id, component_id FROM ${MATCH_COMPONENT_TABLE} WHERE post_id = ANY(?::bigint[])`,
      [ids],
    );
    for (const row of rows || []) {
      const id = Number(row?.post_id);
      const cid = Number(row?.component_id);
      if (Number.isFinite(id) && Number.isFinite(cid)) inTable.set(id, cid);
    }
  }

  // ── 種子集合（表內分量）＋ overlay 的加減 ─────────────────────────────────
  const seeded = new Set(seededBase);
  const deSeededNodes = [];
  for (const change of prefixChanges) {
    const cid = inTable.get(change.post_id);
    if (cid === undefined) continue;
    if (change.oldSeed === true && change.newSeed !== true) deSeededNodes.push(change.post_id);
  }
  if (deSeededNodes.length) {
    // 有界的「還有沒有別人符合」查詢：只查受影響的幾個分量，並排除剛剛失去資格的那幾列。
    const comps = [...new Set(deSeededNodes.map((id) => inTable.get(id)))];
    const prefix = districtKeyPrefixExpression("pg");
    const still = await exec(
      `SELECT DISTINCT component_id FROM ${MATCH_COMPONENT_TABLE}
        WHERE component_id = ANY(?::bigint[])
          AND NOT (post_id = ANY(?::bigint[]))
          AND district_prefix IS NOT NULL
          AND (district_prefix = ANY(?::text[]) OR NOT (district_prefix = ANY(?::text[])))`,
      [comps, deSeededNodes, allowed, allKeys],
    );
    const keep = new Set((still || []).map((row) => Number(row.component_id)));
    for (const cid of comps) if (!keep.has(cid)) seeded.delete(cid);
  }
  // 前綴「由不是種子變成種子」⇒ 那個分量要加入（新增，不必查詢）。
  for (const change of prefixChanges) {
    if (change.newSeed !== true || change.oldSeed === true) continue;
    const cid = inTable.get(change.post_id);
    if (cid !== undefined) seeded.add(cid);
  }

  // ── 小空間 union-find ───────────────────────────────────────────────────────
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

  // (2) 同屋源：群人裡只有「群組大小 ≥ 2」的成員才是邊的端點（單人小組不產生任何邊）。
  if (members.length) {
    const groupSizes = new Map();
    for (const row of members) {
      const key = String(row?.group_key || "");
      if (key) groupSizes.set(key, (groupSizes.get(key) || 0) + 1);
    }
    const groupHub = new Map();
    for (const row of members) {
      const key = String(row?.group_key || "");
      const id = Number(row?.post_id) || 0;
      if (!key || !id || (groupSizes.get(key) || 0) < 2) continue;
      if (!groupHub.has(key)) groupHub.set(key, id);
      else union(keyOf(groupHub.get(key)), keyOf(id));
    }
  }
  // (3) 新增邊的 overlay：一條 union 等價於把兩個分量併起來。
  for (const [a, b] of addedEdges) union(keyOf(a), keyOf(b));

  // ── 種子 key ───────────────────────────────────────────────────────────────
  const seedKeys = new Set();
  for (const cid of seeded) seedKeys.add(ensure(`c${cid}`));
  // 不在配對圖裡的種子（只有同屋源邊、或本次新出現的邊）：它的「分量」就是自己。
  const addSeedForNodes = async (ids) => {
    if (!ids.length) return;
    const rows = await districtSeedIdsAmong(exec, { allowed, allKeys, ids });
    for (const id of rows) if (!inTable.has(id)) seedKeys.add(ensure(`p${id}`));
  };
  if (members.length) {
    await addSeedForNodes(members.map((row) => Number(row?.post_id) || 0).filter(Boolean));
  }
  // overlay 的新節點：用「現在的」前綴判斷是不是種子（不在表裡 ⇒ 自己一個分量）。
  const overlaySeedCandidates = [];
  for (const [a, b] of addedEdges) { overlaySeedCandidates.push(a, b); }
  for (const change of prefixChanges) if (change.newSeed === true && !inTable.has(change.post_id)) overlaySeedCandidates.push(change.post_id);
  await addSeedForNodes([...new Set(overlaySeedCandidates)].filter((id) => !inTable.has(id)));

  const activated = new Set();
  for (const key of seedKeys) activated.add(find(key));
  const componentIds = [];
  const extraPostIds = [];
  for (const key of keys) {
    if (!activated.has(find(key))) continue;
    if (key[0] === "c") componentIds.push(Number(key.slice(1)));
    else extraPostIds.push(Number(key.slice(1)));
  }
  const ids = await componentMemberIds(exec, componentIds);
  for (const id of extraPostIds) if (Number.isFinite(id) && id !== 0) ids.push(id);
  // `relatedOnly=false`（訪客）的舊契約是「**全部**行政區列 ∪ 含種子的分量」：
  // 不在配對圖裡的行政區列不在分量表內，必須照舊從 listings 取回來，否則就是**少算**。
  const result = relatedOnly ? ids : [...ids, ...await districtSeedIds(exec, { allowed, allKeys })];
  return [...new Set(result)];
}

/**
 * 材料化路徑的入口。
 *
 * @returns {Promise<number[]|null>} `null` ＝「證不出新鮮度」⇒ 呼叫端走即時算（fail-safe）。
 */
export async function loadMaterializedDistrictClosure(exec, {
  allowed, allKeys, userId = 0, relatedOnly = false,
  scheduleRebuild = null, advanceState = null, absorbState = null, now = Date.now(),
} = {}) {
  if (typeof exec !== "function") return null;
  if (!Array.isArray(allowed) || !allowed.length) return null;
  if (!Array.isArray(allKeys) || !allKeys.length) return null;

  let guard = null;
  try {
    // 只有這一句可以安全地失敗／缺席：它不引用任何可能不存在的產品表。
    const rows = await exec(TABLE_GUARD_SQL, []);
    guard = rows?.[0] || {};
  } catch {
    // 連目錄都查不到（驅動壞了／不是 PG）：不猜，退回即時算，並排一次重算。
    notify(scheduleRebuild, "guard_unreadable");
    return null;
  }
  if (guard.state_table !== true || guard.component_table !== true) {
    // 表還沒建（第一次）／被別的 fixture 清掉：不查就不會把交易弄死，直接退回即時算。
    notify(scheduleRebuild, "state_unreadable");
    return null;
  }
  // **一句**拿齊：狀態列 ＋ 被指名的變更列 ＋ 逐列證明的比對結果 ＋ 刪除計數 ＋ 表有沒有資料。
  const cap = deltaCap();
  let state = null;
  try {
    const rows = await exec(combinedProbeSql(guard), [MATCH_GRAPH_STATE_KEY, cap + 1]);
    state = rows?.[0] ?? null;
  } catch {
    // 表存在但這一句失敗（欄位缺、權限、逾時）：不准讓它弄死呼叫端的交易 ⇒ 乾淨地退回即時算。
    notify(scheduleRebuild, "state_unreadable");
    return null;
  }
  if (!state || state.built_at == null || state.revision_watermark == null) {
    notify(scheduleRebuild, "state_missing");
    return null;
  }
  const asRows = (value) => {
    if (Array.isArray(value)) return value;
    if (typeof value === "string") { try { return JSON.parse(value) || []; } catch { return []; } }
    return [];
  };

  const maxMs = maxStaleMs();
  // 併在探測句裡一起回來的「現在的刪除計數」（推進水位時要一起記下來，否則下次會誤判成帶外寫入）。
  const liveFingerprint = Number.isFinite(Number(state.stat_fingerprint_live))
    ? Number(state.stat_fingerprint_live)
    : null;
  const builtAt = Number(state.built_at) || 0;
  const watermark = Number(state.revision_watermark) || 0;
  const revision = Number(state.revision) || 0;
  let reason = "";
  let deltaClean = true;
  let deltaCount = Number(state.delta_count) || 0;
  let overlay = null;

  const markerChanged = liveRoundMarker(state) !== String(state.round_marker ?? "");
  if (revision < watermark) reason = "revision_rewound";
  if (!reason && revision > watermark && guard.revision_table === true) {
    if (deltaCount > cap) reason = "delta_too_big";
    else if (deltaCount) {
      // 逐列證明：只對「被 data_revision 指名、且 `entity_type='listing'`」的列比對
      // `match_post_id`／`district_prefix` 是否與表內存的一致。
      //
      // `entity_id` 是 NULL／0 的 bump 無法逐列驗證（實測：`same_house_merge`／
      // `same_house_split`／`listing_offline_confirmed`）。合併／拆分**會**改 `match_post_id`
      // ⇒ 一律視為過期（重算）；只有 `GRAPH_IRRELEVANT_EVENTS` 這張已登記的例外清單可以放行。
      const delta = asRows(state.delta_json);
      let unverifiable = false;
      const ids = [];
      for (const row of delta) {
        const eventType = String(row?.event_type || "");
        if (GRAPH_IRRELEVANT_EVENT_SET.has(eventType)) continue;
        const id = Number(row?.entity_id);
        if (Number.isFinite(id) && id > 0) ids.push(id);
        else unverifiable = true;
      }
      const unique = [...new Set(ids)];
      const compared = asRows(state.verify_json);
      if (unverifiable) { reason = "delta_unverifiable"; deltaClean = false; }
      else if (unique.length) {
        if (compared.length !== unique.length) reason = "verify_incomplete";
        else {
          // 證明通過之後**不再把「圖有變」當成過期**：把變更分類成
          // 「只增（新增邊／新節點／前綴變成種子）」→ 讀取端就地補上（overlay）；
          // 「有減（邊消失、換目標、列被刪、前綴不再是種子）」→ 退回即時算 ＋ 只重建受影響分量。
          overlay = planGraphDelta(compared, { allowed, allKeys });
          if (overlay.shrunk) reason = "graph_shrunk";
        }
        if (reason) deltaClean = false;
      }
    }
  }
  if (!reason) {
    const value = Number(state.stat_fingerprint_live);
    if (revision === watermark && Number.isFinite(value)) {
      // 只有在「版本沒有前進」時才看列刪除計數（同 se-p8）：爬蟲正常寫入時版本一直前進。
      // ⚠️ 另外要求狀態列至少 5 秒前才建的：`pg_stat_user_tables` 的計數有 ~1 秒落地延遲。
      const settled = builtAt > 0 && now - builtAt > 5000;
      if (settled && value !== Number(state.stat_fingerprint)) reason = "stat_fingerprint";
    }
  }
  if (!reason && Number(state.node_count) > 0 && state.table_has_rows !== true) {
    // 「表缺資料」：狀態列說有節點，表卻是空的（被清掉／只還原了一半）⇒ 不准拿它回答。
    reason = "table_missing_rows";
  }
  if (!reason && maxMs > 0 && builtAt > 0 && now - builtAt > maxMs) reason = "max_age";

  // ── 逐列證明通過 ⇒ 材料化的那一份就是現在的圖，可以照樣回答 ─────────────────────
  // **輪次標記單獨變了不算過期**：爬蟲每輪結束都會換標記，而配對圖幾乎不動；
  // 標記的用途只是「提示該重新證明」，證明（上面那段逐列比對）通過就照樣回答，
  // 並把證明的水位往後推一格（一句 CAS UPDATE，跨行程只有一個贏家），
  // 免得下一個請求重做同一段。證明失敗或無法證明 ⇒ `reason` 已被設成對應的失敗原因 ⇒ 重算。
  const overlayPending = Boolean(overlay && (overlay.addedEdges.length || overlay.prefixChanges.length));
  if (!reason && deltaClean && !overlayPending && typeof advanceState === "function"
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
    // 只有「圖有減（邊消失／換目標／不再是種子）」是**局部**的 ⇒ 只重建受影響分量；
    // 其餘（缺表、水位讀不到、超上限、無法驗證、列被刪、超過硬上界）都是異常路徑 ⇒ 全量重算。
    if (reason === "graph_shrunk") notify(absorbState, { kind: "affected", reason, nodes: overlay ? overlay.nodes : [] });
    else notify(scheduleRebuild, reason);
    return null;
  }
  if (overlayPending) {
    // 材料化表還沒有這批新增邊 ⇒ 背景增量吸收（每輪 ≤1 批次），這一個請求用 overlay 就地算。
    notify(absorbState, { kind: "added", reason: "overlay", nodes: overlay.nodes });
  }

  try {
    const ids = await closureIdsFromComponents(exec, { allowed, allKeys, userId, relatedOnly, overlay });
    return Array.isArray(ids) ? ids : null;
  } catch {
    notify(scheduleRebuild, "closure_unreadable");
    return null;
  }
}

/**
 * 把逐列證明的結果分類成增量計畫。
 *
 * 「只增」= 新增邊（含換目標的新邊）／新節點／前綴變成種子 ⇒ overlay 可以精確補上。
 * 「有減」= 邊消失或換目標、列被刪、前綴不再是種子 ⇒ overlay 表達不了（分量要**切開**）
 * ⇒ 退回即時算，並由 `rebuildAffectedComponents()` 只重建受影響的那幾個分量。
 */
export function planGraphDelta(compared, { allowed, allKeys } = {}) {
  const allowedSet = new Set(allowed || []);
  const allKeySet = new Set(allKeys || []);
  const isSeed = (prefix) => {
    if (prefix == null) return false;
    const text = String(prefix);
    return allowedSet.has(text) || !allKeySet.has(text);
  };
  const addedEdges = [];
  const prefixChanges = [];
  const nodes = new Set();
  let shrunk = false;
  for (const row of compared || []) {
    const id = Number(row?.post_id) || 0;
    if (!id) continue;
    const oldEdge = edgeValue(row.stored_match);
    const newEdge = edgeValue(row.cur_match);
    const storedPrefix = row.stored_prefix == null ? null : String(row.stored_prefix);
    const curPrefix = row.cur_prefix == null ? null : String(row.cur_prefix);
    const inTable = row.in_table === true;
    if (oldEdge != null && oldEdge !== newEdge) { shrunk = true; nodes.add(id); nodes.add(oldEdge); }
    if (oldEdge == null && inTable && row.cur_match == null) {
      // 列被刪掉（表內有列、現在沒有 listings 列、自己也沒有邊）：只有在它本來是端點時才需要處理，
      // 這種情形的前綴會由下面的 prefixChanges 接手（變成 NULL）。
    }
    if (newEdge != null && newEdge !== oldEdge) { addedEdges.push([id, newEdge]); nodes.add(id); nodes.add(newEdge); }
    if (curPrefix !== storedPrefix) {
      const oldSeed = isSeed(storedPrefix);
      const newSeed = isSeed(curPrefix);
      prefixChanges.push({ post_id: id, oldSeed, newSeed, storedPrefix, curPrefix });
      nodes.add(id);
      if (oldSeed && !newSeed) shrunk = true; // 「不再是種子」要**減**一個分量 ⇒ 交給受影響分量重建
    }
    if (!inTable && (newEdge != null || curPrefix != null)) nodes.add(id);
  }
  return { addedEdges, prefixChanges, shrunk, nodes: [...nodes] };
}

function notify(scheduleRebuild, reason) {
  if (typeof scheduleRebuild !== "function") return;
  try {
    const out = scheduleRebuild(reason);
    if (out && typeof out.catch === "function") out.catch(() => {});
  } catch {
    // 排程失敗不影響正確性：這一個請求已經要退回即時算，或已經用 overlay 就地算完。
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
 *   • `absorbState`：**增量吸收**（新增邊只合併分量／有減只重建受影響分量），背景去抖＋單飛。
 *   • `scheduleRebuild`：異常路徑才用的全量重算（去抖＋advisory lock＋待機不寫）。
 *   • `advanceState`：證明通過、而且沒有待吸收的 overlay 時只推進水位。
 * 測試要的是「完全不出網」⇒ 不傳就等於三者都不做（fail-safe 方向＝退回即時算）。
 */
export const matchComponentMaintenance = Object.freeze({
  scheduleRebuild: scheduleMatchComponentRebuild,
  absorbState: scheduleMatchComponentAbsorb,
  advanceState: advanceMatchComponentStateLazy,
});

// ── 增量吸收的排程（去抖＋單飛；失敗只是下一個請求再用 overlay 就地算）────────────────
/** 兩次吸收之間的最小間隔（毫秒）：同一批變更不要每個請求各排一次。 */
export const ABSORB_DEBOUNCE_ENV = "MEMBER_DISTRICT_CLOSURE_ABSORB_DEBOUNCE_MS";
export const DEFAULT_ABSORB_DEBOUNCE_MS = 250;
export function absorbDebounceMs() {
  const n = Number(process.env[ABSORB_DEBOUNCE_ENV]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_ABSORB_DEBOUNCE_MS;
}

let absorbTimer = null;
let absorbInFlight = null;
let absorbPending = null;

/** 測試用：清掉吸收排程的狀態。 */
export function resetAbsorbScheduleForTest() {
  if (absorbTimer) clearTimeout(absorbTimer);
  absorbTimer = null;
  absorbInFlight = null;
  absorbPending = null;
}

function mergeAbsorbPayload(payload) {
  const kind = payload?.kind === "affected" ? "affected" : (absorbPending?.kind === "affected" ? "affected" : "added");
  const nodes = new Set(absorbPending?.nodes || []);
  for (const id of payload?.nodes || []) {
    const n = Number(id);
    if (Number.isFinite(n) && n > 0) nodes.add(n);
  }
  absorbPending = { kind, nodes, reason: payload?.reason || absorbPending?.reason || "stale" };
}

async function runAbsorb() {
  absorbTimer = null;
  if (absorbInFlight) return absorbInFlight;
  const payload = absorbPending;
  absorbPending = null;
  if (!payload || !payload.nodes.size) return { skipped: "no_nodes" };
  absorbInFlight = (async () => {
    try {
      const { resolveDbDriver } = await import("./dbDriver.js");
      if (resolveDbDriver() !== "postgres") return { skipped: "not_postgres" };
      const [{ sharedPgDriver }, { absorbMatchComponentDelta }] = await Promise.all([
        import("./pgSharedDriver.js"),
        import("./repository/writePath.js"),
      ]);
      const driver = await sharedPgDriver();
      const result = await absorbMatchComponentDelta(driver, {
        kind: payload.kind, nodes: [...payload.nodes], reason: payload.reason,
      });
      if (result && result.needFullRebuild) scheduleMatchComponentRebuild("absorb_no_components");
      return result;
    } catch (error) {
      return { skipped: "failed", error: String(error?.message || error) };
    } finally {
      absorbInFlight = null;
    }
  })();
  return absorbInFlight;
}

/**
 * 排一次**增量吸收**（去抖＋單飛；不在請求路徑上等它）。
 *
 * 為什麼可以不急：這一個請求會用 overlay 就地算出同一組 id，吸收只是把成果寫回表、
 * 讓下一個請求回到「純表查詢」；所以就算吸收失敗或延後，答案都還是對的。
 */
export function scheduleMatchComponentAbsorb(payload = {}) {
  mergeAbsorbPayload(payload);
  if (absorbInFlight) return absorbInFlight;
  if (!absorbTimer) {
    const timer = setTimeout(() => { void runAbsorb(); }, absorbDebounceMs());
    if (typeof timer.unref === "function") timer.unref();
    absorbTimer = timer;
  }
  return absorbTimer;
}

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
