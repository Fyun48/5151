export const PROBE_ALIVE = "alive";
export const PROBE_GONE = "gone";
export const PROBE_INCONCLUSIVE = "inconclusive";

/** 只有確認上架才寫 alive；只有確認下架才寫 gone；其餘不改狀態。 */
export function classifyListingProbeWrite({ outcome = "", alive = null } = {}) {
  if (outcome === PROBE_GONE || alive === false) {
    return { write: "gone", outcome: PROBE_GONE, alive: false };
  }
  if (outcome === PROBE_ALIVE && alive === true) {
    return { write: "alive", outcome: PROBE_ALIVE, alive: true };
  }
  return { write: "none", outcome: outcome || PROBE_INCONCLUSIVE, alive: null };
}
