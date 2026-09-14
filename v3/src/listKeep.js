/** 列表 keep 更新：同 ID 也要重畫租金／樓層／設備／下架／同屋群組，並保留捲動。 */

export function listingGroupContentKey(item) {
  const peers = item?.same_house?.peers || [];
  const match = item?.match_peer;
  return [
    item?.same_house_role || "",
    item?.same_house_primary_id || "",
    match?.post_id || "",
    match?.price_num ?? "",
    match?.display_ready ?? "",
    peers.map((peer) => `${peer?.post_id}:${peer?.price_num}:${peer?.display_ready}:${peer?.offline}`).join(","),
  ].join("/");
}

export function listingContentKey(item) {
  return [
    item?.post_id,
    item?.price_num,
    item?.title,
    item?.floor_name,
    item?.address,
    item?.tags,
    item?.offline,
    item?.display_ready,
    item?.furnish_items,
    item?.has_natural_gas,
    listingGroupContentKey(item),
  ].join("|");
}

export function listingIdKey(items) {
  return (items || []).map((row) => String(row.post_id)).join(",");
}

export function listingsContentKey(items) {
  return (items || []).map(listingContentKey).join(";;");
}

export function listRefreshLimit({ pageSize = 80, loadedCount = 0, keep = false, append = false, max = 500 } = {}) {
  if (append) return Math.min(max, pageSize);
  const need = keep && loadedCount > 0 ? loadedCount : 0;
  return Math.min(max, Math.max(pageSize, need));
}

export function keptListShouldRerender(prev, next, { refreshCards = false, busy = false } = {}) {
  if (refreshCards) return true;
  if (listingIdKey(prev) !== listingIdKey(next)) return true;
  if (listingsContentKey(prev) !== listingsContentKey(next)) return true;
  return false && busy;
}
