// 站內刊登（self listing）讀取的 driver-aware 入口（PG 島嶼，2026-09-27）。
//
// 為什麼挑這個：把缺口路由分成「卡點全在 handler 內／部分／全在深模組」三類之後，
// `getSelfListing()` 是「唯一卡點」名單裡最大的單一函式（3 條路由），而且它同時是
// 另外 6 條 self-listings／listing-imports 路由的卡點之一——投報率比表面上高。
//
// 它需要的東西很少，而且**大部分是純函式，直接重用不必複製**：
//   - `expireOpenSelfListings()` → 需要 PG 版（一句 UPDATE）
//   - `getSelfRow()`            → 需要 PG 版（一句 SELECT）
//   - `decorateSelfListing()`   → **純函式**，已在 selfListings.js 匯出
//   - `listingVisibleOnSurface()`／`LISTING_SURFACE` → **純函式**，在 stage1FixtureIsolation.js
//   - `httpError()`             → 錯誤工廠，為此把 selfListings.js 的區域版本加上 `export`
//                                 （只加 export，行為不變），確保兩邊丟出的 Error 形狀一致
//
// ⚠️ 方言：同步版的 UPDATE 用 `IFNULL(self_expires_at, '')`，**PG 不接受 IFNULL**，
// 而 `pgExec()` 在注入 `exec` 時不經過 `toPostgresSql`，所以這裡一律寫 `COALESCE`
// （兩邊都合法、轉譯器也不會再改它）。這與 reject-match 那批踩到的是同一個坑。
import { resolveDbDriver } from "./dbDriver.js";
// SQLite 分支需要 handle：`selfListings.js` 的函式吃 `(db, ...)` 參數，
// 與 `listingGroupsAsync.js`／`supportAsync.js` 用同一個既有模式。
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { LISTING_SURFACE, listingVisibleOnSurface } from "./stage1FixtureIsolation.js";
import {
  ABANDON_DRAFT_LISTING_SQL,
  BAN_SELF_PUBLISHER_SQL,
  LISTING_BY_POST_ID_SQL,
  MATCH_SET_SQL,
  SELF_CREATE_IDEMPOTENCY_HIT_SQL,
  SELF_CREATE_IDEMPOTENCY_INSERT_SQL,
  SELF_OPEN_INSERT_SQL,
  SELF_OPEN_UPDATE_SQL,
  normalizePhotoUrl,
  selfOpenInsertParams,
  selfOpenUpdateParams,
  resolveSelfListingMeta,
  selfSearchKey,
  selfSourceKey,
  OPEN_SELF_COUNT_SQL,
  PERSIST_LISTING_VALUES_SQL,
  PUBLISHER_AVATAR_SQL,
  SELF_BAN_UNTIL_SQL,
  SELF_MAX_OPEN,
  SELF_NEW_ACCOUNT_WAIT_MS,
  SELF_PUBLISH_UPDATE_SQL,
  SELF_TTL_DAYS,
  SET_PUBLISHER_FACE_SQL,
  USER_CREATED_AT_SQL,
  composeSelfAddress,
  floorText,
  kindId,
  kindLabel,
  layoutText,
  requireListingTitle,
  resolveListingTraits,
  roleId,
  roleLabel,
  selfPublishUpdateParams,
  NEXT_SELF_POST_ID_SQL,
  SELF_CONTACT_MAX,
  SELF_DRAFT_INSERT_SQL,
  SELF_DRAFT_UPDATE_SQL,
  IMPORT_DRAFT_COMMUNITY_SQL,
  IMPORT_DRAFT_INSERT_SQL,
  IMPORT_DRAFT_UPDATE_SQL,
  importDraftInsertParams,
  importDraftUpdateParams,
  SELF_POST_ID_BASE,
  SELF_POST_ID_END,
  catalogTraitExtras,
  digitsPhone,
  listingFormFields,
  normalizeLineUrl,
  selfDraftInsertParams,
  selfDraftUpdateParams,
  DRAFT_LISTING_UPDATE_SQL,
  HIDE_SELF_LISTING_SQL,
  REPORT_COUNT_SQL,
  REPORT_EXISTS_SQL,
  REPORT_INSERT_SQL,
  SELF_REPORT_HIDE_AFTER,
  decorateSelfListing,
  getListingOfferHook,
  expireOpenSelfListings as expireOpenSelfListingsSync,
  SELF_BODY_MAX,
  SELF_BODY_HINT,
  SELF_BODY_MIN,
  SELF_TITLE_MAX,
  getSelfListing as getSelfListingSync,
  getSelfRow as getSelfRowSync,
  httpError,
  listingPhotoUrls,
  normalizePhotoList,
  selfBanStamp,
} from "./selfListings.js";
import { listingBodyPlain, sanitizeListingBodyHtml } from "./listingBody.js";
import { isMemberMediaUrl } from "./memberMedia.js";
import { getWishConditionsAsync } from "./rentalCatalogAsync.js";
import { MRT_CACHE_CONTRACT } from "./mrt.js";
import { matchCandidatesAsync } from "./crawlerReads.js";
import { bestMatch } from "./match.js";
import { isFixtureMaturityAuthorized } from "./stage1FixtureRegistry.js";
import { lookupDistrict, normalizeWatchDistricts } from "./regions.js";
import { isSelfPhotoPublicUrl } from "./selfPhotos.js";
import { normalizeDeposit, normalizeSelfTraits } from "./selfTraits.js";
import { SELF_PHOTO_MAX_COUNT } from "./selfPhotos.js";
import {
  SELF_LISTING_IDEMPOTENCY_KEY_RE,
  normalizeSelfListingIdempotencyKey,
  selfListingCreateFingerprint,
} from "./selfListingIdempotency.js";
import {
  FIXTURE_ISOLATION,
  FIXTURE_MATURITY,
  REGISTRY_ACTIVE_USER_SQL,
  REGISTRY_INSERT_SQL,
  STAGE1_FIXTURE_KIND,
  STAGE1_FIXTURE_NAMESPACE,
  STAGE1_FIXTURE_STATUS,
  STAGE1_FIXTURE_TTL_MS,
} from "./stage1FixtureRegistry.js";
import { depositLabel, selfTraitLabels } from "./selfTraits.js";
import { ownsMediaUrlAsync } from "./memberMediaAsync.js";
import { copyResult } from "./listingTools.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";

// 複製的冪等表（同步 `listingTools.js:copyOwnListing()` 用的同一組語句）。
export const COPY_IDEMPOTENCY_HIT_SQL =
  "SELECT draft_id FROM listing_copy_idempotency WHERE user_id=? AND request_key=?";
export const COPY_IDEMPOTENCY_INSERT_SQL =
  "INSERT INTO listing_copy_idempotency(user_id, request_key, draft_id, created_at) VALUES (?,?,?,?)";
const isoOf = (now) => (now ? new Date(now) : new Date()).toISOString();

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

async function pgExec(options = {}) {
  if (options.exec) return options.exec;
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

// 逐字對應 selfListings.js:349 的 UPDATE，只把 IFNULL 換成 COALESCE（見檔頭說明）。
export const EXPIRE_SELF_LISTINGS_SQL = `UPDATE listings
   SET self_status = 'expired'
   WHERE source = 'self'
     AND COALESCE(self_status, 'open') = 'open'
     AND COALESCE(self_expires_at, '') != ''
     AND self_expires_at <= ?`;

// selfListings.js:632 的 SELECT（同步版本來就用 COALESCE，所以逐字相同）。
export const SELF_ROW_SQL =
  "SELECT * FROM listings WHERE post_id = ? AND COALESCE(source, '591') = 'self'";

// 回傳受影響的列數；同步版把任何錯誤吞掉回 0，這裡照抄（過期清理失敗不該擋住讀取）。
export async function expireOpenSelfListingsAsync(exec, now = new Date()) {
  const stamp = (now instanceof Date ? now : new Date(now)).toISOString();
  try {
    const rows = await exec(EXPIRE_SELF_LISTINGS_SQL, [stamp]);
    // 注意：注入式 exec 的 UPDATE 回空陣列、PG 也不回資料列，所以這裡拿不到「改了幾列」。
    // 同步版回 `changes`，但**唯一的呼叫端 `getSelfListing()` 不使用它**，
    // 所以兩邊的行為仍然一致；需要精確列數時要另寫一句 SELECT。
    return Number(rows?.changes ?? 0) || 0;
  } catch {
    return 0;
  }
}

// 🚨 這一支原本寫成 `const rows = await exec(...); return rows[0]`，但統一的 exec 形狀是
// **`{ rows, rowCount }`**（見本檔開頭與 crmOutboxAsync.js），所以 `rows[0]` 永遠是
// undefined ⇒ PG 模式下這一支**永遠回 undefined**。它先前沒有呼叫端（`getSelfListingAsync()`
// 用它，但那一條當時也沒接線），所以缺陷一直沒被發現；2026-09-28 接 wish-offers 讀取時
// 由 parity 測試抓到（投影只剩 `listing_ref`）。
export async function getSelfRowAsync(postId, options = {}) {
  if (!isPg(options)) return getSelfRowSync(sqliteHandle(), postId);
  const exec = await pgExec(options);
  const result = await exec(SELF_ROW_SQL, [Number(postId) || 0]);
  const rows = Array.isArray(result) ? result : (result?.rows || []);
  return rows[0] || undefined;
}

// selfListings.js:649 `getSelfListing()` 的 PG 分支。步驟逐條對應：
//   過期清理 → 取列（沒有就 404）→ 可見性（不可見也 404）→ 已關閉且不是本人（404）→ 裝飾
// `now` 只有測試會傳；不傳時與同步版一樣用 `new Date()`。
export async function getSelfListingAsync(postId, { viewerId = 0, now = new Date(), ...options } = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    return getSelfListingSync(sqliteHandle(), postId, { viewerId });
  }
  const exec = await pgExec(options);
  await expireOpenSelfListingsAsync(exec, now);
  const row = await getSelfRowAsync(postId, { ...options, exec });
  if (!row) throw httpError("找不到這則站內刊登", 404);
  const mine = Number(row.listed_by_user_id) === Number(viewerId);
  const surface = mine ? LISTING_SURFACE.OWNER_SELF : LISTING_SURFACE.PUBLIC_DETAIL;
  if (!listingVisibleOnSurface(row, { surface, viewerId })) {
    throw httpError("找不到這則站內刊登", 404);
  }
  const status = String(row.self_status || "open");
  if (status !== "open" && !mine) throw httpError("這則刊登已關閉或隱藏", 404);
  return decorateSelfListing(row, { viewerId });
}

// ---- 關閉自己的站內刊登 ----
//
// 對應 `selfListings.js:1219 closeSelfListing()`。步驟逐條照抄：
//   取列（沒有 → 404）→ 擁有權（非本人且非 admin → 403）→ UPDATE → 通知 hook → 回傳裝飾後的列
//
// ⚠️ `listingOfferHook`（由 `wishOffers.js` 註冊的 `handleWishOfferLifecycle`）**仍用本機
// SQLite handle 呼叫**：那個 hook 做的是「許願出價的清掃」，而 `wishOffers.js` 還沒移植
// （它的函式全都吃 handle）。用 PG 的 exec 呼叫它會直接壞掉；維持原樣是本批唯一的選擇，
// 而且同步版也是 try/catch 包住（清掃失敗不得擋住關閉）。等 wishOffers 移植時再一起改。
export const CLOSE_SELF_LISTING_SQL =
  "UPDATE listings SET self_status = 'closed', last_event = 'offline', last_seen_at = ? WHERE post_id = ?"; // selfListings.js:1226

export async function closeSelfListingAsync(userId, postId, { admin = false, now = new Date(), ...options } = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    const { closeSelfListing } = await import("./db.js");
    return closeSelfListing(userId, postId, { admin });
  }
  const exec = await pgExec(options);
  const row = await getSelfRowAsync(postId, { ...options, exec });
  if (!row) throw httpError("找不到這則站內刊登", 404);
  if (!admin && Number(row.listed_by_user_id) !== Number(userId)) {
    throw httpError("只能關閉自己的刊登", 403);
  }
  const stamp = (now instanceof Date ? now : new Date(now)).toISOString();
  await exec(CLOSE_SELF_LISTING_SQL, [stamp, row.post_id]);
  // 與 `hideSelfListingAsync()` 同一個理由：本機的同步瀏覽路徑讀的是本機 `listings`。
  sqliteHandle().prepare(CLOSE_SELF_LISTING_SQL).run(stamp, row.post_id);
  try { getListingOfferHook()?.(sqliteHandle(), { listingId: row.post_id, now }); } catch { /* 清掃失敗不得擋住關閉 */ }
  return getSelfListingAsync(row.post_id, { viewerId: userId, ...options, exec });
}

// ---- 檢舉站內刊登／後台隱藏（第四十六批）----
//
// 對應 `selfListings.js` 的 `reportSelfListing()`（1249）與 `hideSelfListing()`（1238）。
// 兩支都只碰 `listings` 與 `listing_reports`，語句與政策（達門檻才隱藏、停權幾天）全部共用。
//
// ⚠️ **停權寫的是 `users.self_ban_until`**（`banSelfPublisher()`）。PG 模式下 users 在 PG，
// 但**同步**的建立路徑（`createSelfListing()` → `assertCanPublish()`）讀的是本機 handle
// ⇒ 兩個 store 都要寫；只寫 PG 會讓被停權的人換一台節點就又能上傳。
export async function hideSelfListingAsync(postId, { now = new Date(), ...options } = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    return (await import("./db.js")).hideSelfListing(postId);
  }
  const exec = await pgExec(options);
  const row = await getSelfRowAsync(postId, { ...options, exec });
  if (!row) throw httpError("找不到這則站內刊登", 404);
  const stamp = (now instanceof Date ? now : new Date(now)).toISOString();
  await exec(HIDE_SELF_LISTING_SQL, [stamp, row.post_id]);
  // **兩個 store 都寫**：`listings` 的狀態是本機**同步**瀏覽路徑（`keepSelfListingForViewer()`）
  // 在讀的，只寫 PG 會讓「已隱藏」的刊登還留在本機的清單裡。
  sqliteHandle().prepare(HIDE_SELF_LISTING_SQL).run(stamp, row.post_id);
  // 跨模組的 hook（許願出價清掃）仍用本機 handle：那個模組還沒移植（與 closeSelfListingAsync 同）。
  try { getListingOfferHook()?.(sqliteHandle(), { listingId: row.post_id, now }); } catch { /* 清掃失敗不得擋住隱藏 */ }
  const until = selfBanStamp(now);
  await exec(BAN_SELF_PUBLISHER_SQL, [until, row.listed_by_user_id]);
  try { sqliteHandle().prepare(BAN_SELF_PUBLISHER_SQL).run(until, row.listed_by_user_id); } catch { /* 本機可能還沒有這一欄 */ }
  return { ok: true, post_id: Number(row.post_id), hidden: true, ban_until: until };
}

export async function reportSelfListingAsync(userId, postId, reason = "", { now = new Date(), ...options } = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    return (await import("./db.js")).reportSelfListing(userId, postId, reason);
  }
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入才能檢舉", 401);
  const exec = await pgExec(options);
  const row = await getSelfRowAsync(postId, { ...options, exec });
  if (!row) throw httpError("找不到這則站內刊登", 404);
  if (Number(row.listed_by_user_id) === uid) throw httpError("不能檢舉自己的刊登");
  const already = await exec(REPORT_EXISTS_SQL, [row.post_id, uid]);
  const alreadyRows = Array.isArray(already) ? already : (already?.rows || []);
  if (alreadyRows[0]) return { ok: true, already: true };
  const stamp = (now instanceof Date ? now : new Date(now)).toISOString();
  await exec(REPORT_INSERT_SQL, [row.post_id, uid, String(reason || "").trim().slice(0, 200), stamp]);
  const counted = await exec(REPORT_COUNT_SQL, [row.post_id]);
  const countRows = Array.isArray(counted) ? counted : (counted?.rows || []);
  const count = Number(countRows[0]?.n) || 0;
  const hide = count >= SELF_REPORT_HIDE_AFTER;
  // 達門檻才隱藏（與同步版同一個門檻常數）；`hideSelfListingAsync` 內部再讀一次列，
  // 多一次查詢但語意與同步版完全相同（同步版也是 `hideSelfListing()` 自己再取列）。
  if (hide) await hideSelfListingAsync(row.post_id, { now, ...options, exec });
  return { ok: true, hidden: hide };
}

// ---- 匯入草稿的兩個寫入（第四十七批）----
//
// 對應 `selfListings.js` 的 `updateImportedDraftListing()`（1082）與
// `abandonImportedDraftListing()`（1097）。兩支都只碰 `listings` 的 self_* 欄位，
// 語句與正規化（`normalizePhotoList`／`sanitizeListingBodyHtml`）全部共用。
export async function updateImportedDraftListingAsync(userId, postId, input = {}, options = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    const { updateImportedDraftListing } = await import("./db.js");
    return updateImportedDraftListing(userId, postId, input);
  }
  const uid = Number(userId) || 0;
  const exec = await pgExec(options);
  const row = await getSelfRowAsync(postId, { ...options, exec });
  if (!row) throw httpError("找不到這則匯入草稿", 404);
  if (Number(row.listed_by_user_id) !== uid) throw httpError("只能改自己的匯入草稿", 403);
  if (String(row.self_status || "") !== "draft") throw httpError("只有草稿可以修改匯入內容", 409);
  const title = input.title != null ? String(input.title || "").trim().slice(0, SELF_TITLE_MAX) : row.title;
  const body = sanitizeListingBodyHtml(input.body != null ? input.body : row.self_body || "", SELF_BODY_MAX);
  const photos = input.photos != null ? normalizePhotoList(input.photos) : listingPhotoUrls(row);
  await exec(DRAFT_LISTING_UPDATE_SQL, [title || row.title, body, JSON.stringify(photos), photos[0] || "", row.post_id]);
  // 兩個 store 都寫（本機的同步瀏覽路徑讀 `listings`）。
  sqliteHandle().prepare(DRAFT_LISTING_UPDATE_SQL)
    .run(title || row.title, body, JSON.stringify(photos), photos[0] || "", row.post_id);
  return getSelfListingAsync(row.post_id, { viewerId: uid, ...options, exec });
}

export async function abandonImportedDraftListingAsync(userId, postId, { now = new Date(), ...options } = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    return (await import("./db.js")).abandonImportedDraftListing(userId, postId);
  }
  const uid = Number(userId) || 0;
  const exec = await pgExec(options);
  const row = await getSelfRowAsync(postId, { ...options, exec });
  if (!row) return null;
  if (Number(row.listed_by_user_id) !== uid) throw httpError("只能取消自己的匯入草稿", 403);
  if (String(row.self_status || "") !== "draft") {
    return getSelfListingAsync(row.post_id, { viewerId: uid, ...options, exec });
  }
  const stamp = (now instanceof Date ? now : new Date(now)).toISOString();
  await exec(ABANDON_DRAFT_LISTING_SQL, [stamp, row.post_id]);
  sqliteHandle().prepare(ABANDON_DRAFT_LISTING_SQL).run(stamp, row.post_id);
  return getSelfListingAsync(row.post_id, { viewerId: uid, ...options, exec });
}

// ---- 複製自己的站內刊登（`POST /api/self-listings/:id/copy`，第八十二批）-------------------
//
// 同步版整條讀寫節點本機：來源列（`listings`）、冪等表（`listing_copy_idempotency`）、
// 素材所有權（`member_media`）與新草稿列。PG 模式下刊登與素材都在 PG ⇒ 複製出來的草稿
// 會落在**這台節點**，別的節點看不到（列表因此少一則），而且素材所有權會誤判成「不是自己的」。
//
// 語句與純組裝全部沿用 `selfListings.js`／`listingTools.js`（同一份），這裡只換「誰去跑」。
const rowsOf = (raw) => (Array.isArray(raw) ? raw : (raw?.rows || []));

async function runWith(options, { write = false }, runPostgres, runSqlite) {
  if (!isPg(options)) return runSqlite();
  try {
    return await runPostgres();
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write })) throw error;
    return runSqlite();
  }
}

// 注入式 exec 有兩種慣例（裸陣列／`{rows}`）⇒ 在邊界正規化成 `{rows}`。
// R2：`listings` 多了費用三態與捷運查證欄位。`ensurePgSchema()` 只在 cutover 時鏡射整張表，
// **既有的 PG 表補不了欄位** ⇒ 第一次寫入前用 PG 的 ADD COLUMN IF NOT EXISTS 補一次
// （沿用 listingToolsAsync／crawlerWrites 的做法，失敗不快取）。
export const SELF_LISTING_PG_COLUMNS = [
  "ALTER TABLE listings ADD COLUMN IF NOT EXISTS fee_includes TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE listings ADD COLUMN IF NOT EXISTS self_mrt_station TEXT",
  "ALTER TABLE listings ADD COLUMN IF NOT EXISTS self_mrt_walk_m DOUBLE PRECISION",
  "ALTER TABLE listings ADD COLUMN IF NOT EXISTS self_mrt_source TEXT",
  "ALTER TABLE listings ADD COLUMN IF NOT EXISTS self_mrt_checked_at TEXT",
  // R2（第二輪）：查證狀態與「最近但超過」的距離。
  "ALTER TABLE listings ADD COLUMN IF NOT EXISTS self_mrt_state TEXT",
  "ALTER TABLE listings ADD COLUMN IF NOT EXISTS self_mrt_nearest_m DOUBLE PRECISION",
];

const selfListingSchemaReady = new WeakMap();
export async function ensureSelfListingColumnsOnce(pgDriver) {
  if (!pgDriver) return;
  if (selfListingSchemaReady.has(pgDriver)) return selfListingSchemaReady.get(pgDriver);
  const ready = (async () => {
    for (const sql of SELF_LISTING_PG_COLUMNS) await pgDriver.exec(sql);
  })();
  selfListingSchemaReady.set(pgDriver, ready);
  try {
    await ready;
  } catch (error) {
    selfListingSchemaReady.delete(pgDriver);
    throw error;
  }
}

async function runnerFor(options = {}) {
  if (options.exec) {
    const injected = options.exec;
    return async (sql, params = []) => {
      const raw = await injected(sql, params);
      return Array.isArray(raw) ? { rows: raw } : raw;
    };
  }
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  await ensureSelfListingColumnsOnce(pgDriver);
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params);
}

async function nextSelfPostIdAsync(run) {
  const row = rowsOf(await run(NEXT_SELF_POST_ID_SQL, [SELF_POST_ID_BASE, SELF_POST_ID_END]))[0];
  const current = Number(row?.n) || SELF_POST_ID_BASE;
  const next = Math.max(SELF_POST_ID_BASE, current) + 1;
  if (next >= SELF_POST_ID_END) throw httpError("站內刊登編號已滿", 500);
  return next;
}

/** `listingTools.js:reusableCopyPhotos()` 的 PG 版（素材所有權讀 PG）。 */
export async function reusableCopyPhotosAsync(userId, urls, options = {}) {
  const out = [];
  for (const raw of Array.isArray(urls) ? urls : []) {
    const url = String(raw || "").trim();
    if (!url || out.includes(url)) continue;
    if (isMemberMediaUrl(url)) {
      if (await ownsMediaUrlAsync(userId, url, options)) out.push(url);
      continue;
    }
    if (isSelfPhotoPublicUrl(url)) out.push(url);
  }
  return out;
}

/** `selfListings.js:insertSelfDraftListing()` 的 PG 版（複製草稿的兩句寫入）。 */
export async function insertSelfDraftListingAsync(uid, fields = {}, options = {}) {
  const id = Number(uid) || 0;
  if (!id) throw httpError("請先登入", 401);
  const now = options.now ? new Date(options.now) : new Date();
  const created = (now instanceof Date ? now : new Date(now)).toISOString();
  const title = String(fields.title || "").trim().slice(0, SELF_TITLE_MAX) || "複製草稿";
  const body = String(fields.body || "").trim().slice(0, SELF_BODY_MAX);
  const photos = normalizePhotoList(fields.photos || []);
  const rent = Math.max(0, Math.round(Number(fields.price_num || fields.rent) || 0));
  const address = String(fields.address || "").trim().slice(0, 160);
  const areaName = String(fields.area_name || "").trim().slice(0, 40);
  const layout = String(fields.layout || "").trim().slice(0, 20);
  const floorName = String(fields.floor_name || "").trim().slice(0, 20);
  const kindName = String(fields.kind_name || "").trim().slice(0, 20);
  const roleName = String(fields.role_name || "").trim().slice(0, 20);
  const traits = normalizeSelfTraits(fields.traits, catalogTraitExtras({ includeInactive: true }).ids);
  const deposit = normalizeDeposit(fields.deposit);
  const contactName = String(fields.contact_name || "").trim().slice(0, SELF_CONTACT_MAX);
  const phone = digitsPhone(fields.phone || fields.mobile);
  let lineUrl = "";
  try {
    lineUrl = normalizeLineUrl(fields.line_url);
  } catch {
    lineUrl = "";
  }
  return runWith(options, { write: true }, async () => {
    const run = await runnerFor(options);
    const postId = await nextSelfPostIdAsync(run);
    await run(SELF_DRAFT_INSERT_SQL, selfDraftInsertParams({
      postId, title, rent, address, areaName, layout, floorName, kindName, roleName, cover: photos[0] || "", created,
    }));
    await run(SELF_DRAFT_UPDATE_SQL, selfDraftUpdateParams({
      uid: id, postId, body, photos, traits, deposit, contactName, roleName, phone, lineUrl,
    }));
    // 本機鏡射（還沒搬完的讀取看的是它）；失敗不該讓已經寫進 PG 的草稿變成錯誤。
    try {
      const { insertSelfDraftListing } = await import("./selfListings.js");
      insertSelfDraftListing(sqliteHandle(), id, { ...fields, title, body, photos, rent, price_num: rent, address, area_name: areaName, layout, floor_name: floorName, kind_name: kindName, role_name: roleName, traits, deposit, contact_name: contactName, phone, line_url: lineUrl }, now);
    } catch { /* 本機鏡射盡力而為 */ }
    return getSelfListingAsync(postId, { viewerId: id, ...options });
  }, async () => {
    const { insertSelfDraftListing } = await import("./selfListings.js");
    return insertSelfDraftListing(sqliteHandle(), id, fields, now);
  });
}

/** `selfListings.js:createImportedDraftListing()` 的 PG 版（第八十六批）。
 *
 * 為什麼重要：外部匯入（591／5168）建立的是**草稿列**。同步版把它寫進節點本機 ⇒
 * PG 模式下匯入列在 PG、草稿卻在本機（別的節點看不到、`GET /api/listing-imports/:id`
 * 的 `listing` 永遠是 null、確認後也公開不了）。
 *
 * 驗證與身分標記（`import-draft:` 的 `source_key`、`import:` 的 `source_id`、
 * `self_status='draft'`）全部沿用 `selfListings.js` 的共用常數與純函式，
 * SQL／參數不可能與同步版漂移。
 */
export async function insertImportedDraftListingAsync(userId, input = {}, options = {}) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入才能匯入", 401);
  const now = options.now ? new Date(options.now) : new Date();
  const created = now.toISOString();
  const title = String(input.title || "").trim().slice(0, SELF_TITLE_MAX);
  const body = sanitizeListingBodyHtml(input.body || "", SELF_BODY_MAX);
  if (!title && listingBodyPlain(body).length < SELF_BODY_MIN) throw httpError("匯入內容不足以建立草稿", 400);
  const photos = normalizePhotoList(input.photos || []);
  const address = String(input.address || "").trim();
  const areaName = String(input.area_name || "").trim();
  const layout = String(input.layout || "").trim();
  const floorName = String(input.floor_name || "").trim();
  const kindName = String(input.kind || input.kind_name || "").trim();
  const community = String(input.community || input.community_name || "").trim();
  const tags = ["吉比本站", community].filter(Boolean);
  return runWith(options, { write: true }, async () => {
    const run = await runnerFor(options);
    const postId = await nextSelfPostIdAsync(run);
    await run(IMPORT_DRAFT_INSERT_SQL, importDraftInsertParams({
      postId, sourceKey: `import-draft:${uid}:${postId}`, title, address, areaName,
      layout, floorName, kindName, photos, tags, created,
    }));
    await run(IMPORT_DRAFT_UPDATE_SQL, importDraftUpdateParams({ uid, postId, body, photos }));
    if (community) {
      // `community_name` 是選用欄位（舊庫還沒有）：與同步版同一個 try/catch。
      try { await run(IMPORT_DRAFT_COMMUNITY_SQL, [community, postId]); } catch { /* optional column */ }
    }
    // 本機鏡射（還沒搬完的讀取看的是它）；失敗不該讓已經寫進 PG 的草稿變成錯誤。
    try {
      const { createImportedDraftListing } = await import("./selfListings.js");
      createImportedDraftListing(sqliteHandle(), uid, input, now);
    } catch { /* 本機鏡射盡力而為 */ }
    return getSelfListingAsync(postId, { viewerId: uid, ...options });
  }, async () => {
    const { createImportedDraftListing } = await import("./selfListings.js");
    return createImportedDraftListing(sqliteHandle(), uid, input, now);
  });
}

/** `listingTools.js:copyOwnListing()` 的 PG 版。 */
export async function copyOwnListingAsync(userId, sourceId, input = {}, options = {}) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  if (!isPg(options)) {
    const { copyOwnListing } = await import("./listingTools.js");
    return copyOwnListing(sqliteHandle(), uid, sourceId, input);
  }
  // PG 區段整體包在 try 裡：讀取（來源列／素材）與寫入（草稿）用**同一套**回退政策，
  // 否則 `fallback: "open"` 時 `getSelfRowAsync()` 會直接把連線錯誤往上丟（實測）。
  try {
    return await copyOwnListingPg(uid, sourceId, input, options);
  } catch (error) {
    if (error?.status) throw error;   // 業務錯誤（401／403／404）直接往上丟
    if (!sqliteFallbackAllowed(options, { write: true })) throw error;
    const { copyOwnListing } = await import("./listingTools.js");
    return copyOwnListing(sqliteHandle(), uid, sourceId, input);
  }
}

async function copyOwnListingPg(uid, sourceId, input, options) {
  const run = await runnerFor(options);
  const source = await getSelfRowAsync(sourceId, { ...options, exec: run, driver: "postgres", strict: true });
  if (!source) throw httpError("找不到這則刊登", 404);
  if (Number(source.listed_by_user_id) !== uid) throw httpError("只能複製自己的刊登", 403, "not_owner");
  const key = String(input.idempotency_key || input.idempotencyKey || "").trim().slice(0, 80);
  if (key) {
    const hit = rowsOf(await run(COPY_IDEMPOTENCY_HIT_SQL, [uid, key]))[0];
    if (hit) {
      const draft = await getSelfListingAsync(hit.draft_id, { viewerId: uid, ...options, exec: run, driver: "postgres", strict: true });
      return { ...copyResult(null, uid, source, draft), reused: true };
    }
  }
  const form = listingFormFields(source);
  const photos = await reusableCopyPhotosAsync(uid, listingPhotoUrls(source), { ...options, exec: run, driver: "postgres", strict: true });
  const draft = await insertSelfDraftListingAsync(uid, {
    title: form.title,
    body: form.body,
    rent: form.rent,
    price_num: form.rent,
    address: form.address,
    area_name: source.area_name,
    layout: source.layout,
    floor_name: source.floor_name,
    kind_name: source.kind_name,
    role_name: source.role_name,
    traits: form.traits,
    deposit: form.deposit,
    contact_name: form.contact_name,
    phone: form.phone,
    line_url: form.line_url,
    photos,
  }, { ...options, exec: run, driver: "postgres", strict: true });
  if (key) {
    try {
      await run(COPY_IDEMPOTENCY_INSERT_SQL, [uid, key, draft.post_id, isoOf(options.now)]);
    } catch {
      const again = rowsOf(await run(COPY_IDEMPOTENCY_HIT_SQL, [uid, key]))[0];
      if (again) {
        const reusedDraft = await getSelfListingAsync(again.draft_id, { viewerId: uid, ...options, exec: run, driver: "postgres", strict: true });
        return { ...copyResult(null, uid, source, reusedDraft), reused: true };
      }
    }
  }
  return copyResult(null, uid, source, draft);
}

// ---- 公開站內刊登草稿（`POST /api/self-listings/:id/publish` 與匯入的
//      `POST /api/listing-imports/:id/publish`，第八十三批）--------------------------------
//
// 同步版整條讀寫節點本機：草稿列、停權／註冊時間（`users`）、同時公開數、頭像、
// 條件值（`listing_condition_values`）與配對候選。PG 模式下「別的節點建立的草稿」根本公開不了
// （404），而**站上的刊登清單讀的是 PG** ⇒ 公開動作看起來成功、刊登卻不在站上。
//
// 驗證規則（可刊登條件、成熟度、同時上限、欄位正規化）**全部沿用 `selfListings.js` 的純函式**，
// 這裡只把「跑語句的人」換成 PG。

/** `selfListings.js:assertCanPublish()` 的 PG 版。 */
export async function assertCanPublishAsync(run, userId, now = new Date(), { maturity, options = {} } = {}) {
  const uid = Number(userId) || 0;
  const banned = Date.parse(String(rowsOf(await run(SELF_BAN_UNTIL_SQL, [uid]))[0]?.self_ban_until || ""));
  const at = now instanceof Date ? now.getTime() : (Number(now) || Date.now());
  if (Number.isFinite(banned) && banned > at) {
    const when = new Date(banned).toISOString().slice(0, 10);
    throw httpError(`因不實刊登暫停上傳，直到 ${when}`, 403);
  }
  const created = Date.parse(String(rowsOf(await run(USER_CREATED_AT_SQL, [uid]))[0]?.created_at || ""));
  const skipWait = isFixtureMaturityAuthorized(sqliteHandle(), uid, now, maturity);
  if (!skipWait && Number.isFinite(created) && at - created < SELF_NEW_ACCOUNT_WAIT_MS) {
    throw httpError("新帳號註冊滿 24 小時後才能自行刊登，避免洗版", 403);
  }
  await expireOpenSelfListingsAsync(run, now);
  const open = Number(rowsOf(await run(OPEN_SELF_COUNT_SQL, [uid]))[0]?.n) || 0;
  if (open >= SELF_MAX_OPEN) {
    throw httpError(`同時最多 ${SELF_MAX_OPEN} 則未過期的站內刊登，請先關閉一則`, 403);
  }
  void options;
}

/** `selfListings.js:setPublisherFace()` 的 PG 版（頭像與 `contact_uid`）。 */
export async function setPublisherFaceAsync(run, postId, uid) {
  const avatar = String(rowsOf(await run(PUBLISHER_AVATAR_SQL, [Number(uid) || 0]))[0]?.avatar_url || "").trim();
  await run(SET_PUBLISHER_FACE_SQL, [avatar, String(uid), Number(postId) || 0]);
}

/** `selfListings.js:persistListingValues()` 的 PG 版（租賃目錄 v2 的條件值）。 */
export async function persistListingValuesAsync(run, postId, listingValues) {
  await run(PERSIST_LISTING_VALUES_SQL, [JSON.stringify(listingValues || {}), Number(postId) || 0]);
}

/** `db.js:assertOwnsMemberMediaUrls()` 的 PG 版（只能用自己的素材照片）。 */
export async function assertOwnsMemberMediaUrlsAsync(userId, urls, options = {}) {
  for (const url of Array.isArray(urls) ? urls : []) {
    if (!isMemberMediaUrl(url)) continue;
    if (!(await ownsMediaUrlAsync(userId, url, options))) {
      throw httpError("只能使用自己素材庫的照片", 403);
    }
  }
  return true;
}

/** `selfListings.js:publishImportedDraftListing()` 的 PG 版（草稿 → 公開）。 */
export async function publishImportedDraftListingAsync(userId, postId, input = {}, options = {}) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入才能刊登", 401);
  const now = options.now ? new Date(options.now) : new Date();
  if (!isPg(options)) {
    const { publishImportedDraftListing } = await import("./selfListings.js");
    const { listMatchCandidates } = await import("./db.js");
    // 🚨 與建立路徑同一個坑（2026-10-01 由 HTTP 端到端測試抓到）：`publishImportedDraftListing()` 是
    // **同步**的，而呼叫端傳進來的 `options.matchCandidates` 是 async 的 PG 島嶼版本 ⇒
    // `bestMatch()` 收到 Promise，發布時回「(candidates || []) is not iterable」。
    // SQLite 分支要用同步版（同一組 SQL builder）。
    return publishImportedDraftListing(sqliteHandle(), uid, postId, input, now, {
      matchCandidates: (listing) => listMatchCandidates(listing?.post_id || 0, listing || null),
    });
  }
  try {
    await getWishConditionsAsync(options);
    const run = await runnerFor(options);
    const row = await getSelfRowAsync(postId, { ...options, exec: run, driver: "postgres", strict: true });
    if (!row) throw httpError("找不到這則匯入草稿", 404);
    if (Number(row.listed_by_user_id) !== uid) throw httpError("只能刊登自己的匯入草稿", 403);
    if (String(row.self_status || "") !== "draft") throw httpError("這則不是待刊登的匯入草稿", 409);
    await assertCanPublishAsync(run, uid, now, { maturity: options.maturity || options.isolation, options });

    const districts = normalizeWatchDistricts(input.district ? [input.district] : input.districts).slice(0, 1);
    if (!districts.length) throw httpError("請選一個行政區");
    const district = lookupDistrict(districts[0]);
    if (!district) throw httpError("請選一個有效行政區");
    const rent = Math.round(Number(input.rent || input.price_num) || 0);
    if (!(rent >= 1000 && rent <= 200000)) throw httpError("請填每月租金（1,000～200,000）");
    const ping = Number(String(input.ping || input.area || "").replace(/坪/g, ""));
    if (!(ping > 0 && ping <= 500)) throw httpError("請填坪數");
    if (input.accept_pledge !== true) throw httpError("請勾選屋主／代理人聲明後才能刊登");
    const address = composeSelfAddress(district, input.street || input.address);
    const body = sanitizeListingBodyHtml(input.body != null ? input.body : row.self_body || "", SELF_BODY_MAX);
    if (listingBodyPlain(body).length < SELF_BODY_MIN) throw httpError(SELF_BODY_HINT);
    const kind = kindId(input.kind || input.housing_type);
    const role = roleId(input.role);
    const layout = layoutText(input);
    const floorName = floorText(input);
    if (!floorName) throw httpError("請填出租樓層");
    let contactName = String(input.contact_name || "").trim().slice(0, SELF_CONTACT_MAX);
    if (!contactName) {
      try {
        contactName = String(rowsOf(await run("SELECT nickname FROM users WHERE id = ?", [uid]))[0]?.nickname || "").trim();
      } catch {
        contactName = "";
      }
    }
    const phone = digitsPhone(input.phone || input.mobile);
    const lineUrl = normalizeLineUrl(input.line_url);
    if (phone && phone.replace(/\D/g, "").length < 8) throw httpError("電話號碼太短");
    const extra = catalogTraitExtras({ includeInactive: true });
    const resolved = resolveListingTraits(input, row);
    const traitIds = resolved.traitIds;
    const deposit = normalizeDeposit(input.deposit);
    const photos = normalizePhotoList(input.photos != null ? input.photos : listingPhotoUrls(row));
    const kindName = kindLabel(kind);
    const roleName = roleLabel(role);
    const areaName = `${String(Math.round(ping * 10) / 10).replace(/\.0$/, "")}坪`;
    const title = requireListingTitle(input.title != null ? input.title : row.title);
    const created = (now instanceof Date ? now : new Date(now)).toISOString();
    const expires = new Date((now instanceof Date ? now.getTime() : Number(now) || Date.now()) + SELF_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
    await run(SELF_PUBLISH_UPDATE_SQL, selfPublishUpdateParams({
      postId: Number(row.post_id) || 0,
      region: district.region,
      section: district.id,
      title,
      rent,
      address,
      areaName,
      layout,
      floorName,
      kindName,
      roleName,
      cover: photos[0] || "",
      tags: ["吉比本站", ...selfTraitLabels(traitIds, extra.labels), depositLabel(deposit)].filter(Boolean),
      expires,
      body,
      photos,
      traitIds,
      deposit,
      created,
      contactName,
      phone,
      lineUrl,
      // R2：地址換了就要讓舊座標／舊步行結果失效（與同步版同一條規則）。
      ...resolveSelfListingMeta(input, row, {
        addressChanged: String(row.address || "").trim() !== String(address || "").trim(),
        mrtCacheContract: MRT_CACHE_CONTRACT,
      }),
    }));
    await setPublisherFaceAsync(run, row.post_id, uid);
    // 配對候選：PG 版走 `crawlerReads.matchCandidatesAsync()`（同一組 builder）。
    const listing = rowsOf(await run("SELECT * FROM listings WHERE post_id = ?", [Number(row.post_id) || 0]))[0];
    // ⚠️ `matchCandidatesAsync` 的注入式 exec 吃**純陣列**，而本島的 runner 回 `{rows}`
    // ⇒ 兩個形狀要在這裡對齊（否則 `loadAnyoneFlagMap()` 會 iterate 一個物件而爆掉）。
    const candidateExec = async (sql, params = []) => rowsOf(await run(sql, params));
    const candidates = typeof options.matchCandidates === "function"
      ? await options.matchCandidates(listing)
      : await matchCandidatesAsync(listing.post_id, listing, { ...options, driver: "postgres", exec: candidateExec });
    const hit = bestMatch(listing, candidates);
    if (hit?.listing) {
      await run(
        "UPDATE listings SET match_post_id=?, match_level=?, match_detail=?, match_rejected=0 WHERE post_id=?",
        [hit.listing.post_id, hit.level, hit.detail, Number(row.post_id) || 0],
      );
    }
    await persistListingValuesAsync(run, row.post_id, resolved.listingValues);
    // 本機鏡射（還沒搬完的讀取看的是它）；失敗不該讓已經公開的刊登回錯。
    try {
      const { publishImportedDraftListing } = await import("./selfListings.js");
      publishImportedDraftListing(sqliteHandle(), uid, row.post_id, input, now, {
        matchCandidates: () => [],
      });
    } catch { /* 本機鏡射盡力而為 */ }
    return getSelfListingAsync(row.post_id, { viewerId: uid, ...options, exec: run, driver: "postgres", strict: true });
  } catch (error) {
    if (error?.status) throw error;
    if (!sqliteFallbackAllowed(options, { write: true })) throw error;
    const { publishImportedDraftListing } = await import("./selfListings.js");
    return publishImportedDraftListing(sqliteHandle(), uid, postId, input, now, {
      matchCandidates: options.matchCandidates,
    });
  }
}

// ---- 建立並公開站內刊登（`POST /api/self-listings`，第八十四批）-----------------------------
//
// 同步版整條讀寫節點本機：可刊登條件（`users`）、同時公開數、草稿列、夾具 registry、
// 頭像／條件值與配對候選 ⇒ PG 模式下新刊登落在這台節點，**站上的清單讀 PG ⇒ 剛刊登的物件
// 不在站上**（而且 `assertCanPublish()` 讀的是本機的停權與註冊時間）。
//
// 驗證與欄位正規化全部沿用 `selfListings.js` 的純函式；這裡只換「跑語句的人」。

/** `stage1FixtureRegistry.js:isActiveRegistryFixtureUser()` 的 PG 版。 */
export async function isActiveRegistryFixtureUserAsync(run, userId, now = new Date()) {
  const uid = Number(userId) || 0;
  if (!uid) return false;
  try {
    const rows = rowsOf(await run(REGISTRY_ACTIVE_USER_SQL, [
      STAGE1_FIXTURE_NAMESPACE, STAGE1_FIXTURE_KIND.USER, uid, STAGE1_FIXTURE_STATUS.ACTIVE, isoOf(now),
    ]));
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** `stage1FixtureRegistry.js:fixtureNamespaceFromIsolation()` 的 PG 版。 */
export async function fixtureNamespaceFromIsolationAsync(run, userId, now = new Date(), isolation = null) {
  if (
    !isolation
    || typeof isolation !== "object"
    || isolation[FIXTURE_ISOLATION] !== true
    || Number(isolation.userId) !== Number(userId)
    || !(await isActiveRegistryFixtureUserAsync(run, userId, now))
  ) {
    return "";
  }
  const ns = String(isolation.namespace || "").trim();
  return ns === STAGE1_FIXTURE_NAMESPACE ? ns : "";
}

/** `stage1FixtureRegistry.js:isFixtureMaturityAuthorized()` 的 PG 版。 */
export async function isFixtureMaturityAuthorizedAsync(run, userId, now = new Date(), maturity = null) {
  return Boolean(
    maturity
    && typeof maturity === "object"
    && maturity[FIXTURE_MATURITY] === true
    && Number(maturity.userId) === Number(userId)
    && (await isActiveRegistryFixtureUserAsync(run, userId, now)),
  );
}

/** `stage1FixtureRegistry.js:registerFixtureRow()` 的 PG 版（回傳那一列）。 */
export async function registerFixtureRowAsync(run, {
  namespace = STAGE1_FIXTURE_NAMESPACE,
  runId,
  kind,
  role,
  rowId,
  now = new Date(),
  ttlMs = STAGE1_FIXTURE_TTL_MS,
} = {}) {
  const id = Number(rowId) || 0;
  if (!id) throw new Error("fixture registry row_id is required");
  if (!runId) throw new Error("fixture registry run_id is required");
  if (!kind || !role) throw new Error("fixture registry kind and role are required");
  const created = isoOf(now);
  const expires = new Date((now instanceof Date ? now.getTime() : Date.parse(now) || Date.now()) + Number(ttlMs || STAGE1_FIXTURE_TTL_MS)).toISOString();
  await run(REGISTRY_INSERT_SQL, [namespace, runId, kind, role, id, created, expires, STAGE1_FIXTURE_STATUS.ACTIVE]);
  return { namespace, run_id: runId, kind, role, row_id: id, created_at: created, expires_at: expires, cleaned_at: null, status: STAGE1_FIXTURE_STATUS.ACTIVE };
}

/** `selfListings.js:createSelfListing()` 的 PG 版（含冪等鍵）。 */
export async function createSelfListingAsync(userId, input = {}, options = {}) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入才能刊登", 401);
  const now = options.now ? new Date(options.now) : new Date();
  if (!isPg(options)) {
    const { createSelfListing } = await import("./selfListings.js");
    const { listMatchCandidates } = await import("./db.js");
    return createSelfListing(sqliteHandle(), uid, input, now, {
      // 🚨 `createSelfListing()` 是**同步**的，而呼叫端（server.js）傳進來的
      // `options.matchCandidates` 是 async 的 PG 島嶼版本。直接往下傳，`bestMatch()` 會拿到
      // 一個 Promise，於是每一次站內刊登都在 SQLite 模式回
      // 「(candidates || []) is not iterable」（400）——使用者只看到一句天書，刊登完全不能用。
      // 這裡改成同步版（同一組 SQL builder，只是走本機 handle）。
      matchCandidates: (listing) => listMatchCandidates(listing?.post_id || 0, listing || null),
      maturity: options.maturity,
      isolation: options.isolation,
    });
  }
  try {
    await getWishConditionsAsync(options);
    const run = await runnerFor(options);
    const key = normalizeSelfListingIdempotencyKey(input.idempotency_key ?? input.idempotencyKey);
    const payloadHash = key ? selfListingCreateFingerprint(input) : "";
    if (key) {
      const hit = rowsOf(await run(SELF_CREATE_IDEMPOTENCY_HIT_SQL, [uid, key]))[0];
      if (hit) {
        if (String(hit.payload_hash) !== payloadHash) {
          throw httpError("同一操作不能改成不同內容", 409, "IDEMPOTENCY_CONFLICT");
        }
        return getSelfListingAsync(hit.post_id, { viewerId: uid, ...options, exec: run, driver: "postgres", strict: true });
      }
    }
    const created = await insertOpenSelfListingAsync(run, uid, input, now, options);
    if (key) {
      try {
        await run(SELF_CREATE_IDEMPOTENCY_INSERT_SQL, [uid, key, payloadHash, created.post_id, isoOf(now)]);
      } catch {
        const again = rowsOf(await run(SELF_CREATE_IDEMPOTENCY_HIT_SQL, [uid, key]))[0];
        if (again) {
          if (String(again.payload_hash) !== payloadHash) {
            throw httpError("同一操作不能改成不同內容", 409, "IDEMPOTENCY_CONFLICT");
          }
          return getSelfListingAsync(again.post_id, { viewerId: uid, ...options, exec: run, driver: "postgres", strict: true });
        }
      }
    }
    return created;
  } catch (error) {
    if (error?.status) throw error;
    if (!sqliteFallbackAllowed(options, { write: true })) throw error;
    const { createSelfListing } = await import("./selfListings.js");
    return createSelfListing(sqliteHandle(), uid, input, now, {
      matchCandidates: options.matchCandidates, maturity: options.maturity, isolation: options.isolation,
    });
  }
}

/** `selfListings.js:insertOpenSelfListing()` 的 PG 版（建立並公開一則站內刊登）。 */
export async function insertOpenSelfListingAsync(run, uid, input = {}, now = new Date(), options = {}) {
  const id = Number(uid) || 0;
  const maturity = options.maturity || options.isolation;
  await assertCanPublishAsync(run, id, now, { maturity, options });
  const isolation = options.isolation || null;
  const fixtureNs = await fixtureNamespaceFromIsolationAsync(run, id, now, isolation);

  const districts = normalizeWatchDistricts(input.district ? [input.district] : input.districts).slice(0, 1);
  if (!districts.length) throw httpError("請選一個行政區");
  const district = lookupDistrict(districts[0]);
  if (!district) throw httpError("請選一個有效行政區");
  const rent = Math.round(Number(input.rent || input.price_num) || 0);
  if (!(rent >= 1000 && rent <= 200000)) throw httpError("請填每月租金（1,000～200,000）");
  const ping = Number(String(input.ping || input.area || "").replace(/坪/g, ""));
  if (!(ping > 0 && ping <= 500)) throw httpError("請填坪數");
  if (input.accept_pledge !== true) throw httpError("請勾選屋主／代理人聲明後才能刊登");

  const address = composeSelfAddress(district, input.street || input.address);
  const body = sanitizeListingBodyHtml(input.body || "", SELF_BODY_MAX);
  if (listingBodyPlain(body).length < SELF_BODY_MIN) throw httpError(SELF_BODY_HINT);
  const kind = kindId(input.kind || input.housing_type);
  const role = roleId(input.role);
  const layout = layoutText(input);
  const floorName = floorText(input);
  if (!floorName) throw httpError("請填出租樓層");
  let contactName = String(input.contact_name || "").trim().slice(0, SELF_CONTACT_MAX);
  if (!contactName) {
    try {
      contactName = String(rowsOf(await run("SELECT nickname FROM users WHERE id = ?", [id]))[0]?.nickname || "").trim();
    } catch {
      contactName = "";
    }
  }
  const phone = digitsPhone(input.phone || input.mobile);
  const lineUrl = normalizeLineUrl(input.line_url);
  if (phone && phone.replace(/\D/g, "").length < 8) throw httpError("電話號碼太短");
  const extra = catalogTraitExtras({ includeInactive: true });
  const resolved = resolveListingTraits(input);
  const traitIds = resolved.traitIds;
  const deposit = normalizeDeposit(input.deposit);
  const photos = normalizePhotoList(input.photos || input.photo_urls);
  const cover = normalizePhotoUrl(input.cover || input.photo_url) || photos[0] || "";
  if (cover && !photos.includes(cover)) photos.unshift(cover);
  const storedPhotos = photos.slice(0, SELF_PHOTO_MAX_COUNT);
  const kindName = kindLabel(kind);
  const roleName = roleLabel(role);
  const areaName = `${String(Math.round(ping * 10) / 10).replace(/\.0$/, "")}坪`;
  const title = requireListingTitle(input.title);
  const created = isoOf(now);
  const expires = new Date((now instanceof Date ? now.getTime() : Date.parse(now) || Date.now()) + SELF_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const postId = Number(isolation?.rowId) || await nextSelfPostIdAsync(run);
  const sourceKey = selfSourceKey({
    regionId: district.region, sectionId: district.id, address, floorName, areaName, layout,
  });
  const searchKey = selfSearchKey(district.region, district.id);
  await run(SELF_OPEN_INSERT_SQL, selfOpenInsertParams({
    postId, sourceKey, searchKey, title, priceText: String(rent), rent, address, areaName, layout,
    floorName, kindName, roleName, cover: storedPhotos[0] || cover,
    tags: ["吉比本站", ...selfTraitLabels(traitIds, extra.labels), depositLabel(deposit)].filter(Boolean),
    created, fixtureNs,
  }));
  await run(SELF_OPEN_UPDATE_SQL, selfOpenUpdateParams({
    uid: id, postId, expires, body, storedPhotos, traitIds, deposit, created, contactName, roleName, phone, lineUrl,
    // R2：與同步版共用同一個解析器（費用三態、地址定位、步行捷運查證）。
    ...resolveSelfListingMeta(input, {}, { mrtCacheContract: MRT_CACHE_CONTRACT }),
  }));
  if (fixtureNs && isolation?.runId && isolation.kind && isolation.role && isolation.registered !== true) {
    await registerFixtureRowAsync(run, {
      namespace: fixtureNs, runId: isolation.runId, kind: isolation.kind, role: isolation.role, rowId: postId, now,
    });
  }
  if (typeof isolation?.onAfterInsert === "function") isolation.onAfterInsert({ postId, fixtureNs });
  await setPublisherFaceAsync(run, postId, id);
  const listing = rowsOf(await run(LISTING_BY_POST_ID_SQL, [postId]))[0];
  const candidateExec = async (sql, params = []) => rowsOf(await run(sql, params));
  const candidates = typeof options.matchCandidates === "function"
    ? await options.matchCandidates(listing)
    : await matchCandidatesAsync(listing.post_id, listing, { ...options, driver: "postgres", exec: candidateExec });
  const hit = bestMatch(listing, candidates);
  if (hit?.listing) {
    await run(MATCH_SET_SQL, [hit.listing.post_id, hit.level, hit.detail, postId]);
  }
  await persistListingValuesAsync(run, postId, resolved.listingValues);
  // 本機鏡射（還沒搬完的讀取看的是它）；失敗不該讓已經寫進 PG 的刊登回錯。
  try {
    const { insertOpenSelfListing } = await import("./selfListings.js");
    void insertOpenSelfListing;
    const { createSelfListing } = await import("./selfListings.js");
    createSelfListing(sqliteHandle(), id, input, now, { matchCandidates: () => [], maturity });
  } catch { /* 本機鏡射盡力而為 */ }
  return getSelfListingAsync(postId, { viewerId: id, ...options, exec: run, driver: "postgres", strict: true });
}
