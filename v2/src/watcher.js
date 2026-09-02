import {
  enqueueListingEvent,
  coveringJobsFromAllUsers,
  findBySourceKey,
  getCommunityCache,
  getListing,
  getSettings,
  getUserById,
  getMailTemplates,
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
  db,
  saveSettings,
  setCachedRoute,
  commuteRushEnabled,
  collectCommuteSettings,
  setCommunityCache,
  copyUserFlags,
  setListingDetail,
  setListingMatch,
  touchListingChecked,
  upsertListing,
} from "./db.js";
import { replaceCrawlCovers, touchCrawlCoversRun } from "./crawlCovers.js";
import { fetchCommunityLocation, fetchListingDetail, fetchListings, isListingGoneError, LIST_PAGE_SIZE, mergeFeeRows, probeListingAlive } from "./client591.js";
import { commuteWorkJobs, hasWorkPoint, needsListingGeo, normalizeCommuteMode } from "./geo.js";
import { isTrustedGeoSource, listingCommunityId } from "./location.js";
import { decideNotifyDelivery } from "./floors.js";
import { fetchRoadRoutes, fetchRushRoadRoutes } from "./route.js";
import { hasGoogleMapsKey } from "./mapsBilling.js";
import { bestMatch } from "./match.js";
import { classifyExistingUpdate, eventLabel, listingLastEvent, notify, shouldDockNotify, shouldMailNotify, shouldNotify, shouldWebhookNotify } from "./notify.js";
import { normalizeOfflineConfirmDays, shouldRecheckOffline } from "./offline.js";
import { detailConcurrency, mapPool } from "./pool.js";

function nowIso() {
  return new Date().toISOString();
}

function listingEventPayload(listing, type, detail, stamp = nowIso()) {
  return {
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
    area_name: listing.area_name,
    tags: listing.tags,
    cover: listing.cover,
  };
}

function queueOfflineEvent(postId, { wasOnline = true } = {}) {
  if (!wasOnline) return;
  const listing = getListing(postId);
  if (!listing) return;
  const stamp = nowIso();
  enqueueListingEvent(listing, {
    type: "offline",
    detail: "591 詳情已不存在或已關閉",
    created_at: stamp,
  });
}

async function markOfflineAndNotify(postId, { wasOnline = true } = {}) {
  markListingOffline(postId);
  queueOfflineEvent(postId, { wasOnline });
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

function listingHasTrustedPin(listing) {
  return listing && listing.lat != null && listing.lng != null && isTrustedGeoSource(listing.geo_source);
}

async function applyCommunityPin(listing, community) {
  if (!listing || !community || community.lat == null || community.lng == null) return listing;
  return setListingDetail(listing.post_id, {
    extraFees: listing.extra_fees,
    fetched: listing.extra_fees_fetched,
    lat: community.lat,
    lng: community.lng,
    address: community.address || listing.address,
    community_id: community.id || listing.community_id,
    community_name: community.name || listing.community_name,
    geo_source: "community",
  }) || listing;
}

/** 先走社區超連結（同一棟只打一次社區 API），不夠再抓物件詳情／HTML。 */
export async function ingestListingGeo(postId) {
  let listing = getListing(postId);
  if (!listing) return { located: false };
  if (listingHasTrustedPin(listing) && listing.geo_source === "community") {
    return { located: true };
  }
  const commId = listingCommunityId(listing);
  if (commId) {
    let community = getCommunityCache(commId);
    if (!community || (community.lat == null && !community.address)) {
      community = await fetchCommunityLocation(commId);
      setCommunityCache(community || { id: commId, name: listing.community_name, address: "", lat: null, lng: null });
    }
    if (community?.lat != null && community?.lng != null) {
      listing = await applyCommunityPin(listing, community);
      if (listingHasTrustedPin(listing)) return { located: true };
    }
  }
  if (listingHasTrustedPin(listing)) return { located: true };
  try {
    const detail = await fetchListingDetail(postId, detailOptions());
    listing = applyFetchedDetail(listing, detail) || listing;
    return { located: listingHasTrustedPin(listing) };
  } catch (error) {
    if (isListingGoneError(error)) {
      await markOfflineAndNotify(postId, { wasOnline: !listing?.offline });
    }
    return { located: false, error };
  }
}

async function ingestListingGeoBatch(postIds) {
  const ids = [...new Set((postIds || []).map(Number).filter((id) => id > 0))];
  if (!ids.length) return { attempted: 0, located: 0 };
  const results = await mapPool(ids, { concurrency: detailConcurrency(), gapMs: 80 }, ingestListingGeo);
  return {
    attempted: ids.length,
    located: results.filter((row) => row?.located).length,
  };
}

async function resolveListingRoute(listing, settings) {
  const km = Number(settings.commuteKm);
  const workLat = Number(settings.workLat);
  const workLng = Number(settings.workLng);
  const mode = normalizeCommuteMode(settings.commuteMode);
  if (!(km > 0) || !hasWorkPoint(settings)) return listing;
  const lat = Number(listing?.lat);
  const lng = Number(listing?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return listing;
  const wantRush = commuteRushEnabled() && hasGoogleMapsKey();
  const hasKm = Array.isArray(listing.route_kms) && listing.route_kms.length;
  const hasRush = Number.isFinite(Number(listing.rush_am_min)) && Number.isFinite(Number(listing.rush_pm_min));
  if (hasKm && (!wantRush || hasRush)) return listing;
  if (wantRush) {
    const rush = await fetchRushRoadRoutes(lat, lng, workLat, workLng, { mode });
    const distances = rush?.distances?.length ? rush.distances : listing.route_kms;
    if (distances?.length) setCachedRoute(lat, lng, workLat, workLng, distances, rush, mode);
    return getListing(listing.post_id);
  }
  const distances = await fetchRoadRoutes(lat, lng, workLat, workLng, { mode });
  if (!distances?.length) return listing;
  setCachedRoute(lat, lng, workLat, workLng, distances, null, mode);
  return getListing(listing.post_id);
}

export async function flushPendingNotifications(settings = getSettings(), { silent = false } = {}) {
  const pending = pendingNotifyEvents(80);
  const dockByUser = new Map();
  const hookByUser = new Map();
  const mailByUser = new Map();
  for (const event of pending) {
    const userId = Number(event.user_id) || 0;
    const userSettings = userId ? getSettings(userId) : settings;
    const listing = getListing(event.post_id, userId || undefined);
    const mailTo = String(getUserById(userId)?.email || "").trim();
    const forDock = listing ? shouldDockNotify(userSettings, listing, event) : false;
    const forHook = listing ? shouldWebhookNotify(userSettings, listing, event) : false;
    const forMail = listing ? shouldMailNotify(userSettings, listing, event, { to: mailTo }) : false;
    if (!listing || (!forDock && !forHook && !forMail)) {
      markEventNotified(event.id);
      continue;
    }
    const delivery = decideNotifyDelivery(listing, {
      ...userSettings,
      waitRushMinutes: commuteRushEnabled() && hasGoogleMapsKey(),
    });
    if (delivery === "pending") continue;
    markEventNotified(event.id);
    if (delivery === "send") {
      const payload = { ...eventPayloadFromListing(event, listing), user_id: userId };
      if (forDock) {
        const list = dockByUser.get(userId) || [];
        list.push(payload);
        dockByUser.set(userId, list);
      }
      if (forHook) {
        const list = hookByUser.get(userId) || [];
        list.push(payload);
        hookByUser.set(userId, list);
      }
      if (forMail) {
        const list = mailByUser.get(userId) || [];
        list.push(payload);
        mailByUser.set(userId, list);
      }
    }
  }
  const ready = [];
  const userIds = new Set([...dockByUser.keys(), ...hookByUser.keys(), ...mailByUser.keys()]);
  const templates = getMailTemplates();
  for (const userId of userIds) {
    const dock = dockByUser.get(userId) || [];
    const hook = hookByUser.get(userId) || [];
    const mail = mailByUser.get(userId) || [];
    if (!silent && (dock.length || hook.length || mail.length)) {
      await notify(getSettings(userId), dock, {
        webhookEvents: hook,
        mailEvents: mail,
        mailTo: String(getUserById(userId)?.email || "").trim(),
        mailTemplates: templates,
      });
    }
    ready.push(...dock.map((event) => ({ ...event, type_label: eventLabel(event.type), user_id: userId })));
  }
  return ready;
}

async function resolvePendingNotifyLocations(settings, { withRoute = true } = {}) {
  if (!needsListingGeo(settings)) return;
  const pending = pendingNotifyEvents(40);
  const ids = [];
  const seen = new Set();
  for (const event of pending) {
    if (seen.has(event.post_id)) continue;
    seen.add(event.post_id);
    const userId = Number(event.user_id) || 0;
    const listing = getListing(event.post_id, userId || undefined);
    if (!listing) continue;
    const userSettings = userId ? getSettings(userId) : settings;
    if (!shouldNotify(userSettings, listing, event)) continue;
    if (decideNotifyDelivery(listing, {
      ...userSettings,
      waitRushMinutes: commuteRushEnabled() && hasGoogleMapsKey(),
    }) !== "pending") continue;
    ids.push(event.post_id);
  }
  await ingestListingGeoBatch(ids);
  if (!withRoute) return;
  for (const postId of ids) {
    const listing = getListing(postId);
    if (listing) await resolveListingRoute(listing, settings);
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
        const wasOnline = !getListing(row.post_id)?.offline;
        await markOfflineAndNotify(row.post_id, { wasOnline });
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
  const jobs = coveringJobsFromAllUsers();
  if (!jobs.length) {
    throw new Error("請先貼上至少一組 591 搜尋網址");
  }
  replaceCrawlCovers(db, jobs);

  const isBaseline = settings.hasBaseline !== true && listingCount() === 0;
  const requested = Number(settings.pagesPerWatch);
  const pages = Math.min(40, requested > 5 ? requested : 40);
  const collected = [];
  const errors = [];
  const fetchOptions = {
    minBuildingFloors: settings.minBuildingFloors || 4,
    excludeKeywords: settings.excludeKeywords,
    excludeBoxes: settings.excludeBoxes,
    excludeAgents: settings.excludeAgents,
    excludeAgentIds: settings.excludeAgentIds,
    commuteKm: settings.commuteKm,
    workLat: settings.workLat,
    workLng: settings.workLng,
  };

  for (const job of jobs) {
    try {
      const result = await fetchListings(job.searchUrl, pages, fetchOptions);
      collected.push(result);
      if (result.total > 0 && result.listings.length === 0) {
        errors.push(`${result.parsed.label}：591 有 ${result.total} 筆，但都被目前篩選排除了`);
      }
    } catch (error) {
      errors.push(`${job.searchUrl} → ${error.message}`);
    }
  }

  if (!collected.length) {
    throw new Error(errors.join("；") || "591 搜尋沒有回傳資料");
  }

  const seen = new Set();
  const freshIds = [];
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
      if (!existing) freshIds.push(listing.post_id);
      if (upserts % 20 === 0) await yieldEventLoop();

      if (!existing && prev && (level === "high" || level === "medium")) {
        setListingMatch(listing.post_id, {
          match_post_id: prev.post_id,
          match_level: level,
          match_detail: detail,
        });
      }
      if (!existing && prev) {
        const copied = copyUserFlags(prev.post_id, listing.post_id);
        if (copied || prev.hidden || prev.viewed) {
          setListingMatch(listing.post_id, {
            match_post_id: prev.post_id,
            match_level: level || "high",
            match_detail: detail,
          });
        }
      }

      if (type === "seen" || isBaseline || isSearchBaseline) continue;

      // 非特別關注的內容微差（地址補齊來回等）不要進通知佇列
      const saved = getListing(listing.post_id) || listing;
      const evt = { type, detail };
      enqueueListingEvent(saved, evt);
    }
  }

  if (needsListingGeo(settings) && freshIds.length > 0 && freshIds.length <= LIST_PAGE_SIZE) {
    await ingestListingGeoBatch(freshIds);
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
      if (isListingGoneError(error)) {
        const listing = getListing(row.post_id);
        await markOfflineAndNotify(row.post_id, { wasOnline: !listing?.offline });
      }
      // 詳情失敗下次再試，不中斷本輪追蹤
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  const events = options.silent ? [] : await flushPendingNotifications(settings, { silent: options.silent });
  if (settings.hasBaseline !== true) {
    saveSettings({ hasBaseline: true });
  }
  touchCrawlCoversRun(db);

  return {
    baseline: isBaseline,
    fetched: seen.size,
    searches: searchReports,
    covers: jobs.map((job) => ({
      regionId: job.regionId,
      sectionIds: job.sectionIds,
      priceMin: job.priceMin,
      priceMax: job.priceMax,
      href: job.searchUrl,
    })),
    events,
    errors,
    offline: offlineSweep,
    checked_at: nowIso(),
  };
}

export async function backfillListingCoords(settings = getSettings(), { limit = LIST_PAGE_SIZE } = {}) {
  if (!needsListingGeo(settings) || limit <= 0) return { attempted: 0, located: 0 };
  const rows = listingsNeeding591Geo(limit);
  return ingestListingGeoBatch(rows.map((row) => row.post_id));
}

export async function backfillListingRoutes(settings = getSettings(), { limit = 20 } = {}) {
  const fallback = commuteWorkJobs([settings, ...collectCommuteSettings()])[0];
  if (limit <= 0) return { attempted: 0, located: 0 };
  const rows = listingsNeedingRoute(limit);
  if (!rows.length && !(fallback || (Number(settings.commuteKm) > 0 && hasWorkPoint(settings)))) {
    return { attempted: 0, located: 0 };
  }
  let attempted = 0;
  let located = 0;
  for (const row of rows) {
    const workLat = Number(row.workLat || settings.workLat || fallback?.workLat);
    const workLng = Number(row.workLng || settings.workLng || fallback?.workLng);
    const mode = normalizeCommuteMode(row.commuteMode || settings.commuteMode || fallback?.commuteMode);
    if (!Number.isFinite(workLat) || !Number.isFinite(workLng)) continue;
    attempted += 1;
    const wantRush = commuteRushEnabled() && hasGoogleMapsKey();
    const rush = wantRush ? await fetchRushRoadRoutes(row.lat, row.lng, workLat, workLng, { mode }) : null;
    const distances = rush?.distances?.length ? rush.distances : await fetchRoadRoutes(row.lat, row.lng, workLat, workLng, { mode });
    if (distances?.length) {
      for (let tryNo = 0; tryNo < 4; tryNo += 1) {
        try {
          setCachedRoute(row.lat, row.lng, workLat, workLng, distances, rush, mode);
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
