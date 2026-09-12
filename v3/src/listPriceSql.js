// Conservative SQL reduction only: the complete fee/price parser still decides
// eligibility. rentAmount() prefers finite numeric price_num >= 1000, and monthly
// extras cannot reduce it. Keep legacy strings, small values and infinities for
// the existing parser. The one-dollar margin also preserves rounding boundaries.
export function appendPriceCeilingCandidates(settings, clauses, params) {
  const max = Number(settings?.priceMax);
  if (!Number.isFinite(max) || max <= 0) return;
  clauses.push(`NOT (
    typeof(price_num) IN ('integer', 'real')
    AND price_num BETWEEN 1000 AND ?
    AND price_num > ?
  )`);
  params.push(Number.MAX_VALUE, max + 1);
}
