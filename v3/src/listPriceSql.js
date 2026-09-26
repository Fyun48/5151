// Conservative SQL reduction only: the complete fee/price parser still decides
// eligibility. rentAmount() prefers finite numeric price_num >= 1000, and monthly
// extras cannot reduce it. Keep legacy strings, small values and infinities for
// the existing parser. The one-dollar margin also preserves rounding boundaries.
export function appendPriceCeilingCandidates(settings, clauses, params, { driver = "sqlite" } = {}) {
  const max = Number(settings?.priceMax);
  if (!Number.isFinite(max) || max <= 0) return;
  // PG has a typed numeric column; SQLite may contain legacy text. Casting the
  // PG expression also prevents its bigint type from being inferred for MAX_VALUE.
  const numeric = driver === "postgres" ? "price_num IS NOT NULL" : "typeof(price_num) IN ('integer', 'real')";
  const price = driver === "postgres" ? "CAST(price_num AS DOUBLE PRECISION)" : "price_num";
  clauses.push(`NOT (
    ${numeric}
    AND ${price} BETWEEN 1000 AND ?
    AND ${price} > ?
  )`);
  params.push(Number.MAX_VALUE, max + 1);
}
