import {
  addEvent,
  findBySourceKey,
  getListing,
  getSettings,
  listingCount,
  listingCountForSearch,
  listMatchCandidates,
  listingsNeedingFeeDetail,
  markEventNotified,
  saveSettings,
  setCachedGeo,
  getCachedGeo,
  setFlags,
  setListingDetail,
  setListingMatch,
  upsertListing,
} from "./db.js";
import { fetchListingDetail, fetchListings, mergeFeeRows } from "./client591.js";
import { bestMatch } from "./match.js";
import { eventLabel, notify } from "./notify.js";

function nowIso() {
  return new Date().toISOString();
}

function shouldNotify(settings, listing, type) {
  if (listing.hidden) return false;
  if (listing.watched && settings.notifyWatchedAlways) return true;
  if (listing.viewed && !settings.notifyViewed) return false;
  if (type === "new") return Boolean(settings.notifyNew);
  if (type === "same_source" || type === "update") return Boolean(settings.notifySameSource);
  return false;
}

function classify(incoming, existing) {
  if (!existing) {
    const siblings = findBySourceKey(incoming.source_key, incoming.post_id);
    if (siblings.length) {
      const prev = siblings[0];
      const detail = prev.price && prev.price !== incoming.price
        ? `指紋相同，先前 #${prev.post_id}，${prev.price} → ${incoming.price}`
        : `指紋相同，先前 #${prev.post_id}`;
      return { type: "same_source", detail, prev, level: "high" };
    }
    const hit = bestMatch(incoming, listMatchCandidates(incoming.post_id));
    if (hit?.listing) {
      const prev = hit.listing;
      const priceBit = prev.price && prev.price !== incoming.price ? `，${prev.price} → ${incoming.price}` : "";
      return { type: "same_source", detail: `${hit.detail}${priceBit}`, prev, level: hit.level };
    }
    return { type: "new", detail: incoming.price || "" };
  }

  if (existing.price && incoming.price && existing.price !== incoming.price) {
    return { type: "update", detail: `價格 ${existing.price} → ${incoming.price}` };
  }
  if (existing.title !== incoming.title) {
    return { type: "update", detail: "標題變更" };
  }
  return { type: "seen", detail: "" };
}

export async function runWatch(options = {}) {
  const settings = getSettings();
  const urls = (settings.searchUrls || []).map((url) => String(url).trim()).filter(Boolean);
  if (!urls.length) {
    throw new Error("請先貼上至少一組 591 搜尋網址");
  }

  const isBaseline = settings.hasBaseline !== true && listingCount() === 0;
  const pages = settings.pagesPerWatch || 2;
  const collected = [];
  const errors = [];

  for (const url of urls) {
    try {
      const result = await fetchListings(url, pages, {
        excludeLowFloors: settings.excludeLowFloors !== false,
        wholeFloorOnly: settings.wholeFloorOnly !== false,
        minBuildingFloors: settings.minBuildingFloors || 4,
        excludeKeywords: settings.excludeKeywords,
        excludeBoxes: settings.excludeBoxes,
        lookupGeo: getCachedGeo,
        saveGeo: setCachedGeo,
      });
      collected.push(result);
      if (result.total > 0 && result.listings.length === 0) {
        errors.push(`${result.parsed.label}：591 有 ${result.total} 筆，但都被目前篩選排除了`);
      }
    } catch (error) {
      errors.push(`${url} → ${error.message}`);
    }
  }

  if (!collected.length) {
    throw new Error(errors.join("；") || "591 搜尋沒有回傳資料");
  }

  const seen = new Set();
  const events = [];
  const searchReports = [];

  for (const batch of collected) {
    const isSearchBaseline = listingCountForSearch(batch.searchUrl) === 0;
    searchReports.push({
      label: batch.parsed.label,
      href: batch.parsed.href,
      total: batch.total,
      fetched: batch.listings.length,
      baseline: isSearchBaseline,
    });
    for (const listing of batch.listings) {
      if (seen.has(listing.post_id)) continue;
      seen.add(listing.post_id);

      const existing = getListing(listing.post_id);
      const { type, detail, prev, level } = classify(listing, existing);
      const stamp = nowIso();
      upsertListing({
        ...listing,
        search_key: batch.searchUrl,
        first_seen_at: existing?.first_seen_at || stamp,
        last_seen_at: stamp,
        last_event: type === "seen" ? existing?.last_event || "new" : type,
      });

      if (!existing && prev && (prev.hidden || prev.viewed)) {
        setListingMatch(listing.post_id, {
          match_post_id: prev.post_id,
          match_level: level || "high",
          match_detail: detail,
        });
        setFlags(listing.post_id, {
          hidden: true,
          viewed: true,
          watched: Boolean(prev.watched),
        });
      } else if (!existing && prev?.watched) {
        setFlags(listing.post_id, { watched: true });
      }

      if (type === "seen" || isBaseline || isSearchBaseline) continue;

      const current = getListing(listing.post_id);
      const event = {
        post_id: listing.post_id,
        source_key: listing.source_key,
        type,
        title: listing.title,
        detail,
        created_at: stamp,
        notified: 0,
        url: listing.url,
        price: listing.price,
        extra_fee: listing.extra_fee,
        extra_fee_text: listing.extra_fee_text,
        extra_fees: listing.extra_fees,
        address: listing.address,
        layout: listing.layout,
        floor_name: listing.floor_name,
        kind_name: listing.kind_name,
        cover: listing.cover,
      };
      const id = addEvent(event);
      event.id = id;
      if (shouldNotify(settings, current, type)) {
        events.push(event);
        markEventNotified(id);
      }
    }
  }

  const pendingFees = listingsNeedingFeeDetail(20);
  for (const row of pendingFees) {
    try {
      const listing = getListing(row.post_id);
      if (!listing) continue;
      const detail = await fetchListingDetail(row.post_id);
      setListingDetail(row.post_id, {
        extraFees: mergeFeeRows(listing.extra_fees, detail.fees),
        contact: detail.contact,
        fetched: 1,
      });
    } catch {
      // 詳情失敗下次再試，不中斷本輪追蹤
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  if (!options.silent && events.length) {
    await notify(settings, events);
  }
  if (settings.hasBaseline !== true) {
    saveSettings({ hasBaseline: true });
  }

  return {
    baseline: isBaseline,
    fetched: seen.size,
    searches: searchReports,
    events: events.map((event) => ({
      ...event,
      type_label: eventLabel(event.type),
    })),
    errors,
    checked_at: nowIso(),
  };
}
