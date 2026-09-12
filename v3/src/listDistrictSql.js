import { CITIES } from "./regions.js";

const known = CITIES.flatMap(city => city.districts.map(district => ({
  key: `${city.id}|${district.id}`, name: district.name,
})));
const allKeys = known.map(row => row.key);

// Keep unrecognised/legacy keys for the existing address/title fallback.
// This is a conservative candidate reduction, not a new district classifier.
export function appendDistrictCandidates(names, clauses, params, { preserveRelationsFor } = {}) {
  const selected = new Set(names || []);
  if (!selected.size) return;
  const allowed = known.filter(row => selected.has(row.name)).map(row => row.key);
  if (!allowed.length || allowed.length === allKeys.length) return;
  const key = "(COALESCE(source_key, '') || '|')";
  const first = `instr(${key}, '|')`;
  const prefix = `substr(${key}, 1, ${first} + instr(substr(${key}, ${first} + 1), '|') - 1)`;
  const marks = values => values.map(() => "?").join(",");
  const alternatives = [`${prefix} IN (${marks(allowed)})`, `${prefix} NOT IN (${marks(allKeys)})`];
  params.push(...allowed, ...allKeys);
  // A one-sided match outside the district can assign the in-district card's
  // role. Personal group members must also retain their overlaid flags.
  if (preserveRelationsFor !== undefined) {
    alternatives.push("COALESCE(match_post_id, 0) != 0");
    alternatives.push("post_id IN (SELECT match_post_id FROM listings WHERE COALESCE(match_post_id, 0) != 0)");
    if (Number(preserveRelationsFor) > 0) {
      alternatives.push("post_id IN (SELECT post_id FROM user_same_house_members WHERE user_id = ?)");
      params.push(Number(preserveRelationsFor));
    }
  }
  clauses.push(`(${alternatives.join(" OR ")})`);
}
