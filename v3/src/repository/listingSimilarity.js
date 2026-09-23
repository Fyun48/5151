// The similarity/insight admin reads + the pHash settings (PostgreSQL side of ④).
//
// listingSimilarity.js owns the pHash附屬表、同源建議與爬蟲洞察。它的每一條語句都跑在 SQLite
// handle 上，所以 `DB_DRIVER=postgres` 時會出現「寫 PostgreSQL、審核 UI 讀本機 v3.db」——
// 後台看到的建議／洞察永遠是舊的（或空的）。
//
// 這個模組把「同一份語句文字」變成 builder，交給注入的 exec 執行；哪個 driver 由
// listingSimilarityAsync.js 決定（sqlite → 原函式不變；postgres → 這裡）。
//
// 第一段（本檔）只含：settings 讀寫、審核 UI 的四個讀取（list／insight／admin／review）。
// 佇列寫入（phash／suggestion／insight）是第二段。
export const SIMILARITY_TABLES = [
  "listing_image_phash",
  "listing_similarity_suggestion",
  "listing_crawl_insight",
];

export function readSettingQuery(key) {
  return { sql: "SELECT value FROM settings WHERE key = ?", params: [key] };
}

export function writeSettingQuery(key, value) {
  return {
    sql: "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    params: [key, JSON.stringify(value)],
  };
}

export function enabledInsightProviderQuery(category) {
  return {
    sql: "SELECT is_enabled FROM system_provider_configs WHERE category = ? AND is_enabled = 1 LIMIT 1",
    params: [category],
  };
}

export function listingRowQuery(postId) {
  return { sql: "SELECT * FROM listings WHERE post_id = ?", params: [Number(postId) || 0] };
}

export function listSuggestionsQuery({ review_state = "pending", limit = 50 } = {}) {
  const take = Math.max(1, Math.min(100, Number(limit) || 50));
  return review_state === "all"
    ? { sql: "SELECT * FROM listing_similarity_suggestion ORDER BY id DESC LIMIT ?", params: [take] }
    : {
      sql: "SELECT * FROM listing_similarity_suggestion WHERE review_state = ? ORDER BY id DESC LIMIT ?",
      params: [review_state, take],
    };
}

export function suggestionByIdQuery(id) {
  return { sql: "SELECT * FROM listing_similarity_suggestion WHERE id = ?", params: [Number(id) || 0] };
}

// listingSimilarity.js reviewSimilarity() 的三個寫入欄位（reviewed_by 可為 null）。
export function reviewSuggestionQuery(id, state, reviewedAt, reviewedBy) {
  return {
    sql: `UPDATE listing_similarity_suggestion
    SET review_state = ?, reviewed_at = ?, reviewed_by = ?
    WHERE id = ?`,
    params: [state, reviewedAt, Number(reviewedBy) || null, Number(id) || 0],
  };
}

export function listInsightsQuery(limit = 20) {
  const take = Math.max(1, Math.min(50, Number(limit) || 20));
  return {
    sql: `
    SELECT i.*, l.title
    FROM listing_crawl_insight i
    LEFT JOIN listings l ON l.post_id = i.post_id
    ORDER BY i.id DESC
    LIMIT ?
  `,
    params: [take],
  };
}

export async function readSetting(exec, key) {
  const query = readSettingQuery(key);
  const rows = await exec(query.sql, query.params);
  return (rows || [])[0] || null;
}

export async function writeSetting(exec, key, value) {
  const query = writeSettingQuery(key, value);
  await exec(query.sql, query.params);
}

export async function insightProviderEnabled(exec, category) {
  const query = enabledInsightProviderQuery(category);
  const rows = await exec(query.sql, query.params);
  return Number(((rows || [])[0] || {}).is_enabled) === 1;
}

export async function listingById(exec, postId) {
  const query = listingRowQuery(postId);
  return (await exec(query.sql, query.params))?.[0] || null;
}

export async function listSuggestions(exec, options = {}) {
  const query = listSuggestionsQuery(options);
  return (await exec(query.sql, query.params)) || [];
}

export async function suggestionById(exec, id) {
  const query = suggestionByIdQuery(id);
  return (await exec(query.sql, query.params))?.[0] || null;
}

export async function reviewSuggestion(exec, id, state, reviewedAt, reviewedBy) {
  const query = reviewSuggestionQuery(id, state, reviewedAt, reviewedBy);
  await exec(query.sql, query.params);
}

export async function listInsights(exec, limit = 20) {
  const query = listInsightsQuery(limit);
  return (await exec(query.sql, query.params)) || [];
}

// ---- 第二段：佇列寫入（phash 指紋／同源建議／爬蟲洞察）----
//
// 語句文字與 listingSimilarity.js 逐字相同（兩邊共用同一份），只有 `IFNULL` 改成等價且兩個
// driver 都吃的 `COALESCE`（SQLite 也支援）。決策（hardVetoReasons／shouldAskLlm／配對）留在
// listingSimilarityAsync.js，這裡只負責 SQL。
export function insertPhashQuery({ postId, url, imageKey, algoVersion, phash, stamp }) {
  return {
    sql: `INSERT INTO listing_image_phash(post_id, image_url, image_key, algo_version, phash, computed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(post_id, image_key, algo_version) DO UPDATE SET
        image_url = excluded.image_url,
        phash = excluded.phash,
        computed_at = excluded.computed_at`,
    params: [Number(postId) || 0, String(url).slice(0, 500), imageKey, algoVersion, phash, stamp],
  };
}

export function otherHashesQuery(algoVersion, postId) {
  return {
    sql: "SELECT post_id, phash, image_key FROM listing_image_phash WHERE algo_version = ? AND post_id != ?",
    params: [algoVersion, Number(postId) || 0],
  };
}

export function suggestionPairQuery(lo, hi) {
  return {
    sql: "SELECT id, review_state, evidence_json FROM listing_similarity_suggestion WHERE listing_a = ? AND listing_b = ?",
    params: [lo, hi],
  };
}

export function suggestionPairRowQuery(lo, hi) {
  return {
    sql: "SELECT * FROM listing_similarity_suggestion WHERE listing_a = ? AND listing_b = ?",
    params: [lo, hi],
  };
}

export function upsertSuggestionQuery(lo, hi, evidence, stamp) {
  return {
    sql: `INSERT INTO listing_similarity_suggestion(listing_a, listing_b, evidence_json, review_state, created_at)
    VALUES (?, ?, ?, 'pending', ?)
    ON CONFLICT(listing_a, listing_b) DO UPDATE SET
      evidence_json = excluded.evidence_json
    WHERE listing_similarity_suggestion.review_state = 'pending'`,
    params: [lo, hi, JSON.stringify(evidence), stamp],
  };
}

export function insertInsightQuery(postId, hash, hints, applyState, stamp) {
  return {
    sql: `INSERT INTO listing_crawl_insight(post_id, source_text_hash, hints_json, apply_state, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(post_id, source_text_hash) DO UPDATE SET
      hints_json = excluded.hints_json,
      apply_state = excluded.apply_state`,
    params: [Number(postId) || 0, hash, JSON.stringify(hints), applyState, stamp],
  };
}

export function insightRowQuery(postId, hash) {
  return {
    sql: "SELECT * FROM listing_crawl_insight WHERE post_id = ? AND source_text_hash = ?",
    params: [Number(postId) || 0, hash],
  };
}

// listingSimilarity.js maybeFillEmptyStructured()：只補空白欄（IFNULL → COALESCE，兩邊等價）。
export function applyFloorHintQuery(postId, floor) {
  return {
    sql: "UPDATE listings SET floor_name = ? WHERE post_id = ? AND COALESCE(floor_name, '') = ''",
    params: [String(floor).slice(0, 40), Number(postId) || 0],
  };
}

export async function insertPhash(exec, row) {
  const query = insertPhashQuery(row);
  await exec(query.sql, query.params);
}

export async function otherHashes(exec, algoVersion, postId) {
  const query = otherHashesQuery(algoVersion, postId);
  return (await exec(query.sql, query.params)) || [];
}

export async function suggestionPair(exec, lo, hi) {
  const query = suggestionPairQuery(lo, hi);
  return (await exec(query.sql, query.params))?.[0] || null;
}

export async function suggestionPairRow(exec, lo, hi) {
  const query = suggestionPairRowQuery(lo, hi);
  return (await exec(query.sql, query.params))?.[0] || null;
}

export async function upsertSuggestion(exec, lo, hi, evidence, stamp) {
  const query = upsertSuggestionQuery(lo, hi, evidence, stamp);
  await exec(query.sql, query.params);
}

export async function insertInsight(exec, postId, hash, hints, applyState, stamp) {
  const query = insertInsightQuery(postId, hash, hints, applyState, stamp);
  await exec(query.sql, query.params);
}

export async function insightRow(exec, postId, hash) {
  const query = insightRowQuery(postId, hash);
  return (await exec(query.sql, query.params))?.[0] || null;
}

export async function applyFloorHint(exec, postId, floor) {
  const query = applyFloorHintQuery(postId, floor);
  await exec(query.sql, query.params);
}
