import {
  addEvent,
  findBySourceKey,
  getListing,
  getSettings,
  listingCount,
  listingCountForSearch,
  markEventNotified,
  saveSettings,
  upsertListing,
} from "./db.js";
import { fetchListings } from "./client591.js";
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
        ? `先前刊登 #${prev.post_id}，${prev.price} → ${incoming.price}`
        : `先前刊登 #${prev.post_id}`;
      return { type: "same_source", detail };
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
      });
      collected.push(result);
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
      const { type, detail } = classify(listing, existing);
      const stamp = nowIso();
      upsertListing({
        ...listing,
        search_key: batch.searchUrl,
        first_seen_at: existing?.first_seen_at || stamp,
        last_seen_at: stamp,
        last_event: type === "seen" ? existing?.last_event || "new" : type,
      });

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
      };
      const id = addEvent(event);
      event.id = id;
      if (shouldNotify(settings, current, type)) {
        events.push(event);
        markEventNotified(id);
      }
    }
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
