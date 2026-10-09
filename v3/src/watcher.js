import {
  bindNotifyJobSnapshots,
  coveringPlan,
  findBySourceKey,
  getCommunityCache,
  getListing,
  getSettings,
  getSystemCrawl,
  getUserById,
  getMailTemplates,
  listingCount,
  listMatchCandidates,
  listingHasTrustedGeo,
  markListingOffline,
  restoreListingOnline,
  markListingAlive,
  eventPayloadFromListing,
  eventChannelsHandled,
  channelJobDone,
  db,
  saveSettings,
  commuteRushEnabled,
  collectCommuteSettings,
  touchListingChecked,
  isCrawlSourceEnabled,
  persistHpListingFields,
  invalidateListingLocation,
  persistListing,
  routeJobKeyFor,
  pushPayloadFromEvents,
} from "./db.js";
import { reserveCoveringPlan, completeCoveringPlan, crawlRuntimeAsync, recordCrawlSourceRoundAsync, readCrawlSourceStreaksAsync } from "./crawlScheduleAsync.js";
// 第九十二批：來源連續失敗的容忍政策（Owner 2026-09-30 同意）。純函式在 crawlSourceStreaks.js，
// 這裡只負責「逐輪餵結果、拿回誰還會阻擋完成紀錄」。
import {
  blockingCrawlSources,
  crawlSourceLabel,
  jobCoveredByBlockingSources,
  sourceRoundBlocked,
  sourceRoundWarnings,
} from "./crawlSourceStreaks.js";
// 第九十六批 B：被擋而停工的來源會記下冷卻期；還在冷卻的這一輪直接跳過（不要每輪開頭都去撞同一面牆）。
import { isSourceCoolingDown, SOURCE_BLOCK_COOLDOWN_MS } from "./crawlWatchdog.js";
// 爬蟲基線寫入必須走 driver-aware 入口：PG 模式下只寫 SQLite 會讓基線永遠留在單一節點，
// 其他節點讀不到 → 每次排程都重跑整輪（與 crawl_covers 同一個事故成因）。
import { commuteRushEnabledAsync, getSettingsAsync, saveSettingsAsync } from "./settingsAsync.js";
// 通知決策要讀站上那一份的會員與信件範本（PG 模式下讀本機等於用別台節點的資料做決定）。
import { getUserByIdAsync } from "./usersAsync.js";
import { getMailTemplatesAsync } from "./adminSettingsAsync.js";
import { markCoveringProgressAsync } from "./coveringBookkeepingAsync.js";
import { CRAWL_PAGES_591, CRAWL_PAGES_EXTERNAL, coveringPhaseDeadlineMs, SWEEP_SCAN_BUDGET_MS } from "./crawlPolicy.js";
// 外站跨輪輪轉（一輪只排一家、最久沒成功的先；延後不記失敗）。政策與理由寫在該檔檔首。
import { pickExternalSources, externalSourcesPerRun, externalPhaseBudgetMs } from "./externalRotation.js";
import { noteConsecutiveTimeout, withBudget } from "./crawlWatchdog.js";
import { currentCrawlExecution, isCrawlCancelled, throwIfCrawlCancelled } from "./crawlExecution.js";
import { crawlTelemetry, setCrawlPhase, newCrawlRoundId, logDeadlineStop } from "./crawlTelemetry.js";
import { fetchCommunityLocation, fetchListingDetail, fetchListings, isListingGoneError, LIST_PAGE_SIZE, mergeFeeRows, probeListingAlive } from "./client591.js";
import { probeListingAliveBySource } from "./probe.js";
import { classifyListingProbeWrite } from "./probeOutcomes.js";
import { processListingEnrichBatch } from "./listingEnrichQueue.js";
// 2.3b 第二段：入列與 worker 的 queue 管理走 driver-aware 版本
// （SQLite 模式的行為與同步函式完全相同；PG 模式才寫到 PostgreSQL）。
import { enqueueListingEnrichAsync, listingEnrichQueueFacade } from "./listingEnrichQueueAsync.js";
import { crawlSourceEnabled } from "./crawlSources.js";
import { getCrawlSourcesAsync } from "./siteContentAsync.js";
import { resolveDbDriver } from "./dbDriver.js";
import { assertRuntimeDbGuard } from "./runtimeGuards.js";
import { getCachedGeoAsync, setCachedGeoAsync } from "./geoCacheAsync.js";
import { listingCommutePatchesAsync } from "./listingCommuteAsync.js";
import { sendUserWebPushAsync } from "./webPushAsync.js";
import {
  finishRouteAttemptAsync,
  markRouteJobAsync,
  setCachedRouteAsync,
} from "./routeCacheAsync.js";
import { fetchHbCoveringListings } from "./hbhousing.js";
import { fetchSinyiCoveringListings } from "./sinyi.js";
import { fetchHpCoveringListings } from "./houseprice.js";
import { enrichDdListingFromObject, fetchDdCoveringListings, fetchDdObject } from "./ddroom.js";
import { fetchHfCoveringListings } from "./housefun.js";
import { fetchRakuyaCoveringListings, fetchRakuyaDetail, repairRakuyaScopes } from "./rakuya.js";
import { fetchSourceKit } from "./sourceKit.js";
import { commuteWorkJobs, geocodeAddress, geoFailReason, hasWorkPoint, needsListingGeo, normalizeCommuteMode } from "./geo.js";
import { parseTaiwanAddressParts, streetCacheKey } from "./geoPrecision.js";
import { isTrustedGeoSource, listingCommunityId, pickRicherAddress } from "./location.js";
import { decideNotifyDelivery, decideNotifyDecision, isStalePendingNotify } from "./floors.js";
import { NOTIFY_BACKOFF_MS } from "./geoPrecision.js";
import { fetchRoadRoutes, fetchRoadRouteTable, fetchRushRoadRoutes } from "./route.js";
import { COMMUTE_STATES, commuteSettingsFingerprint, routeRetryDecision } from "./commuteState.js";
import { fetchMrtAccess } from "./mrt.js";
import { googleDirectionsAllowed } from "./mapsBilling.js";
import { bestMatch } from "./match.js";
import { collapseSameHouseNotifyEvents } from "./userSameHouse.js";
import { classifyExistingUpdate, eventLabel, listingLastEvent, notify, shouldDockNotify, shouldMailNotify, shouldNotify, shouldPushNotify, shouldWebhookNotify } from "./notify.js";
import { feeChangeDetail, feeFieldsChanged, incomingHasFeePayload, isCostChangeType } from "./listingCompare.js";
import { significantListingUpdate } from "./sameHouseReconcile.js";
import { rentAmount } from "./listingCost.js";
import { normalizeOfflineConfirmDays, shouldRecheckOffline } from "./offline.js";
import { detailConcurrency, mapPool } from "./pool.js";
// Driver-aware reads: with DB_DRIVER=postgres the crawler has to read back what it just wrote
// (see crawlerReads.js). The synchronous read stays for helpers that are still sync.
import {
  listingForWatchAsync,
  listingCountForSearchAsync,
  matchCandidatesAsync,
  needing591GeoAsync,
  needingAddressEnrichAsync,
  needingAddressGeoAsync,
  needingAliveCheckAsync,
  needingFeeDetailAsync,
  needingMrtAsync,
  needingOfflineRecheckAsync,
  needingRouteAsync,
  needingSourceKitAsync,
  watchSiblings,
} from "./crawlerReads.js";
// ... and the write half: the loops must store their results in the same store (crawlerWrites.js).
import {
  confirmExpiredOfflineAsync,
  invalidateListingLocationAsync,
  markListingAliveAsync,
  markListingOfflineAsync,
  markSourceKitRetryAsync,
  persistHpListingFieldsAsync,
  restoreListingOnlineAsync,
  setCachedMrtAsync,
  setCommunityCacheAsync,
  setListingDetailAsync,
  touchListingCheckedAsync,
  upsertListingPrepAsync,
  updateListingsGeoByAddressAsync,
} from "./crawlerWrites.js";
// 樂屋抓取游標：PG 模式下不再讀寫本機 SQLite（見 crawlerProgressAsync.js 的說明）。
import { getRakuyaPageCursorsAsync, saveRakuyaPageCursorsAsync } from "./crawlerProgressAsync.js";
// 配對與同屋重評估：站上讀 PG 的 listing_group_members，寫入也必須進 PG
// （見 listingMatchAsync.js 的說明）。
import { reconcileListingByIdAsync, setListingMatchAsync } from "./listingMatchAsync.js";
import { getMemberMailBundleAsync } from "./memberMailAsync.js";

// 重刊旗標複製必須走 driver-aware 入口：正式站 DB_DRIVER=postgres 時，同步版 copyUserFlags()
// 只寫節點本機 SQLite（讀 PG、寫本機 = 無聲孤島寫入），所以這裡改用 async 版（讀寫都依 driver）。
import { copyUserFlagsAsync } from "./personalFlagsAsync.js";

// Driver-aware notification queue: the flush loop reads the pending page and writes every channel
// outcome through these (notifyQueueAsync.js).
import { markEventNotifiedAsync, pendingNotifyEventsAsync, updateEventNotifyAsync } from "./notifyQueueAsync.js";
import { enqueueListingEventAsync } from "./notifyEnqueueAsync.js";

function nowIso() {
  return new Date().toISOString();
}

function listingForWatch(postId, userId) {
  return getListing(postId, userId, { sameHouse: false });
}

/**
 * 補抓 worker（`processListingEnrichBatch()`）的 helper bundle。
 *
 * 兩件必須一起看的事：
 *   1. `listingEnrichQueue.js` 的 `runHelper()` **一律優先 `xxxAsync`**，只有在 bundle 沒有
 *      對應的 async 變體時才退回同步版（那個順序是為了 SQLite-only 的呼叫端）。
 *   2. 所以 PG 模式下同步變體是**死碼**——留著只會讓尺規（靜態分析）把整條路由判成 MIXED，
 *      也讓「這個 bundle 到底走哪個 store」看不出來。
 *
 * ⇒ 這裡依 driver 決定要不要提供同步變體：PG 只給 async（真的走 `crawlerWrites.js` 的
 * PostgreSQL 分支），SQLite 兩種都給（行為與以前完全相同）。`options` 會逐層轉發給 async 變體，
 * 讓測試能注入 `pgDriver`／`strict`（正式路徑不傳，行為不變）。
 */
export function listingEnrichHelpers(options = {}) {
  const driver = options.driver || resolveDbDriver();
  const fwd = (fn) => (...args) => fn(...args, options);
  const base = {
    loadListingAsync: (id) => listingForWatchAsync(id, undefined, options),
    persistHpListingFieldsAsync: (id, next, extra = {}) => persistHpListingFieldsAsync(id, next, { ...options, ...extra }),
    upsertListingPrepAsync: (postId, listing, evalResult) => upsertListingPrepAsync(postId, listing, evalResult, options),
    // 同步版簽名是 `(listing, next)`，async 版是 `(postId)`；兩個都只取 post_id。
    invalidateLocationAsync: (listing, next) => invalidateListingLocationAsync(Number(next?.post_id || listing?.post_id) || 0, options),
    markGoneAsync: fwd(markListingOfflineAsync),
    markAliveAsync: fwd(markListingAliveAsync),
    // 開閘後同步 `isCrawlSourceEnabled()`（getCrawlSources → settingKey）讀本機 SQLite ⇒ 改讀 PG。
    // 同步版 `isSourceEnabled` 是 SQLite 專用（見下方），PG 模式只給 async 變體。
    isSourceEnabledAsync: async (id) => crawlSourceEnabled((await getCrawlSourcesAsync(options)).items, id),
    onFirstReady: async (listing) => {
      const age = Date.now() - (Date.parse(listing.first_seen_at || "") || 0);
      if (age > 2 * 60 * 60 * 1000) return;
      await enqueueListingEventAsync({ ...listing, display_ready: true }, {
        type: "new",
        detail: "5168 資料已補齊，開始展示",
        created_at: nowIso(),
      });
    },
    // 2.3b 第二段：補抓 worker 的 queue 管理（seed／claim／finish／metric／擁有權／prep）走
    // driver-aware 分派（processListingEnrichBatch 會用這個 bundle）。PG 模式下 seed 回 0，
    // 因為種子查詢還依賴 listings 的讀取島（細節見 PG-2.3-NOTES.md）。
    enrichQueue: listingEnrichQueueFacade(db, { driver }),
  };
  if (driver === "postgres") return base;
  // SQLite-only 的呼叫端（以及非 PG 的舊路徑）用同步變體：與以前完全相同。
  return {
    ...base,
    loadListing: (id) => listingForWatch(id),
    persistHpListingFields,
    invalidateLocation: invalidateListingLocation,
    markGone: (id) => markListingOffline(id),
    markAlive: (id) => markListingAlive(id),
    isSourceEnabled: isCrawlSourceEnabled,
  };
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

async function queueOfflineEvent(postId, { wasOnline = true } = {}) {
  if (!wasOnline) return;
  const listing = await listingForWatchAsync(postId);
  if (!listing) return;
  const stamp = nowIso();
  await enqueueListingEventAsync(listing, {
    type: "offline",
    detail: "591 詳情已不存在或已關閉",
    created_at: stamp,
  });
}

async function markOfflineAndNotify(postId, { wasOnline = true } = {}) {
  await markListingOfflineAsync(postId);
  await queueOfflineEvent(postId, { wasOnline });
}

function yieldEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function costPatchFromClassify({ type, detail, cost_change_type }, incoming, existing, prev, stamp) {
  if (isCostChangeType(type) || cost_change_type) {
    return {
      cost_changed_at: stamp,
      cost_change_type: cost_change_type || type,
      cost_change_detail: detail || "",
    };
  }
  const prior = prev || existing;
  if (type === "same_source" && prior) {
    const oldRent = rentAmount(prior);
    const newRent = rentAmount(incoming);
    const rentChanged = oldRent > 0 && newRent > 0 && oldRent !== newRent;
    const feeChanged = incomingHasFeePayload(prior) && feeFieldsChanged(incoming, prior);
    if (!rentChanged && !feeChanged) return {};
    const bits = [];
    if (rentChanged) bits.push(`相較先前同屋源 #${prior.post_id}，租金 ${prior.price || oldRent} → ${incoming.price || newRent}`);
    if (feeChanged) bits.push(feeChangeDetail(prior, incoming));
    return {
      cost_changed_at: stamp,
      cost_change_type: rentChanged && newRent < oldRent ? "price_drop" : (rentChanged ? "price_update" : "fee_update"),
      cost_change_detail: bits.join("；"),
    };
  }
  return {};
}

// `siblings` / `candidates` are the two reads classify() may need (crawlerReads.watchSiblings and
// crawlerReads.matchCandidatesAsync): the caller awaits them once and hands them in, so this stays
// a pure decision function for both drivers. Passing null falls back to the synchronous SQLite
// reads, which is what a SQLite-only caller still does.
function classify(incoming, existing, siblings = null, candidates = null) {
  if (!existing) {
    const sameSource = siblings ?? findBySourceKey(incoming.source_key, incoming.post_id);
    if (sameSource.length) {
      const prev = sameSource[0];
      const detail = prev.price && prev.price !== incoming.price
        ? `指紋相同，先前 #${prev.post_id}，${prev.price} → ${incoming.price}`
        : `指紋相同，先前 #${prev.post_id}`;
      return { type: "same_source", detail, prev, level: "high" };
    }
    const pool = candidates ?? listMatchCandidates(incoming.post_id, incoming);
    const hit = bestMatch(incoming, pool);
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
    // Fire-and-forget inside client591, so swallow a rejected write here (the async path already
    // falls back to SQLite on a PostgreSQL failure).
    saveCommunity: (community) => { setCommunityCacheAsync(community).catch(() => {}); },
  };
}

async function applyFetchedDetail(listing, detail) {
  const saved = await setListingDetailAsync(listing.post_id, {
    extraFees: mergeFeeRows(listing.extra_fees, detail.fees),
    contact: detail.contact,
    fetched: 1,
    lat: detail.lat,
    lng: detail.lng,
    address: detail.address,
    community_id: detail.community_id,
    community_name: detail.community_name,
    community_linked: detail.community_id ? 1 : detail.community_linked,
    geo_source: detail.geo_source,
    has_natural_gas: detail.has_natural_gas,
    has_balcony: detail.has_balcony,
    furnish_items: detail.furnish_items,
    kit_fetched: 1,
  });
  try { await reconcileListingByIdAsync(listing.post_id, { reason: "detail_enrichment" }); } catch { /* ignore */ }
  return saved;
}

function listingHasTrustedPin(listing) {
  return listing && listing.lat != null && listing.lng != null && isTrustedGeoSource(listing.geo_source);
}

async function applyCommunityPin(listing, community) {
  if (!listing || !community || community.lat == null || community.lng == null) return listing;
  return await setListingDetailAsync(listing.post_id, {
    extraFees: listing.extra_fees,
    fetched: listing.extra_fees_fetched,
    lat: community.lat,
    lng: community.lng,
    address: pickRicherAddress([listing.address, community.address]) || community.address || listing.address,
    community_id: community.id || listing.community_id,
    community_name: community.name || listing.community_name,
    community_linked: 1,
    geo_source: "community",
  }) || listing;
}

/** 先走社區超連結（同一棟只打一次社區 API），不夠再抓物件詳情／HTML。 */
export async function ingestListingGeo(postId) {
  let listing = await listingForWatchAsync(postId);
  if (!listing) return { located: false };
  if (String(listing.source || "591") !== "591") {
    return { located: listingHasTrustedPin(listing) };
  }
  if (listingHasTrustedPin(listing) && listing.geo_source === "community") {
    return { located: true };
  }
  const commId = listingCommunityId(listing);
  if (commId) {
    let community = getCommunityCache(commId);
    if (!community || (community.lat == null && !community.address)) {
      community = await fetchCommunityLocation(commId);
      await setCommunityCacheAsync(community || { id: commId, name: listing.community_name, address: "", lat: null, lng: null });
    }
    if (community?.lat != null && community?.lng != null) {
      listing = await applyCommunityPin(listing, community);
      if (listingHasTrustedPin(listing)) return { located: true };
    }
  }
  if (listingHasTrustedPin(listing)) return { located: true };
  try {
    const detail = await fetchListingDetail(postId, detailOptions());
    listing = (await applyFetchedDetail(listing, detail)) || listing;
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

async function resolveListingRoute(listing, settings, options = {}) {
  const km = Number(settings.commuteKm);
  const workLat = Number(settings.workLat);
  const workLng = Number(settings.workLng);
  const mode = normalizeCommuteMode(settings.commuteMode);
  if (!(km > 0) || !hasWorkPoint(settings)) return listing;
  const lat = Number(listing?.lat);
  const lng = Number(listing?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return listing;
  const wantRush = (await commuteRushEnabledAsync(options)) && googleDirectionsAllowed();
  const hasKm = Array.isArray(listing.route_kms) && listing.route_kms.length;
  const hasRush = Number.isFinite(Number(listing.rush_am_min)) && Number.isFinite(Number(listing.rush_pm_min));
  if (hasKm && (!wantRush || hasRush)) return listing;
  if (wantRush) {
    const rush = await fetchRushRoadRoutes(lat, lng, workLat, workLng, { mode });
    const distances = rush?.distances?.length ? rush.distances : listing.route_kms;
    if (distances?.length) await setCachedRouteAsync(lat, lng, workLat, workLng, distances, rush, mode, "to_work", options);
    return listingForWatchAsync(listing.post_id);
  }
  const distances = await fetchRoadRoutes(lat, lng, workLat, workLng, { mode });
  if (!distances?.length) return listing;
  await setCachedRouteAsync(lat, lng, workLat, workLng, distances, null, mode, "to_work", options);
  return listingForWatchAsync(listing.post_id);
}

// `bindNotifyJobSnapshots()`（db.js）是**同步**的全會員迴圈（`listUserIds()` ＋
// `getActiveSearchProfile()`），而且它填的那份 memo 只有**同步**的 enqueue 入口在讀
// ——PG 模式的 enqueue 走 `repository/notifyEnqueue.js`（自己讀 PG 的 active profile）。
// ⇒ PG 模式下這一圈只會讀到**節點本機**的會員與搜尋設定檔（別的節點建的會員不在裡面，
// 而本機的舊 profile 會被拿去當通知範圍）。包成 driver-aware 的委派，兩個 driver 都保留原行為。
async function bindNotifyJobSnapshotsFor(options = {}) {
  if ((options.driver || resolveDbDriver()) === "postgres") return 0;
  return bindNotifyJobSnapshots();
}

export async function flushPendingNotifications(settings = null, { silent = false, ...options } = {}) {
  // ⚠️ 逐會員的設定與信箱要讀**站上讀的那一份**（PG）：同步版讀本機 ⇒ PG 模式下
  // 「暫停通知的會員照樣被通知」、信件寄到舊的（或空的）信箱，而且不會報錯。
  // `options` 一路轉發給島嶼，測試才能注入 driver（正式路徑不傳，行為不變）。
  settings = settings || await getSettingsAsync(0, options);
  await bindNotifyJobSnapshotsFor(options);
  const pending = await pendingNotifyEventsAsync({ limit: 400 }, options);
  const dockByUser = new Map();
  const hookByUser = new Map();
  const mailByUser = new Map();
  const pushByUser = new Map();
  const neededByEvent = new Map();
  for (const event of pending) {
    const userId = Number(event.user_id) || 0;
    const userSettings = userId ? await getSettingsAsync(userId, options) : settings;
    const listing = await listingForWatchAsync(event.post_id, userId || undefined, options);
    const mailTo = String((await getUserByIdAsync(userId, options))?.email || "").trim();
    const mailBundle = userId ? await getMemberMailBundleAsync(userId) : { configured: false, smtp: null, templates: await getMailTemplatesAsync(options) };
    const mailReady = Boolean(mailBundle.configured);
    if (!listing) {
      await updateEventNotifyAsync(event.id, { notify_decide: "cancelled", notify_reason: "missing", notified: 1 }, options);
      continue;
    }
    if (userSettings.notificationsPaused === true) {
      await updateEventNotifyAsync(event.id, { notify_reason: "paused" }, options);
      continue;
    }
    const forDock = shouldDockNotify(userSettings, listing, event);
    const forHook = shouldWebhookNotify(userSettings, listing, event);
    const forMail = shouldMailNotify(userSettings, listing, event, { to: mailTo, configured: mailReady });
    const forPush = shouldPushNotify(userSettings, listing, event);
    const decision = decideNotifyDecision(listing, userSettings);
    await updateEventNotifyAsync(event.id, {
      notify_decide: decision.decide,
      notify_reason: decision.reason,
      notify_coord_version: Number(listing.coord_version) || 0,
      notify_ready_at: decision.verdict === "send" ? Date.now() : event.notify_ready_at,
    }, options);
    if (decision.verdict === "pending") {
      if (isStalePendingNotify(event)) {
        await updateEventNotifyAsync(event.id, {
          notify_decide: "wait_data",
          notify_reason: "backoff",
          notify_next_at: Date.now() + NOTIFY_BACKOFF_MS,
          notify_retry_count: (Number(event.notify_retry_count) || 0) + 1,
        }, options);
      }
      continue;
    }
    if (decision.verdict !== "send") {
      await updateEventNotifyAsync(event.id, { notified: 1, notify_decide: decision.decide || "skip_distance", notify_reason: decision.reason }, options);
      continue;
    }
    if (!forDock && !forHook && !forMail && !forPush) {
      await updateEventNotifyAsync(event.id, {
        dock_job_state: "skipped",
        line_job_state: "skipped",
        email_job_state: "skipped",
        push_job_state: "skipped",
        notified: 1,
        notify_reason: "channels_off",
      }, options);
      continue;
    }
    const created = Date.parse(event.created_at || "");
    const delayNote = Number.isFinite(created) && Date.now() - created > 10 * 60 * 1000
      ? "延後確認符合條件的新物件"
      : "";
    const payload = {
      ...eventPayloadFromListing(event, listing),
      user_id: userId,
      event_id: event.id,
      notify_note: decision.notify_note || "",
      notify_delay_note: delayNote,
      location_class: decision.location_class || listing.location_class,
      commute_approx: Boolean(decision.approximate || listing.commute_approx),
    };
    neededByEvent.set(event.id, { dock: forDock, hook: forHook, mail: forMail, push: forPush, userId });
    if (forDock && !channelJobDone(event.dock_job_state)) {
      const list = dockByUser.get(userId) || [];
      list.push(payload);
      dockByUser.set(userId, list);
    }
    if (forHook && !channelJobDone(event.line_job_state)) {
      const list = hookByUser.get(userId) || [];
      list.push(payload);
      hookByUser.set(userId, list);
    }
    if (forMail && !channelJobDone(event.email_job_state)) {
      const list = mailByUser.get(userId) || [];
      list.push(payload);
      mailByUser.set(userId, list);
    }
    if (forPush && !channelJobDone(event.push_job_state)) {
      const list = pushByUser.get(userId) || [];
      list.push(payload);
      pushByUser.set(userId, list);
    }
  }
  const ready = [];
  const userIds = new Set([...dockByUser.keys(), ...hookByUser.keys(), ...mailByUser.keys(), ...pushByUser.keys()]);
  for (const userId of userIds) {
    const dock = dockByUser.get(userId) || [];
    const hook = collapseSameHouseNotifyEvents(hookByUser.get(userId) || [], (event) => (
      Number(event?.same_house_primary_id) || Number(event?.post_id) || 0
    ));
    const mail = mailByUser.get(userId) || [];
    const push = pushByUser.get(userId) || [];
    const mailBundle = userId ? await getMemberMailBundleAsync(userId) : { smtp: null, templates: await getMailTemplatesAsync(options) };
    let result = { webhook: { job_state: "skipped" }, mail: { job_state: "skipped", shown_ids: [] } };
    if (!silent && (dock.length || hook.length || mail.length)) {
      result = await notify(await getSettingsAsync(userId, options), dock, {
        webhookEvents: hook,
        mailEvents: mail,
        mailTo: String((await getUserByIdAsync(userId, options))?.email || "").trim(),
        mailTemplates: mailBundle.templates,
        smtp: mailBundle.smtp || null,
      }) || result;
    }
    let pushState = "skipped";
    if (!silent && push.length) {
      try {
        await sendUserWebPushAsync(userId, pushPayloadFromEvents(push), options);
        pushState = "accepted";
      } catch {
        pushState = "retry";
      }
    }
    const hookState = hook.length ? (result.webhook?.job_state || "retry") : "";
    const mailState = result.mail?.job_state || "retry";
    const mailShown = new Set(result.mail?.shown_ids || mail.slice(0, 8).map((event) => event.event_id || event.id));
    for (const payload of dock) {
      await updateEventNotifyAsync(payload.event_id, { dock_job_state: silent ? "accepted" : "accepted" }, options);
    }
    for (const payload of hook) {
      await updateEventNotifyAsync(payload.event_id, {
        line_job_state: hookState || "retry",
        notify_last_error: result.webhook?.fail_reason || "",
      }, options);
    }
    for (const payload of mail) {
      const id = payload.event_id || payload.id;
      await updateEventNotifyAsync(id, {
        email_job_state: mailShown.has(id) ? mailState : "retry",
        notify_last_error: mailShown.has(id) ? (result.mail?.fail_reason || "") : "batch_overflow",
      }, options);
    }
    for (const payload of push) {
      await updateEventNotifyAsync(payload.event_id, { push_job_state: pushState }, options);
    }
    const touched = new Set([
      ...dock.map((event) => event.event_id),
      ...hook.map((event) => event.event_id),
      ...mail.map((event) => event.event_id),
      ...push.map((event) => event.event_id),
    ]);
    for (const id of touched) {
      const needed = neededByEvent.get(id);
      const latest = pending.find((row) => row.id === id) || {};
      const merged = {
        ...latest,
        dock_job_state: dock.some((event) => event.event_id === id) ? "accepted" : latest.dock_job_state,
        line_job_state: hook.some((event) => event.event_id === id) ? (hookState || latest.line_job_state) : latest.line_job_state,
        email_job_state: mail.some((event) => event.event_id === id)
          ? (mailShown.has(id) ? mailState : "retry")
          : latest.email_job_state,
        push_job_state: push.some((event) => event.event_id === id) ? pushState : latest.push_job_state,
      };
      if (needed && eventChannelsHandled(merged, needed)) await markEventNotifiedAsync(id);
    }
    ready.push(...dock.map((event) => ({ ...event, type_label: eventLabel(event.type), user_id: userId })));
  }
  return ready;
}

async function resolvePendingNotifyLocations(settings, { withRoute = true, ...options } = {}) {
  if (!needsListingGeo(settings)) return;
  const pending = await pendingNotifyEventsAsync({ limit: 40 });
  const ids = [];
  const seen = new Set();
  for (const event of pending) {
    if (seen.has(event.post_id)) continue;
    seen.add(event.post_id);
    const userId = Number(event.user_id) || 0;
    const listing = await listingForWatchAsync(event.post_id, userId || undefined);
    if (!listing) continue;
    const userSettings = userId ? getSettings(userId) : settings;
    if (!shouldNotify(userSettings, listing, event)) continue;
    if (decideNotifyDelivery(listing, {
      ...userSettings,
      waitRushMinutes: (await commuteRushEnabledAsync(options)) && googleDirectionsAllowed(),
    }) !== "pending") continue;
    ids.push(event.post_id);
  }
  await ingestListingGeoBatch(ids);
  if (!withRoute) return;
  for (const postId of ids) {
    const listing = await listingForWatchAsync(postId);
    if (listing) await resolveListingRoute(listing, settings, options);
  }
}

async function sweepOfflineListings(seenIds, { limit = 20, budgetMs = SWEEP_SCAN_BUDGET_MS, system = null } = {}) {
  const confirmDays = normalizeOfflineConfirmDays((system || getSystemCrawl()).offlineConfirmDays);
  const confirmed = await confirmExpiredOfflineAsync({ days: confirmDays });
  const rows = await needingAliveCheckAsync({ excludeIds: [...seenIds], limit });
  crawlTelemetry.log(`下架掃描開始：待確認 ${rows.length} 筆／預算 ${limit} 筆`);
  let checked = 0;
  let gone = 0;
  let rechecked = 0;
  let restored = 0;
  // 掃描自己的小預算（預設 SWEEP_SCAN_BUDGET_MS）：到點就停手並留一行儀表板，
  // 不讓「逐筆探測外部站台」的慢回應反過來吃掉整輪抓取的開頭。0／負數＝不設限。
  const scanStartedAt = Date.now();
  const scanBudget = Number(budgetMs);
  const overScanBudget = () => Number.isFinite(scanBudget) && scanBudget > 0 && Date.now() - scanStartedAt >= scanBudget;
  let stoppedOnBudget = false;
  const stopOnBudget = () => {
    stoppedOnBudget = true;
    logDeadlineStop(Date.now() - scanStartedAt);
  };
  const aliveBatchStartedAt = Date.now();
  for (const row of rows) {
    throwIfCrawlCancelled();
    if (overScanBudget()) { stopOnBudget(); break; }
    const listing = await listingForWatchAsync(row.post_id);
    if (!listing) continue;
    checked += 1;
    try {
      const { supported, outcome, alive } = await probeListingAliveBySource(listing);
      if (!supported) { checked -= 1; continue; }
      const decision = classifyListingProbeWrite({ outcome, alive });
      if (decision.write === "gone") {
        await markOfflineAndNotify(row.post_id, { wasOnline: !listing.offline });
        gone += 1;
      } else if (decision.write === "alive") {
        await markListingAliveAsync(row.post_id, { wasOffline: Boolean(listing.offline) });
      }
    } catch {
      throwIfCrawlCancelled();
      // 探測失敗（保守）：不動狀態，下輪再試
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  crawlTelemetry.log(`本批探測 ${checked} 筆、耗時 ${Date.now() - aliveBatchStartedAt}ms`);
  if (rows.length >= limit && limit > 0) {
    crawlTelemetry.log(`下架掃描：待確認已達預算 ${limit} 筆（可能還有更多），本輪先收手`);
  }
  if (stoppedOnBudget || overScanBudget()) {
    if (!stoppedOnBudget) stopOnBudget();
    return { checked, gone, rechecked, restored, confirmed };
  }
  const pendingRecheck = await needingOfflineRecheckAsync({ limit: 8 });
  const now = new Date();
  const recheckBatchStartedAt = Date.now();
  for (const row of pendingRecheck) {
    if (rechecked >= 8) break;
    if (!shouldRecheckOffline(row, { days: confirmDays, now })) continue;
    throwIfCrawlCancelled();
    if (overScanBudget()) { stopOnBudget(); break; }
    const listing = await listingForWatchAsync(row.post_id);
    if (!listing) continue;
    rechecked += 1;
    try {
      const { supported, outcome, alive } = await probeListingAliveBySource(listing);
      if (supported && classifyListingProbeWrite({ outcome, alive }).write === "alive") { await restoreListingOnlineAsync(row.post_id); restored += 1; }
      else await touchListingCheckedAsync(row.post_id);
    } catch {
      throwIfCrawlCancelled();
      await touchListingCheckedAsync(row.post_id);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  crawlTelemetry.log(`本批複查 ${rechecked} 筆、耗時 ${Date.now() - recheckBatchStartedAt}ms`);
  if (rechecked >= 8) {
    crawlTelemetry.log(`下架掃描：複查已達 ${rechecked} 筆上限（rechecked>=8），提前收手`);
  }
  return { checked, gone, rechecked, restored, confirmed };
}

export function isWatchIntervalPending(lastCheckedAt, intervalMinutes, now = Date.now()) {
  const t = Date.parse(lastCheckedAt);
  if (!Number.isFinite(t)) return false;
  const wait = Math.max(1, Number(intervalMinutes) || 1) * 60 * 1000;
  return now - t < wait;
}

export async function runWatch(options = {}) {
  // G4 啟動檢查：sandbox 與獨立 crawler 行程也走同一個 gate（fail-fast）。
  assertRuntimeDbGuard();
  throwIfCrawlCancelled();
  const roundId = newCrawlRoundId();
  const roundStartedAt = Date.now();
  setCrawlPhase("準備");
  crawlTelemetry.log(`輪次開始：${roundId}`);
  const logRoundEnd = (extra = {}) => {
    crawlTelemetry.log(`輪次結束：${roundId}（${Date.now() - roundStartedAt}ms，fetched ${extra.fetched ?? 0}，covered ${extra.covered ?? 0}，jobs ${extra.jobs ?? 0}，skipped ${extra.skipped ?? ""}）`);
  };
  const runtime = await crawlRuntimeAsync();
  const want591 = runtime.sourceEnabled("591");
  const wantHb = runtime.sourceEnabled("hbhousing");
  const wantSinyi = runtime.sourceEnabled("sinyi");
  const wantHp = runtime.sourceEnabled("houseprice");
  const wantDd = runtime.sourceEnabled("ddroom");
  const wantHf = runtime.sourceEnabled("housefun");
  const wantRakuya = runtime.sourceEnabled("rakuya");
  if (!want591 && !wantHb && !wantSinyi && !wantHp && !wantDd && !wantHf && !wantRakuya) {
    logRoundEnd({ skipped: "sources" });
    return {
      checked_at: nowIso(),
      searches: [],
      events: [],
      skipped: "sources",
      message: "591 與外站來源都已在後台關閉，這次沒有抓取",
    };
  }
  const settings = runtime.settings;
  // 第九十六批 B：開工前先看哪些來源還在冷卻期（上一輪被擋到停工）。
  // 讀不到就當作沒有（維持原本行為，不讓診斷狀態擋住整輪）。
  const cooling = new Set();
  let sourceStreaks = {};
  try {
    const { streaks } = await readCrawlSourceStreaksAsync();
    sourceStreaks = streaks || {};
    for (const [id, row] of Object.entries(streaks || {})) {
      if (isSourceCoolingDown(row)) cooling.add(id);
    }
  } catch {
    cooling.clear();
  }
  const plan = Array.isArray(options.jobs)
    ? {
      jobs: options.jobs,
      includedUserIds: options.includedUserIds || [],
      memberRequirements: options.memberRequirements || [],
      includeSystem: options.includeSystem === true,
    }
    : await reserveCoveringPlan({
      now: Date.now(),
      includeSystem: options.includeSystem !== false,
    });
  const jobs = plan.jobs;
  if (!jobs.length) {
    logRoundEnd({ jobs: 0, skipped: "no-jobs" });
    throw new Error("請先選行政區或貼上至少一組 591 搜尋網址");
  }
  await bindNotifyJobSnapshotsFor(options);

  const isBaseline = settings.hasBaseline !== true && listingCount() === 0;
  const pages = CRAWL_PAGES_591;
  const hbPages = CRAWL_PAGES_EXTERNAL;
  const collected = [];
  const errors = [];
  // 第九十二批：`sourceSuccess` 每一組都帶上**來源 id**（原本只有集合，出錯時看不出是誰），
  // `sourceRounds` 則是這一輪各來源的成敗，收尾時一次寫進 `crawlScheduleV1.sourceStreaks`。
  const sourceSuccess = [];
  const sourceRounds = [];
  const noteSourceRound = (source, urls, sourceErrors, blocked = false, applicable = true, partial = false) => {
    sourceRounds.push({
      source,
      covered: urls.size,
      total: jobs.length,
      // 這一輪是不是「只抓了一部分行政區」（到達每輪上限，其餘下一輪）：
      // 不算這一組已完成、也不算失敗（第九十七批的每輪上限）。
      partial: partial === true,
      // 這一輪是不是「因為被擋而停工」（會換算成 blockedUntil 冷卻期）。
      blocked: blocked === true,
      cooldownMs: SOURCE_BLOCK_COOLDOWN_MS,
      // 這一輪有沒有「這個來源真的能抓的行政區」？
      // 2026-09-30 沙盒實測：5168 只有台北／新北的 sid，其他縣市的覆蓋條件會讓它一個批次都生不出來
      // ⇒ 原本被算成「失敗輪」，`fails` 一路累積、後台顯示「連續失敗 7 輪」卻沒有任何錯誤訊息。
      applicable: applicable !== false,
      // 只留少量樣本（狀態會寫進 settings 的單一 JSON 值，不要把整包錯誤塞進去）。
      error: [...new Set((sourceErrors || []).filter(Boolean))].slice(0, 3).join("；"),
    });
  };
  const fetchOptions = {
    // 測試注入點（跟 `hbPostJson` 同一套做法）：`fetchListings` 內部是
    // `typeof options.fetchPage === "function" ? options.fetchPage : 真的抓頁`，
    // 所以沒傳時行為完全不變。有它才能離線驗「591 覆蓋階段到點停手」這條路。
    fetchPage: options.fetchPage,
    minBuildingFloors: Number(settings.minBuildingFloors) || 0,
    excludeKeywords: settings.excludeKeywords,
    excludeBoxes: settings.excludeBoxes,
    excludeAgents: settings.excludeAgents,
    excludeAgentIds: settings.excludeAgentIds,
    commuteKm: settings.commuteKm,
    workLat: settings.workLat,
    workLng: settings.workLng,
  };

  // 下架掃描排在「抓來源之前」（2026-10-09，提案選項 B）：可見優先的探測要在這一輪抓頁落地
  // 之前先做一小段，才不會像 2026-10-09 實測那樣——整輪預算被輪尾（落地＋明細＋套件＋通知）
  // 吃光，掃描永遠輪不到。每輪探測上限沿用 #662（skipHeavyGeo 的輕量路徑 12、重路徑 40，
  // 每筆固定 400ms 延遲）；掃描有自己的小預算（SWEEP_SCAN_BUDGET_MS），到點就停手。
  // 掃描放前面不准變成整輪失敗的新來源：fail-soft（逐筆 try/catch），讀寫例外只記一行、抓取照跑。
  let offlineSweep = { checked: 0, gone: 0, rechecked: 0, restored: 0, confirmed: 0 };
  try {
    setCrawlPhase("下架掃描");
    offlineSweep = await sweepOfflineListings([], {
      limit: options.skipHeavyGeo ? 12 : 40,
      budgetMs: options.sweepScanBudgetMs,
      system: runtime.system,
    });
  } catch (error) {
    if (isCrawlCancelled()) throw error;
    crawlTelemetry.warn(`下架掃描失敗，本輪跳過（不影響抓取）：${error?.message || error}`);
  }

  if (want591 && !cooling.has("591")) {
    const successful = new Set();
    const sourceErrors = [];
    sourceSuccess.push({ source: "591", urls: successful });
    let consecutiveTimeouts = 0;
    const source591StartedAt = Date.now();
    setCrawlPhase("來源 591");
    crawlTelemetry.log("來源 591：開始");
    try {
      // 591 覆蓋階段的時間上限（理由寫在 crawlPolicy.js：實測地板是 591，不是外站）。
      // 只在「兩個覆蓋條件之間」檢查，不在半頁中停 ⇒ 已抓到的頁面照樣落地、照樣記完成。
      const coveringExecution = currentCrawlExecution();
      const coveringRemainingMs = coveringExecution?.deadline ? coveringExecution.deadline - Date.now() : 0;
      const coveringDeadline = Number(options.coveringPhaseDeadlineMs) > 0
        ? Number(options.coveringPhaseDeadlineMs)
        : coveringPhaseDeadlineMs({ remainingMs: coveringRemainingMs, env: process.env });
      let coveringTimedOut = false;
      for (const job of jobs) {
        if (coveringDeadline && Date.now() >= coveringDeadline) {
          coveringTimedOut = true;
          errors.push(`591 覆蓋階段到點停手（本輪 ${jobs.length} 個縣市，只跑完 ${successful.size} 個）`
            + "，其餘留到下一輪——未跑完的覆蓋條件不會被記成完成，這一輪也不記成失敗");
          break;
        }
        try {
          const result = await fetchListings(job.searchUrl, pages, fetchOptions);
          throwIfCrawlCancelled();
          collected.push(result);
          if (!result.errors?.length) successful.add(job.searchUrl);
          consecutiveTimeouts = 0;
          if (result.total > 0 && result.listings.length === 0) {
            errors.push(`${result.parsed.label}：591 有 ${result.total} 筆，但都被目前篩選排除了`);
          }
        } catch (error) {
          throwIfCrawlCancelled();
          errors.push(`${job.searchUrl} → ${error.message}`);
          sourceErrors.push(error.message);
          const skip = noteConsecutiveTimeout(consecutiveTimeouts, error);
          consecutiveTimeouts = skip.consecutive;
          if (skip.skipRest) {
            errors.push("591 連續逾時，其餘縣市本輪跳過");
            break;
          }
        }
      }
      noteSourceRound("591", successful, sourceErrors, false, true, coveringTimedOut);
    } finally {
      const interrupted = isCrawlCancelled();
      crawlTelemetry.log(`來源 591：結束（${Date.now() - source591StartedAt}ms，行政區 ${successful.size}/${jobs.length}，頁 ${pages}${interrupted ? "，中斷" : ""}）`);
    }
  }

  async function collectExternal(source, label, run, phaseBudgetMs = 0) {
    const successful = new Set();
    const sourceErrors = [];
    sourceSuccess.push({ source, urls: successful });
    const externalStartedAt = Date.now();
    setCrawlPhase(`來源 ${label}`);
    crawlTelemetry.log(`來源 ${label}：開始`);
    // ⚠️ 一定要宣告在 try 外面：`noteSourceRound(...)` 在 try/catch 之後要用它，
    // 寫在 try 裡面會是 `ReferenceError: batches is not defined`（2026-09-30 沙盒第一輪就抓到，
    // 當時的 watcher 測試只比對原始碼文字，抓不到這種作用域錯誤）。
    // `phaseTimedOut` 只在「這一家這一階段的預算用盡」時成立 ⇒ 這一輪對這家是「只跑了一半」，
    // **不是失敗**：走既有的 `partial` 語意（`applySourceRound` 看到 partial/applicable=false 就整條跳過，
    // 不累加 fails），但還是會蓋 `lastAttemptAt` 的章，所以下一輪輪轉會換人、這家不會霸榜。
    let phaseTimedOut = false;
    let batches = [];
    try {
      batches = phaseBudgetMs > 0
        ? await withBudget(run, phaseBudgetMs, `${label}這一輪的外站階段`)
        : await run();
      throwIfCrawlCancelled();
      // 「沒有可抓的行政區」的批次（`applicable: false`）不進 collected、也不算成功，
      // 但要讓這一輪知道「這個來源這一輪不適用」，才不會被誤記成失敗。
      const applicableBatches = batches.filter((batch) => batch?.applicable !== false);
      if (!applicableBatches.length) sourceSuccess[sourceSuccess.length - 1].applicable = false;
      for (const batch of applicableBatches) {
        // 到達每輪上限的批次（partial）不算「這一組已完成」——其餘行政區下一輪才抓。
        if (!batch.errors?.length && batch.searchUrl && batch.partial !== true) successful.add(batch.searchUrl);
        for (const error of batch.errors || []) {
          const line = `${label} ${error.district || ""} 第 ${error.page || 1} 頁 [${error.code || "FETCH_FAILED"}]：${error.message}`;
          errors.push(line);
          sourceErrors.push(line);
        }
        if (batch.errors?.length && !batch.listings.length && batch.progress?.resetReason !== "PAGE_OUT_OF_RANGE") continue;
        collected.push(batch);
        if (batch.total > 0 && batch.listings.length === 0) {
          errors.push(`${batch.parsed.label}：有資料，但都被目前篩選排除了`);
        }
      }
    } catch (error) {
      // 整輪被砍／被新的一輪取代 ⇒ 立刻停手，逐頁 fail-soft 不可以吞掉取消（AGENTS 第三條）。
      if (isCrawlCancelled()) throw error;
      const abortedByOurOwnBudget = error?.code === "TIMEOUT" || error?.name === "TimeoutError"
        || error?.name === "AbortError" || /abort/i.test(String(error?.message || ""));
      if (abortedByOurOwnBudget) {
        phaseTimedOut = true;
        errors.push(`${label}：這一輪給這家的階段預算 ${Math.max(1, Math.round(phaseBudgetMs / 60000))} 分鐘用盡，先停手`
          + "（算「只跑了一半」，不算失敗；下一輪換一家，這家的 fails 不會一直累加）");
      } else {
        errors.push(`${label} → ${error.message}`);
        sourceErrors.push(error.message);
      }
    } finally {
      const interrupted = isCrawlCancelled();
      crawlTelemetry.log(`來源 ${label}：結束（${Date.now() - externalStartedAt}ms，行政區 ${successful.size}/${jobs.length}，頁 ${hbPages}${interrupted ? "，中斷" : ""}）`);
    }
    // 這一批是不是「被擋到停工」：只要有任一批次回報 blocked，就當這一家這一輪被擋。
    const applicable = batches.some((batch) => batch?.applicable !== false);
    const partial = phaseTimedOut || batches.some((batch) => batch?.partial === true);
    noteSourceRound(source, successful, sourceErrors, sourceRoundBlocked(batches), applicable, partial);
  }

  // 2026-10-08：外站改成跨輪輪轉（理由與算式見 `externalRotation.js` 檔首）。
  // 原本六家是**寫死順序依序跑**，但每家一輪要跑幾十個行政區×頁面、單頁逾時上限 8 秒，
  // 40 分鐘預算跑不完 5 家 ⇒ 排在後面的家每輪都被自己的取消訊號打死：正式站實測
  // 租租通／好房網 `fails=117`、`lastSuccessAt` 從未成功、`last_seen_at` 停在 2026-09-22。
  // 現在一輪只排 `CRAWL_EXTERNAL_SOURCES_PER_RUN` 家（預設 1），最久沒成功的先；
  // **延後不是一種失敗**（不對它呼叫 `noteSourceRound`），下一輪它會因為更餓而排前面。
  const externalTasks = [
    { id: "hbhousing", label: "住商", enabled: wantHb, invoke: () => fetchHbCoveringListings(jobs, {
      ...fetchOptions,
      pages: hbPages,
      postJson: options.hbPostJson,
    }) },
    { id: "sinyi", label: "信義", enabled: wantSinyi, invoke: () => fetchSinyiCoveringListings(jobs, {
      ...fetchOptions,
      pages: hbPages,
      postForm: options.sinyiPostForm,
    }) },
    { id: "houseprice", label: "5168", enabled: wantHp, invoke: () => fetchHpCoveringListings(jobs, {
      ...fetchOptions,
      pages: hbPages,
      getHtml: options.hpGetHtml,
      hasGeo: listingHasTrustedGeo,
    }) },
    { id: "ddroom", label: "租租通", enabled: wantDd, invoke: () => fetchDdCoveringListings(jobs, {
      ...fetchOptions,
      pages: hbPages,
      getJson: options.ddGetJson,
    }) },
    { id: "housefun", label: "好房網", enabled: wantHf, invoke: () => fetchHfCoveringListings(jobs, {
      ...fetchOptions,
      pages: hbPages,
      postForm: options.hfPostForm,
    }) },
    { id: "rakuya", label: "樂屋網", enabled: wantRakuya, invoke: async () => {
      repairRakuyaScopes(db, jobs);
      // 抓取游標與其他節點同源；PG 模式下讀本機 SQLite 會拿到別台的舊頁碼
      const startPages = await getRakuyaPageCursorsAsync();
      return fetchRakuyaCoveringListings(jobs, {
        ...fetchOptions,
        pages: hbPages,
        fetchText: options.rakuyaFetchText,
        startPages,
      });
    } },
  ];
  const externalRotation = pickExternalSources(
    externalTasks.filter((task) => task.enabled),
    sourceStreaks,
    { perRun: externalSourcesPerRun(process.env), cooling },
  );
  for (const task of externalRotation.running) {
    // 階段預算綁在「這一輪還剩多少」上（留 2 分鐘給輪尾收尾；不足 3 分鐘就整輪不碰外站）。
    // 2026-10-08 實測：一輪一家還是爆過預算——591 花 13 分鐘，5168 一家花掉 27 分鐘且零落地。
    const execution = currentCrawlExecution();
    const remainingMs = execution?.deadline ? execution.deadline - Date.now() : 0;
    // `options.externalPhaseBudgetMs` 是測試用的注入點（跟 `hbPostJson` 同一套做法）：
    // 離線測試要跑「階段預算用盡」這條路，等 3 分鐘實在是太慢。
    const phaseMs = Number(options.externalPhaseBudgetMs) > 0
      ? Number(options.externalPhaseBudgetMs)
      : externalPhaseBudgetMs({ remainingMs, env: process.env });
    if (!phaseMs) {
      console.log(`外站輪轉：這一輪剩 ${Math.max(0, Math.round(remainingMs / 1000))} 秒，不夠跑一家外站（至少 3 分鐘）`
        + `｜${externalRotation.running.length} 家全數延後（不算失敗，下一輪優先）`);
      break;
    }
    await collectExternal(task.id, task.label, task.invoke, phaseMs);
  }
  if (externalRotation.deferred.length) {
    console.log(
      `外站輪轉：本輪排 ${externalRotation.running.map((task) => task.id).join(",") || "（無）"}`
      + `｜延後 ${externalRotation.deferred.map((task) => task.id).join(",")}（不算失敗，下一輪優先）`,
    );
  }

  // 第九十二批：**先**把這一輪的來源成敗寫進 `crawlScheduleV1.sourceStreaks`，再決定誰會阻擋完成紀錄。
  // 判定放在這裡（收集階段之後、落地迴圈與 `!collected.length` 之前）有三個理由：
  //   1. 來源集合已經收齊，這一輪誰成功誰失敗已成定局；
  //   2. 全部來源都沒抓到東西的輪次也要累積失敗輪數（否則「永遠失敗」的來源不會被放行）；
  //   3. 落地迴圈裡的逐批完成記錄要用同一份容忍名單。
  // 記錄失敗時**維持從嚴**（不知道容忍名單就不放行），只留一則錯誤訊息。
  let sourcePolicy = { streaks: {}, tolerated: [], toleratedNow: [], recovered: [], failed: [] };
  if (sourceRounds.length) {
    try {
      sourcePolicy = await recordCrawlSourceRoundAsync({ rounds: sourceRounds, at: nowIso() });
    } catch (error) {
      errors.push(`來源連續失敗紀錄失敗（這一輪維持從嚴）：${error?.message || error}`);
    }
  }
  const sourceWarnings = sourceRoundWarnings(sourcePolicy, sourceRounds);
  for (const id of cooling) {
    sourceWarnings.push(`抓取來源「${crawlSourceLabel(id)}」上一輪被擋，這一輪仍在冷卻期（跳過這一家，讓對方的封鎖窗口過期）`);
  }
  for (const warning of sourceWarnings) console.warn(warning);

  if (!collected.length) {
    if (want591) {
      logRoundEnd({ jobs: jobs.length, skipped: "portals" });
      throw new Error(errors.join("；") || "591 搜尋沒有回傳資料");
    }
    logRoundEnd({ jobs: jobs.length, skipped: "portals" });
    return {
      checked_at: nowIso(),
      searches: [],
      events: [],
      errors,
      warnings: sourceWarnings,
      sources: sourceRounds,
      skipped: "portals",
      message: errors.join("；") || "外站這次沒抓到資料（可能被擋或暫時失敗）",
    };
  }

  const seen = new Set();
  const freshIds = [];
  const searchReports = [];

  // 第九十一批：**逐批記錄完成**。
  //
  // 為什麼：一輪的「取頁 ＋ 落地」在正式站要 25 分鐘上下，超過 `TICK_BUDGET_MS` 就會被
  // `withBudget()` 放棄；而完成紀錄（`lastCoveringAt`／`crawl_covers.last_run_at`／
  // `crawlScheduleV1.completed`）原本只在整輪結束時才寫 ⇒ 被放棄的輪次等於白跑，
  // 覆蓋條件永遠是「該抓了」，每輪重跑同一批（正式站 2026-09-27～09-30 的實際狀態：
  // `crawl_covers.last_run_at` 全部凍結、`attempts` 累積到近 3000）。
  //
  // 政策（第九十二批起）：只有「該 job 在**每一個還在嚴格的來源**都成功」才能記成完成。
  // 「還在嚴格」＝ 連續失敗還沒到門檻（`SOURCE_FAILURE_ROUNDS_BEFORE_TOLERATED`）；
  // 連續失敗達門檻的來源已被放行（見上方 `sourcePolicy`），但仍留 warning 與後台可見的狀態。
  // 安全閥：如果所有來源都被放行（等於全滅），`jobCoveredByBlockingSources()` 回 false ⇒
  // 這種輪次不會被當成「已覆蓋」。
  const jobBySearchUrl = new Map();
  for (const job of jobs || []) if (job?.searchUrl) jobBySearchUrl.set(job.searchUrl, job);
  const blockingSources = blockingCrawlSources(sourceSuccess, sourcePolicy.tolerated);
  const isCoveredJob = (job) => jobCoveredByBlockingSources(job, blockingSources);
  const successfulJobUrls = new Set(
    (jobs || []).filter((job) => isCoveredJob(job)).map((job) => job.searchUrl),
  );
  const recordedCoverUrls = new Set();

  // 取頁階段（整輪最久的一段）跑完就先記進度：輪次可能超過 15 分鐘，不能等整輪結束才更新，
  // 否則 isSystemCoveringDue() 在這段期間只會看到上一輪的舊時間（2026-09-24 事故）。
  await markCoveringProgressAsync({ at: nowIso(), includeSystem: plan.includeSystem === true });

  setCrawlPhase("落地");
  for (const batch of collected) {
    // 第九十六批追加：落地階段也要理會「整輪被 withBudget 放棄」。
    // 原本只有取頁階段會檢查，於是預算用盡後這一輪仍把上萬筆寫完（正式站實測 70 分鐘沒收尾），
    // 下一輪又開始 ⇒ 兩輪重疊、DB 連線與 CPU 互相排擠，收集階段被拖到 40 分鐘以上。
    // 被放棄的輪次留下的是「已落地的批次 ＋ 逐批完成紀錄」，其餘下一輪再抓。
    throwIfCrawlCancelled();
    const isSearchBaseline = (await listingCountForSearchAsync(batch.searchUrl)) === 0;
    searchReports.push({
      label: batch.parsed.label,
      href: batch.parsed.href,
      total: batch.total,
      fetched: batch.listings.length,
      baseline: isSearchBaseline,
      source: batch.parsed.source || batch.listings[0]?.source || "",
      stopReason: batch.parsed.stopReason || "",
      errors: batch.errors || [],
    });
    let upserts = 0;
    // 每批（≈ 每組覆蓋）落地後就更新一次進度，讓長輪次的節奏判定有依據。
    await markCoveringProgressAsync({ at: nowIso() });
    for (const listing of batch.listings) {
      if (seen.has(listing.post_id)) continue;
      // 每 20 筆檢查一次取消（用既有的 upserts 計數，成本可忽略）。
      if (upserts % 20 === 0) throwIfCrawlCancelled();
      seen.add(listing.post_id);

      // Awaited so change detection reads the same store persistListing() writes to
      // (crawlerReads.js). `siblings` and `candidates` are only needed when the row is new, and
      // they are what classify() would otherwise read synchronously from SQLite.
      const existing = await listingForWatchAsync(listing.post_id);
      let siblings = null;
      let candidates = null;
      if (!existing) {
        siblings = await watchSiblings(listing.source_key, listing.post_id);
        if (!siblings.length) candidates = await matchCandidatesAsync(listing.post_id, listing);
      }
      const { type, detail, prev, level, cost_change_type } = classify(listing, existing, siblings, candidates);
      const stamp = nowIso();
      await persistListing({
        ...listing,
        search_key: batch.searchUrl,
        first_seen_at: existing?.first_seen_at || stamp,
        last_seen_at: stamp,
        last_event: listingLastEvent(type, existing),
        ...costPatchFromClassify({ type, detail, cost_change_type }, listing, existing, prev, stamp),
      });
      upserts += 1;
      if (!existing) freshIds.push(listing.post_id);
      if (String(listing.source || "") === "houseprice") {
        await enqueueListingEnrichAsync(db, (await listingForWatchAsync(listing.post_id)) || listing, { via: "scheduler" });
      }
      if (upserts % 20 === 0) await yieldEventLoop();

      if (!existing && prev && (level === "high" || level === "medium")) {
        await setListingMatchAsync(listing.post_id, {
          match_post_id: prev.post_id,
          match_level: level,
          match_detail: detail,
        });
      } else if (existing && significantListingUpdate(existing, listing)) {
        try { await reconcileListingByIdAsync(listing.post_id, { reason: "significant_update" }); } catch { /* ignore */ }
      }
      if (!existing && prev) {
        const copied = await copyUserFlagsAsync(prev.post_id, listing.post_id);
        if (copied || prev.hidden || prev.viewed) {
          await setListingMatchAsync(listing.post_id, {
            match_post_id: prev.post_id,
            match_level: level || "high",
            match_detail: detail,
          });
        }
      }

      if (type === "seen" || isBaseline || isSearchBaseline) continue;

      // 非特別關注的內容微差（地址補齊來回等）不要進通知佇列
      const saved = (await listingForWatchAsync(listing.post_id)) || listing;
      // 5168 全新房源等資料準備完成再通知，避免舊庫回填大量「全新」
      if (type === "new" && String(saved.source || listing.source || "") === "houseprice") continue;
      const evt = { type, detail };
      await enqueueListingEventAsync(saved, evt);
    }

    // 這一批的物件都落地了 ⇒ 如果它的來源全部成功，立刻記錄「這組覆蓋條件已完成」。
    // 整輪若在後面的階段被 `withBudget()` 放棄，這筆紀錄仍然留著（見上方第九十一批說明）。
    if (successfulJobUrls.has(batch.searchUrl) && !recordedCoverUrls.has(batch.searchUrl)) {
      const job = jobBySearchUrl.get(batch.searchUrl);
      if (job) {
        recordedCoverUrls.add(batch.searchUrl);
        try {
          await completeCoveringPlan({ successfulJobs: [job], memberRequirements: [], at: nowIso() });
        } catch (error) {
          // 記錄失敗不該讓整輪掛掉（下一輪會再記一次）。
          errors.push(`${batch.searchUrl} → 覆蓋完成記錄失敗：${error?.message || error}`);
        }
      }
    }
  }

  // Only advance after those pages have been stored successfully.
  const rakuyaProgress = collected.filter(batch => batch.parsed.source === "rakuya"
    && (!batch.errors?.length || batch.progress?.resetReason === "PAGE_OUT_OF_RANGE"))
    .map(batch => batch.progress).filter(Boolean);
  if (rakuyaProgress.length) await saveRakuyaPageCursorsAsync(rakuyaProgress);

  if (needsListingGeo(settings) && freshIds.length > 0 && freshIds.length <= LIST_PAGE_SIZE) {
    await ingestListingGeoBatch(freshIds);
  }

  await resolvePendingNotifyLocations(settings, { withRoute: options.skipHeavyGeo !== true, ...options });

  setCrawlPhase("明細補抓");
  const pendingFees = await needingFeeDetailAsync({ limit: needsListingGeo(settings) ? 30 : 20 });
  for (const row of pendingFees) {
    try {
      const listing = await listingForWatchAsync(row.post_id);
      if (!listing) continue;
      const detail = await fetchListingDetail(row.post_id, detailOptions());
      await applyFetchedDetail(listing, detail);
    } catch (error) {
      if (isListingGoneError(error)) {
        const listing = await listingForWatchAsync(row.post_id);
        await markOfflineAndNotify(row.post_id, { wasOnline: !listing?.offline });
      }
      // 詳情失敗下次再試，不中斷本輪追蹤
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  const skipBlockedKit = new Set();
  setCrawlPhase("來源套件");
  const pendingSourceKit = await needingSourceKitAsync({ limit: 8 });
  for (const row of pendingSourceKit) {
    try {
      const listing = await listingForWatchAsync(row.post_id);
      if (!listing) continue;
      if (skipBlockedKit.has(listing.source)) continue;
      const kit = await fetchSourceKit(listing);
      const extraFees = Array.isArray(kit.extra_fees)
        ? mergeFeeRows(listing.extra_fees, kit.extra_fees)
        : listing.extra_fees;
      await setListingDetailAsync(listing.post_id, {
        extraFees,
        fetched: Array.isArray(kit.extra_fees) && kit.extra_fees.length
          ? 1
          : listing.extra_fees_fetched,
        has_natural_gas: kit.has_natural_gas,
        has_balcony: kit.has_balcony,
        furnish_items: kit.furnish_items,
        kit_fetched: 1,
      });
    } catch (error) {
      if (error?.code === "FETCH_BLOCKED") skipBlockedKit.add(row.source);
      await markSourceKitRetryAsync(row.post_id, {
        error: error?.code || error?.message || "kit_failed",
        delayMs: error?.code === "FETCH_BLOCKED" ? 60 * 60 * 1000 : 15 * 60 * 1000,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  setCrawlPhase("通知");
  const events = options.silent ? [] : await flushPendingNotifications(settings, { silent: options.silent });
  if (settings.hasBaseline !== true) {
    await saveSettingsAsync({ hasBaseline: true });
  }
  // 整輪完成的紀錄（lastCoveringAt／lastSystemCoveringAt ＋ crawl_covers.last_run_at）要走 driver-aware
  // 入口：只寫 SQLite 的話，PG 模式的「該抓了」判定永遠讀到舊值 → 每分鐘重跑一整輪（2026-09-24 事故）。
  // A partial source failure is not a successful cover. Be conservative until every source that is
  // still strict reports success; tolerated (long-failing) sources no longer block, but they always
  // leave a warning. Never postpone unprocessed members.
  setCrawlPhase("完成記錄");
  await completeCoveringPlan({
    successfulJobs: jobs.filter((job) => isCoveredJob(job)),
    memberRequirements: plan.memberRequirements,
    at: nowIso(),
  });

  const result = {
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
    // 第九十二批：輪次結果要能看出「哪個來源失敗、連續幾輪、有沒有被放行」。
    warnings: sourceWarnings,
    sources: sourceRounds.map((round) => ({
      ...round,
      fails: Number(sourcePolicy.streaks?.[round.source]?.fails) || 0,
      tolerated: sourcePolicy.tolerated.includes(round.source),
      applicable: round.applicable !== false,
      partial: round.partial === true,
      lastError: sourcePolicy.streaks?.[round.source]?.lastError || "",
    })),
    offline: offlineSweep,
    checked_at: nowIso(),
  };
  logRoundEnd({ fetched: seen.size, covered: recordedCoverUrls.size, jobs: jobs.length, skipped: result.skipped });
  return result;
}

export async function backfillListingCoords(settings = null, { limit = LIST_PAGE_SIZE, ...options } = {}) {
  // PG 模式下 `getSettings()` 讀的是節點本機 ⇒ 預設值改成向 PG 問（`getSettingsAsync`）。
  settings = settings || await getSettingsAsync(0, options);
  if (!needsListingGeo(settings) || limit <= 0) return { attempted: 0, located: 0 };
  const rows = await needing591GeoAsync({ limit });
  return ingestListingGeoBatch(rows.map((row) => row.post_id));
}

const routeInflight = new Set();

// 鍵的算法只有一份（db.js `routeJobKeyFor`）：同步與 PG 兩條路徑不可以各算各的，
// 否則 route_jobs 會出現兩列同義的鍵。
const routeJobKey = (row, direction, kind) => routeJobKeyFor(row, direction, kind);

// ⚠️ 三個寫入都走 PG 島嶼（`routeCacheAsync.js`）：同步版在 PG 模式下把剛算好的路線寫進
// **節點本機**，而卡片是從 PG 讀的 ⇒ 不論補幾輪，通勤欄位都算不出來（而且沒有錯誤訊息）。
async function markRouteJob(row, direction, kind, patch, options = {}) {
  await markRouteJobAsync(row, direction, kind, patch, options);
}

async function writeCachedRoute(fromLat, fromLng, toLat, toLng, distances, rush, mode, direction = "to_work", options = {}) {
  for (let tryNo = 0; tryNo < 4; tryNo += 1) {
    try {
      const result = await setCachedRouteAsync(fromLat, fromLng, toLat, toLng, distances, rush, mode, direction, options);
      return Boolean(result?.ok);
    } catch (error) {
      if (!String(error.message || "").includes("locked") || tryNo === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 400 * (tryNo + 1)));
    }
  }
  return false;
}

async function finishRouteAttempt(row, direction, kind, reason, options = {}) {
  const key = routeJobKey(row, direction, kind);
  routeInflight.delete(key);
  await finishRouteAttemptAsync(row, direction, kind, reason, options);
}

export async function backfillListingRoutes(settings = null, { limit = 20, priorityIds = [], ...options } = {}) {
  settings = settings || await getSettingsAsync(0, options);
  const fallback = commuteWorkJobs([settings, ...collectCommuteSettings()])[0];
  if (limit <= 0) return { attempted: 0, located: 0, listings: [], postIds: [] };
  const rows = (await needingRouteAsync({ limit, priorityIds })).filter((row) => {
    const key = routeJobKey(row, "to_work", "distance");
    return !routeInflight.has(key);
  });
  if (!rows.length && !(fallback || (Number(settings.commuteKm) > 0 && hasWorkPoint(settings)))) {
    return { attempted: 0, located: 0, listings: [], postIds: [] };
  }
  let attempted = 0;
  let located = 0;
  const locatedIds = [];
  const wantRush = (await commuteRushEnabledAsync(options)) && googleDirectionsAllowed();
  const groups = new Map();
  for (const row of rows) {
    const workLat = Number(row.workLat || settings.workLat || fallback?.workLat);
    const workLng = Number(row.workLng || settings.workLng || fallback?.workLng);
    const mode = normalizeCommuteMode(row.commuteMode || settings.commuteMode || fallback?.commuteMode);
    if (!Number.isFinite(workLat) || !Number.isFinite(workLng)) {
      finishRouteAttempt({ ...row, workLat, workLng, commuteMode: mode }, "to_work", "distance", "no_coords");
      continue;
    }
    const next = { ...row, workLat, workLng, commuteMode: mode };
    const key = `${workLat}|${workLng}|${mode}`;
    if (!groups.has(key)) groups.set(key, { workLat, workLng, mode, rows: [] });
    groups.get(key).rows.push(next);
  }
  for (const group of groups.values()) {
    const basics = group.rows.filter((row) => row.needBasic !== false);
    for (const row of basics) {
      const key = routeJobKey(row, "to_work", "distance");
      routeInflight.add(key);
      markRouteJob(row, "to_work", "distance", { job_state: COMMUTE_STATES.COMPUTING });
    }
    if (basics.length) {
      const hits = await fetchRoadRouteTable(group.workLat, group.workLng, basics, { direction: "to_work" });
      for (const hit of hits) {
        attempted += 1;
        const row = { ...hit, workLat: group.workLat, workLng: group.workLng, commuteMode: group.mode };
        if (hit.busy) {
          finishRouteAttempt(row, "to_work", "distance", "busy");
          continue;
        }
        if (hit.distances?.length && await writeCachedRoute(hit.lat, hit.lng, group.workLat, group.workLng, hit.distances, null, group.mode, "to_work")) {
          routeInflight.delete(routeJobKey(row, "to_work", "distance"));
          markRouteJob(row, "to_work", "distance", { job_state: COMMUTE_STATES.DONE, fail_reason: "", next_retry_at: "" });
          located += 1;
          locatedIds.push(row.post_id);
        } else if (hit.distances?.length) {
          finishRouteAttempt(row, "to_work", "distance", "error");
        } else {
          finishRouteAttempt(row, "to_work", "distance", "no_route");
        }
      }
    }
    const returns = group.rows.filter((row) => row.needReturn !== false);
    if (returns.length) {
      const hits = await fetchRoadRouteTable(group.workLat, group.workLng, returns, { direction: "from_work" });
      for (const hit of hits) {
        if (hit.distances?.length) {
          await writeCachedRoute(group.workLat, group.workLng, hit.lat, hit.lng, hit.distances, null, group.mode, "from_work");
          if (!locatedIds.includes(hit.post_id)) locatedIds.push(hit.post_id);
        }
      }
    }
    if (wantRush) {
      for (const row of group.rows) {
        if (row.needRush === false) continue;
        const rushKey = routeJobKey(row, "to_work", "rush");
        if (routeInflight.has(rushKey)) continue;
        routeInflight.add(rushKey);
        markRouteJob(row, "to_work", "rush", { job_state: COMMUTE_STATES.COMPUTING });
        const rush = await fetchRushRoadRoutes(row.lat, row.lng, group.workLat, group.workLng, { mode: group.mode });
        routeInflight.delete(rushKey);
        if (rush && (rush.distances?.length || rush.rushAm != null || rush.rushPm != null)) {
          await writeCachedRoute(row.lat, row.lng, group.workLat, group.workLng, rush.distances || [row.route_km].filter(Boolean), rush, group.mode, "to_work");
          markRouteJob(row, "to_work", "rush", { job_state: COMMUTE_STATES.DONE, fail_reason: "", next_retry_at: "" });
          if (!locatedIds.includes(row.post_id)) locatedIds.push(row.post_id);
        } else {
          finishRouteAttempt(row, "to_work", "rush", "busy");
        }
      }
    }
  }
  const patchSettings = {
    ...settings,
    commuteKm: Number(settings.commuteKm) > 0 ? settings.commuteKm : 1,
  };
  // 通勤 patch 走 PG 島嶼（第七十六批）：PG 模式下列表在 PG，同步版讀本機 ⇒ PG 才有的刊登
  // 一律是 `null`（接著廣播出去的 `commute_updated` 就是空的）。`userId: null` 在兩邊都代表
  // 「預設帳號」，PG 版會向 PG 問（`defaultUserIdAsync`）。
  const patchIds = [...new Set([...locatedIds, ...rows.map((row) => row.post_id)])];
  const listings = (await listingCommutePatchesAsync(patchIds, null, { settings: patchSettings, ...options }))
    .filter(Boolean);
  return {
    attempted,
    located,
    listings,
    postIds: [...new Set(locatedIds)],
    fingerprint: commuteSettingsFingerprint(patchSettings),
  };
}

export async function backfillAddressGeo(settings = null, { limit = 12, ...options } = {}) {
  settings = settings || await getSettingsAsync(0, options);
  if (!needsListingGeo(settings) || limit <= 0) return { attempted: 0, located: 0 };
  const rows = await needingAddressGeoAsync({ limit });
  let attempted = 0;
  let located = 0;
  for (const row of rows) {
    attempted += 1;
    try {
      if (geoFailReason(row.address)) continue;
      // 快取與 listings 的座標都要走 driver-aware 入口（PG 模式下寫本機 SQLite 等於沒回填）。
      const hit = await geocodeAddress(row.address, (key) => getCachedGeoAsync(key), { fast: true, budgetMs: 5000, maxExternal: 1, strict: false });
      if (hit?.busy) continue;
      if (hit && Number.isFinite(Number(hit.lat)) && Number.isFinite(Number(hit.lng))) {
        await setCachedGeoAsync(row.address, hit.lat, hit.lng, hit);
        if (hit.location_class === "street") {
          const streetKey = streetCacheKey(parseTaiwanAddressParts(row.address));
          if (streetKey) await setCachedGeoAsync(streetKey, hit.lat, hit.lng, { ...hit, cache_kind: "street" });
        }
        await updateListingsGeoByAddressAsync(row.address, hit.lat, hit.lng, hit);
        located += 1;
      }
    } catch {
      // 定位失敗就留給下一輪
    }
  }
  return { attempted, located };
}

export async function backfillIncompleteAddresses({ limit = 8 } = {}) {
  const hp = await processListingEnrichBatch(db, listingEnrichHelpers(), { limit: Math.min(8, limit) });
  const rows = await needingAddressEnrichAsync({ limit: Math.max(0, limit - (hp.processed || 0)) });
  if (!rows.length && !hp.attempted) return { attempted: 0, located: 0, processed: 0, updated: 0 };
  let attempted = hp.attempted || 0;
  let located = hp.located || 0;
  let updated = hp.updated || 0;
  for (const row of rows) {
    attempted += 1;
    try {
      const current = await listingForWatchAsync(row.post_id);
      if (!current) continue;
      if (row.source === "591") {
        const detail = await fetchListingDetail(row.source_id || row.post_id, detailOptions());
        if (!detail?.address) continue;
        const saved591 = await applyFetchedDetail(current, detail);
        if (saved591?.address && saved591.address !== current.address) {
          located += 1;
          updated += 1;
        }
        continue;
      }
      if (row.source === "ddroom") {
        const object = await fetchDdObject(row.source_id || row.url);
        if (!object) continue;
        const next = enrichDdListingFromObject(current, object);
        if (next.address !== current.address || next.floor_name !== current.floor_name || next.lat !== current.lat) {
          await persistListing({ ...next, last_seen_at: current.last_seen_at || nowIso() });
          updated += 1;
          if (next.lat != null && next.lng != null) located += 1;
        }
        continue;
      }
      if (row.source === "rakuya") {
        const detail = await fetchRakuyaDetail(current);
        if (!detail) continue;
        const next = {
          ...current,
          address: detail.address || current.address,
          floor_name: detail.floorName || current.floor_name,
          area_name: detail.areaName || current.area_name,
          layout: detail.layout || current.layout,
          kind_name: detail.kind || current.kind_name,
          has_natural_gas: detail.has_natural_gas,
          has_balcony: detail.has_balcony,
          furnish_items: detail.furnish_items,
          lat: detail.lat ?? current.lat,
          lng: detail.lng ?? current.lng,
        };
        if (next.address !== current.address || next.floor_name !== current.floor_name || next.lat !== current.lat) {
          await persistListing({ ...next, last_seen_at: current.last_seen_at || nowIso() });
          updated += 1;
          if (next.lat != null && next.lng != null) located += 1;
        }
      }
    } catch {
      // 明細暫時抓不到就下一輪
    }
  }
  return { attempted, located, processed: attempted, updated, hp };
}

export async function backfillListingMrt({ limit = 20 } = {}) {
  const rows = await needingMrtAsync({ limit });
  if (!rows.length) return { attempted: 0, located: 0 };
  let attempted = 0;
  let located = 0;
  for (const row of rows) {
    attempted += 1;
    const access = await fetchMrtAccess(row.lat, row.lng);
    if (access?.pending) continue;
    if (access?.resolved) {
      await setCachedMrtAsync(row.lat, row.lng, access);
      located += 1;
    }
  }
  return { attempted, located };
}
