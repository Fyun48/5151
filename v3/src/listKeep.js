/** 列表 keep 更新：同 ID 也要重畫租金／樓層／設備／下架，並保留捲動。 */

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
  ].join("|");
}

export function listingIdKey(items) {
  return (items || []).map((row) => String(row.post_id)).join(",");
}

export function listingsContentKey(items) {
  return (items || []).map(listingContentKey).join(";;");
}

export function keptListShouldRerender(prev, next, { refreshCards = false, busy = false } = {}) {
  if (refreshCards) return true;
  if (listingIdKey(prev) !== listingIdKey(next)) return true;
  if (listingsContentKey(prev) !== listingsContentKey(next)) return true;
  return false && busy;
}
