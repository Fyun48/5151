import {
  addEvent,
  findBySourceKey,
  getCommunityCache,
  getListing,
  getSettings,
  listingCount,
  listingCountForSearch,
  listMatchCandidates,
  listingsNeeding591Geo,
  listingsNeedingFeeDetail,
  listingsNeedingRoute,
  listingsNeedingAliveCheck,
  listingsNeedingOfflineRecheck,
  markEventNotified,
  markListingOffline,
  confirmExpiredOfflineListings,
  restoreListingOnline,
  pendingNotifyEvents,
  eventPayloadFromListing,
  saveSettings,
  setCachedRoute,
  setCommunityCache,
  setFlags,
  setListingDetail,
  setListingMatch,
  touchListingChecked,
  upsertListing,
} from "./db.js";
import { fetchListingDetail, fetchListings, isListingGoneError, mergeFeeRows, probeListingAlive } from "./client591.js";
import { needsListingGeo } from "./geo.js";
import { decideNotifyDelivery } from "./floors.js";
import { fetchRoadRoutes } from "./route.js";
import { bestMatch } from "./match.js";
import { classifyExistingUpdate, eventLabel, listingLastEvent, notify, shouldDockNotify, shouldWebhookNotify } from "./notify.js";
import { normalizeOfflineConfirmDays, shouldRecheckOffline } from "./offline.js";

function nowIso() {
  return new Date().toISOString();
}

function yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
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

  const change = classifyExistingUpdate(incoming, existing);
  if (existing.offline) {
    return { ...change, prev: existing, level: "high" };
  }
  return change;
}

function detailOptions() {
  return {
    getCommunity: getCommunityCache,
    saveCommunity: setCommunityCache,
  };
}

function applyFetchedDetail(listing, detail) {
  return setListingDetail(listing.post_id, {
    extraFees: mergeFeeRows(listing.extra_fees, detail.fees),
    contact: detail.contact,
    fetched: 1,
    lat: detail.lat,
    lng: detail.lng,
    address: detail.address,
    community_id: detail.community_id,
    community_name: detail.community_name,
    geo_source: detail.geo_source,
  });
}

async function resolveListingRoute(listing, settings) {
  const km = Number(settings.commuteKm);
  const workLat = Number(settings.workLat);
  const workLng = Number(settings.workLng);
  if (!(km > 0) || !Number.isFinite(workLat) || !Number.isFinite(workLng)) return listing;
  const lat = Number(listing?.lat);
  const lng = Number(listing?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return listing;
  if (Array.isArray(listing.route_kms) && listing.route_kms.length) return listing;
  const distances = await fetchRoadRoutes(lat, lng, workLat, workLng);
  if (!distances?.length) return listing;
  setCachedRoute(lat, lng, workLat, workLng, distances);
  return getListing(listing.post_id);
}

export async function flushPendingNotifications(settings = getSettings(), { silent = false } = {}) {
  const pending = pendingNotifyEvents(80);
  const ready = [];
  const hookReady = [];
  for (const event of pending) {
    const listing = getListing(event.post_id);
    const forDock = listing ? shouldDockNotify(settings, listing, event.type) : false;
    const forHook = listing ? shouldWebhookNotify(settings, listing, event) : false;
    if (!listing || (!forDock && !forHook)) {
      markEventNotified(event.id);
      continue;
    }
    const delivery = decideNotifyDelivery(listing, settings);
    if (delivery === "pending") continue;
    markEventNotified(event.id);
    if (delivery === "send") {
      const payload = eventPayloadFromListing(event, listing);
      if (forDock) ready.push(payload);
      if (forHook) hookReady.push(payload);
    }
  }
  if (!silent && (ready.length || hookReady.length)) {
    await notify(settings, ready, { webhookEvents: hookReady });
  }
  return ready.map((event) => ({ ...event, type_label: eventLabel(event.type) }));
}

async function resolvePendingNotifyLocations(settings, { withRoute = true } = {}) {
  if (!needsListingGeo(settings)) return;
  const pending = pendingNotifyEvents(40);
  const seen = new Set();
  for (const event of pending) {
    if (seen.has(event.post_id)) continue;
    seen.add(event.post_id);
    let listing = getListing(event.post_id);
    if (!listing) continue;
    if (!shouldDockNotify(settings, listing, event.type) && !shouldWebhookNotify(settings, listing, event)) continue;
    if (decideNotifyDelivery(listing, settings) !== "pending") continue;
    try {
      const detail = await fetchListingDetail(event.post_id, detailOptions());
      listing = applyFetchedDetail(listing, detail) || listing;
      if (withRoute) listing = (await resolveListingRoute(listing, settings)) || listing;
    } catch (error) {
      if (isListingGoneError(error)) markListingOffline(event.post_id);
      // 詳情或路線失敗就留待下一輪補
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

async function sweepOfflineListings(seenIds, { limit = 20 } = {}) {
  const settings = getSettings();
  const confirmDays = normalizeOfflineConfirmDays(settings.offlineConfirmDays);
  const confirmed = confirmExpiredOfflineListings(confirmDays);
  const rows = listingsNeedingAliveCheck({ excludeIds: [...seenIds], limit });
  let checked = 0;
  let gone = 0;
  let rechecked = 0;
  let restored = 0;
  for (const row of rows) {
    checked += 1;
    try {
      await probeListingAlive(row.post_id);
      touchListingChecked(row.post_id);
    } catch (error) {
      if (isListingGoneError(error)) {
        markListingOffline(row.post_id);
        gone += 1;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  const pendingRecheck = listingsNeedingOfflineRecheck({ limit: 8 });
  const now = new Date();
  for (const row of pendingRecheck) {
    if (rechecked >= 8) break;
    if (!shouldRecheckOffline(row, { days: confirmDays, now })) continue;
    rechecked += 1;
    try {
      await probeListingAlive(row.post_id);
      restoreListingOnline(row.post_id);
      restored += 1;
    } catch (error) {
      if (isListingGoneError(error)) touchListingChecked(row.post_id);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return { checked, gone, rechecked, restored, confirmed };
}

export async function runWatch(options = {}) {
  const settings = getSettings();
  const urls = (settings.searchUrls || []).map((url) => String(url).trim()).filter(Boolean);
  if (!urls.length) {
    throw new Error("請先貼上至少一組 591 搜尋網址");
  }

  const isBaseline = settings.hasBaseline !== true && listingCount() === 0;
  const requested = Number(settings.pagesPerWatch);
  const pages = Math.min(40, requested > 5 ? requested : 40);
  const collected = [];
  const errors = [];
  const fetchOptions = {
    excludeLowFloors: settings.excludeLowFloors !== false,
    wholeFloorOnly: settings.wholeFloorOnly !== false,
    minBuildingFloors: settings.minBuildingFloors || 4,
    excludeKeywords: settings.excludeKeywords,
    excludeBoxes: settings.excludeBoxes,
    excludeAgents: settings.excludeAgents,
    excludeAgentIds: settings.excludeAgentIds,
    commuteKm: settings.commuteKm,
    workLat: settings.workLat,
    workLng: settings.workLng,
  };

  for (const url of urls) {
    try {
      const result = await fetchListings(url, pages, fetchOptions);
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
    let upserts = 0;
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
        last_event: listingLastEvent(type, existing),
      });
      upserts += 1;
      if (upserts % 20 === 0) await yieldEventLoop();

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
          watch_note: prev.watch_note || "",
        });
      } else if (!existing && prev?.watched) {
        setFlags(listing.post_id, { watched: true, watch_note: prev.watch_note || "" });
      }

      if (type === "seen" || isBaseline || isSearchBaseline) continue;

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
    }
  }

  await resolvePendingNotifyLocations(settings, { withRoute: options.skipHeavyGeo !== true });
  const offlineSweep = await sweepOfflineListings(seen, { limit: options.skipHeavyGeo ? 12 : 20 });

  const pendingFees = listingsNeedingFeeDetail(needsListingGeo(settings) ? 30 : 20);
  for (const row of pendingFees) {
    try {
      const listing = getListing(row.post_id);
      if (!listing) continue;
      const detail = await fetchListingDetail(row.post_id, detailOptions());
      applyFetchedDetail(listing, detail);
    } catch (error) {
      if (isListingGoneError(error)) markListingOffline(row.post_id);
      // 詳情失敗下次再試，不中斷本輪追蹤
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  const events = options.silent ? [] : await flushPendingNotifications(settings, { silent: options.silent });
  if (settings.hasBaseline !== true) {
    saveSettings({ hasBaseline: true });
  }

  return {
    baseline: isBaseline,
    fetched: seen.size,
    searches: searchReports,
    events,
    errors,
    offline: offlineSweep,
    checked_at: nowIso(),
  };
}

export async function backfillListingCoords(settings = getSettings(), { limit = 12 } = {}) {
  if (!needsListingGeo(settings) || limit <= 0) return { attempted: 0, located: 0 };
  const rows = listingsNeeding591Geo(limit);
  let attempted = 0;
  let located = 0;
  for (const row of rows) {
    attempted += 1;
    try {
      const listing = getListing(row.post_id);
      if (!listing) continue;
      const detail = await fetchListingDetail(row.post_id, detailOptions());
      setListingDetail(row.post_id, {
        extraFees: mergeFeeRows(listing.extra_fees, detail.fees),
        contact: detail.contact,
        fetched: 1,
        lat: detail.lat,
        lng: detail.lng,
        address: detail.address,
        community_id: detail.community_id,
        community_name: detail.community_name,
        geo_source: detail.geo_source,
      });
      if (detail.lat != null && detail.lng != null) located += 1;
    } catch (error) {
      if (isListingGoneError(error)) markListingOffline(row.post_id);
      // 591 詳情失敗下次再試
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { attempted, located };
}

export async function backfillListingRoutes(settings = getSettings(), { limit = 20 } = {}) {
  const workLat = Number(settings.workLat);
  const workLng = Number(settings.workLng);
  if (!(Number(settings.commuteKm) > 0) || !Number.isFinite(workLat) || !Number.isFinite(workLng) || limit <= 0) {
    return { attempted: 0, located: 0 };
  }
  const rows = listingsNeedingRoute(limit);
  let attempted = 0;
  let located = 0;
  for (const row of rows) {
    attempted += 1;
    const distances = await fetchRoadRoutes(row.lat, row.lng, workLat, workLng);
    if (distances?.length) {
      for (let tryNo = 0; tryNo < 4; tryNo += 1) {
        try {
          setCachedRoute(row.lat, row.lng, workLat, workLng, distances);
          located += 1;
          break;
        } catch (error) {
          if (!String(error.message || "").includes("locked") || tryNo === 3) throw error;
          await new Promise((resolve) => setTimeout(resolve, 400 * (tryNo + 1)));
        }
      }
    }
  }
  return { attempted, located };
}
