// SSE delta events (Phase 10). Replaces the old "every background update forces
// loadList()" with a small, typed event vocabulary. Enrichment patches a card;
// only a real search membership/order change triggers a re-query.

export const DELTA_EVENT = Object.freeze({
  LISTING_ADDED: "listing_added",
  LISTING_UPDATED: "listing_updated",
  LISTING_REMOVED: "listing_removed",
  COMMUTE_UPDATED: "commute_updated",
  STATS_INVALIDATED: "stats_invalidated",
  SEARCH_MEMBERSHIP_CHANGED: "search_membership_changed",
});

// Fields whose change affects whether / where a listing appears in search.
const MEMBERSHIP_FIELDS = [
  "district", "total_monthly_cost", "rent", "kind", "source",
  "offline", "hidden", "match_verdict", "match_level",
];

export function searchMembershipChanged(prev, next) {
  if (!prev || !next) return true;
  return MEMBERSHIP_FIELDS.some((field) => (prev[field] ?? null) !== (next[field] ?? null));
}

// Map a change into a delta event. `type` is one of
// "added" | "removed" | "commute" | "stats" | "updated".
export function classifyDeltaEvent({ type = "updated", prev = null, next = null } = {}) {
  switch (type) {
    case "added": return DELTA_EVENT.LISTING_ADDED;
    case "removed": return DELTA_EVENT.LISTING_REMOVED;
    case "commute": return DELTA_EVENT.COMMUTE_UPDATED;
    case "stats": return DELTA_EVENT.STATS_INVALIDATED;
    case "updated":
    default:
      return searchMembershipChanged(prev, next)
        ? DELTA_EVENT.SEARCH_MEMBERSHIP_CHANGED
        : DELTA_EVENT.LISTING_UPDATED;
  }
}

// True when the client must re-query the list instead of patching a card.
export function eventRequiresRelist(event) {
  return [
    DELTA_EVENT.LISTING_ADDED,
    DELTA_EVENT.LISTING_REMOVED,
    DELTA_EVENT.SEARCH_MEMBERSHIP_CHANGED,
    DELTA_EVENT.STATS_INVALIDATED,
  ].includes(event);
}
