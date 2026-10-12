// 行政區「投影預篩」：用 `listing_search_projection.district`（`idx_proj_district`）先取
// 候選 post_id 集合，取代 `split_part(source_key…)` 那個**無法建索引**的行政區子句。
//
// 為什麼可以這樣做（語意論證，逐條對應裁決 §4.1 P1）：
//   1. `listings` **沒有 `district` 欄**，現行子句只能對 `source_key` 做 `split_part` ⇒ seq scan。
//      `listing_search_projection.district` 是 `districtNameFromListing(row)` 的投影
//      （`listingSearchProjection.js:96`），該函式正是**會員列表判定鏈最後一道行政區過濾**
//      （`db.js` `districtSet.has(row.district || districtNameFromListing(row))`）用的同一個函式。
//   2. 所以投影集合 ⊇「Node 判定鏈最後會留下的行政區列」；預篩**只是多餘的前置縮窄**，
//      不取代任何現有判定 —— 判定鏈照舊逐列跑一次。
//   3. **投影滯後／過期必須退回完整掃描**：見 `districtProjectionVerified()` 的兩項證明
//      （缺列 ＋ 前綴與投影不一致），任一非 0 就回 `null`，呼叫端沿用原本的 `split_part` 子句
//      ⇒ **絕不靜默少算**。證明值依 `data_revision|districts` 版本快取。
//   4. 可用 `MEMBER_DISTRICT_PREFILTER=0` 完全關閉（等價測試的 A/B 開關）。
import {
  districtKeyLists, districtKeyPrefixExpression,
} from "./listDistrictSql.js";

const TABLE = "listing_search_projection";

/** 關閉開關（A/B 等價證據用）；預設開啟。 */
export function districtPrefilterEnabled() {
  const raw = process.env.MEMBER_DISTRICT_PREFILTER;
  if (raw == null || raw === "") return true;
  return !["0", "false", "off", "no"].includes(String(raw).trim().toLowerCase());
}

// ── 守門的驗證狀態（se-p7：從「整份答案快取」改成「已驗證範圍（watermark）」）──────────────
// 舊版 key = `<revision>|<districts>`：寫入活躍時 `data_revision.MAX(id)` 幾乎每秒換代
// （正式庫 2026-10-12 實測：`listing_updated` 1.25 筆/秒、`listing_added` 0.16 筆/秒）
// ⇒ 快取一路未命中，等於每個請求都要付兩項全表證明（正式庫 333ms/次）。
//
// 新版只把「**已經被證明為 0 的範圍**」記下來：
//   1. 起點是全掃一次（`missing`／`mismatched` 的判定式**逐字不變**）⇒ 記下 watermark
//      （當下的 `MAX(data_revision.id)`）與當時的結構指紋。
//   2. 之後只重驗 `(watermark, 目前 revision]` 之間**由 data_revision 指名變更過的 post_id**
//      （有界、走兩張表的主鍵）。那一段用的判定式是原判定式**同一組述詞再加上
//      `post_id = ANY(...)` 的範圍限制**，不是另一套寫法。
//   3. 兩道兜底（**se-p8：分工重新界定，判定式一字不動**）：
//      a. **結構指紋＝帶外寫入偵測器**（`pg_stat_user_tables` 的 `n_tup_ins + n_tup_del`，
//         `listings` ＋ 投影表）。它**不再是「能不能沿用快取」的前置條件**，只在
//         **「版本沒有前進（`MAX(id)` 與上次相同）但指紋卻變了」**時才觸發全掃 —— 那正是它
//         本來要抓的「有人不 bump revision 直接改表（列增減）」。反過來，爬蟲正常寫入時
//         指紋本來就一直變（`data_revision` 每筆變更一行、與 listings 同交易），舊寫法會把
//         這種「有 bump、也有記錄」的正常變更誤判成帶外寫入 ⇒ 每請求全掃（正式庫實測：
//         全掃形狀 anti-join 每請求 1–2 次 × 110–244ms）。**不得**再走回頭路。
//         ⚠️ 這一項的有效性受 PG 統計落地時機限制（`PGSTAT_MIN_INTERVAL` ≈ 1 秒；寫入端若就此
//         閒置，要等它下一次 commit 或連線結束才會落地 —— repro 實測「INSERT 後立刻 `end()`」
//         2ms 可見，「INSERT 後閒置」曾 >8 秒不可見）。所以它是**提早發現**、不是唯一保證。
//      b. **有界週期全掃**（`FULL_SCAN_INTERVAL_MS`，預設 5 分鐘）：**硬上界**就在這裡。凡是
//         「沒有版本號、也沒有列增減指紋」的變更（例如有人直接 UPDATE 投影的 `district`、
//         或 `source_key` 前綴被改），都只在這個窗口內沒被發現；另有兩個同類殘留風險：
//         (i) 指紋是 `n_tup_ins + n_tup_del` 的**聚合**，同時增列又刪列可能讓它淨值不變；
//         (ii) `n_tup_upd` 刻意不計（爬蟲每秒 upsert，計入就等於每請求全掃）。
//         兩者的暴露上界同樣是 `FULL_SCAN_INTERVAL_MS`（預設 300000ms）。
//   4. 任何不確定都退回全掃：delta 太大、變更列無法逐一列舉（`entity_id IS NULL`／未知
//      `entity_type`）、指紋讀不到、版本號倒退 —— 一律全掃。誤判 `ok=false` 只是變慢。
//
// se-p8 不變式（**紅線**）：回 `true` 的必要條件是「`[0, watermark]` 由全掃證明過 ∧
// `(watermark, MAX(id)]` 由 data_revision 指名變更的 post_id 逐筆證明過 ∧ 距上次全掃
// < `FULL_SCAN_INTERVAL_MS`」。指紋只在「版本沒前進卻變了」時把結果降級成全掃，
// **永遠不會**把結果升級成 `true`。判定式（`missing`／`mismatched`）逐字不變。
const GUARD_CACHE_LIMIT = 64;
const guardCache = new Map();

function guardEnvInt(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}
// 週期全掃的上限（毫秒）＋單次增量可處理的變更列上限。皆由環境變數可調，預設值即文件值。
const FULL_SCAN_INTERVAL_MS = guardEnvInt("MEMBER_DISTRICT_GUARD_FULL_SCAN_MS", 300000);
const DELTA_ROW_LIMIT = guardEnvInt("MEMBER_DISTRICT_GUARD_DELTA_LIMIT", 4000);

/** 測試／寫入端主動失效用（同 `resetPgProductCountCache` 的形狀）。 */
export function resetDistrictProjectionCompletenessCache() {
  guardCache.clear();
  idsCache.clear();
}

async function currentRevision(runOne) {
  try {
    const hasTable = await runOne("SELECT to_regclass('data_revision') IS NOT NULL AS has_table");
    if (!hasTable?.has_table) return null;
    const row = await runOne("SELECT MAX(id) AS n FROM data_revision");
    if (row?.n == null) return null;
    const revision = Number(row.n);
    return Number.isFinite(revision) ? revision : null;
  } catch {
    return null;
  }
}

function defaultRunOne(exec) {
  return async (sql, params = []) => {
    const rows = await exec(sql, params);
    return Array.isArray(rows) ? rows[0] ?? null : rows ?? null;
  };
}

/** 多列版本：結構指紋與 delta 都是**多列**查詢（`runOne` 只看第一列）。 */
function runAllRows(exec) {
  if (typeof exec !== "function") return null;
  return async (sql, params = []) => {
    const rows = await exec(sql, params);
    return Array.isArray(rows) ? rows : [];
  };
}

// 結構指紋（檔頭 3a）。刻意**不含** `n_tup_upd`：爬蟲每秒都在 upsert `listings`
// （實測：5 次 `INSERT … ON CONFLICT DO UPDATE` 讓 `n_tup_ins + n_tup_del` 變化 = 0），含 update
// 就等於每個請求都要全掃。`schemaname = ANY(current_schemas(false))` 與本檔不帶 schema 的表名用
// 同一組 search_path 解析，免得把同名測試 fixture schema 一起算進來。
// 兩張表都要看得到（tables = 2）才當有效指紋：少一張（不同 schema／權限不足）就回 null ⇒ 全掃。
const STRUCTURAL_SENTINEL_SQL = `SELECT COALESCE(SUM(n_tup_ins + n_tup_del), 0)::text AS churn,
         COUNT(*)::int AS tables
    FROM pg_stat_user_tables
   WHERE relname IN ('listings', '${TABLE}')
     AND schemaname = ANY(current_schemas(false))`;

async function structuralSentinel(runAll) {
  if (!runAll) return null;
  try {
    const row = (await runAll(STRUCTURAL_SENTINEL_SQL))[0] || null;
    if (!row || Number(row.tables) < 2) return null;
    return String(row.churn);
  } catch {
    return null;
  }
}

// `(watermark, revision]` 之間由 data_revision 指名變更過的 post_id（去重、有界）。
// 回傳 `null` ＝**無法逐一列舉** ⇒ 呼叫端必須全掃。回傳陣列（可為空）＝這一段可以逐筆重驗。
async function changedPostIdsSince(runAll, fromRevision, toRevision) {
  if (!runAll) return null;
  let rows;
  try {
    rows = await runAll(
      `SELECT entity_type, entity_id FROM data_revision
        WHERE id > $1 AND id <= $2 ORDER BY id LIMIT ${DELTA_ROW_LIMIT + 1}`,
      [fromRevision, toRevision],
    );
  } catch {
    return null;
  }
  if (rows.length > DELTA_ROW_LIMIT) return null;
  const ids = new Set();
  for (const row of rows) {
    // 只有 listing 的變更可能動到 `listings`／投影；其他 entity_type（crawl_source…）無法
    // 逐一列舉 ⇒ 全掃（fail-safe；這類事件在正式庫罕見）。
    if (String(row?.entity_type) !== "listing") return null;
    const id = Number(row?.entity_id);
    // `entity_id IS NULL`（例如 `listing_offline_confirmed` 的批次下架）無法指名受影響列 ⇒ 全掃。
    if (!Number.isFinite(id) || id <= 0) return null;
    ids.add(id);
  }
  return [...ids];
}

/** 兩張表都在嗎？（缺表時直接發查詢會讓整個快照交易 aborted ⇒ 呼叫端拿不到期待的 42P01） */
async function projectionTablesPresent(one) {
  try {
    const hasTables = await one(
      `SELECT to_regclass('listings') IS NOT NULL AND to_regclass('${TABLE}') IS NOT NULL AS ok`,
    );
    return Boolean(hasTables?.ok);
  } catch {
    return false;
  }
}

/**
 * 全掃版本的兩項證明（**判定式逐字沿用舊版**，一次往返；兩項都必須為 0）：
 *   `missing`    —— 有 listings 列卻沒有投影列 ⇒ 投影滯後（缺列）。
 *   `mismatched` —— `source_key` 前綴屬於本次要篩的行政區、但投影 `district` 不在本次清單內
 *                   ⇒ 兩套推導不一致（＝投影內容過期，例如 refresh 失敗）。
 *
 * 任一非 0 就不能用預篩（回 `false`）：否則可能把 Node 判定鏈會留下的列事先濾掉，
 * 也就是**靜默少算**。這正是裁決 §4.1 P1「投影滯後必須退回完整掃描」的要求。
 *
 * repro 實測（184,245 列、7 個行政區）：`missing=0`、`mismatched=0`
 * （前綴相符 15,379 ＝ 投影相符 15,379），兩項同一次往返約 70–120ms。
 */
async function fullProjectionProof(one, keys, names) {
  // ⚠️ 先確認**兩個表都在**才發查詢。
  // 為什麼非做不可：`listing-search-parity.test.js` 會把 `listings` 改名來模擬缺 schema；
  // 若這一支在缺表時仍然送出 `FROM listings`，PG 會回 42P01 並讓**整個快照交易進入 aborted**，
  // 後續真正的候選查詢就變成 25P02（current transaction is aborted），呼叫端再也拿不到
  // 期待的 42P01 ⇒ 測試紅、而且真實環境的錯誤碼也會失真。
  if (!(await projectionTablesPresent(one))) return false;
  const prefix = districtKeyPrefixExpression("pg");
  const placeholders = (n, offset) => Array.from({ length: n }, (_, i) => `$${i + offset}`).join(",");
  const row = await one(
    // 兩個證明**語意不變**（2026-10-11 第二刀：只改查詢形狀，不動判定）：
    //   missing    —— 以 `listings` 側驅動的 anti-join（投影 `post_id` 是主鍵 ⇒ 一對一）。
    //   mismatched —— 改由**投影側驅動**：投影表 71MB、listings 335MB，先掃小的那一邊，
    //                 再用 `post_id`（兩邊都是主鍵）回查 listings 套前綴述詞。
    //                 原本的 `LEFT JOIN listings × project` 會整表掃 184k 列。
    // repro 實測：206–214ms → 136–147ms（同一組參數、同一個 revision）。
    //
    // 兩種寫法的判定完全相同：`p.district = ANY(...)` 為 NULL 時（投影沒有行政區），
    // 原版 `NOT (NULL)` ＝ NULL ⇒ FILTER 不算；新版 `... IS NOT TRUE` 也排除 NULL ⇒ 一致。
    //
    // ⚠️ se-p7：這段字串是 authority，**不得改判定**。增量版（`scopedProjectionProof`）只在這
    // 同一組述詞上再加 `post_id = ANY(...)` 的範圍限制，兩者的輸出必須在同一份資料上一致。
    `SELECT
       (SELECT COUNT(*) FROM listings l WHERE NOT EXISTS (
          SELECT 1 FROM ${TABLE} p WHERE p.post_id = l.post_id)) AS missing,
       (SELECT COUNT(*) FROM ${TABLE} p
         WHERE (p.district = ANY($${keys.length + 1}::text[])) IS NOT TRUE
           AND EXISTS (
             SELECT 1 FROM listings l
             WHERE l.post_id = p.post_id
               AND (${prefix} IN (${placeholders(keys.length, 1)}))
           )) AS mismatched`,
    [...keys, names],
  );
  const missing = Number(row?.missing);
  const mismatched = Number(row?.mismatched);
  return missing === 0 && mismatched === 0;
}

/**
 * 增量版本：**同一組判定式**限制在 `ids`（＝watermark 之後被指名變更的 post_id）上。
 * 只是在原述詞上加 `post_id = ANY($1／$2::bigint[])`（走主鍵），判定式本身沒有新寫法。
 */
async function scopedProjectionProof(one, ids, keys, names) {
  if (!ids.length) return true;
  if (!(await projectionTablesPresent(one))) return false;
  const prefix = districtKeyPrefixExpression("pg");
  const placeholders = (n, offset) => Array.from({ length: n }, (_, i) => `$${i + offset}`).join(",");
  const row = await one(
    `SELECT
       (SELECT COUNT(*) FROM listings l
         WHERE l.post_id = ANY($1::bigint[])
           AND NOT EXISTS (SELECT 1 FROM ${TABLE} p WHERE p.post_id = l.post_id)) AS missing,
       (SELECT COUNT(*) FROM ${TABLE} p
         WHERE p.post_id = ANY($2::bigint[])
           AND (p.district = ANY($${keys.length + 3}::text[])) IS NOT TRUE
           AND EXISTS (
             SELECT 1 FROM listings l
             WHERE l.post_id = p.post_id
               AND (${prefix} IN (${placeholders(keys.length, 3)}))
           )) AS mismatched`,
    [ids, ids, ...keys, names],
  );
  const missing = Number(row?.missing);
  const mismatched = Number(row?.mismatched);
  return missing === 0 && mismatched === 0;
}

async function safeFullScan(one, keys, names) {
  try {
    return await fullProjectionProof(one, keys, names);
  } catch {
    return false;
  }
}

async function safeScopedProof(one, ids, keys, names) {
  try {
    return await scopedProjectionProof(one, ids, keys, names);
  } catch {
    return false;
  }
}

/**
 * 「全掃 ＋ 記下已驗證範圍」。**指紋先讀、全掃後做**：兩者之間發生的列增減會讓下一次
 * 請求的指紋對不上 ⇒ 下一請求立刻全掃。反過來（先掃再讀指紋）會把「掃完才發生的變更」記成
 * 已驗證，可能掩蓋漂移。
 *
 * se-p8：這裡的指紋**只是「帶外寫入偵測器」的基準值**，不是「能不能快取」的條件。
 * 沒有指紋（`sentinel == null`）仍然不可跨請求快取（fail-safe：退回舊版「每個請求都全掃」）。
 */
async function fullScanAndCache(one, runAll, cacheKey, rev, keys, names) {
  const sentinel = await structuralSentinel(runAll);
  const ok = await safeFullScan(one, keys, names);
  if (!ok) {
    guardCache.delete(cacheKey);
    return false;
  }
  if (sentinel == null) {
    // 沒有結構指紋就不可跨請求快取（fail-safe：退回舊版「每個請求都全掃」的強度）。
    guardCache.delete(cacheKey);
    return true;
  }
  if (guardCache.size >= GUARD_CACHE_LIMIT) guardCache.clear();
  guardCache.set(cacheKey, { ok: true, revision: rev, verifiedAt: Date.now(), sentinel });
  return true;
}

/**
 * 投影「可用」的兩項證明（語意與舊版相同，但只把**已驗證範圍**記進快取；見檔頭）。
 * 回傳 `true` 才准用預篩。
 *
 * se-p8 的三段語意（**指紋只降級、不升級**）：
 *   ① 版本沒前進（`entry.revision === rev`）：
 *      - 指紋沒變 ⇒ 已驗證範圍仍然有效（`true`）。
 *      - 指紋**變了** ⇒ 有**沒有 revision 紀錄的列增減**（真正的帶外寫入）⇒ 全掃。
 *      - 指紋讀不到 ⇒ 不確定 ⇒ 全掃。
 *   ② 版本前進了（`entry.revision < rev`）：
 *      - 先用 `data_revision` 指名變更的 post_id 做**增量證明**（有界、走主鍵）。這一條路
 *        **與指紋無關** —— 有 bump revision 的正常寫入不該被指紋誤判成帶外寫入。
 *      - 只有「delta 無法逐一列舉／過大／增量證明不過」才全掃。
 *   ③ 週期硬上界、沒有任何 entry、版本倒退（`entry.revision > rev`）⇒ 全掃。
 */
export async function districtProjectionVerified(exec, { districtNames = [], allowedKeys = null, runOne = null, revision = undefined } = {}) {
  const one = runOne || defaultRunOne(exec);
  const runAll = runAllRows(exec);
  const names = [...new Set((districtNames || []).filter(Boolean))];
  const keys = Array.isArray(allowedKeys) ? allowedKeys : [];
  if (!names.length || !keys.length) return false;
  const rev = revision === undefined ? await currentRevision(one) : revision;
  // 沒有可靠版本號（表不存在／空表／查詢失敗）⇒ 不跨請求快取，逐次全掃（與舊版同契約）。
  if (rev == null) return safeFullScan(one, keys, names);

  const cacheKey = names.join(",");
  const entry = guardCache.get(cacheKey);
  if (entry && entry.ok && entry.revision <= rev && Date.now() - entry.verifiedAt < FULL_SCAN_INTERVAL_MS) {
    if (entry.revision === rev) {
      // ① 版本沒前進：只有「指紋也一樣」才能沿用已驗證範圍。
      const sentinelNow = await structuralSentinel(runAll);
      if (sentinelNow != null && sentinelNow === entry.sentinel) return true;
      // 指紋變了或讀不到 ⇒ 全掃（不回 false：只是變慢，掃完照樣可以判 ok=true）。
    } else {
      // ② 版本前進了：走「delta 增量證明」這條路，指紋不參與。
      const ids = await changedPostIdsSince(runAll, entry.revision, rev);
      if (ids != null) {
        if (!ids.length) {
          entry.revision = rev;
          return true;
        }
        if (await safeScopedProof(one, ids, keys, names)) {
          entry.revision = rev;
          return true;
        }
        // 抓到漂移：不推進 watermark、不快取（誤判 ok=false 只會變慢）。
        return false;
      }
      // delta 無法逐一列舉 ⇒ 落到下面的全掃（fail-safe）。
    }
  }
  // ③ 全掃。`fullScanAndCache` 接受新的 `rev` 與當下的指紋 ⇒ 下一個請求從這個範圍重新起算。
  return fullScanAndCache(one, runAll, cacheKey, rev, keys, names);
}

/** 只做「缺列」那一項（測試／獨立檢查用）。 */
export async function districtProjectionComplete(exec, { runOne = null } = {}) {
  const one = runOne || defaultRunOne(exec);
  try {
    const hasTable = await one(`SELECT to_regclass('${TABLE}') IS NOT NULL AS has_table`);
    if (!hasTable?.has_table) return false;
    const row = await one(`SELECT COUNT(*) AS n FROM listings l WHERE NOT EXISTS (SELECT 1 FROM ${TABLE} p WHERE p.post_id = l.post_id)`);
    return Number(row?.n) === 0;
  } catch {
    return false;
  }
}

/**
 * 預篩 id 集合（依 `revision|districts` 快取）。
 *
 * 為什麼要快取：同一個請求裡 list 與 stats 會**各問一次**同一個行政區組合（兩邊的
 * `memberRegionDistrictNames`／`resolveListDistrictNames` 在預設情境下是同一組），
 * 而每次查詢都要把上萬個 post_id 從 PG 搬回 Node（repro 實測 33–80ms）。
 * 快取只依 `data_revision` 與行政區組合，**不依時間**，所以不會讓過期結果被沿用。
 */
const idsCache = new Map();
const IDS_CACHE_LIMIT = 64;

async function projectedIdsForRevision(exec, names, cacheSuffix) {
  const one = defaultRunOne(exec);
  const rev = await currentRevision(one);
  const cacheKey = `${rev == null ? "norev" : rev}|${cacheSuffix}`;
  if (rev != null && idsCache.has(cacheKey)) return idsCache.get(cacheKey);
  const rows = await exec(`SELECT post_id FROM ${TABLE} WHERE district = ANY(?::text[])`, [names]);
  const postIds = [];
  for (const row of rows || []) {
    const id = Number(Array.isArray(row) ? row[0] : row?.post_id);
    if (Number.isFinite(id) && id > 0) postIds.push(id);
  }
  if (rev != null) {
    if (idsCache.size >= IDS_CACHE_LIMIT) idsCache.clear();
    idsCache.set(cacheKey, postIds);
  }
  return postIds;
}

/**
 * 取行政區預篩 id 集合。回傳 `{ postIds, districtNames }` 或 `null`
 * （＝不用預篩，呼叫端沿用原本的 `split_part` 子句）。
 *
 * `districtNames` 為空、選滿全部行政區（本來就不縮減）、開關關閉、或投影驗證不通過時都回 `null`。
 */
export async function loadDistrictPrefilterIds(exec, { districtNames = [], allDistrictNames = [] } = {}) {
  if (!districtPrefilterEnabled()) return null;
  const names = [...new Set((districtNames || []).filter(Boolean))];
  if (!names.length) return null;
  if (allDistrictNames.length && names.length >= allDistrictNames.length) return null;
  const { allowed, allKeys } = districtKeyLists(names);
  if (!allowed.length || allowed.length === allKeys.length) return null;
  if (!(await districtProjectionVerified(exec, { districtNames: names, allowedKeys: allowed }))) return null;
  const postIds = await projectedIdsForRevision(exec, names, `${names.join(",")}`);
  return { postIds, districtNames: names };
}
