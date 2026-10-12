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
import { districtKeyPrefixExpression } from "../listDistrictSql.js";
import {
  MATCH_COMPONENT_LOCK_KEY,
  MATCH_GRAPH_STATE_KEY,
  componentLabels,
} from "../listingMatchComponents.js";

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

// ── 行政區關係閉包的「配對圖連通分量」材料化（2026-10-12）──────────────────────────
//
// 為什麼放在**寫入端**：這一包是「把每請求重算 869–927ms 的 union-find 事先算好」，所以
// 產生它的東西（DDL、重算、寫入批次）全部屬於寫入路徑；讀取端（`listingMatchComponents.js`）
// 只負責用便宜的讀證明「這一份沒有過期」，並在過期時**排一次背景重算**。
//
// 邊界（Owner 定）：不准每寫一列就重算 ⇒ 重算由「爬蟲輪次結束／圖真的變了」觸發，一次一批。
// 待機不寫：第一句就是 `pg_is_in_recovery()`。表是本模組新建的衍生表，
// **沒有**在 `listings` 上加欄（`listings` 的 fold_* 欄由 #739 那條線在動）。
export function matchComponentDdlStatements() {
  return [
    `CREATE TABLE IF NOT EXISTS listing_match_component (
       post_id bigint PRIMARY KEY,
       component_id bigint NOT NULL,
       district_prefix text,
       match_post_id bigint
     )`,
    "CREATE INDEX IF NOT EXISTS idx_listing_match_component_component ON listing_match_component (component_id)",
    "CREATE INDEX IF NOT EXISTS idx_listing_match_component_prefix ON listing_match_component (district_prefix)",
    `CREATE TABLE IF NOT EXISTS listing_match_component_state (
       state_key text PRIMARY KEY,
       built_at bigint NOT NULL,
       round_marker text,
       revision_watermark bigint NOT NULL,
       listings_stat_fingerprint bigint NOT NULL,
       node_count bigint NOT NULL,
       edge_count bigint NOT NULL,
       component_count bigint NOT NULL,
       built_db text
     )`,
  ];
}

const matchComponentReady = new WeakSet();

/** 冪等 DDL 入口（WeakSet 記在 driver 上 ⇒ 同一行程只跑一輪），形狀同 `ensureSourcePublishedAtOnce`。 */
export async function ensureMatchComponentsOnce(pgDriver) {
  if (!pgDriver || typeof pgDriver.query !== "function") throw new Error("ensureMatchComponentsOnce requires a PG driver");
  if (matchComponentReady.has(pgDriver)) return;
  for (const statement of matchComponentDdlStatements()) await pgDriver.query(statement);
  matchComponentReady.add(pgDriver);
}

// ⚠️ 佔位符是 `$n`，不是 `?`：這一支走的是 `pgDriver.query()`（`dbDriverPostgres` 的原生介面），
// 它**不做** SQLite→PG 翻譯；翻譯只發生在注入式 `exec`（呼叫端自己呼叫 `toPostgresSql()`）身上。
const MATCH_COMPONENT_STATE_SQL = `
INSERT INTO listing_match_component_state
  (state_key, built_at, round_marker, revision_watermark, listings_stat_fingerprint,
   node_count, edge_count, component_count, built_db)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (state_key) DO UPDATE SET
  built_at = excluded.built_at,
  round_marker = excluded.round_marker,
  revision_watermark = excluded.revision_watermark,
  listings_stat_fingerprint = excluded.listings_stat_fingerprint,
  node_count = excluded.node_count,
  edge_count = excluded.edge_count,
  component_count = excluded.component_count,
  built_db = excluded.built_db`;

/** 「這一輪算出來的分量與表內逐列相同嗎」——全部在 PG 端比，不必把 7 萬列搬回 Node。 */
function matchComponentDiffSql(prefixExpression) {
  return `
SELECT (SELECT count(*) FROM listing_match_component) AS existing_count,
       (SELECT count(*) FROM unnest($1::bigint[], $2::bigint[]) AS u(post_id, component_id)) AS incoming_count,
       (SELECT count(*)
          FROM unnest($1::bigint[], $2::bigint[]) AS u(post_id, component_id)
          LEFT JOIN listings l ON l.post_id = u.post_id
          LEFT JOIN listing_match_component c ON c.post_id = u.post_id
         WHERE c.post_id IS NULL
            OR c.component_id IS DISTINCT FROM u.component_id
            OR c.match_post_id IS DISTINCT FROM l.match_post_id
            OR c.district_prefix IS DISTINCT FROM ${prefixExpression}) AS diff_count`;
}

const matchComponentInsertSql = (prefixExpression) => `
INSERT INTO listing_match_component (post_id, component_id, district_prefix, match_post_id)
SELECT u.post_id, u.component_id, ${prefixExpression}, l.match_post_id
  FROM unnest($1::bigint[], $2::bigint[]) AS u(post_id, component_id)
  LEFT JOIN listings l ON l.post_id = u.post_id`;

/**
 * 把「配對圖（`listings.match_post_id` 的無向連通分量）」重算成材料化表。
 *
 * 一次呼叫＝**一批寫入**（一個交易：清表 ＋ 一句 `INSERT … SELECT unnest(...)`）＋一句狀態 upsert；
 * 分量／前綴／邊值逐列比對完全相同時**連那一批都不寫**（只更新狀態列的建置時間與水位）。
 *
 * 呼叫端：`listingMatchComponents.scheduleMatchComponentRebuild()`（背景、去抖；
 * 失敗只代表下一個請求仍然走即時算）。
 */
export async function rebuildMatchComponents(pgDriver, { now = Date.now(), reason = "scheduled", force = false } = {}) {
  if (!pgDriver || typeof pgDriver.query !== "function") throw new Error("rebuildMatchComponents requires a PG driver");
  const recovery = (await pgDriver.query("SELECT pg_is_in_recovery() AS in_recovery")).rows?.[0];
  if (recovery?.in_recovery === true) return { skipped: "in_recovery" };
  const locked = (await pgDriver.query("SELECT pg_try_advisory_lock($1) AS ok", [MATCH_COMPONENT_LOCK_KEY])).rows?.[0]?.ok === true;
  if (!locked) return { skipped: "locked" };
  try {
    await ensureMatchComponentsOnce(pgDriver);
    const prefixExpression = districtKeyPrefixExpression("pg");
    // 水位／輪次標記／統計指紋一律在**讀邊之前**取：晚一點的變更會被下一次逐列證明再驗一次
    // （多驗一次只是慢；少驗一次才會少算）。
    const before = (await pgDriver.query(
      `SELECT (SELECT COALESCE(MAX(id), 0) FROM data_revision) AS revision,
              (SELECT value FROM settings WHERE key = 'lastCoveringAt') AS covering,
              (SELECT value FROM settings WHERE key = 'lastSystemCoveringAt') AS system_covering,
              CAST((SELECT MAX(last_run_at) FROM crawl_covers) AS text) AS covers_max,
              COALESCE((SELECT SUM(n_tup_del) FROM pg_stat_user_tables WHERE relname = 'listings'), 0) AS stat_fingerprint,
              current_database() AS built_db`,
    )).rows?.[0] || {};

    const edgeRows = (await pgDriver.query(
      "SELECT post_id, match_post_id FROM listings WHERE match_post_id > 0 OR match_post_id < 0",
    )).rows || [];
    const pairs = [];
    for (const row of edgeRows) {
      const a = Number(row.post_id) || 0;
      const b = Number(row.match_post_id) || 0;
      if (a && b) pairs.push([a, b]);
    }
    // 與讀取端的即時算**共用同一份**標記演算法（`componentLabels`）：兩邊各寫一份就會漂移。
    const labels = componentLabels(pairs).allLabels();
    const postIds = [...labels.keys()];
    const componentIds = postIds.map((id) => labels.get(id));

    let changed = force;
    let diff = null;
    if (!changed) {
      diff = (await pgDriver.query(matchComponentDiffSql(prefixExpression), [postIds, componentIds])).rows?.[0] || {};
      changed = Number(diff.existing_count) !== Number(diff.incoming_count) || Number(diff.diff_count) > 0;
    }

    const roundMarker = `${before.covering == null ? "" : String(before.covering)}|${before.covers_max == null ? "" : String(before.covers_max)}`;
    const stateParams = [
      MATCH_GRAPH_STATE_KEY,
      now,
      roundMarker,
      Number(before.revision) || 0,
      Number(before.stat_fingerprint) || 0,
      postIds.length,
      pairs.length,
      new Set(componentIds).size,
      before.built_db == null ? null : String(before.built_db),
    ];
    if (changed) {
      await pgDriver.withTransaction(async (client) => {
        await client.query("DELETE FROM listing_match_component");
        await client.query(matchComponentInsertSql(prefixExpression), [postIds, componentIds]);
        await client.query(MATCH_COMPONENT_STATE_SQL, stateParams);
      });
    } else {
      await pgDriver.query(MATCH_COMPONENT_STATE_SQL, stateParams);
    }
    return {
      changed,
      reason,
      nodes: postIds.length,
      edges: pairs.length,
      components: new Set(componentIds).size,
      diff_count: diff == null ? null : Number(diff.diff_count),
    };
  } finally {
    try {
      await pgDriver.query("SELECT pg_advisory_unlock($1)", [MATCH_COMPONENT_LOCK_KEY]);
    } catch {
      // 解鎖失敗＝連線要收了；session 級 advisory lock 會跟著連線結束，不必讓重算失敗。
    }
  }
}

/**
 * 只把「逐列證明」的水位往前推（材料化表**不動**）——常態路徑用。
 *
 * 為什麼需要它：爬蟲每輪結束都換 `lastCoveringAt`／`crawl_covers.last_run_at`，而配對圖幾乎不動；
 * 若每次換標記就重算（7 萬條邊 ＋ 10 萬節點 union-find ＋ 10 萬列 diff），每一輪要多付好幾秒。
 * 逐列證明已經通過時，材料化的那一份**就是現在的圖**，只需要把水位／標記／統計指紋記下來。
 *
 * CAS（`WHERE revision_watermark = $5`）：跨行程／跨節點同時推的時候只有一個贏家，
 * 不會把水位寫回去（也就不會出現「用水位掩蓋沒驗證過的區間」）。
 * 待機不寫；`rowCount !== 1` 一律回 false（呼叫端只是下一個請求重驗一次，不影響正確性）。
 */
export async function advanceMatchComponentState(pgDriver, {
  expectedRevision, revision, roundMarker, statFingerprint, reason = "verified",
} = {}) {
  if (!pgDriver || typeof pgDriver.query !== "function") return false;
  if (!Number.isFinite(Number(revision)) || !Number.isFinite(Number(expectedRevision))) return false;
  const recovery = (await pgDriver.query("SELECT pg_is_in_recovery() AS in_recovery")).rows?.[0];
  if (recovery?.in_recovery === true) return false;
  const res = await pgDriver.query(
    `UPDATE listing_match_component_state
        SET revision_watermark = $1, round_marker = $2, listings_stat_fingerprint = $3
      WHERE state_key = $4 AND revision_watermark = $5`,
    [
      Number(revision) || 0,
      roundMarker == null ? "" : String(roundMarker),
      Number(statFingerprint) || 0,
      MATCH_GRAPH_STATE_KEY,
      Number(expectedRevision) || 0,
    ],
  );
  void reason;
  return Number(res?.rowCount ?? 0) === 1;
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
