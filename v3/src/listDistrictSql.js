import { CITIES } from "./regions.js";

const known = CITIES.flatMap(city => city.districts.map(district => ({
  key: `${city.id}|${district.id}`, name: district.name,
})));
const allKeys = known.map(row => row.key);
const key = "(COALESCE(source_key, '') || '|')";
const first = `instr(${key}, '|')`;
const prefix = `substr(${key}, 1, ${first} + instr(substr(${key}, ${first} + 1), '|') - 1)`;

export function ensureDistrictCandidateIndex(db) {
  // SQLite maintains this derived key on every source_key insert/update. Sharing
  // the exact expression with the query lets the ID scan use a covering index.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_listings_district_prefix ON listings(${prefix})`);
}

// 行政區鍵的共用知識（給需要自行組查詢的 driver 用；B3b 的 PG closure 就靠它）。
export function districtKeyLists(names) {
  const selected = new Set(names || []);
  const allowed = known.filter(row => selected.has(row.name)).map(row => row.key);
  return { allowed, allKeys };
}

/**
 * 行政區前綴的 SQL 表達式（同一份知識、兩種 dialect）：
 * SQLite 用 instr/substr；PostgreSQL 用 split_part（`city|district|`）。
 */
export function districtKeyPrefixExpression(dialect = "sqlite") {
  // 注意：SQLite 版本的 prefix 是 `cityId|districtId`（**不帶尾端 `|`**，與 known 的 key 同格式），
  // 所以 PG 版也必須完全相同，否則 IN/NOT IN 比對不到（實測踩過）。
  if (String(dialect) === "pg") {
    return `(split_part(COALESCE(source_key, ''), '|', 1) || '|' || split_part(COALESCE(source_key, ''), '|', 2))`;
  }
  return prefix;
}

// 行政區「投影預篩」子句（PG 專屬）。
//
// 取代 `${prefix} IN (allowed)` 那個 `split_part(source_key…)` 表達式：改由呼叫端先用
// `listing_search_projection.district`（`idx_proj_district`）取回 id 集合，這裡只放
// `post_id = ANY(?::bigint[])`，讓 PG 能用主鍵索引／bitmap 取得候選而不是 seq scan。
//
// 語意論證與退回條件見 `listingDistrictPrefilter.js`。要點：
//   * `projectedIds` 必須是「Node 判定鏈最後會留下的行政區列」的**超集**；
//     預篩是多餘的前置縮窄，判定鏈照舊逐列跑。
//   * 原本的 `${prefix} NOT IN (allKeys)`（未知／legacy 前綴保留）**不再需要**：
//     `districtNameFromListing` 在 `source_key` 解析不出行政區時會改由 address／title 推導，
//     而那正是投影 `district` 欄的來源；投影完整時，推導得出行政區的列一定在 `projectedIds`
//     內，推導不出來的列則會被判定鏈的 `districtSet` 過濾掉。因此這一項移除**不會少算**。
//   * 取不到投影（滯後／缺表／`MEMBER_DISTRICT_PREFILTER=0`）時呼叫端不會走這條，改回
//     `appendDistrictCandidates` 的完整表達式。
//
// 回傳 `true` 表示已接手（含「不需要縮減」的情形）；`false` 表示呼叫端應退回舊路徑。
export function appendDistrictProjectedCandidates(names, clauses, params, { projectedIds = null, relatedIds = null, driver = "postgres" } = {}) {
  if (!Array.isArray(projectedIds)) return false;
  if (driver !== "postgres") return false;
  const selected = new Set(names || []);
  if (!selected.size) return true;
  const allowed = known.filter(row => selected.has(row.name)).map(row => row.key);
  // 沒有可辨識的行政區名稱、或本來就選滿全部行政區 ⇒ 與舊路徑一樣不縮減。
  if (!allowed.length || allowed.length === allKeys.length) return true;
  const alternatives = ["post_id = ANY(?::bigint[])"];
  params.push(projectedIds);
  if (Array.isArray(relatedIds) && relatedIds.length) {
    alternatives.push("post_id = ANY(?::bigint[])");
    params.push(relatedIds);
  }
  clauses.push(`(${alternatives.join(" OR ")})`);
  return true;
}

// Keep unrecognised/legacy keys for the existing address/title fallback.
// This is a conservative candidate reduction, not a new district classifier.
export function appendDistrictCandidates(names, clauses, params, { preserveRelationsFor, driver = "sqlite", relatedIds = null } = {}) {
  const selected = new Set(names || []);
  if (!selected.size) return;
  const allowed = known.filter(row => selected.has(row.name)).map(row => row.key);
  if (!allowed.length || allowed.length === allKeys.length) return;
  const marks = values => values.map(() => "?").join(",");
  const districtPrefix = driver === "postgres" ? districtKeyPrefixExpression("pg") : prefix;
  const alternatives = [`${districtPrefix} IN (${marks(allowed)})`, `${districtPrefix} NOT IN (${marks(allKeys)})`];
  params.push(...allowed, ...allKeys);
  if (Array.isArray(relatedIds) && relatedIds.length) {
    if (driver !== "postgres") throw new Error("District relation IDs require PostgreSQL");
    alternatives.push("post_id = ANY(?::bigint[])");
    params.push(relatedIds);
  }
  // Keep complete relation components of district candidates, including incoming
  // one-sided matches and the viewer's personal groups. Unrelated matches in
  // other districts cannot affect their roles. UNION terminates mutual cycles.
  if (preserveRelationsFor !== undefined) {
    const personal = Number(preserveRelationsFor) > 0 ? `
      UNION
      SELECT peer.post_id FROM district_related connected
      JOIN user_same_house_members member ON member.post_id = connected.post_id AND member.user_id = ?
      JOIN user_same_house_members peer ON peer.user_id = member.user_id AND peer.group_key = member.group_key
    ` : "";
    if (Number(preserveRelationsFor) > 0) {
      params.push(Number(preserveRelationsFor));
    }
    clauses.push(`post_id IN (
      WITH RECURSIVE district_related(post_id) AS (
        SELECT post_id FROM listings WHERE (${alternatives.join(" OR ")})
        UNION
        SELECT l.match_post_id FROM district_related connected
        JOIN listings l ON l.post_id = connected.post_id
        WHERE COALESCE(l.match_post_id, 0) != 0
        UNION
        SELECT l.post_id FROM district_related connected
        JOIN listings l ON l.match_post_id = connected.post_id
        ${personal}
      )
      SELECT post_id FROM district_related
    )`);
    return;
  }
  // Select IDs from the narrow index before reading wide listing fields. A
  // direct OR predicate on SELECT <all fields> otherwise causes a table scan.
  clauses.push(driver === "postgres"
    ? `(${alternatives.join(" OR ")})`
    : `post_id IN (SELECT post_id FROM listings WHERE ${alternatives.join(" OR ")})`);
}
