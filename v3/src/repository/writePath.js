// Hot-path write adapters (PostgreSQL hot path, write side).
//
// The list path READS `user_listing_flags` / `route_cache` / `route_jobs` through
// repository/decorationData.js. Their WRITES still lived inside db.js and personalFlags.js bound
// to a synchronous node:sqlite handle. Reading on PostgreSQL while writing on SQLite would let the
// two stores diverge, so this module re-states those statements against an injected executor: the
// same SQL text runs on either driver (the PostgreSQL executor translates `?` -> `$n` and the
// SQLite-only functions through sqlDialect).
//
// The statement text is copied verbatim from the SQLite implementations (same columns, same
// conflict targets, same CASE expressions). test/write-path-parity.test.js asserts that the same
// payload produces identical rows on both drivers.
import { toPostgresSql } from "../sqlDialect.js";
import { listingCommunityId, preferListingAddress, sourceCommunityLinked, sqlTrustedGeoSource } from "../location.js";
import { sanitizeFloorName } from "../floors.js";
import { listingKitFrom, mergeKitColumns } from "../listingKit.js";
import {
  bindProjectionValues,
  computeListingProjection,
  listingProjectionUpsertSql,
} from "../listingSearchProjection.js";
import { bindFoldColumnValues, computeFoldColumns, foldColumnsUpdateSql } from "../match.js";
import { applyListingTotalsDelta, listingUpsertDelta, listingsUpsertRowImpactSql } from "../listingTotalsPgWrite.js";
import { DEFAULT_LISTING_TOTALS_BUCKET } from "../listingTotalsPgSchema.js";

// 同屋源折疊的比較輸入固化欄（讀取端 SQL 折疊用，見 docs/same-house-fold-spec.md §4.2）。
// nullable、無 default ⇒ 加欄為 metadata-only；值由 computeFoldColumns 以既有解析函式算。
export function foldColumnsDdlStatements() {
  return [
    "ALTER TABLE listings ADD COLUMN IF NOT EXISTS fold_rent_num double precision",
    "ALTER TABLE listings ADD COLUMN IF NOT EXISTS fold_refresh_kind smallint",
    "ALTER TABLE listings ADD COLUMN IF NOT EXISTS fold_refresh_rel_ms bigint",
    "ALTER TABLE listings ADD COLUMN IF NOT EXISTS fold_refresh_abs_ms bigint",
  ];
}

// 591 詳情帶回來的絕對發佈時間（ISO 字串，`client591.sourcePublishedAtFromDetail`）。
// 讀取端本來就引用這個欄名（db.js `listingEffectiveUpdatedAt`、listingSearchProjection.js），
// 所以補欄只是把原設計接回來；既有列補欄後是 NULL／空字串 ⇒ 讀取端照舊退回下一個時間來源。
// PG 的 listings 是既有表，`pgSchema.js` 只做 CREATE、沒有 ALTER ⇒ 要在第一次寫入前冪等補欄，
// 否則 upsert／詳情 UPDATE 會以 42703 整批失敗（同 fold_* 欄的理由）。
export function sourcePublishedAtDdlStatements() {
  return ["ALTER TABLE listings ADD COLUMN IF NOT EXISTS source_published_at text"];
}

// 同一條 DDL 的冪等入口（WeakSet 記在 driver 上 ⇒ 同一行程只跑一輪）。時機：任何會寫這個欄位的
// 路徑在第一次寫入前呼叫一次。
const sourcePublishedAtReady = new WeakSet();
export async function ensureSourcePublishedAtOnce(pgDriver) {
  if (!pgDriver || sourcePublishedAtReady.has(pgDriver)) return;
  for (const statement of sourcePublishedAtDdlStatements()) await pgDriver.exec(statement);
  sourcePublishedAtReady.add(pgDriver);
}

// SQLite 版冪等 DDL：SQLite 不支援 `ADD COLUMN IF NOT EXISTS`，用 PRAGMA table_info 判斷。
// 讓 fold_* 在兩個 driver 上都存在（PG 鏡射 SQLite schema 的 parity／integration 測試需要它）。
export function ensureFoldColumnsSqlite(sqliteDb) {
  const cols = new Set(sqliteDb.prepare("PRAGMA table_info(listings)").all().map((r) => r.name));
  const ddl = [];
  if (!cols.has("fold_rent_num")) ddl.push("ALTER TABLE listings ADD COLUMN fold_rent_num REAL");
  if (!cols.has("fold_refresh_kind")) ddl.push("ALTER TABLE listings ADD COLUMN fold_refresh_kind INTEGER");
  if (!cols.has("fold_refresh_rel_ms")) ddl.push("ALTER TABLE listings ADD COLUMN fold_refresh_rel_ms INTEGER");
  if (!cols.has("fold_refresh_abs_ms")) ddl.push("ALTER TABLE listings ADD COLUMN fold_refresh_abs_ms INTEGER");
  for (const sql of ddl) sqliteDb.exec(sql);
  return ddl.length;
}

export const WRITE_PATH_SQL = {
  // personalFlags.js setUserListingFlags()
  upsertPersonalFlags: `INSERT INTO user_listing_flags (
       user_id, post_id, viewed, watched, hidden, watch_note, viewed_at, watched_at, hidden_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, post_id) DO UPDATE SET
       viewed = excluded.viewed,
       watched = excluded.watched,
       hidden = excluded.hidden,
       watch_note = excluded.watch_note,
       viewed_at = CASE
         WHEN excluded.viewed = 1 THEN COALESCE(user_listing_flags.viewed_at, excluded.viewed_at)
         ELSE user_listing_flags.viewed_at
       END,
       watched_at = CASE
         WHEN excluded.watched = 1 AND IFNULL(user_listing_flags.watched, 0) = 0 THEN excluded.watched_at
         WHEN excluded.watched = 1 THEN COALESCE(user_listing_flags.watched_at, excluded.watched_at)
         ELSE user_listing_flags.watched_at
       END,
       hidden_at = CASE
         WHEN excluded.hidden = 1 THEN COALESCE(user_listing_flags.hidden_at, excluded.hidden_at)
         ELSE user_listing_flags.hidden_at
       END`,
  // db.js setCachedRoute() - the rush-aware and the plain variant
  upsertRouteCacheWithRush: `INSERT INTO route_cache(route_key, distances, min_km, min_m, updated_at, rush_am_min, rush_pm_min, rush_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(route_key) DO UPDATE SET
         distances = excluded.distances,
         min_km = excluded.min_km,
         min_m = excluded.min_m,
         updated_at = excluded.updated_at,
         rush_am_min = excluded.rush_am_min,
         rush_pm_min = excluded.rush_pm_min,
         rush_updated_at = excluded.rush_updated_at`,
  upsertRouteCache: `INSERT INTO route_cache(route_key, distances, min_km, min_m, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(route_key) DO UPDATE SET
         distances = excluded.distances,
         min_km = excluded.min_km,
         min_m = excluded.min_m,
         updated_at = excluded.updated_at`,
  // db.js upsertRouteJob()
  upsertRouteJob: `INSERT INTO route_jobs(job_key, post_id, direction, kind, commute_mode, work_lat, work_lng, job_state, fail_reason, attempts, next_retry_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_key) DO UPDATE SET
       job_state = excluded.job_state,
       fail_reason = excluded.fail_reason,
       attempts = excluded.attempts,
       next_retry_at = excluded.next_retry_at,
       updated_at = excluded.updated_at,
       work_lat = excluded.work_lat,
       work_lng = excluded.work_lng`,
};

// The listings row upsert, copied from db.js upsertListing(). test/upsert-listing-write.test.js
// captures the SQL the production path actually sends and asserts that this text matches it after
// whitespace normalisation, so a transcription slip cannot survive the suite.
export function listingsUpsertSql() {
  return `INSERT INTO listings (
      post_id, source_key, search_key, title, url, price, price_num, extra_fee, extra_fee_text,
      price_contain_text, extra_fees, extra_fees_fetched, address, area_name,
      layout, floor_name, kind_name, role_name, cover, tags, refresh_time,
      first_seen_at, last_seen_at, last_event, viewed, watched, lat, lng,
      community_id, community_name, community_linked, cost_changed_at, cost_change_type, cost_change_detail,
      source_published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(post_id) DO UPDATE SET
      source_key = excluded.source_key,
      search_key = excluded.search_key,
      title = excluded.title,
      url = excluded.url,
      price = CASE WHEN IFNULL(excluded.price, '') != '' THEN excluded.price ELSE listings.price END,
      price_num = CASE WHEN excluded.price_num > 0 THEN excluded.price_num ELSE listings.price_num END,
      extra_fee = excluded.extra_fee,
      extra_fee_text = CASE WHEN IFNULL(excluded.extra_fee_text, '') != '' THEN excluded.extra_fee_text ELSE listings.extra_fee_text END,
      price_contain_text = CASE WHEN IFNULL(excluded.price_contain_text, '') != '' THEN excluded.price_contain_text ELSE listings.price_contain_text END,
      extra_fees = CASE
        WHEN listings.extra_fees_fetched = 1 AND IFNULL(listings.extra_fees, '') NOT IN ('', '[]')
        THEN listings.extra_fees
        ELSE excluded.extra_fees
      END,
      address = CASE
        WHEN IFNULL(excluded.address, '') != '' THEN excluded.address
        ELSE listings.address
      END,
      area_name = CASE WHEN IFNULL(excluded.area_name, '') != '' THEN excluded.area_name ELSE listings.area_name END,
      layout = CASE WHEN IFNULL(excluded.layout, '') != '' THEN excluded.layout ELSE listings.layout END,
      floor_name = CASE WHEN IFNULL(excluded.floor_name, '') != '' THEN excluded.floor_name ELSE listings.floor_name END,
      kind_name = CASE WHEN IFNULL(excluded.kind_name, '') != '' THEN excluded.kind_name ELSE listings.kind_name END,
      role_name = CASE WHEN IFNULL(excluded.role_name, '') != '' THEN excluded.role_name ELSE listings.role_name END,
      cover = CASE WHEN IFNULL(excluded.cover, '') != '' THEN excluded.cover ELSE listings.cover END,
      tags = excluded.tags,
      refresh_time = CASE WHEN IFNULL(excluded.refresh_time, '') != '' THEN excluded.refresh_time ELSE listings.refresh_time END,
      last_seen_at = excluded.last_seen_at,
      last_event = CASE
        WHEN IFNULL(listings.offline, 0) = 1 AND excluded.last_event IN ('seen', 'offline', '') THEN 'same_source'
        ELSE excluded.last_event
      END,
      last_checked_at = excluded.last_seen_at,
      offline = 0,
      offline_at = NULL,
      offline_confirmed = 0,
      lat = CASE
        WHEN ${sqlTrustedGeoSource("listings.geo_source")} THEN listings.lat
        ELSE COALESCE(excluded.lat, listings.lat)
      END,
      lng = CASE
        WHEN ${sqlTrustedGeoSource("listings.geo_source")} THEN listings.lng
        ELSE COALESCE(excluded.lng, listings.lng)
      END,
      community_id = CASE
        WHEN excluded.community_id > 0 THEN excluded.community_id
        ELSE listings.community_id
      END,
      community_name = CASE
        WHEN IFNULL(excluded.community_name, '') != '' THEN excluded.community_name
        ELSE listings.community_name
      END,
      community_linked = CASE
        WHEN excluded.community_linked > 0 OR excluded.community_id > 0 THEN 1
        ELSE listings.community_linked
      END,
      cost_changed_at = CASE
        WHEN IFNULL(excluded.cost_changed_at, '') != '' THEN excluded.cost_changed_at
        ELSE listings.cost_changed_at
      END,
      cost_change_type = CASE
        WHEN IFNULL(excluded.cost_change_type, '') != '' THEN excluded.cost_change_type
        ELSE listings.cost_change_type
      END,
      cost_change_detail = CASE
        WHEN IFNULL(excluded.cost_change_detail, '') != '' THEN excluded.cost_change_detail
        ELSE listings.cost_change_detail
      END,
      source_published_at = CASE
        WHEN IFNULL(excluded.source_published_at, '') != '' THEN excluded.source_published_at
        ELSE listings.source_published_at
      END`;
}

// Parameter order of the statement above (db.js upsertListing().run(...)). `existing` is the
// pre-read row the production path uses for preferListingAddress()/sanitizeFloorName() fallbacks.
export function listingsUpsertParams(listing, existing = null) {
  const extraFees = typeof listing.extra_fees === "string" ? listing.extra_fees : JSON.stringify(listing.extra_fees || []);
  const communityId = Number(listing.community_id) || listingCommunityId(listing) || 0;
  const communityName = String(listing.community_name || "").trim();
  const communityLinked = sourceCommunityLinked({
    communityId,
    hasAnchor: Number(listing.community_linked) === 1,
  }) ? 1 : 0;
  const address = preferListingAddress(listing.address, existing?.address, existing?.geo_source);
  const floorName = sanitizeFloorName(listing.floor_name) || sanitizeFloorName(existing?.floor_name) || "";
  return [
    listing.post_id,
    listing.source_key,
    listing.search_key || "",
    listing.title,
    listing.url,
    listing.price,
    listing.price_num,
    Number(listing.extra_fee) || 0,
    listing.extra_fee_text || "",
    listing.price_contain_text || "",
    extraFees,
    Number(listing.extra_fees_fetched) || 0,
    address,
    listing.area_name,
    listing.layout,
    floorName,
    listing.kind_name,
    listing.role_name,
    listing.cover,
    listing.tags,
    listing.refresh_time,
    listing.first_seen_at,
    listing.last_seen_at,
    listing.last_event,
    listing.lat ?? null,
    listing.lng ?? null,
    communityId,
    communityName,
    communityLinked,
    String(listing.cost_changed_at || "").trim(),
    String(listing.cost_change_type || "").trim(),
    String(listing.cost_change_detail || "").trim(),
    String(listing.source_published_at || "").trim(),
  ];
}

// 與 `listingsUpsertSql()` **同一句話**，只在尾端接上 `RETURNING`：讓 PostgreSQL 直接回答
// 「這一列是新增（`xmax = 0`）還是 `ON CONFLICT DO UPDATE`」以及它落在哪一個 fixture 桶。
//
// 為什麼不用既有的前置 SELECT（`existing`）：那個讀取與 upsert 之間有競態，且 `existing`
// 是**舊**的狀態；`xmax = 0` 是 upsert 這一句自己在同一個交易裡給的答案。
// `COALESCE(...)` 之後再把 `''`（＝非 fixture）也正規化一次的判斷留在 JS 端
//（`listingUpsertDelta()`），SQL 只負責回報事實。
export function listingsUpsertWithImpactSql() {
  return `${listingsUpsertSql()}\n    RETURNING (xmax = 0) AS inserted, COALESCE(fixture_namespace, '') AS fixture_namespace`;
}

function createExecutor({ driver, sqliteDb, pgDriver }) {
  if (driver === "postgres") {
    if (!pgDriver) throw new Error("createWritePath(postgres) requires pgDriver");
    const query = (sql, params = []) => pgDriver.query(toPostgresSql(sql), params);
    return {
      run: (sql, params = []) => query(sql, params),
      one: async (sql, params = []) => (await query(sql, params)).rows[0] ?? null,
    };
  }
  if (!sqliteDb) throw new Error("createWritePath(sqlite) requires sqliteDb");
  return {
    run: (sql, params = []) => sqliteDb.prepare(sql).run(...params),
    one: (sql, params = []) => sqliteDb.prepare(sql).get(...params) ?? null,
  };
}

const int = (value) => (Number(value) ? 1 : 0);
const text = (value) => (value == null ? null : String(value));
// Number(null) is 0, so "not provided" must be detected before the numeric coercion - otherwise a
// missing minimum would be stored as 0 and distance ordering would silently break.
const provided = (value) => value != null && value !== "";
const finite = (value) => (provided(value) && Number.isFinite(Number(value)) ? Number(value) : null);

export function createWritePath({ driver = "sqlite", sqliteDb = null, pgDriver = null } = {}) {
  const io = createExecutor({ driver, sqliteDb, pgDriver });
  const exec = io.run;
  return {
    driver,
    // Mirrors personalFlags.setUserListingFlags(): the caller decides the stamped values.
    async upsertPersonalFlags({
      userId,
      postId,
      viewed = 0,
      watched = 0,
      hidden = 0,
      watchNote = "",
      viewedAt = null,
      watchedAt = null,
      hiddenAt = null,
    } = {}) {
      await exec(WRITE_PATH_SQL.upsertPersonalFlags, [
        Number(userId) || 0,
        Number(postId) || 0,
        int(viewed),
        int(watched),
        int(hidden),
        String(watchNote || ""),
        text(viewedAt),
        text(watchedAt),
        text(hiddenAt),
      ]);
    },
    // Mirrors db.js setCachedRoute(): distances is stored as JSON text, min_m falls back to the
    // smallest distance when the caller has no measured minimum.
    async upsertRouteCache({ routeKey, distances = [], minKm = null, minM = null, rush = null, updatedAt = null } = {}) {
      const key = String(routeKey || "");
      if (!key) throw new Error("upsertRouteCache requires routeKey");
      const list = (Array.isArray(distances) ? distances : []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (!list.length) return;
      const stamp = updatedAt || new Date().toISOString();
      const min = provided(minKm) && Number.isFinite(Number(minKm)) ? Number(minKm) : Math.min(...list);
      const metres = provided(minM) && Number.isFinite(Number(minM)) ? Number(minM) : Math.round(min * 1000);
      const am = finite(rush?.am ?? rush?.rushAm);
      const pm = finite(rush?.pm ?? rush?.rushPm);
      if (am != null && pm != null) {
        await exec(WRITE_PATH_SQL.upsertRouteCacheWithRush, [key, JSON.stringify(list), min, metres, stamp, am, pm, stamp]);
        return;
      }
      await exec(WRITE_PATH_SQL.upsertRouteCache, [key, JSON.stringify(list), min, metres, stamp]);
    },
    // Mirrors db.js upsertRouteJob().
    async upsertRouteJob({
      jobKey,
      postId = 0,
      direction = "to_work",
      kind = "distance",
      commuteMode = "scooter",
      workLat = null,
      workLng = null,
      jobState = "wait_route",
      failReason = "",
      attempts = 0,
      nextRetryAt = "",
      updatedAt = null,
    } = {}) {
      const key = String(jobKey || "");
      if (!key) throw new Error("upsertRouteJob requires jobKey");
      await exec(WRITE_PATH_SQL.upsertRouteJob, [
        key,
        Number(postId) || 0,
        String(direction || "to_work"),
        String(kind || "distance"),
        String(commuteMode || "scooter"),
        finite(workLat),
        finite(workLng),
        String(jobState || "wait_route"),
        String(failReason || ""),
        Number(attempts) || 0,
        String(nextRetryAt || ""),
        updatedAt || new Date().toISOString(),
      ]);
    },
    // Mirrors db.js upsertListing()'s core step: the pre-read of the existing row (used for the
    // preferListingAddress()/sanitizeFloorName() fallbacks) followed by the listings row upsert.
    // The DB-side follow-ups (source/source_id backfill, kit columns, projection sync, revision
    // bump) are separate steps and are not part of this adapter yet.
    async upsertListingRow(listing) {
      const postId = Number(listing?.post_id) || 0;
      if (!postId) throw new Error("upsertListingRow requires listing.post_id");
      let existing = null;
      try {
        existing = await io.one(
          "SELECT address, geo_source, floor_name, has_natural_gas, has_balcony, furnish_items FROM listings WHERE post_id = ?",
          [postId],
        );
      } catch {
        try {
          existing = await io.one("SELECT address, geo_source, floor_name FROM listings WHERE post_id = ?", [postId]);
        } catch {
          existing = null;
        }
      }
      const params = listingsUpsertParams(listing, existing);
      if (driver !== "postgres") {
        await exec(listingsUpsertSql(), params);
        // The pre-read row is handed back so the caller can mirror db.js upsertListing()'s
        // "listing_added" vs "listing_updated" change-log entry and the kit-column merge.
        return existing;
      }
      // PostgreSQL：同一句 upsert 直接回報「這列是新增還是命中既有列」（`xmax = 0`）。
      // `dbTotal` 的同交易精準計數器就靠這個答案決定 +1／0，不需要多一次往返，
      // 而且是**同一個 statement** 在同一個交易內回答的（不是先 SELECT 再 INSERT 的競態）。
      const applied = await exec(listingsUpsertWithImpactSql(), params);
      await applyListingTotalsDelta(pgDriver, {
        bucketKey: DEFAULT_LISTING_TOTALS_BUCKET,
        delta: listingUpsertDelta(applied?.rows?.[0] ?? null),
        now: Date.now(),
      });
      // The pre-read row is handed back so the caller can mirror db.js upsertListing()'s
      // "listing_added" vs "listing_updated" change-log entry and the kit-column merge.
      return existing;
    },
    // Mirrors the follow-up UPDATEs in db.js upsertListing(): source/source_id backfill, content_seq
    // bump, geo_source backfill and the kit columns.
    async backfillListing(listing, existing = null) {
      const postId = Number(listing?.post_id) || 0;
      if (!postId) throw new Error("backfillListing requires listing.post_id");
      const origin = String(listing.source || "591").trim() || "591";
      const originId = String(listing.source_id || postId || "").trim() || String(postId);
      await exec(
        "UPDATE listings SET source = ?, source_id = COALESCE(NULLIF(source_id, ''), ?) WHERE post_id = ?",
        [origin, originId, postId],
      );
      const kit = mergeKitColumns(existing || {}, listingKitFrom({ ...listing, tags: listing.tags }));
      await exec(
        "UPDATE listings SET has_natural_gas = ?, has_balcony = ?, furnish_items = ? WHERE post_id = ?",
        [kit.has_natural_gas, kit.has_balcony, JSON.stringify(kit.furnish_items), postId],
      );
      await exec("UPDATE listings SET content_seq = IFNULL(content_seq, 0) + 1 WHERE post_id = ?", [postId]);
      const geoSource = String(listing.geo_source || "").trim();
      if (geoSource) {
        await exec(
          "UPDATE listings SET geo_source = COALESCE(NULLIF(geo_source, ''), ?) WHERE post_id = ?",
          [geoSource, postId],
        );
      }
    },
    // Mirrors listingSearchProjection.syncListingProjection(): the derived projection row the
    // SQL-first search reads (an upsert, so a brand-new listing becomes searchable too).
    async syncProjection(row, { now = Date.now() } = {}) {
      const values = computeListingProjection(row, now);
      await exec(listingProjectionUpsertSql(), bindProjectionValues(values));
    },
    // 同屋源折疊輸入固化：以「回讀後的最終列」算 fold_*（與讀取端 candidate 列同一欄位子集，
    // 不新增第二套解析）。peer 關係變動不影響這些輸入欄（role 是讀取時 SQL 現算），故不在此重算。
    async syncFoldColumns(row) {
      // 與 refreshFoldColumns(Sync) 共用同一支 SQL 與綁定，值一律由 computeFoldColumns 決定。
      await exec(foldColumnsUpdateSql(), bindFoldColumnValues(computeFoldColumns(row), Number(row?.post_id) || 0));
    },
    // Mirrors dataRevision.bumpRevision(): the durable change-log row.
    async bumpRevision({ entityType, entityId = null, eventType, now = Date.now() } = {}) {
      if (!entityType || !eventType) throw new Error("bumpRevision requires entityType and eventType");
      await exec(
        "INSERT INTO data_revision (entity_type, entity_id, event_type, created_at) VALUES (?, ?, ?, ?)",
        [String(entityType), entityId == null ? null : Number(entityId), String(eventType), Number(now) || Date.now()],
      );
    },
    /**
     * 刪除一列 `listings` 並在同交易維護 `dbTotal` 計數器（`–1`／fixture 列 `0`）。
     *
     * 目前**沒有任何產品路徑**呼叫它：站上的「清除物件紀錄／清除全部資料」
     * （`RESET_LISTINGS_SQLS`／`RESET_ALL_SQLS`）走的是 `siteResetAsync.js` 的整批 DELETE。
     * 那條路徑不經過這裡，所以它造成的偏差由**對帳**覆蓋（見 `listingTotalsPgCounter.js`），
     * 這是刻意的取捨：批刪本來就會有大量資料變動，一次真 COUNT 是最省的修復方式。
     */
    async deleteListingRow(postId, { bucketKey = DEFAULT_LISTING_TOTALS_BUCKET } = {}) {
      const id = Number(postId) || 0;
      if (!id) throw new Error("deleteListingRow requires postId");
      const res = await exec(
        "DELETE FROM listings WHERE post_id = ? AND (fixture_namespace IS NULL OR fixture_namespace = '') RETURNING post_id",
        [id],
      );
      const removed = Number(res?.rowCount ?? res?.changes ?? 0) || 0;
      await applyListingTotalsDelta(pgDriver, { bucketKey, delta: -removed, now: Date.now() });
      return removed;
    },
  };
}
