import { allDistricts, lookupDistrict, normalizeWatchDistricts } from "./regions.js";
import { coverToListUrl } from "./covering.js";
import { bestMatch } from "./match.js";
import { isSelfPhotoPublicUrl, SELF_PHOTO_MAX_BYTES, SELF_PHOTO_MAX_COUNT } from "./selfPhotos.js";
import { isMemberMediaUrl } from "./memberMedia.js";
import {
  SELF_BODY_TEMPLATES,
  SELF_DEPOSIT_OPTIONS,
  SELF_TRAIT_GROUPS,
  depositLabel,
  normalizeDeposit,
  normalizeSelfTraits,
  normalizeSelfTraitsInput,
  selfTraitLabels,
} from "./selfTraits.js";
import { ensureProfileSchema } from "./profile.js";
import { listingBodyPlain, sanitizeListingBodyHtml } from "./listingBody.js";
import {
  catalogAsSelfTraitGroups,
  listingValuesFromKnownTraits,
  mergeListingConditionValues,
  traitsFromListingValues,
} from "./rentalCatalog.js";
import { isRentalCatalogV2Enabled } from "./rentalMarketplaceFlags.js";
import {
  ensureSelfListingIdempotencySchema,
  normalizeSelfListingIdempotencyKey,
  selfListingCreateFingerprint,
} from "./selfListingIdempotency.js";
import { LISTING_SURFACE, listingVisibleOnSurface } from "./stage1FixtureIsolation.js";
import {
  ensureStage1FixtureSchema,
  fixtureNamespaceFromIsolation,
  isFixtureMaturityAuthorized,
  registerFixtureRow,
} from "./stage1FixtureRegistry.js";

let listingCatalog = null;
let listingFlags = {};
let listingOfferHook = null;

// 讀取目前註冊的 hook。PG 分支（selfListingsAsync.js）需要「用本機 handle 呼叫同一個 hook」，
// 所以要有 getter（原本只有 setter）。只加匯出，行為不變。
export function getListingOfferHook() {
  return listingOfferHook;
}

export function setListingOfferHook(fn) {
  listingOfferHook = typeof fn === "function" ? fn : null;
}

export function setSelfListingCatalog(catalog, flags) {
  listingCatalog = catalog || null;
  if (flags) listingFlags = flags;
}

export function setSelfListingHydrate(catalog, flags) {
  if (catalog && typeof catalog === "object" && !Array.isArray(catalog.categories) && (catalog.catalog || catalog.flags)) {
    setSelfListingCatalog(catalog.catalog || listingCatalog, catalog.flags || flags);
    return;
  }
  setSelfListingCatalog(catalog, flags);
}

export function catalogTraitExtras({ includeInactive = false } = {}) {
  if (!listingCatalog || !isRentalCatalogV2Enabled(listingFlags)) return { ids: [], labels: {} };
  const ids = [];
  const labels = {};
  for (const group of catalogAsSelfTraitGroups(listingCatalog, { includeInactive })) {
    for (const item of group.items) {
      ids.push(item.id);
      labels[item.id] = item.label;
      if (item.canonical_id) {
        ids.push(item.canonical_id);
        labels[item.canonical_id] = item.label;
      }
      if (item.listing_negative) {
        ids.push(item.listing_negative);
        labels[item.listing_negative] = item.label;
      }
      if (item.listing_legacy) {
        ids.push(item.listing_legacy);
        labels[item.listing_legacy] = item.label;
      }
    }
  }
  return { ids, labels };
}

/**
 * A3：**顯示名稱**用的對照表。刻意**不**受 `rental_catalog_v2` 旗標影響。
 *
 * 為什麼要跟 `catalogTraitExtras()` 分開：
 *   - `catalogTraitExtras().ids` 決定「哪些 trait id 可以寫入」⇒ 必須繼續綁旗標，
 *     旗標一關就不該突然接受目錄才有的 id。
 *   - **標籤只是顯示**。工作單要求「顯示名稱與穩定的條件 ID／key 必須分開處理」，
 *     所以後台改完名稱並發布後，前台（刊登表單、我的刊登卡片、公開分享頁）
 *     都應該顯示新名稱，不必重新部署、也不該因為旗標沒開就卡在舊的靜態名稱。
 *
 * ⚠️ 這裡只回傳 id → label，不動任何結構；呼叫端只拿它覆蓋顯示字串。
 */
const traitLabelMapCache = new WeakMap();

export function catalogTraitLabelMap(catalog = listingCatalog) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) return {};
  // 逐列呼叫（`decorateSelfListing`）時不該每次重新展開整份目錄：用 WeakMap 依目錄物件記憶，
  // 目錄換新（hydrate／publish）時舊的快取自然失效。
  const cached = traitLabelMapCache.get(catalog);
  if (cached) return cached;
  const labels = {};
  try {
    for (const group of catalogAsSelfTraitGroups(catalog, { includeInactive: true })) {
      for (const item of group.items) {
        if (!item?.id || !item?.label) continue;
        labels[item.id] = item.label;
        if (item.canonical_id) labels[item.canonical_id] = item.label;
        if (item.listing_negative) labels[item.listing_negative] = item.label;
        if (item.listing_legacy) labels[item.listing_legacy] = item.label;
      }
    }
  } catch {
    return {};
  }
  traitLabelMapCache.set(catalog, labels);
  return labels;
}

/** 把目錄的顯示名稱覆蓋到一組 trait 群組上（結構與 id 完全不動）。 */
export function overlayTraitLabels(groups, labels = {}) {
  const map = labels instanceof Map ? labels : new Map(Object.entries(labels || {}));
  if (!map.size || !Array.isArray(groups)) return groups;
  return groups.map((group) => ({
    ...group,
    items: (group.items || []).map((item) => {
      const next = map.get(item?.id);
      return next && next !== item.label ? { ...item, label: next } : item;
    }),
  }));
}

function parseListingValues(row) {
  try {
    const raw = row?.listing_condition_values;
    return raw && typeof raw === "object" ? raw : JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

export function resolveListingTraits(input = {}, previous = {}) {
  if (!listingCatalog || !isRentalCatalogV2Enabled(listingFlags)) {
    return {
      traitIds: normalizeSelfTraitsInput(input.traits, catalogTraitExtras().ids),
      listingValues: {},
    };
  }
  const previousTraits = (() => {
    try { return JSON.parse(previous.self_traits || "[]"); } catch { return []; }
  })();
  const listingValues = mergeListingConditionValues(
    listingCatalog,
    input.listing_values || {},
    input.traits || [],
    parseListingValues(previous),
    previousTraits,
  );
  const extraActive = catalogTraitExtras({ includeInactive: false });
  const extraAll = catalogTraitExtras({ includeInactive: true });
  const fromValues = traitsFromListingValues(listingValues, listingCatalog);
  const incoming = normalizeSelfTraitsInput(input.traits, extraActive.ids)
    .filter((id) => extraActive.ids.includes(id));
  const historical = normalizeSelfTraits(previousTraits, extraAll.ids);
  const inactive = new Set(
    catalogAsSelfTraitGroups(listingCatalog, { includeInactive: true })
      .flatMap((group) => group.items)
      .filter((item) => item.enabled === false)
      .flatMap((item) => [item.id, item.canonical_id, item.listing_negative, item.listing_legacy].filter(Boolean)),
  );
  const traitIds = [];
  const push = (id) => {
    const key = String(id || "").trim();
    if (key && !traitIds.includes(key)) traitIds.push(key);
  };
  fromValues.forEach(push);
  incoming.forEach(push);
  for (const id of historical) {
    if (inactive.has(id)) push(id);
  }
  return { traitIds: traitIds.slice(0, 40), listingValues };
}

export const PERSIST_LISTING_VALUES_SQL = "UPDATE listings SET listing_condition_values = ? WHERE post_id = ?";

function persistListingValues(db, postId, listingValues) {
  if (!listingCatalog || !isRentalCatalogV2Enabled(listingFlags)) return;
  try {
    db.prepare(PERSIST_LISTING_VALUES_SQL)
      .run(JSON.stringify(listingValues || {}), postId);
  } catch {
    // column missing in isolated tests before ensureSelfListingSchema
  }
}

export const SELF_POST_ID_BASE = 2_100_000_000;
export const SELF_POST_ID_END = 2_200_000_000;
export const SELF_MAX_OPEN = 10;
export const SELF_TTL_DAYS = 30;
export const SELF_NEW_ACCOUNT_WAIT_MS = 24 * 60 * 60 * 1000;
export const SELF_TITLE_MAX = 80;
export const SELF_TITLE_MIN = 5;
export const SELF_BODY_MAX = 500;
export const SELF_BAN_DAYS = 14;
export const SELF_BODY_MIN = 8;
/**
 * A1：工作單指定的**提示與錯誤訊息**統一用這一句（原文，不加「（至少 N 個字）」）。
 * 8 字規則仍然照舊執行 —— 字數規則由欄位下方的即時字數提示說明
 * （「目前 N 個字，至少還要 M 個字」），訊息本身照工作單指定的字串。
 */
export const SELF_BODY_HINT = "請寫一些這屋子的故事與回憶";
export const SELF_CONTACT_MAX = 80;
export const SELF_PHOTO_URL_MAX = 500;
export const SELF_REPORT_HIDE_AFTER = 2;

export const SELF_KINDS = [
  { id: "whole", label: "整層住家" },
  { id: "suite", label: "獨立套房" },
  { id: "share", label: "分租套房" },
  { id: "room", label: "雅房" },
  { id: "other", label: "其他" },
];

export const SELF_ROLES = [
  { id: "owner", label: "屋主" },
  { id: "agent", label: "代理人" },
];

export const SELF_LEGAL = "這是免費找房工具，不是仲介、不經手金錢。全站免責已於註冊時同意。自行刊登是公開摘要，沒有即時私訊。此處只需再確認本次刊登的屋主／授權事實。";

export const SELF_AUDIT = "站內物件會不定期抽查。若發現不實、惡作劇或明顯誤導，系統會自動下架，並暫停該帳號上傳物件 14 天。這不是仲介認證，也不保證屋況屬實；請租屋族仍以現場與合約為準。";

export const SELF_RICH_HINT = "來看的人最常問的，其實多半寫在這裡就能先答完。多勾一項、多寫一句，之後就少被重複打擾，也比較快遇到適合的人。";

export const SELF_PLEDGE = "我是這間房子的屋主，或已取得屋主授權的代理人。我確認刊登內容屬實，了解平台會抽查，不實刊登會被下架並暫停上傳。平台不驗證權狀、不保證真實，法律責任由我自行負擔。";

export function isSelfListingId(postId) {
  const n = Number(postId);
  return Number.isFinite(n) && n >= SELF_POST_ID_BASE && n < SELF_POST_ID_END;
}

export function isSelfListingRow(row) {
  return String(row?.source || "") === "self" || isSelfListingId(row?.post_id);
}

export function selfSourceLabel(source) {
  const id = String(source || "591");
  if (id === "self") return "吉比本站";
  if (id === "hbhousing") return "住商";
  if (id === "sinyi") return "信義";
  if (id === "houseprice") return "5168";
  if (id === "ddroom") return "租租通";
  if (id === "housefun") return "好房";
  if (id === "rakuya") return "樂屋網";
  if (id === "591") return "591";
  return id;
}

export function selfListingMeta(options = {}) {
  // A3：`options.catalog` 決定**結構**（只有 v2 旗標開的時候才由目錄決定）；
  // `options.catalogLabels` 決定**顯示名稱**，任何情況都要套用。
  const baseTraits = options.catalog ? catalogAsSelfTraitGroups(options.catalog) : SELF_TRAIT_GROUPS;
  const traits = overlayTraitLabels(baseTraits, options.catalogLabels || {});
  return {
    legal: `${SELF_LEGAL} ${SELF_AUDIT}`,
    max_open: SELF_MAX_OPEN,
    ttl_days: SELF_TTL_DAYS,
    kinds: SELF_KINDS,
    roles: SELF_ROLES,
    traits,
    deposits: SELF_DEPOSIT_OPTIONS,
    templates: SELF_BODY_TEMPLATES,
    body_max: SELF_BODY_MAX,
    audit: SELF_AUDIT,
    rich_hint: SELF_RICH_HINT,
    pledge: SELF_PLEDGE,
    ban_days: SELF_BAN_DAYS,
    photos: {
      max_count: SELF_PHOTO_MAX_COUNT,
      max_bytes: SELF_PHOTO_MAX_BYTES,
      accept: "image/jpeg,image/png,image/webp",
    },
  };
}

/** R2：房東端可以填「租金已包含」的項目（與許願房的五個條件同一組 key）。 */
export const SELF_FEE_INCLUDE_KEYS = Object.freeze(["utilities", "management", "parking_car", "parking_scooter", "internet"]);
export const SELF_FEE_INCLUDE_STATES = Object.freeze(["included", "extra", "unknown"]);

function normalizeFeeIncludeState(value) {
  if (value === true || value === 1 || value === "included" || value === "present" || value === "1") return "included";
  if (value === false || value === 0 || value === "extra" || value === "absent" || value === "0") return "extra";
  return "unknown";
}

/**
 * 正規化屋主填的費用三態。
 * - 只留白名單的 key；沒提到的 key 不存在（＝未確認）
 * - 輸入完全沒帶 `fee_includes` 時沿用 previous（編輯其他欄位不會清掉已填的費用）
 * - 明確填 "unknown" 會蓋掉 previous（屋主可以把它改回未確認）
 */
export function resolveListingFeeIncludes(input = {}, previous = {}) {
  const incoming = input.fee_includes;
  if (incoming === undefined || incoming === null) return String(previous.fee_includes || "");
  let bag = incoming;
  if (typeof bag === "string") {
    const text = bag.trim();
    if (!text) return "";
    try { bag = JSON.parse(text); } catch { return ""; }
  }
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return "";
  const out = {};
  for (const key of SELF_FEE_INCLUDE_KEYS) {
    if (!(key in bag)) continue;
    const state = normalizeFeeIncludeState(bag[key]);
    if (state === "unknown") continue; // 未確認＝等同沒有填，不必存
    out[key] = state;
  }
  return JSON.stringify(out);
}

export function parseListingFeeIncludes(row = {}) {
  const raw = row?.fee_includes;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 給前端顯示用的標籤（房東端填的三態）。 */
export const SELF_FEE_INCLUDE_LABELS = Object.freeze({
  utilities: "水電",
  management: "管理費",
  parking_car: "停汽車位",
  parking_scooter: "停機車位",
  internet: "網路",
});

export function listingFeeIncludeLabels(row = {}) {
  const parsed = parseListingFeeIncludes(row);
  return SELF_FEE_INCLUDE_KEYS
    .filter((key) => parsed[key] === "included")
    .map((key) => `租金含${SELF_FEE_INCLUDE_LABELS[key]}`);
}

/**
 * R2：地址定位與步行捷運查證結果要綁在房源上。
 * - 有傳座標（伺服器端已地理編碼）⇒ 寫入 lat/lng/geo_source
 * - 地址變了卻定位不到 ⇒ **清掉舊座標與舊查證結果**（不可以留著上一個地址的結果）
 * - 沒有查證結果時欄位留空 ⇒ 配對看到的是「未確認」
 */
export function resolveListingLocation(input = {}, previous = {}, { addressChanged = false } = {}) {
  const lat = Number(input.lat);
  const lng = Number(input.lng);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0 && lng !== 0;
  if (hasCoords) {
    return { lat, lng, geo_source: String(input.geo_source || "self"), clear: false };
  }
  if (addressChanged) return { lat: null, lng: null, geo_source: "", clear: true };
  return {
    lat: Number.isFinite(Number(previous.lat)) ? Number(previous.lat) : null,
    lng: Number.isFinite(Number(previous.lng)) ? Number(previous.lng) : null,
    geo_source: String(previous.geo_source || ""),
    clear: false,
  };
}

/**
 * R2：把「這次寫入要落地的費用三態／座標／捷運查證結果」算成一份固定形狀。
 * 三個寫入路徑（建立、草稿發布、匯入發布）與兩個 driver 都用這一份，避免漂移。
 *
 * 規則：
 *   - 費用：輸入沒帶就沿用 previous（編輯其他欄位不會清掉已填的值）
 *   - 座標：這次有定位到就用新的；**地址變了卻定位不到 ⇒ 清空舊座標**；
 *           地址沒變又沒重新定位 ⇒ 沿用 previous
 *   - 捷運：這次有查證結果就用新的；地址變了 ⇒ 一定清掉（舊結果屬於舊地址）；
 *           地址沒變 ⇒ 沿用 previous
 */
export function resolveSelfListingMeta(input = {}, previous = {}, { addressChanged = false } = {}) {
  const location = resolveListingLocation(input, previous, { addressChanged });
  const feeIncludes = resolveListingFeeIncludes(input, previous);
  const walkM = Number(input.mrt_walk_m);
  const hasFresh = Number.isFinite(walkM) && walkM >= 0 && String(input.mrt_source || "");
  let mrt = null;
  if (hasFresh) {
    mrt = {
      station: String(input.mrt_station || ""),
      walk_m: walkM,
      source: String(input.mrt_source),
      checked_at: String(input.mrt_checked_at || new Date().toISOString()),
    };
  } else if (!addressChanged && Number.isFinite(Number(previous.self_mrt_walk_m)) && Number(previous.self_mrt_walk_m) >= 0) {
    mrt = {
      station: String(previous.self_mrt_station || ""),
      walk_m: Number(previous.self_mrt_walk_m),
      source: String(previous.self_mrt_source || ""),
      checked_at: String(previous.self_mrt_checked_at || ""),
    };
  }
  return { feeIncludes, lat: location.lat, lng: location.lng, geoSource: location.geo_source, mrt };
}

export function ensureSelfListingSchema(db) {
  for (const sql of [
    "ALTER TABLE listings ADD COLUMN listed_by_user_id INTEGER",
    "ALTER TABLE listings ADD COLUMN self_status TEXT",
    "ALTER TABLE listings ADD COLUMN self_expires_at TEXT",
    "ALTER TABLE listings ADD COLUMN self_body TEXT",
    "ALTER TABLE listings ADD COLUMN self_photos TEXT",
    "ALTER TABLE listings ADD COLUMN self_traits TEXT",
    "ALTER TABLE listings ADD COLUMN self_pledge_at TEXT",
    "ALTER TABLE listings ADD COLUMN self_deposit TEXT",
    "ALTER TABLE listings ADD COLUMN listing_condition_values TEXT",
    // R2：五項「租金已包含」的房東端三態（"included"／"extra"／"unknown"）。
    // 空字串＝屋主沒有填過（未確認），不可以推論成「已含」或「另計」。
    "ALTER TABLE listings ADD COLUMN fee_includes TEXT NOT NULL DEFAULT ''",
    // R2：已查證的步行捷運結果直接綁在房源列上，內頁顯示與配對讀同一份資料。
    "ALTER TABLE listings ADD COLUMN self_mrt_station TEXT",
    "ALTER TABLE listings ADD COLUMN self_mrt_walk_m REAL",
    "ALTER TABLE listings ADD COLUMN self_mrt_source TEXT",
    "ALTER TABLE listings ADD COLUMN self_mrt_checked_at TEXT",
    "ALTER TABLE listings ADD COLUMN fixture_namespace TEXT",
  ]) {
    try {
      db.exec(sql);
    } catch {
      // already migrated
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS listing_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_listings_self ON listings(source, self_status, listed_by_user_id);
    CREATE INDEX IF NOT EXISTS idx_listings_self_owner_open
      ON listings(listed_by_user_id, self_status, post_id)
      WHERE COALESCE(source, '591') = 'self';
    CREATE INDEX IF NOT EXISTS idx_listing_reports_post ON listing_reports(post_id, user_id);
  `);
  ensureSelfListingIdempotencySchema(db);
  ensureProfileSchema(db);
  ensureStage1FixtureSchema(db);
}

export function sqlNotSelfSource() {
  return `COALESCE(source, '591') != 'self'`;
}

export function sql591Source() {
  return `COALESCE(source, '591') = '591'`;
}

export function sqlOpenSelfListing(nowIso) {
  return {
    sql: `(
      COALESCE(source, '591') != 'self'
      OR (
        COALESCE(self_status, 'open') = 'open'
        AND (self_expires_at IS NULL OR self_expires_at > ?)
      )
    )`,
    params: [nowIso],
  };
}

export function httpError(message, status = 400, code = "") {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function withImmediate(db, fn) {
  try { db.exec("PRAGMA busy_timeout=8000"); } catch { /* ignore */ }
  let last;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      last = error;
      if (!/locked|busy/i.test(String(error.message || ""))) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
      continue;
    }
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
  }
  throw last || new Error("database is locked");
}

function nowMs(now) {
  return now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.now();
}

function iso(now) {
  return new Date(nowMs(now)).toISOString();
}

export function kindLabel(id) {
  return SELF_KINDS.find((row) => row.id === id)?.label || SELF_KINDS[0].label;
}

export function kindId(value) {
  const id = String(value || "whole").trim();
  return SELF_KINDS.some((row) => row.id === id) ? id : "whole";
}

export function roleLabel(id) {
  return SELF_ROLES.find((row) => row.id === id)?.label || "屋主";
}

export function roleId(value) {
  const id = String(value || "owner").trim();
  return SELF_ROLES.some((row) => row.id === id) ? id : "owner";
}

export const USER_CREATED_AT_SQL = "SELECT created_at FROM users WHERE id = ?";

function userCreatedAt(db, userId) {
  try {
    return String(db.prepare(USER_CREATED_AT_SQL).get(userId)?.created_at || "");
  } catch {
    return "";
  }
}

export function expireOpenSelfListings(db, now = new Date()) {
  const stamp = iso(now);
  try {
    const result = db.prepare(
      `UPDATE listings
       SET self_status = 'expired'
       WHERE source = 'self'
         AND COALESCE(self_status, 'open') = 'open'
         AND IFNULL(self_expires_at, '') != ''
         AND self_expires_at <= ?`,
    ).run(stamp);
    return Number(result.changes) || 0;
  } catch {
    return 0;
  }
}

export const OPEN_SELF_COUNT_SQL = `SELECT COUNT(*) AS n FROM listings
     WHERE listed_by_user_id = ?
       AND COALESCE(source, '591') = 'self'
       AND COALESCE(self_status, 'open') = 'open'`;

export const SELF_BAN_UNTIL_SQL = "SELECT self_ban_until FROM users WHERE id = ?";

function selfBanUntil(db, userId) {
  try {
    return String(db.prepare(SELF_BAN_UNTIL_SQL).get(userId)?.self_ban_until || "");
  } catch {
    return "";
  }
}

export function banSelfPublisher(db, userId, now = new Date()) {
  const uid = Number(userId) || 0;
  if (!uid) return "";
  const until = selfBanStamp(now);
  try {
    db.prepare(BAN_SELF_PUBLISHER_SQL).run(until, uid);
  } catch {
    // 測試庫可能還沒有這欄
  }
  return until;
}

function assertCanPublish(db, userId, now = new Date(), { maturity } = {}) {
  const banned = Date.parse(selfBanUntil(db, userId));
  if (Number.isFinite(banned) && banned > nowMs(now)) {
    const when = new Date(banned).toISOString().slice(0, 10);
    throw httpError(`因不實刊登暫停上傳，直到 ${when}`, 403);
  }
  const created = Date.parse(userCreatedAt(db, userId));
  const skipWait = isFixtureMaturityAuthorized(db, userId, now, maturity);
  if (!skipWait && Number.isFinite(created) && nowMs(now) - created < SELF_NEW_ACCOUNT_WAIT_MS) {
    throw httpError("新帳號註冊滿 24 小時後才能自行刊登，避免洗版", 403);
  }
  expireOpenSelfListings(db, now);
  const open = db.prepare(OPEN_SELF_COUNT_SQL).get(userId);
  if (Number(open?.n) >= SELF_MAX_OPEN) {
    throw httpError(`同時最多 ${SELF_MAX_OPEN} 則未過期的站內刊登，請先關閉一則`, 403);
  }
}

export function nextSelfPostId(db) {
  const row = db.prepare(NEXT_SELF_POST_ID_SQL).get(SELF_POST_ID_BASE, SELF_POST_ID_END);
  const current = Number(row?.n) || SELF_POST_ID_BASE;
  const next = Math.max(SELF_POST_ID_BASE, current) + 1;
  if (next >= SELF_POST_ID_END) throw httpError("站內刊登編號已滿", 500);
  return next;
}

function publisherAvatar(db, uid) {
  try {
    return String(db.prepare(PUBLISHER_AVATAR_SQL).get(uid)?.avatar_url || "").trim();
  } catch {
    return "";
  }
}

export const PUBLISHER_AVATAR_SQL = "SELECT avatar_url FROM users WHERE id=?";
export const SET_PUBLISHER_FACE_SQL = "UPDATE listings SET avatar = ?, contact_uid = ? WHERE post_id = ?";

function setPublisherFace(db, postId, uid) {
  const avatar = publisherAvatar(db, uid);
  try {
    db.prepare(SET_PUBLISHER_FACE_SQL).run(avatar, String(uid), postId);
  } catch {
    try {
      db.prepare("UPDATE listings SET avatar = ? WHERE post_id = ?").run(avatar, postId);
    } catch { /* test schema may omit these columns */ }
  }
}

export function requireListingTitle(raw, fallback = "") {
  const title = String(raw || fallback || "").trim().slice(0, SELF_TITLE_MAX);
  if (title.length < SELF_TITLE_MIN) throw httpError(`標題至少 ${SELF_TITLE_MIN} 個字`);
  return title;
}

export function composeSelfAddress(district, streetOrFull) {
  const prefix = `${district.city}${district.name}`;
  let street = String(streetOrFull || "").replace(/\s+/g, " ").trim();
  if (street.startsWith(prefix)) street = street.slice(prefix.length).trim();
  if (!/[路街巷弄大道]/.test(street) || street.replace(/\s+/g, "").length < 2) {
    throw httpError("請至少加上路名（例如 中正路 100 號）");
  }
  return `${prefix}${street}`;
}

export function digitsPhone(value) {
  return String(value || "").replace(/[^\d+]/g, "");
}

export function normalizePhotoUrl(value) {
  const raw = String(value || "").trim().slice(0, SELF_PHOTO_URL_MAX);
  if (!raw) return "";
  if (isSelfPhotoPublicUrl(raw)) return raw;
  if (isMemberMediaUrl(raw)) return raw; // 會員素材庫照片（/media/lib/...）；所有權由路由層驗證
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw httpError("封面網址格式不正確");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw httpError("封面只接受 http 或 https 網址，或本站上傳的照片");
  }
  return url.toString().slice(0, SELF_PHOTO_URL_MAX);
}

// 匯出給 PG 版：草稿欄位的正規化（照片清單）兩個 driver 必須相同。
export function normalizePhotoList(input) {
  const raw = Array.isArray(input) ? input : [];
  const out = [];
  for (const item of raw) {
    const url = normalizePhotoUrl(item);
    if (url && !out.includes(url)) out.push(url);
  }
  return out.slice(0, SELF_PHOTO_MAX_COUNT);
}

export function listingPhotoUrls(row) {
  let stored = [];
  try {
    const parsed = JSON.parse(row?.self_photos || "[]");
    stored = Array.isArray(parsed) ? parsed : [];
  } catch {
    stored = [];
  }
  const cover = String(row?.cover || "").trim();
  const out = [];
  for (const item of [cover, ...stored]) {
    const url = String(item || "").trim();
    if (url && !out.includes(url)) out.push(url);
  }
  return out.slice(0, SELF_PHOTO_MAX_COUNT);
}

export function normalizeLineUrl(value) {
  const raw = String(value || "").trim().slice(0, 300);
  if (!raw) return "";
  if (/^https:\/\/(line\.me|lin\.ee)\//i.test(raw)) return raw;
  throw httpError("LINE 請貼 https://line.me 或 https://lin.ee 連結");
}

export function layoutText(input) {
  const rooms = Math.max(0, Math.min(12, Math.round(Number(input.rooms) || 0)));
  const living = Math.max(0, Math.min(8, Math.round(Number(input.living) || 0)));
  const bath = Math.max(0, Math.min(8, Math.round(Number(input.bath) || 0)));
  if (rooms || living || bath) {
    return `${rooms}房${living}廳${bath}衛`;
  }
  const raw = String(input.layout || "").trim().slice(0, 20);
  return raw || "格局未填";
}

export function floorText(input) {
  const floor = Math.max(0, Math.min(80, Math.round(Number(input.floor) || 0)));
  const total = Math.max(0, Math.min(80, Math.round(Number(input.total_floors) || 0)));
  if (floor && total) return `${floor}F/${total}F`;
  if (floor) return `${floor}F`;
  return String(input.floor_name || "").trim().slice(0, 20);
}

export function selfSourceKey({ regionId, sectionId, address, floorName, areaName, layout }) {
  const addr = String(address || "").replace(/\s+/g, "").toLowerCase();
  const floor = String(floorName || "").split("/")[0].trim();
  const area = String(areaName || "").replace(/坪/g, "");
  return [regionId || "", sectionId || "", "", addr, floor, area, layout].join("|");
}

export function selfSearchKey(regionId, sectionId) {
  return coverToListUrl({
    regionId,
    sectionIds: [sectionId],
    priceMin: 0,
    priceMax: 0,
  });
}

export function decorateSelfListing(row, { viewerId = 0 } = {}) {
  if (!row) return row;
  return {
    post_id: Number(row.post_id),
    source: "self",
    source_label: "吉比本站",
    title: String(row.title || ""),
    url: String(row.url || `/go/${row.post_id}`),
    price: String(row.price || ""),
    price_num: Number(row.price_num) || 0,
    address: String(row.address || ""),
    area_name: String(row.area_name || ""),
    layout: String(row.layout || ""),
    floor_name: String(row.floor_name || ""),
    kind_name: String(row.kind_name || ""),
    role_name: String(row.role_name || ""),
    cover: String(row.cover || ""),
    photos: listingPhotoUrls(row),
    body: sanitizeListingBodyHtml(String(row.self_body || ""), SELF_BODY_MAX),
    traits: (() => {
      try {
        return normalizeSelfTraits(JSON.parse(row.self_traits || "[]"), catalogTraitExtras({ includeInactive: true }).ids);
      } catch {
        return [];
      }
    })(),
    trait_labels: (() => {
      try {
        // A3：標籤一律跟著已發布的共用條件目錄走（不受 v2 旗標影響）。
        return selfTraitLabels(JSON.parse(row.self_traits || "[]"), catalogTraitLabelMap());
      } catch {
        return [];
      }
    })(),
    // R2：屋主填的費用三態（重新編輯要原樣還原）與已查證的步行捷運結果。
    fee_includes: parseListingFeeIncludes(row),
    fee_include_labels: listingFeeIncludeLabels(row),
    mrt_station: String(row.self_mrt_station || ""),
    mrt_walk_m: Number.isFinite(Number(row.self_mrt_walk_m)) && Number(row.self_mrt_walk_m) >= 0
      ? Number(row.self_mrt_walk_m)
      : null,
    mrt_walk_km: (() => {
      const m = Number(row.self_mrt_walk_m);
      return Number.isFinite(m) && m >= 0 ? Math.round((m / 1000) * 10) / 10 : null;
    })(),
    mrt_checked_at: String(row.self_mrt_checked_at || ""),
    listing_values: (() => {
      const stored = parseListingValues(row);
      if (stored && Object.keys(stored).length) return stored;
      if (!listingCatalog || !isRentalCatalogV2Enabled(listingFlags)) return {};
      try {
        return listingValuesFromKnownTraits(JSON.parse(row.self_traits || "[]"), listingCatalog);
      } catch {
        return {};
      }
    })(),
    deposit: String(row.self_deposit || ""),
    pledged: Boolean(row.self_pledge_at),
    contact_name: String(row.contact_name || ""),
    contact_role: String(row.contact_role || row.role_name || ""),
    mobile: String(row.mobile || row.phone || ""),
    phone: String(row.phone || row.mobile || ""),
    line_url: String(row.line_url || ""),
    status: String(row.self_status || "open"),
    created_at: row.first_seen_at,
    expires_at: row.self_expires_at || null,
    match_level: row.match_level || null,
    match_detail: row.match_detail || "",
    match_post_id: Number(row.match_post_id) || 0,
    mine: Number(row.listed_by_user_id) === Number(viewerId),
  };
}

/** 公開分享頁／API 白名單：不含帳號、所有權、媒合與刊登狀態等私有欄位。 */
export function publicListingView(listing, id) {
  return {
    id: Number(listing?.post_id || listing?.id || id) || 0,
    title: listing?.title || "",
    price: listing?.price || "",
    price_num: Number(listing?.price_num) || 0,
    address: listing?.address || "",
    area_name: listing?.area_name || "",
    layout: listing?.layout || "",
    floor_name: listing?.floor_name || "",
    kind_name: listing?.kind_name || "",
    role_name: listing?.role_name || "",
    cover: listing?.cover || "",
    photos: Array.isArray(listing?.photos) ? listing.photos : [],
    body: listing?.body || "",
    traits: Array.isArray(listing?.traits) ? listing.traits : [],
    trait_labels: Array.isArray(listing?.trait_labels) ? listing.trait_labels : [],
    // R2：租金已包含哪些費用（屋主自己填的三態）。沒有填的項目不會出現在這裡。
    fee_includes: listing?.fee_includes && typeof listing.fee_includes === "object" ? listing.fee_includes : {},
    fee_include_labels: Array.isArray(listing?.fee_include_labels) ? listing.fee_include_labels : [],
    deposit: listing?.deposit || "",
    contact_name: listing?.contact_name || "",
    contact_role: listing?.contact_role || "",
    mobile: listing?.mobile || "",
    phone: listing?.phone || "",
    line_url: listing?.line_url || "",
    created_at: listing?.created_at || null,
  };
}

export function getSelfRow(db, postId) {
  return db.prepare(
    "SELECT * FROM listings WHERE post_id = ? AND COALESCE(source, '591') = 'self'",
  ).get(Number(postId) || 0);
}

// 自己的站內刊登（同步與 PG 版共用同一句；PG 島嶼在 `rentalMatchAsync.js`）。
export const SELF_LISTINGS_BY_OWNER_SQL = `SELECT * FROM listings
     WHERE listed_by_user_id = ? AND COALESCE(source, '591') = 'self'
     ORDER BY post_id DESC LIMIT 30`;

export function listMineSelfListings(db, userId) {
  const uid = Number(userId) || 0;
  if (!uid) return [];
  expireOpenSelfListings(db);
  return db.prepare(SELF_LISTINGS_BY_OWNER_SQL).all(uid).map((row) => decorateSelfListing(row, { viewerId: uid }));
}

export function getSelfListing(db, postId, { viewerId = 0 } = {}) {
  expireOpenSelfListings(db);
  const row = getSelfRow(db, postId);
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

function readCreateIdempotency(db, uid, key) {
  return db.prepare(
    "SELECT payload_hash, post_id FROM self_listing_create_idempotency WHERE user_id=? AND idempotency_key=?",
  ).get(uid, key);
}

function insertCreateIdempotency(db, uid, key, payloadHash, postId, now) {
  db.prepare(
    `INSERT INTO self_listing_create_idempotency(user_id, idempotency_key, payload_hash, post_id, created_at)
     VALUES (?,?,?,?,?)`,
  ).run(uid, key, payloadHash, postId, iso(now));
}

export function createSelfListing(db, userId, input = {}, now = new Date(), { matchCandidates, maturity, isolation } = {}) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入才能刊登", 401);
  const key = normalizeSelfListingIdempotencyKey(input.idempotency_key ?? input.idempotencyKey);
  const payloadHash = key ? selfListingCreateFingerprint(input) : "";
  const run = () => {
    if (key) {
      const existing = readCreateIdempotency(db, uid, key);
      if (existing) {
        if (existing.payload_hash !== payloadHash) {
          throw httpError("同一操作不能改成不同內容", 409, "IDEMPOTENCY_CONFLICT");
        }
        return getSelfListing(db, existing.post_id, { viewerId: uid });
      }
    }
    const created = insertOpenSelfListing(db, uid, input, now, { matchCandidates, maturity, isolation });
    if (key) {
      try {
        insertCreateIdempotency(db, uid, key, payloadHash, created.post_id, now);
      } catch (error) {
        const again = readCreateIdempotency(db, uid, key);
        if (again) {
          if (again.payload_hash !== payloadHash) {
            throw httpError("同一操作不能改成不同內容", 409, "IDEMPOTENCY_CONFLICT");
          }
          return getSelfListing(db, again.post_id, { viewerId: uid });
        }
        throw error;
      }
    }
    return created;
  };
  if (!key) return run();
  try {
    return withImmediate(db, run);
  } catch (error) {
    if (/transaction|within/i.test(String(error.message || ""))) return run();
    throw error;
  }
}

// 「建立並公開」的兩句 SQL 與參數組裝（同步與 PG 版共用；`selfListingsAsync.js` 會跑同一份）。
export const SELF_OPEN_INSERT_SQL = `INSERT INTO listings (
      post_id, source_key, search_key, title, url, price, price_num,
      extra_fee, extra_fee_text, price_contain_text, extra_fees, extra_fees_fetched,
      address, area_name, layout, floor_name, kind_name, role_name, cover, tags,
      refresh_time, first_seen_at, last_seen_at, last_event, viewed, watched,
      fixture_namespace
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, '', '', '[]', 1, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, 'new', 0, 0, ?)`;

export function selfOpenInsertParams({
  postId, sourceKey, searchKey, title, priceText, rent, address, areaName, layout, floorName,
  kindName, roleName, cover, tags, created, fixtureNs,
}) {
  return [
    postId, sourceKey, searchKey, title, `/go/${postId}`, priceText, rent,
    address, areaName, layout, floorName, kindName, roleName, cover,
    JSON.stringify(tags || []), created, created, fixtureNs || null,
  ];
}

export const SELF_OPEN_UPDATE_SQL = `UPDATE listings SET
      source = 'self',
      source_id = ?,
      listed_by_user_id = ?,
      self_status = 'open',
      self_expires_at = ?,
      self_body = ?,
      self_photos = ?,
      self_traits = ?,
      self_deposit = ?,
      self_pledge_at = ?,
      fee_includes = ?,
      lat = ?,
      lng = ?,
      geo_source = ?,
      self_mrt_station = ?,
      self_mrt_walk_m = ?,
      self_mrt_source = ?,
      self_mrt_checked_at = ?,
      contact_name = ?,
      contact_role = ?,
      mobile = ?,
      phone = ?,
      line_url = ?,
      contact_fetched = 1
    WHERE post_id = ?`;

export function selfOpenUpdateParams({
  uid, postId, expires, body, storedPhotos, traitIds, deposit, created, contactName, roleName, phone, lineUrl,
  feeIncludes = "", lat = null, lng = null, geoSource = "", mrt = null,
}) {
  return [
    `self:${uid}:${postId}`, uid, expires, body, JSON.stringify(storedPhotos), JSON.stringify(traitIds),
    deposit, created,
    // R2：費用三態與座標／捷運查證結果。
    // `geo_source` 用 CASE：傳 null 代表「這次不動」（沒重新定位），傳空字串代表「清掉舊來源」。
    // R2：費用三態與座標／捷運查證結果一律**明確寫入**（含用 null／空字串清空）；
    // 要保留舊值時由 `resolveSelfListingMeta()` 把舊值原樣帶進來，SQL 不做隱式保留。
    String(feeIncludes || ""),
    Number.isFinite(Number(lat)) && Number(lat) !== 0 ? Number(lat) : null,
    Number.isFinite(Number(lng)) && Number(lng) !== 0 ? Number(lng) : null,
    String(geoSource || ""),
    mrt?.station ? String(mrt.station) : null,
    mrt && Number.isFinite(Number(mrt.walk_m)) ? Number(mrt.walk_m) : null,
    mrt?.source ? String(mrt.source) : null,
    mrt?.checked_at ? String(mrt.checked_at) : null,
    contactName || roleName, roleName, phone, phone, lineUrl, postId,
  ];
}

export const MATCH_SET_SQL = "UPDATE listings SET match_post_id=?, match_level=?, match_detail=?, match_rejected=0 WHERE post_id=?";
export const LISTING_BY_POST_ID_SQL = "SELECT * FROM listings WHERE post_id = ?";
export const SELF_CREATE_IDEMPOTENCY_HIT_SQL =
  "SELECT payload_hash, post_id FROM self_listing_create_idempotency WHERE user_id=? AND idempotency_key=?";
export const SELF_CREATE_IDEMPOTENCY_INSERT_SQL = `INSERT INTO self_listing_create_idempotency(user_id, idempotency_key, payload_hash, post_id, created_at)
     VALUES (?,?,?,?,?)`;

function insertOpenSelfListing(db, uid, input = {}, now = new Date(), { matchCandidates, maturity, isolation } = {}) {
  assertCanPublish(db, uid, now, { maturity: maturity || isolation });
  void input.fixture_namespace;
  const fixtureNs = fixtureNamespaceFromIsolation(db, uid, now, isolation);

  const districts = normalizeWatchDistricts(
    input.district ? [input.district] : input.districts,
  ).slice(0, 1);
  if (!districts.length) throw httpError("請選一個行政區");
  const district = lookupDistrict(districts[0]);
  if (!district) throw httpError("請選一個有效行政區");

  const rent = Math.round(Number(input.rent || input.price_num) || 0);
  if (!(rent >= 1000 && rent <= 200000)) throw httpError("請填每月租金（1,000～200,000）");

  const ping = Number(String(input.ping || input.area || "").replace(/坪/g, ""));
  if (!(ping > 0 && ping <= 500)) throw httpError("請填坪數");

  if (input.accept_pledge !== true) {
    throw httpError("請勾選屋主／代理人聲明後才能刊登");
  }

  const address = composeSelfAddress(district, input.street || input.address);

  const body = sanitizeListingBodyHtml(input.body || "", SELF_BODY_MAX);
  const plainBody = listingBodyPlain(body);
  if (plainBody.length < SELF_BODY_MIN) throw httpError(SELF_BODY_HINT);

  const kind = kindId(input.kind || input.housing_type);
  const role = roleId(input.role);
  const layout = layoutText(input);
  const floorName = floorText(input);
  if (!floorName) throw httpError("請填出租樓層");

  let contactName = String(input.contact_name || "").trim().slice(0, SELF_CONTACT_MAX);
  if (!contactName) {
    try {
      contactName = String(db.prepare("SELECT nickname FROM users WHERE id = ?").get(uid)?.nickname || "").trim();
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

  const created = iso(now);
  const expires = new Date(nowMs(now) + SELF_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const postId = Number(isolation?.rowId) || nextSelfPostId(db);
  if (typeof isolation?.onBeforeInsert === "function") isolation.onBeforeInsert({ postId, fixtureNs });
  const sourceKey = selfSourceKey({
    regionId: district.region,
    sectionId: district.id,
    address,
    floorName,
    areaName,
    layout,
  });
  const searchKey = selfSearchKey(district.region, district.id);
  const priceText = String(rent);

  db.prepare(SELF_OPEN_INSERT_SQL).run(...selfOpenInsertParams({
    postId, sourceKey, searchKey, title, priceText, rent, address, areaName, layout, floorName,
    kindName, roleName, cover: storedPhotos[0] || cover,
    tags: ["吉比本站", ...selfTraitLabels(traitIds, extra.labels), depositLabel(deposit)].filter(Boolean),
    created, fixtureNs,
  }));

  db.prepare(SELF_OPEN_UPDATE_SQL).run(...selfOpenUpdateParams({
    uid, postId, expires, body, storedPhotos, traitIds, deposit, created, contactName, roleName, phone, lineUrl,
    // R2：屋主填的費用三態、地址定位結果與捷運查證結果都綁在這一列上。
    ...resolveSelfListingMeta(input, {}),
  }));
  if (fixtureNs && isolation?.runId && isolation.kind && isolation.role && isolation.registered !== true) {
    registerFixtureRow(db, {
      namespace: fixtureNs,
      runId: isolation.runId,
      kind: isolation.kind,
      role: isolation.role,
      rowId: postId,
      now,
    });
  }
  if (typeof isolation?.onAfterInsert === "function") isolation.onAfterInsert({ postId, fixtureNs });
  setPublisherFace(db, postId, uid);

  const listing = db.prepare("SELECT * FROM listings WHERE post_id = ?").get(postId);
  const candidates = typeof matchCandidates === "function"
    ? matchCandidates(listing)
    : [];
  const hit = bestMatch(listing, candidates);
  if (hit?.listing) {
    db.prepare(MATCH_SET_SQL).run(hit.listing.post_id, hit.level, hit.detail, postId);
  }

  persistListingValues(db, postId, resolved.listingValues);
  return getSelfListing(db, postId, { viewerId: uid });
}

/** 匯入結果寫成草稿：不公開、不填聯絡／設施／聲明。工作者不得呼叫 publish。 */
// 匯入草稿的兩句 SQL 與參數組裝（同步與 PG 版共用；PG 版在 `selfListingsAsync.js`）。
// 抽出來的理由與其他批次相同：`source_key`／`source_id`（`import-draft:`／`import:` 前綴）
// 與 `self_status='draft'` 是匯入流程的身分標記，兩邊漂移就會出現「草稿在、匯入列找不到」。
export const IMPORT_DRAFT_INSERT_SQL = `INSERT INTO listings (
      post_id, source_key, search_key, title, url, price, price_num,
      extra_fee, extra_fee_text, price_contain_text, extra_fees, extra_fees_fetched,
      address, area_name, layout, floor_name, kind_name, role_name, cover, tags,
      refresh_time, first_seen_at, last_seen_at, last_event, viewed, watched
    ) VALUES (?, ?, '', ?, ?, '', 0, 0, '', '', '[]', 1, ?, ?, ?, ?, ?, '', ?, ?, '', ?, ?, 'draft', 0, 0)`;

export const IMPORT_DRAFT_UPDATE_SQL = `UPDATE listings SET
      source = 'self',
      source_id = ?,
      listed_by_user_id = ?,
      self_status = 'draft',
      self_body = ?,
      self_photos = ?,
      self_traits = '[]',
      self_deposit = '',
      contact_name = '',
      contact_role = '',
      mobile = '',
      phone = '',
      line_url = '',
      contact_fetched = 0
    WHERE post_id = ?`;

export const IMPORT_DRAFT_COMMUNITY_SQL = "UPDATE listings SET community_name=? WHERE post_id=?";

/** 匯入草稿 INSERT 的參數（純函式）：欄位順序與上面的 SQL 逐字對應。 */
export function importDraftInsertParams({ postId, sourceKey, title, address, areaName, layout, floorName, kindName, photos, tags, created }) {
  return [postId, sourceKey, title || "匯入草稿", `/go/${postId}`, address, areaName, layout,
    floorName, kindName, photos[0] || "", JSON.stringify(tags), created, created];
}

/** 匯入草稿 UPDATE 的參數（純函式）：`source_id` 的 `import:` 前綴只有一份。 */
export function importDraftUpdateParams({ uid, postId, body, photos }) {
  return [`import:${uid}:${postId}`, uid, body, JSON.stringify(photos), postId];
}

export function createImportedDraftListing(db, userId, input = {}, now = new Date()) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入才能匯入", 401);
  const title = String(input.title || "").trim().slice(0, SELF_TITLE_MAX);
  const body = sanitizeListingBodyHtml(input.body || "", SELF_BODY_MAX);
  if (!title && listingBodyPlain(body).length < SELF_BODY_MIN) throw httpError("匯入內容不足以建立草稿", 400);
  const photos = normalizePhotoList(input.photos || []);
  const created = iso(now);
  const postId = nextSelfPostId(db);
  const sourceKey = `import-draft:${uid}:${postId}`;
  const address = String(input.address || "").trim();
  const areaName = String(input.area_name || "").trim();
  const layout = String(input.layout || "").trim();
  const floorName = String(input.floor_name || "").trim();
  const kindName = String(input.kind || input.kind_name || "").trim();
  const community = String(input.community || input.community_name || "").trim();
  const tags = ["吉比本站", community].filter(Boolean);
  db.prepare(IMPORT_DRAFT_INSERT_SQL).run(...importDraftInsertParams({
    postId, sourceKey, title, address, areaName, layout, floorName, kindName, photos, tags, created,
  }));
  db.prepare(IMPORT_DRAFT_UPDATE_SQL).run(...importDraftUpdateParams({ uid, postId, body, photos }));
  if (community) {
    try { db.prepare(IMPORT_DRAFT_COMMUNITY_SQL).run(community, postId); } catch { /* optional column */ }
  }
  return getSelfListing(db, postId, { viewerId: uid });
}

/** 會員自己的內容草稿（複製刊登）。不公開、不帶舊聲明／舊匯入身分。 */
// 複製草稿的兩句 SQL 與參數組裝（同步與 PG 版共用；`listingToolsAsync.js` 會跑同一份）。
export const SELF_DRAFT_INSERT_SQL = `INSERT INTO listings (
      post_id, source_key, search_key, title, url, price, price_num,
      extra_fee, extra_fee_text, price_contain_text, extra_fees, extra_fees_fetched,
      address, area_name, layout, floor_name, kind_name, role_name, cover, tags,
      refresh_time, first_seen_at, last_seen_at, last_event, viewed, watched
    ) VALUES (?, ?, '', ?, ?, ?, ?, 0, '', '', '[]', 1, ?, ?, ?, ?, ?, ?, ?, '[]', '', ?, ?, 'draft', 0, 0)`;
export const SELF_DRAFT_UPDATE_SQL = `UPDATE listings SET
      source = 'self',
      source_id = ?,
      listed_by_user_id = ?,
      self_status = 'draft',
      self_body = ?,
      self_photos = ?,
      self_traits = ?,
      self_deposit = ?,
      contact_name = ?,
      contact_role = ?,
      mobile = ?,
      phone = ?,
      line_url = ?,
      contact_fetched = 0
    WHERE post_id = ?`;
export const NEXT_SELF_POST_ID_SQL = "SELECT MAX(post_id) AS n FROM listings WHERE post_id >= ? AND post_id < ?";

/** 草稿 INSERT 的參數（純函式）：欄位順序與上面的 SQL 逐字對應。 */
export function selfDraftInsertParams({ postId, title, rent, address, areaName, layout, floorName, kindName, roleName, cover, created }) {
  return [postId, `copy-draft:${postId}`, title, `/go/${postId}`, rent ? String(rent) : "", rent,
    address, areaName, layout, floorName, kindName, roleName, cover, created, created];
}

/** 草稿 UPDATE 的參數（純函式）。 */
export function selfDraftUpdateParams({ uid, postId, body, photos, traits, deposit, contactName, roleName, phone, lineUrl }) {
  return [`copy:${uid}:${postId}`, uid, body, JSON.stringify(photos), JSON.stringify(traits), deposit,
    contactName, roleName, phone, phone, lineUrl, postId];
}

export function insertSelfDraftListing(db, userId, fields = {}, now = new Date()) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  const created = iso(now);
  const postId = nextSelfPostId(db);
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
  db.prepare(SELF_DRAFT_INSERT_SQL).run(...selfDraftInsertParams({
    postId, title, rent, address, areaName, layout, floorName, kindName, roleName, cover: photos[0] || "", created,
  }));
  db.prepare(SELF_DRAFT_UPDATE_SQL).run(...selfDraftUpdateParams({
    uid, postId, body, photos, traits, deposit, contactName, roleName, phone, lineUrl,
  }));
  return getSelfListing(db, postId, { viewerId: uid });
}

export function listingFormFields(row) {
  if (!row) return {};
  const decorated = row.post_id && row.self_body == null && row.body != null ? row : null;
  const title = String(decorated?.title || row.title || "");
  const body = String(decorated?.body || row.self_body || row.body || "");
  const address = String(decorated?.address || row.address || "");
  const areaName = String(decorated?.area_name || row.area_name || "");
  const layout = String(decorated?.layout || row.layout || "");
  const floorName = String(decorated?.floor_name || row.floor_name || "");
  const kindName = String(decorated?.kind_name || row.kind_name || "");
  const roleName = String(decorated?.role_name || row.role_name || "");
  const ping = Number(String(areaName).replace(/坪/g, "")) || 0;
  const layoutBits = layout.match(/(\d+)\s*房\s*(\d+)\s*廳\s*(\d+)\s*衛/);
  const floorBits = floorName.match(/(\d+)\s*F(?:\s*\/\s*(\d+)\s*F)?/i);
  const kind = SELF_KINDS.find((item) => item.label === kindName || item.id === row.kind)?.id || "whole";
  const role = SELF_ROLES.find((item) => item.label === roleName || item.id === row.role)?.id || "owner";
  let district = "";
  let street = address;
  const bits = String(row.source_key || "").split("|");
  if (bits.length >= 2 && bits[0] && bits[1] && lookupDistrict(`${bits[0]}-${bits[1]}`)) {
    district = `${bits[0]}-${bits[1]}`;
  }
  if (!district) {
    const found = allDistricts()
      .slice()
      .sort((a, b) => `${b.city}${b.name}`.length - `${a.city}${a.name}`.length)
      .find((item) => address.startsWith(`${item.city}${item.name}`));
    if (found) district = `${found.region}-${found.id}`;
  }
  if (district) {
    const info = lookupDistrict(district);
    const prefix = info ? `${info.city}${info.name}` : "";
    if (prefix && street.startsWith(prefix)) street = street.slice(prefix.length).trim();
  }
  return {
    title,
    body,
    rent: Number(decorated?.price_num || row.price_num) || 0,
    ping,
    kind,
    role,
    district,
    street,
    floor: floorBits ? Number(floorBits[1]) : 0,
    total_floors: floorBits && floorBits[2] ? Number(floorBits[2]) : 0,
    rooms: layoutBits ? Number(layoutBits[1]) : 0,
    living: layoutBits ? Number(layoutBits[2]) : 0,
    bath: layoutBits ? Number(layoutBits[3]) : 0,
    deposit: String(decorated?.deposit || row.self_deposit || row.deposit || ""),
    traits: Array.isArray(decorated?.traits)
      ? decorated.traits
      : (() => {
        try { return normalizeSelfTraits(JSON.parse(row.self_traits || "[]"), catalogTraitExtras({ includeInactive: true }).ids); } catch { return []; }
      })(),
    listing_values: decorated?.listing_values || parseListingValues(row),
    contact_name: String(decorated?.contact_name || row.contact_name || ""),
    phone: String(decorated?.phone || row.phone || row.mobile || ""),
    line_url: String(decorated?.line_url || row.line_url || ""),
    photos: Array.isArray(decorated?.photos) ? decorated.photos : listingPhotoUrls(row),
    address,
  };
}

// 匯入草稿的兩個 UPDATE（PG 也接受、逐字共用）。
export const DRAFT_LISTING_UPDATE_SQL =
  "UPDATE listings SET title=?, self_body=?, self_photos=?, cover=? WHERE post_id=?";
export const ABANDON_DRAFT_LISTING_SQL =
  "UPDATE listings SET self_status='cancelled', last_event='offline', last_seen_at=? WHERE post_id=?";

export function updateImportedDraftListing(db, userId, postId, input = {}) {
  const uid = Number(userId) || 0;
  const row = getSelfRow(db, postId);
  if (!row) throw httpError("找不到這則匯入草稿", 404);
  if (Number(row.listed_by_user_id) !== uid) throw httpError("只能改自己的匯入草稿", 403);
  if (String(row.self_status || "") !== "draft") throw httpError("只有草稿可以修改匯入內容", 409);
  const title = input.title != null ? String(input.title || "").trim().slice(0, SELF_TITLE_MAX) : row.title;
  const body = sanitizeListingBodyHtml(input.body != null ? input.body : row.self_body || "", SELF_BODY_MAX);
  const photos = input.photos != null ? normalizePhotoList(input.photos) : listingPhotoUrls(row);
  db.prepare(DRAFT_LISTING_UPDATE_SQL)
    .run(title || row.title, body, JSON.stringify(photos), photos[0] || "", row.post_id);
  return getSelfListing(db, row.post_id, { viewerId: uid });
}

export function abandonImportedDraftListing(db, userId, postId, now = new Date()) {
  const uid = Number(userId) || 0;
  const row = getSelfRow(db, postId);
  if (!row) return null;
  if (Number(row.listed_by_user_id) !== uid) throw httpError("只能取消自己的匯入草稿", 403);
  if (String(row.self_status || "") !== "draft") return getSelfListing(db, row.post_id, { viewerId: uid });
  db.prepare(ABANDON_DRAFT_LISTING_SQL).run(iso(now), row.post_id);
  return getSelfListing(db, row.post_id, { viewerId: uid });
}

/** 會員確認匯入後，以一般刊登欄位把同一則草稿轉成公開。工作者不得呼叫。 */
// 公開（草稿 → open）的 UPDATE 與參數組裝（同步與 PG 版共用；`selfListingsAsync.js` 會跑同一份）。
export const SELF_PUBLISH_UPDATE_SQL = `UPDATE listings SET
      source_key=?, search_key=?, title=?, url=?, price=?, price_num=?,
      address=?, area_name=?, layout=?, floor_name=?, kind_name=?, role_name=?,
      cover=?, tags=?,
      self_status='open', self_expires_at=?, self_body=?, self_photos=?,
      self_traits=?, self_deposit=?, self_pledge_at=?,
      fee_includes=?, lat=?, lng=?, geo_source=?,
      self_mrt_station=?, self_mrt_walk_m=?, self_mrt_source=?, self_mrt_checked_at=?,
      contact_name=?, contact_role=?, mobile=?, phone=?, line_url=?, contact_fetched=1,
      last_event='new', last_seen_at=?
    WHERE post_id=?`;

export function selfPublishUpdateParams({
  postId, region, section, title, rent, address, areaName, layout, floorName, kindName, roleName,
  cover, tags, expires, body, photos, traitIds, deposit, created, contactName, phone, lineUrl,
  feeIncludes = "", lat = null, lng = null, geoSource = "", mrt = null,
}) {
  return [
    selfSourceKey({ regionId: region, sectionId: section, address, floorName, areaName, layout }),
    selfSearchKey(region, section),
    title,
    `/go/${postId}`,
    String(rent),
    rent,
    address,
    areaName,
    layout,
    floorName,
    kindName,
    roleName,
    cover,
    JSON.stringify(tags || []),
    expires,
    body,
    JSON.stringify((photos || []).slice(0, SELF_PHOTO_MAX_COUNT)),
    JSON.stringify(traitIds || []),
    deposit,
    created,
    // R2：屋主填的費用三態、地址定位與步行捷運查證結果（發布時一起落地）。
    String(feeIncludes || ""),
    Number.isFinite(Number(lat)) && Number(lat) !== 0 ? Number(lat) : null,
    Number.isFinite(Number(lng)) && Number(lng) !== 0 ? Number(lng) : null,
    String(geoSource || ""),
    mrt?.station ? String(mrt.station) : null,
    mrt && Number.isFinite(Number(mrt.walk_m)) ? Number(mrt.walk_m) : null,
    mrt?.source ? String(mrt.source) : null,
    mrt?.checked_at ? String(mrt.checked_at) : null,
    contactName || roleName,
    roleName,
    phone,
    phone,
    lineUrl,
    created,
    postId,
  ];
}

export function publishImportedDraftListing(db, userId, postId, input = {}, now = new Date(), { matchCandidates } = {}) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入才能刊登", 401);
  const row = getSelfRow(db, postId);
  if (!row) throw httpError("找不到這則匯入草稿", 404);
  if (Number(row.listed_by_user_id) !== uid) throw httpError("只能刊登自己的匯入草稿", 403);
  if (String(row.self_status || "") !== "draft") throw httpError("這則不是待刊登的匯入草稿", 409);
  assertCanPublish(db, uid, now);

  const districts = normalizeWatchDistricts(
    input.district ? [input.district] : input.districts,
  ).slice(0, 1);
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
  const plainBody = listingBodyPlain(body);
  if (plainBody.length < SELF_BODY_MIN) throw httpError(SELF_BODY_HINT);
  const kind = kindId(input.kind || input.housing_type);
  const role = roleId(input.role);
  const layout = layoutText(input);
  const floorName = floorText(input);
  if (!floorName) throw httpError("請填出租樓層");
  let contactName = String(input.contact_name || "").trim().slice(0, SELF_CONTACT_MAX);
  if (!contactName) {
    try {
      contactName = String(db.prepare("SELECT nickname FROM users WHERE id = ?").get(uid)?.nickname || "").trim();
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
  const created = iso(now);
  const expires = new Date(nowMs(now) + SELF_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  // R2：地址換了就要讓舊的座標與步行捷運結果失效（不可以留著上一個地址的查證結果）。
  const addressChanged = String(row.address || "").trim() !== String(address || "").trim();
  const sourceKey = selfSourceKey({
    regionId: district.region,
    sectionId: district.id,
    address,
    floorName,
    areaName,
    layout,
  });
  db.prepare(SELF_PUBLISH_UPDATE_SQL).run(...selfPublishUpdateParams({
    postId: row.post_id,
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
    ...resolveSelfListingMeta(input, row, { addressChanged }),
  }));
  setPublisherFace(db, row.post_id, uid);
  const listing = db.prepare("SELECT * FROM listings WHERE post_id = ?").get(row.post_id);
  const candidates = typeof matchCandidates === "function" ? matchCandidates(listing) : [];
  const hit = bestMatch(listing, candidates);
  if (hit?.listing) {
    db.prepare(
      `UPDATE listings SET match_post_id=?, match_level=?, match_detail=?, match_rejected=0 WHERE post_id=?`,
    ).run(hit.listing.post_id, hit.level, hit.detail, row.post_id);
  }
  persistListingValues(db, row.post_id, resolved.listingValues);
  return getSelfListing(db, row.post_id, { viewerId: uid });
}

export function publishOwnedDraftListing(db, userId, postId, input = {}, now = new Date(), opts = {}) {
  return publishImportedDraftListing(db, userId, postId, input, now, opts);
}

export function closeSelfListing(db, userId, postId, { admin = false } = {}, now = new Date()) {
  const row = getSelfRow(db, postId);
  if (!row) throw httpError("找不到這則站內刊登", 404);
  if (!admin && Number(row.listed_by_user_id) !== Number(userId)) {
    throw httpError("只能關閉自己的刊登", 403);
  }
  db.prepare(
    "UPDATE listings SET self_status = 'closed', last_event = 'offline', last_seen_at = ? WHERE post_id = ?",
  ).run(iso(now), row.post_id);
  try { listingOfferHook?.(db, { listingId: row.post_id, now }); } catch { /* offer sweep must not block close */ }
  return getSelfListing(db, row.post_id, { viewerId: userId });
}

// 隱藏、檢舉與停權的語句抽成常數：PG 版（`selfListingsAsync.js`）逐字共用。
// ⚠️ `banSelfPublisher()` 寫的是 **users**（`self_ban_until`）。PG 模式下 users 在 PG，
// 但 `assertCanPublish()`（同步的建立路徑）讀的是本機 handle ⇒ 兩個 store 都要寫（見 async 版）。
export const HIDE_SELF_LISTING_SQL =
  "UPDATE listings SET self_status = 'hidden', hidden = 1, hidden_at = ? WHERE post_id = ?";
export const REPORT_EXISTS_SQL = "SELECT id FROM listing_reports WHERE post_id = ? AND user_id = ?";
export const REPORT_INSERT_SQL = "INSERT INTO listing_reports(post_id, user_id, reason, created_at) VALUES (?, ?, ?, ?)";
export const REPORT_COUNT_SQL = "SELECT COUNT(*) AS n FROM listing_reports WHERE post_id = ?";
export const BAN_SELF_PUBLISHER_SQL = "UPDATE users SET self_ban_until = ? WHERE id = ?";

// 停權到期時間的算法（純函式）：兩個 driver 共用，這也是「停多久」的政策。
// ⚠️ 時間來源要用 `Date`／數字／**ISO 字串**都可以：模組內的 `nowMs()` 只認 Date 與數字，
// 餵字串時 `Number("2026-…")` 是 NaN ⇒ **靜默地**退回 `Date.now()`（PG 版與同步版的停權時間
// 就會差幾小時，測試當場抓到）。這裡自己解析，解析不出來才用當下。
export function selfBanStamp(now = new Date()) {
  const ms = now instanceof Date ? now.getTime() : Date.parse(now);
  const base = Number.isFinite(ms) ? ms : Date.now();
  return new Date(base + SELF_BAN_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

export function hideSelfListing(db, postId, now = new Date()) {
  const row = getSelfRow(db, postId);
  if (!row) throw httpError("找不到這則站內刊登", 404);
  db.prepare(HIDE_SELF_LISTING_SQL).run(iso(now), row.post_id);
  try { listingOfferHook?.(db, { listingId: row.post_id, now }); } catch { /* offer sweep must not block hide */ }
  const until = banSelfPublisher(db, row.listed_by_user_id, now);
  return { ok: true, post_id: Number(row.post_id), hidden: true, ban_until: until };
}

export function reportSelfListing(db, userId, postId, reason = "", now = new Date()) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入才能檢舉", 401);
  const row = getSelfRow(db, postId);
  if (!row) throw httpError("找不到這則站內刊登", 404);
  if (Number(row.listed_by_user_id) === uid) throw httpError("不能檢舉自己的刊登");
  const already = db.prepare(REPORT_EXISTS_SQL).get(row.post_id, uid);
  if (already) return { ok: true, already: true };
  db.prepare(REPORT_INSERT_SQL).run(row.post_id, uid, String(reason || "").trim().slice(0, 200), iso(now));
  const count = Number(db.prepare(REPORT_COUNT_SQL).get(row.post_id)?.n) || 0;
  if (count >= SELF_REPORT_HIDE_AFTER) {
    hideSelfListing(db, row.post_id, now);
  }
  return { ok: true, hidden: count >= SELF_REPORT_HIDE_AFTER };
}

export function keepSelfListingForViewer(row, uid, settings, listingInScope) {
  if (!listingVisibleOnSurface(row, { surface: LISTING_SURFACE.BROWSE, viewerId: uid })) return false;
  if (!isSelfListingRow(row)) return true;
  if (row.mine === true) return true;
  if (Number(row.listed_by_user_id) === Number(uid)) return true;
  if (Number(row.watched) === 1) return true;
  if (typeof listingInScope === "function") return listingInScope(row, settings);
  return false;
}
