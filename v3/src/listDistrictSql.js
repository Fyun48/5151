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

// Keep unrecognised/legacy keys for the existing address/title fallback.
// This is a conservative candidate reduction, not a new district classifier.
export function appendDistrictCandidates(names, clauses, params, { preserveRelationsFor } = {}) {
  const selected = new Set(names || []);
  if (!selected.size) return;
  const allowed = known.filter(row => selected.has(row.name)).map(row => row.key);
  if (!allowed.length || allowed.length === allKeys.length) return;
  const marks = values => values.map(() => "?").join(",");
  const alternatives = [`${prefix} IN (${marks(allowed)})`, `${prefix} NOT IN (${marks(allKeys)})`];
  params.push(...allowed, ...allKeys);
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
  clauses.push(`post_id IN (SELECT post_id FROM listings WHERE ${alternatives.join(" OR ")})`);
}
