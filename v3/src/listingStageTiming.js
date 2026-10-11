// 會員列表路徑的「階段取樣診斷」→ `Server-Timing` 回應標頭。
//
// 為什麼要有這一層：這一包（窄載體＋投影預篩）的每一階梯都要有「哪一段變快」的證據，
// 而不是只有總秒數。裁決 §4.1 P4 明確要求把各階段落進診斷。
//
// 契約（不得違反）：
//   1. **只寫進 header**。payload 的內容與欄位集合必須逐字不變；`timing.stages`／
//      `timing.stats_stages` 是既有欄位（這一層不新增、不修改），本模組只把它們**鏡射**成
//      標準的 `Server-Timing` 度量。測試 `v3/test/listing-server-timing.test.js` 會固定住
//      這件事（header 有值、JSON 沒有新鍵）。
//   2. `list;dur` 與 `stats;dur` 的語意與數字**不變**（量測腳本 `member-perf.mjs` 與
//      `member-list-benchmark.mjs` 都靠它們）。
//   3. 未知／缺少的階段一律略過，不得輸出 `NaN`。

/** 既有兩個總量度量（語意不得改變）。 */
const TOTAL_METRICS = Object.freeze([
  ["list", "query_ms"],
  ["stats", "stats_ms"],
]);

/**
 * 階段的鏡射表：header 名稱 → `queryDetails`／`stats_stages` 的鍵（可多個，取和）。
 * `list` 階段的鍵名沿用 `searchListingsNodePgInner` 的 `markStage()`。
 */
const LIST_STAGE_METRICS = Object.freeze([
  ["prepare", ["prepare_ms"]],
  ["cand", ["sql_ms"]],
  ["filter", ["profile_ms", "relations_ms", "display_ms"]],
  ["rows", ["preload_ms", "sort_ms", "preload_page_ms", "hydrate_ms"]],
]);

const STATS_STAGE_METRICS = Object.freeze([
  ["stats_cand", ["status_ms", "district_ms", "candidates_ms", "normalize_ms", "auxiliary_ms"]],
  ["stats_provider", ["provider_ms"]],
  ["stats_count", ["profile_sync_ms", "count_sync_ms", "reduce_ms", "profile_ms", "count_ms"]],
]);

function numberOrNull(value) {
  // `null`／`""` 一律視為「沒有這個階段」，不可被 Number() 轉成 0（會讓 header 說謊）。
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function sumOf(stages, keys) {
  let total = null;
  for (const key of keys) {
    const n = numberOrNull(stages?.[key]);
    if (n != null) total = (total || 0) + n;
  }
  return total;
}

/**
 * 回傳 `[{name, dur}]`。名稱為 `Server-Timing` 的 metric 名，`dur` 為毫秒整數。
 * 純函式、無副作用，方便測試逐項斷言。
 */
export function listingStageMetrics(timing = {}) {
  const stages = timing?.stages && typeof timing.stages === "object" ? timing.stages : {};
  const statsStages = timing?.stats_stages && typeof timing.stats_stages === "object" ? timing.stats_stages : {};
  const metrics = [];
  for (const [name, key] of TOTAL_METRICS) {
    const dur = numberOrNull(timing?.[key]);
    if (dur != null) metrics.push({ name, dur });
  }
  for (const [name, keys] of LIST_STAGE_METRICS) {
    const dur = sumOf(stages, keys);
    if (dur != null) metrics.push({ name, dur });
  }
  for (const [name, keys] of STATS_STAGE_METRICS) {
    const dur = sumOf(statsStages, keys);
    if (dur != null) metrics.push({ name, dur });
  }
  return metrics;
}

/** `Server-Timing` 標頭字串；沒有可用度量時回傳空字串（呼叫端就不設標頭）。 */
export function buildListingServerTimingHeader(timing = {}) {
  return listingStageMetrics(timing)
    .map(({ name, dur }) => `${name};dur=${dur}`)
    .join(", ");
}
