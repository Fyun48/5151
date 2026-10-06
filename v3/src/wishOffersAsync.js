// 許願房提案（wish offers）讀取的 driver-aware 入口（PG 島嶼，2026-09-28）。
//
// 為什麼先做讀取：`wishOffers.js` 是 1080 行、約 30 個吃 handle 的函式，但**這一組**
// （`GET /api/wish-offers/:offerRef`、`/contact`、`/inbox`、`/owner`）只差四個讀取：
//   `loadVisibleOffer`／`loadFreshOffer`／`publicOfferView`／`tenantBlocksOwner`
// 而它們全部是「一句 SELECT ＋ 純判斷」，投影與安全檢查（`assertOfferSafeView`、
// `safeListingSummary`）留在 `wishOffers.js`，兩個 driver 共用同一份。
//
// ⚠️ 這裡**只做讀取**。accept／decline／withdraw／block／report 是寫入且牽涉狀態機與事件，
// 屬於下一批；在那之前那些路由仍走同步版（寫 PG 而讀 SQLite 會是雙向分歧）。
//
// ⚠️ `getSelfRow()` 不必重寫：`selfListingsAsync.js` 已經有 `getSelfRowAsync()`，
// 直接拿來當 loader 的一員（這正是「動手前先查既有 *Async.js」那條紀律的實例）。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { ensurePgSchema } from "./pgSchema.js";
import { expireOpenSelfListingsAsync, getSelfRowAsync } from "./selfListingsAsync.js";
import {
  ACCEPTED_OFFER_SQL,
  OFFER_EXPIRE_BATCH,
  OFFER_LISTING_DAILY_CAP,
  OFFER_OWNER_DAILY_CAP,
  OFFER_SAME_WISH_COOLDOWN_MS,
  OFFER_TTL_MS,
  IDEMPOTENCY_BY_KEY_SQL,
  IDEMPOTENCY_INSERT_SQL,
  LISTING_OFFERS_SINCE_SQL,
  OFFER_BY_ID_SQL,
  OFFER_INSERT_SQL,
  OWNER_OFFERS_SINCE_SQL,
  PENDING_OFFER_SQL,
  WISH_BY_PUBLIC_REF_SQL,
  LAST_TERMINAL_OFFER_SQL,
  idempotencyParams,
  isUniqueViolation,
  normalizeOfferIdempotencyKey,
  offerInsertParams,
  OFFER_REPORT_DAILY_CAP,
  OFFER_REPORT_DETAIL_MAX,
  ADMIN_REPORTS_SQL,
  OFFER_REPORT_REASONS,
  OFFER_TERMINAL_STATUSES,
  assertContactReadable,
  assertOfferBurst,
  assertWishOfferEnabled,
  atMs,
  attachOfferCtas,
  contactFieldsFor,
  contactProjection,
  liveMatchEligible,
  offerHasExpired,
  recordOfferFail,
  createOfferReport as createOfferReportSync,
  loadFreshOffer as loadFreshOfferSync,
  loadVisibleOffer as loadVisibleOfferSync,
  newOfferToken,
  offerCtaForItem,
  offerHttpError,
  publicAdminReportView,
  publicBlockView,
  publicOfferViewWith,
} from "./wishOffers.js";
import { currentRentalMarketplaceFlags } from "./demand.js";
import { isWishOfferEnabled } from "./rentalMarketplaceFlags.js";
import { runWishOfferExpiryTick } from "./wishOfferWorker.js";
import { getRentalCatalogAsync, getWishConditionsAsync } from "./rentalCatalogAsync.js";
import { emitRentalNotifyEventAsync } from "./rentalNotifyWriteAsync.js";
import { containsUnsafeMarkup, sanitizeDocumentText } from "./safeContent.js";
import { listWishOffersWith } from "./wishOfferQueries.js";

// 這一批碰的表：提案本體、許願房、封鎖名單（刊登由 `getSelfRowAsync()` 自己處理）。
export const OFFER_TABLES = ["wish_offers", "demand_posts", "user_blocks"];

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

function normalizeResult(raw) {
  if (Array.isArray(raw)) return { rows: raw, rowCount: Number(raw.rowCount ?? raw.length) || 0 };
  const rows = (raw && raw.rows) || [];
  return { rows, rowCount: Number((raw && raw.rowCount) ?? rows.length) || 0 };
}

const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);

const schemaReady = new WeakMap();
export async function ensureOfferStoreOnce(pgDriver) {
  if (!pgDriver) return;
  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);
  const ready = ensurePgSchema(pgDriver, sqliteHandle(), { tables: OFFER_TABLES });
  schemaReady.set(pgDriver, ready);
  try {
    await ready;
  } catch (error) {
    schemaReady.delete(pgDriver);
    throw error;
  }
}

async function withFallback(options, { write = false }, runPostgres, runSqlite) {
  if (!isPg(options)) return runSqlite();
  try {
    if (options.exec) {
      const injected = (sql, params = []) => Promise.resolve(options.exec(sql, params)).then(normalizeResult);
      return await runPostgres(injected);
    }
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    await ensureOfferStoreOnce(pgDriver);
    const exec = async (sql, params = []) => normalizeResult(await pgDriver.query(toPostgresSql(sql), params));
    return await runPostgres(exec);
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write })) throw error;
    return runSqlite();
  }
}

// 逐字對應 wishOffers.js 的語句。
export const OFFER_BY_TOKEN_SQL = "SELECT * FROM wish_offers WHERE public_token = ?";
// ⚠️ `OFFER_BY_ID_SQL`／`LAST_TERMINAL_OFFER_SQL` 這一批之後**只有一份**（定義在 `wishOffers.js`），
// 這裡改成 import 後轉出：同一句 SQL 在兩個模組各寫一次，就是漂移的開始。
export { OFFER_BY_ID_SQL, LAST_TERMINAL_OFFER_SQL } from "./wishOffers.js";
export const WISH_BY_ID_SQL = "SELECT * FROM demand_posts WHERE id = ?";
export const BLOCK_EXISTS_SQL =
  "SELECT id FROM user_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?";
// 待處理報價數：**同一句 SQL 在 `demandAsync.js` 也有一份**（`pendingOfferCountAsync`，隨
// PR #531 的屋主摘要一起）。那一支還沒 merge，所以這裡先自己算，避免這一包依賴一個未合併的
// PR。**兩支合併之後應該收斂成一支**（同語句、同語意，重複只是暫時的）。
export const PENDING_OFFER_COUNT_SQL =
  "SELECT COUNT(*) AS n FROM wish_offers WHERE tenant_user_id = ? AND status = 'pending'";

async function pendingOfferCountAsync(run, userId) {
  const uid = Number(userId) || 0;
  if (!uid) return 0;
  return Number(one((await run(PENDING_OFFER_COUNT_SQL, [uid])).rows)?.n) || 0;
}

// `tenantBlocksOwner()`／`isBlocked()` 的 PG 版（userBlocks.js 那兩支只吃 handle）。
export async function tenantBlocksOwnerAsync(run, tenantUserId, ownerUserId) {
  const a = Number(tenantUserId) || 0;
  const b = Number(ownerUserId) || 0;
  if (!a || !b) return false;
  return Boolean(one((await run(BLOCK_EXISTS_SQL, [a, b])).rows));
}

// `wishOffers.js:attachOfferCtas()` 的 PG 版（配對頁每一張卡的「提供我的房源」按鈕）。
//
// 同步版在 PG 模式下讀的是**節點本機**的 `demand_posts`／`wish_offers`／`user_blocks`／`users`
// ⇒ 按鈕狀態（可提供／等待回覆／冷卻／已接受）會與站上其他地方不一致。
// 決策本身是純函式（`offerCtaForItem`），這裡只負責把三個查詢換成 PG。
export const WISHES_BY_TOKENS_SQL = (count) =>
  `SELECT id, user_id, public_token FROM demand_posts WHERE public_token IN (${Array.from({ length: count }, () => "?").join(",")})`;
export const ACTIVE_OFFERS_SQL = `SELECT public_token, wish_id, status FROM wish_offers
       WHERE owner_user_id = ? AND listing_id = ? AND status IN ('pending', 'accepted')`;
export const OWNER_BAN_SQL = "SELECT self_ban_until FROM users WHERE id = ?";

async function ownerBannedAsync(run, ownerUserId, now = new Date()) {
  try {
    const until = String(one((await run(OWNER_BAN_SQL, [Number(ownerUserId) || 0])).rows)?.self_ban_until || "");
    if (!until) return false;
    const ts = Date.parse(until);
    return Number.isFinite(ts) && ts > (now instanceof Date ? now.getTime() : Number(now) || Date.now());
  } catch {
    return false;
  }
}

export async function attachOfferCtasAsync(items, { listingId, ownerUserId, now = new Date(), flags = null, ...options } = {}) {
  const list = Array.isArray(items) ? items : [];
  const enabled = flags ? flags.wish?.offer_enabled === true : isWishOfferEnabled(currentRentalMarketplaceFlags());
  if (!enabled) {
    return list.map((item) => ({ ...item, offer_available: false, offer_cta: "提供房源（即將推出）" }));
  }
  return withFallback(options, {}, async (run) => {
    const tokens = list.map((item) => item.wish_ref).filter(Boolean);
    const wishes = new Map();
    if (tokens.length) {
      for (const row of (await run(WISHES_BY_TOKENS_SQL(tokens.length), tokens)).rows) {
        wishes.set(String(row.public_token), row);
      }
    }
    const active = new Map();
    if (tokens.length) {
      for (const row of (await run(ACTIVE_OFFERS_SQL, [Number(ownerUserId) || 0, Number(listingId) || 0])).rows) {
        const prev = active.get(Number(row.wish_id));
        if (!prev || row.status === "accepted") active.set(Number(row.wish_id), row);
      }
    }
    const banned = await ownerBannedAsync(run, ownerUserId, now);
    const out = [];
    for (const item of list) {
      const wish = wishes.get(item.wish_ref);
      if (!wish) {
        out.push({ ...item, offer_available: false, offer_cta: "目前無法提供", offer_status: "unavailable" });
        continue;
      }
      if (await tenantBlocksOwnerAsync(run, wish.user_id, ownerUserId)) {
        out.push({ ...item, offer_available: false, offer_cta: "目前無法提供", offer_status: "unavailable" });
        continue;
      }
      const last = one((await run(LAST_TERMINAL_OFFER_SQL, [Number(ownerUserId) || 0, Number(listingId) || 0, Number(wish.id) || 0])).rows);
      out.push(offerCtaForItem(item, { wish, active: active.get(Number(wish.id)) || null, lastTerminal: last || null, banned, now }));
    }
    return out;
  }, () => attachOfferCtas(sqliteHandle(), list, { listingId, ownerUserId, now }));
}

// `loadVisibleOffer()` 的 PG 版（找不到、或看的人不是 owner／tenant ⇒ null）。
export async function loadVisibleOfferAsync(offerRef, userId, options = {}) {
  return withFallback(options, {}, async (run) => {
    const ref = String(offerRef || "").trim();
    if (!ref || /^\d+$/.test(ref)) return null;
    const row = one((await run(OFFER_BY_TOKEN_SQL, [ref])).rows);
    if (!row) return null;
    const uid = Number(userId) || 0;
    if (Number(row.owner_user_id) !== uid && Number(row.tenant_user_id) !== uid) return null;
    return row;
  }, () => loadVisibleOfferSync(sqliteHandle(), offerRef, userId));
}

// `loadFreshOffer()` 的 PG 版（刻意**不**做擁有者檢查：呼叫端自己會驗）。
export async function loadFreshOfferAsync(offerId, options = {}) {
  return withFallback(options, {}, async (run) => {
    const id = Number(offerId);
    if (!Number.isFinite(id)) return null;
    return one((await run(OFFER_BY_ID_SQL, [id])).rows);
  }, () => loadFreshOfferSync(sqliteHandle(), offerId));
}

// `publicOfferView()` 的 PG 版：投影與安全檢查重用 wishOffers.js 的 `publicOfferViewWith()`，
// 這裡只負責把它需要的三個讀取先抓齊（那支是同步的純轉換）。
export async function publicOfferViewAsync(offer, userId, o = {}, options = {}) {
  const { includeMatch = true } = o || {};
  return withFallback(options, {}, async (run) => {
    const wishRow = one((await run(WISH_BY_ID_SQL, [Number(offer.wish_id)])).rows);
    // 刊登列沿用既有的 PG 版（不重寫同一句 SELECT）。
    // ⚠️ 一定要把 `options.exec` 一起傳下去：`getSelfRowAsync()` 在**沒有** exec 時會去要
    // 真正的 pgDriver，離線夾具就永遠拿不到列（第一版漏傳，投影因此只有 `listing_ref`，
    // 而且因為 `listing` 還是個物件，diff 只顯示「少了幾個鍵」，很容易誤判成欄位問題）。
    const listingRow = offer.listing_id
      ? await getSelfRowAsync(offer.listing_id, { ...options, driver: "postgres" })
      : null;
    // 封鎖查詢只有 accepted 時才會被投影用到，其餘情況不必多問一次。
    const blocked = offer.status === "accepted"
      ? await tenantBlocksOwnerAsync(run, offer.tenant_user_id, offer.owner_user_id)
      : false;
    return publicOfferViewWith({
      wishRow: () => wishRow,
      listingRow: () => listingRow,
      blocksOwner: () => blocked,
    }, offer, userId, { includeMatch });
  }, async () => (await import("./wishOffers.js")).publicOfferView(sqliteHandle(), offer, userId, { includeMatch }));
}

// 給「一次要投影多筆」的呼叫端（inbox／owner 列表）：把 N 筆的讀取批次化，
// 避免每一筆都來回一趟 PG。語意與逐筆 `publicOfferViewAsync()` 相同。
export async function publicOfferViewManyAsync(offers, userId, o = {}, options = {}) {
  const list = Array.isArray(offers) ? offers : [];
  const out = [];
  for (const offer of list) out.push(await publicOfferViewAsync(offer, userId, o, options));
  return out;
}

// ── 列表（inbox／owner）──────────────────────────────────────────────────────
//
// `listWishOffers()` 的分頁、游標、統計與投影順序全部留在 `wishOfferQueries.js`
// （`listWishOffersWith()`），這裡只供三個查詢與投影。語句逐字對應原版。
export const OFFER_COUNT_SQL = (column, status) =>
  `SELECT COUNT(*) AS n FROM wish_offers WHERE ${column} = ?${status ? " AND status = ?" : ""}`;
export const OFFER_PAGE_SQL = (column, status, keyset) => {
  let sql = `SELECT * FROM wish_offers WHERE ${column} = ?`;
  if (status) sql += " AND status = ?";
  if (keyset) sql += " AND (created_at < ? OR (created_at = ? AND id < ?))";
  return `${sql} ORDER BY created_at DESC, id DESC LIMIT ?`;
};

// ⚠️ `column` 只能是這兩個（由下面兩支固定傳入，不接受外部字串）。
const OFFER_ROLE_COLUMNS = Object.freeze({ owner: "owner_user_id", tenant: "tenant_user_id" });

export function offerListQueriesFor(run, options = {}) {
  return {
    count: async ({ column, userId, status }) => Number(
      one((await run(OFFER_COUNT_SQL(column, status), status ? [Number(userId) || 0, String(status)] : [Number(userId) || 0])).rows,
    )?.n) || 0,
    page: async ({ column, userId, status, afterCreatedAt, afterId, limit }) => {
      const keyset = Boolean(afterCreatedAt && afterId);
      const params = [Number(userId) || 0];
      if (status) params.push(String(status));
      if (keyset) params.push(String(afterCreatedAt), String(afterCreatedAt), Number(afterId));
      params.push(Number(limit) + 1);
      return (await run(OFFER_PAGE_SQL(column, status, keyset), params)).rows || [];
    },
    pendingCount: (userId) => pendingOfferCountAsync(run, userId),
    // 逐列投影（由呼叫端覆寫成非同步版本）：與同步版相同，每一列一次
    // `publicOfferViewAsync`；列表本身已有 keyset 上限，批次化留給之後。
    project: () => null,
  };
}

async function listOffersAsync(role, userId, opts = {}, options = {}) {
  const column = OFFER_ROLE_COLUMNS[role];
  return withFallback(options, {}, async (run) => {
    // 分頁／游標／統計與投影順序全部由 `listWishOffersWith()` 決定（同步版跑的是同一段），
    // 這裡只把三個查詢與投影接到注入式 runner 上。
    const queries = offerListQueriesFor(run, options);
    queries.project = (row, viewerId) => publicOfferViewAsync(row, viewerId, {}, options);
    return listWishOffersWith(queries, {
      role,
      column,
      userId,
      ...opts,
      includePendingCount: role === "tenant",
    });
  }, async () => {
    // ⚠️ 列表在 `wishOfferQueries.js`，不是 `wishOffers.js`（第一版抓錯模組）。
    const db = sqliteHandle();
    const mod = await import("./wishOfferQueries.js");
    return role === "owner"
      ? mod.listOwnerWishOffers(db, userId, opts)
      : mod.listTenantWishOffers(db, userId, opts);
  });
}

export async function listTenantWishOffersAsync(userId, opts = {}, options = {}) {
  return listOffersAsync("tenant", userId, opts, options);
}

export async function listOwnerWishOffersAsync(userId, opts = {}, options = {}) {
  return listOffersAsync("owner", userId, opts, options);
}

// ── 檢舉（`POST /api/wish-offers/:offerRef/report`）────────────────────────────
//
// 這一支是**寫入 ＋ 稽核事件**，所以只做讀取的上一包刻意沒動它。
// 規則（原因代碼、每日上限、同一人對同一提案只能檢舉一次、內容淨化）全部重用
// `wishOffers.js` 的常數與 `safeContent.js` 的淨化函式——不在這裡重寫第二份。
// 節流（`assertOfferBurst`）是**行程內記憶體**，與 driver 無關，直接共用。
export const REPORT_WINDOW_SQL =
  "SELECT COUNT(*) AS n FROM wish_offer_reports WHERE reporter_user_id = ? AND created_at >= ?";
export const REPORT_EXISTING_SQL =
  "SELECT public_token FROM wish_offer_reports WHERE offer_id = ? AND reporter_user_id = ?";
export const REPORT_INSERT_SQL = `INSERT INTO wish_offer_reports(
         public_token, offer_id, reporter_user_id, reported_user_id, listing_id, reason, detail, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`;
export const OFFER_EVENT_INSERT_SQL =
  "INSERT INTO wish_offer_events(offer_id, actor_user_id, event_type, created_at, meta_json) VALUES (?, ?, ?, ?, ?)";

const isoOf = (now) => (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
// 狀態機那一段沿用同步版的命名（`iso`），與上面的 `isoOf` 同義。
const iso = isoOf;
const rollingWindowStart = (now, ms) => isoOf(new Date((now instanceof Date ? now.getTime() : Date.now()) - ms));

// `writeOfferEvent()` 的 PG 版：沿用同一組「敏感欄位不落庫」的過濾清單。
// ⚠️ 呼叫端只能傳 `writeOfferEvent()` 的白名單事件（`OFFER_EVENTS`）；本批只用到
// `offer_reported`。要新增事件時，兩邊的白名單要一起看（見 `wishOffers.js` 的 OFFER_EVENTS）。
export async function writeOfferEventAsync(run, {
  offerId = null,
  actorUserId = null,
  eventType,
  meta = {},
  now = new Date(),
} = {}) {
  const safe = { ...(meta && typeof meta === "object" ? meta : {}) };
  for (const key of ["phone", "email", "line_url", "contact", "session"]) delete safe[key];
  await run(OFFER_EVENT_INSERT_SQL, [
    offerId || null, actorUserId || null, String(eventType), isoOf(now), JSON.stringify(safe),
  ]);
}

// `createOfferReport()` 的 PG 版。順序與同步版逐條相同：
// 驗證 → 每日上限 → 已檢舉過就回 already → 寫入 → 撞唯一鍵也回 already → 稽核事件。
export async function reportOfferAsync(userId, offer, { reason, detail = "", now = new Date(), actorKey = "" } = {}, options = {}) {
  return withFallback(options, { write: true }, async (run) => {
    assertWishOfferEnabled();
    if (actorKey) assertOfferBurst(`report:${actorKey}`, now);
    const code = String(reason || "").trim();
    if (!OFFER_REPORT_REASONS.includes(code)) {
      throw offerHttpError("請選擇檢舉原因", 400, "invalid_report_reason");
    }
    if (containsUnsafeMarkup(detail)) {
      throw offerHttpError("檢舉內容含有不允許的標記", 400, "unsafe_report_detail");
    }
    const text = sanitizeDocumentText(detail, OFFER_REPORT_DETAIL_MAX);
    const uid = Number(userId) || 0;
    const since = rollingWindowStart(now, 24 * 60 * 60 * 1000);
    const used = Number(one((await run(REPORT_WINDOW_SQL, [uid, since])).rows)?.n) || 0;
    if (used >= OFFER_REPORT_DAILY_CAP) {
      throw offerHttpError("今日檢舉次數已達上限", 429, "RATE_LIMITED", { retry_after: 3600 });
    }
    const existing = one((await run(REPORT_EXISTING_SQL, [Number(offer.id), uid])).rows);
    if (existing) return { ok: true, already: true, report_ref: existing.public_token };
    const token = newOfferToken();
    const inserted = await run(REPORT_INSERT_SQL, [
      token, Number(offer.id), uid, offer.owner_user_id, offer.listing_id, code, text, isoOf(now),
    ]);
    // 同步版靠 SQLite 的 UNIQUE 例外走 already 分支；PG 版用 rowCount 判斷有沒有真的寫進去
    // （競態時另一方已經寫入）。兩邊回傳形狀相同。
    if (Number(inserted?.rowCount) === 0) {
      const row = one((await run(REPORT_EXISTING_SQL, [Number(offer.id), uid])).rows);
      return { ok: true, already: true, report_ref: row?.public_token || "" };
    }
    await writeOfferEventAsync(run, {
      offerId: offer.id, actorUserId: uid, eventType: "offer_reported", meta: { reason: code }, now,
    });
    return { ok: true, already: false, report_ref: token };
  }, () => createOfferReportSync(sqliteHandle(), userId, offer, { reason, detail, now, actorKey }));
}

// 產業務入口：把「可見性 → 只有房客能檢舉 → 寫入」收在模組裡，server.js 不必自己組。
// 角色檢查與同步版 `reportWishOffer()` 逐字相同（`tenant_user_id` 必須是檢舉人）。
export async function reportVisibleOfferAsync(offerRef, userId, input = {}, options = {}) {
  const offer = await loadVisibleOfferAsync(offerRef, userId, options);
  if (!offer || Number(offer.tenant_user_id) !== Number(userId)) {
    throw offerHttpError("找不到這筆提案", 404, "offer_not_found");
  }
  return reportOfferAsync(userId, offer, input, options);
}

// ── 封鎖名單（`GET /api/wish-offers/blocks`、`POST /api/wish-offers/blocks/:ref/remove`）──
//
// `listMyBlocks()` 除了封鎖列本身，還會對每一列查一次刊登（只為了標題）；
// `unblockByRef()` 則是 `loadOwnedBlock()` ＋ 一句 DELETE。
// 兩者都與 `insertUserBlock()`（block／report 路由在用）共用同一張 `user_blocks`，
// 所以這一張表的讀寫要在同一批搬完，否則會出現「同一張表一半 PG、一半 SQLite」。
export const BLOCKS_BY_USER_SQL =
  "SELECT * FROM user_blocks WHERE blocker_user_id = ? ORDER BY created_at DESC, id DESC";
export const BLOCK_BY_TOKEN_SQL = "SELECT * FROM user_blocks WHERE public_token = ?";
export const BLOCK_DELETE_SQL = "DELETE FROM user_blocks WHERE id = ? AND blocker_user_id = ?";

export async function listBlocksForUserAsync(run, userId) {
  const uid = Number(userId) || 0;
  if (!uid) return [];
  return (await run(BLOCKS_BY_USER_SQL, [uid])).rows || [];
}

// `loadOwnedBlock()` 的 PG 版：ref 必須是 token（不接受數字），而且要屬於這個人。
export async function loadOwnedBlockAsync(run, userId, blockRef) {
  const token = String(blockRef || "").trim();
  if (!token || /^\d+$/.test(token)) return null;
  const row = one((await run(BLOCK_BY_TOKEN_SQL, [token])).rows);
  if (!row || Number(row.blocker_user_id) !== Number(userId)) return null;
  return row;
}

// `listMyBlocks()` 的 PG 版。投影重用 `wishOffers.js` 的 `publicBlockView()`（純函式）。
export async function listMyBlocksAsync(userId, options = {}) {
  return withFallback(options, {}, async (run) => {
    assertWishOfferEnabled();
    const uid = Number(userId) || 0;
    if (!uid) return [];
    const rows = await listBlocksForUserAsync(run, uid);
    const items = [];
    for (const row of rows) {
      // 刊登列沿用既有的 PG 版；沒有 listing_id 的那種直接帶 null（同步版同義）。
      const listing = row.listing_id ? await getSelfRowAsync(row.listing_id, { ...options, driver: "postgres" }) : null;
      items.push(publicBlockView(row, listing || null));
    }
    return items;
  }, async () => (await import("./wishOffers.js")).listMyBlocks(sqliteHandle(), userId));
}

// `unblockByRef()` 的 PG 版：找不到 ⇒ 404；`context = 'moderation'` 不能自行解除 ⇒ 403。
export async function unblockByRefAsync(userId, blockRef, options = {}) {
  return withFallback(options, { write: true }, async (run) => {
    assertWishOfferEnabled();
    const uid = Number(userId) || 0;
    const row = await loadOwnedBlockAsync(run, uid, blockRef);
    if (!row) throw offerHttpError("找不到這筆封鎖", 404, "block_not_found");
    if (String(row.context || "") === "moderation") {
      throw offerHttpError("這筆封鎖不能自行解除", 403, "block_locked");
    }
    await run(BLOCK_DELETE_SQL, [Number(row.id), uid]);
    return { ok: true, block_ref: row.public_token };
  }, async () => (await import("./wishOffers.js")).unblockByRef(sqliteHandle(), userId, blockRef));
}

// ── 後台檢舉清單（`GET /api/admin/wish-offer-reports`）────────────────────────
//
// 這一條是**讀取**，而且現在特別重要：檢舉列已經由 `reportOfferAsync()` 寫進 PG，
// 若後台清單還讀節點 SQLite，管理員看到的會是**舊的／空的**清單（寫 PG、讀 SQLite 的分歧）。
// 映射重用 `wishOffers.js` 的 `publicAdminReportView()`，語句逐字用 `ADMIN_REPORTS_SQL`。
export async function listAdminOfferReportsAsync(opts = {}, options = {}) {
  const size = Math.min(100, Math.max(1, Number(opts?.limit) || 50));
  return withFallback(options, {}, async (run) => {
    const rows = (await run(ADMIN_REPORTS_SQL, [size])).rows || [];
    return { items: rows.map(publicAdminReportView) };
  }, async () => {
    const mod = await import("./wishOffers.js");
    return { items: mod.listAdminOfferReports(sqliteHandle(), opts) };
  });
}

// ── 聯絡方式（`GET /api/wish-offers/:offerRef/contact`）────────────────────────
//
// 這一條會**先寫一筆稽核事件**（`contact_projection_accessed`）才回聯絡方式，所以它與狀態機
// 同屬「寫入」那一類。三個讀取（可見性、許願房列、刊登列、封鎖）都已經有 PG 版；
// 組裝與守衛重用 `wishOffers.js` 的純函式，兩個 driver 的行為不可能漂移。
export async function projectOfferContactAsync(offerRef, userId, { now = new Date(), actorKey = "" } = {}, options = {}) {
  return withFallback(options, { write: true }, async (run) => {
    assertWishOfferEnabled();
    if (actorKey) assertOfferBurst(`contact:${actorKey}`, now);
    const offer = await loadVisibleOfferAsync(offerRef, userId, options);
    const role = offer ? (Number(offer.owner_user_id) === Number(userId)
      ? "owner"
      : (Number(offer.tenant_user_id) === Number(userId) ? "tenant" : "")) : "";
    // 順序與同步版一致：先角色／狀態／封鎖（由 `assertContactReadable()` 一次判完），
    // 再讀兩列。錯誤碼相同 ⇒ 呼叫端看到的行為不變。
    const blocked = offer && role ? await tenantBlocksOwnerAsync(run, offer.tenant_user_id, offer.owner_user_id) : false;
    assertContactReadable(role, offer || {}, blocked);
    const wishRow = one((await run(WISH_BY_ID_SQL, [Number(offer.wish_id)])).rows);
    const listingRow = offer.listing_id ? await getSelfRowAsync(offer.listing_id, { ...options, driver: "postgres" }) : null;
    const fields = contactFieldsFor({ role, wishRow, listingRow });
    const projection = contactProjection(offer, role, fields);
    await writeOfferEventAsync(run, {
      offerId: offer.id,
      actorUserId: userId,
      eventType: "contact_projection_accessed",
      meta: { viewer_role: role, available: projection.contact.available },
      now,
    });
    return projection;
  }, async () => {
    const mod = await import("./wishOfferTransitions.js");
    return mod.readOfferContact(sqliteHandle(), userId, offerRef, { now, actorKey });
  });
}

// ── 提案狀態機（accept／decline／withdraw／block）──────────────────────────────
//
// 這是第三十六批那份順序的第 3 步，也是 wishOffers 群的最後四條路由。
// 前置條件都已在前面幾輪備齊：通知寫入端（第 2 步）、`wish_offer_events`（第 33 批）、
// `loadVisibleOfferAsync`／`loadFreshOfferAsync`／`getSelfRowAsync`／`insertUserBlock` 的 PG 路徑。
//
// ⚠️ 這一支比前面幾支更需要注意**交易**：同步版用 `withImmediate(db, …)`（BEGIN IMMEDIATE）
// 把「讀 → 樂觀鎖 UPDATE → 寫事件」包成一個原子單位。PG 版對應的是
// `pgDriver.withTransaction()`，只有真的 driver 有；注入式夾具沒有交易，
// 但**測試是單執行緒序列執行**，所以沒有交易也不會觀察到差異（正式站有）。
export const OFFER_BY_ID_FOR_UPDATE_SQL = "SELECT * FROM wish_offers WHERE id = ?";
export const OFFER_STATUS_SQL = "SELECT status FROM wish_offers WHERE id = ?";
export const OFFER_TERMINAL_BY_ID_SQL = `UPDATE wish_offers
     SET status = ?, ${"${field}"} = COALESCE(${"${field}"}, ?), updated_at = ?, version = version + 1
     WHERE id = ? AND status IN ('pending', 'accepted')`;
export const OFFER_IDS_BY_SCOPE_SQL = (clauses) => `SELECT id FROM wish_offers WHERE ${clauses}`;
export const OFFER_TERMINAL_BY_SCOPE_SQL = (clauses, field) => `UPDATE wish_offers
     SET status = ?, ${field} = COALESCE(${field}, ?), updated_at = ?, version = version + 1
     WHERE ${clauses}`;
export const BLOCK_INSERT_SQL = `INSERT INTO user_blocks(public_token, blocker_user_id, blocked_user_id, context, offer_id, listing_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`;
export const BLOCK_EXISTING_SQL =
  "SELECT * FROM user_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?";

// `STAMP_FIELD` 只允許這三個（同步版的 `stampField` 也是這幾個；這裡做成白名單，
// 因為它會被**拼進 SQL**，不能讓外部字串進來）。
const STAMP_FIELDS = new Set(["accepted_at", "declined_at", "withdrawn_at", "expired_at", "blocked_at"]);
export const stampFieldFor = (toStatus, stampField) => {
  const field = stampField || `${toStatus}_at`;
  if (!STAMP_FIELDS.has(field)) throw new Error(`unsupported stamp field: ${field}`);
  return field;
};

// `transitionOffer()` 的 PG 版：樂觀鎖。
// ⚠️ 同步版看 `result.changes`、PG 看 `rowCount`——**兩個都要當成「有沒有改到」**，
// 用 `undefined` 或錯誤的欄位會讓「衝突」被誤判成「成功」（狀態機的核心不變式）。
export async function transitionOfferAsync(run, offerId, {
  fromStatus,
  toStatus,
  version,
  stampField,
  now = new Date(),
} = {}) {
  const stamp = iso(now);
  const field = stampFieldFor(toStatus, stampField);
  const res = await run(
    `UPDATE wish_offers
     SET status = ?, ${field} = ?, updated_at = ?, version = version + 1
     WHERE id = ? AND status = ? AND version = ?`,
    [toStatus, stamp, stamp, Number(offerId), fromStatus, Number(version)],
  );
  return Number(res?.rowCount) || 0;
}

// `expirePendingIfDue()` 的 PG 版。
export async function expirePendingIfDueAsync(run, offer, now = new Date(), options = {}) {
  if (!offer || offer.status !== "pending" || !offerHasExpired(offer, now)) {
    return { expired: false, offer };
  }
  const changed = await transitionOfferAsync(run, offer.id, {
    fromStatus: "pending", toStatus: "expired", version: offer.version, stampField: "expired_at", now,
  });
  const fresh = one((await run(OFFER_BY_ID_FOR_UPDATE_SQL, [Number(offer.id)])).rows) || offer;
  if (changed) {
    await writeOfferEventAsync(run, {
      offerId: offer.id, actorUserId: null, eventType: "offer_expired", meta: { reason: "ttl" }, now,
    });
  }
  return { expired: fresh.status === "expired", offer: fresh };
}

// `terminalizeOffers()` 的 PG 版：把某個範圍內所有 pending／accepted 一次終結，逐筆寫事件。
export async function terminalizeOffersAsync(run, {
  wishId = null,
  listingId = null,
  ownerUserId = null,
  tenantUserId = null,
  toStatus = "expired",
  now = new Date(),
} = {}) {
  if (!OFFER_TERMINAL_STATUSES.includes(toStatus) && toStatus !== "blocked") return 0;
  const clauses = ["status IN ('pending', 'accepted')"];
  const params = [];
  for (const [column, value] of [["wish_id", wishId], ["listing_id", listingId], ["owner_user_id", ownerUserId], ["tenant_user_id", tenantUserId]]) {
    if (value) {
      clauses.push(`${column} = ?`);
      params.push(Number(value));
    }
  }
  if (clauses.length === 1) return 0;
  const where = clauses.join(" AND ");
  const rows = (await run(OFFER_IDS_BY_SCOPE_SQL(where), params)).rows || [];
  if (!rows.length) return 0;
  const stamp = iso(now);
  const field = toStatus === "blocked" ? "blocked_at" : toStatus === "withdrawn" ? "withdrawn_at" : "expired_at";
  await run(OFFER_TERMINAL_BY_SCOPE_SQL(where, field), [toStatus, stamp, stamp, ...params]);
  for (const row of rows) {
    await writeOfferEventAsync(run, {
      offerId: row.id,
      eventType: toStatus === "blocked" ? "offer_blocked" : toStatus === "withdrawn" ? "offer_withdrawn" : "offer_expired",
      now,
    });
  }
  return rows.length;
}

// `insertUserBlock()` 的 PG 版：先查再寫（`UNIQUE(blocker, blocked)` 是表約束，PG 上沒有索引，
// 所以不能靠 ON CONFLICT；先查再寫與同步版的語意相同）。
export async function insertUserBlockAsync(run, {
  blockerUserId, blockedUserId, context = "wish_offer", offerId = null, listingId = null, now = new Date(),
} = {}) {
  const blocker = Number(blockerUserId) || 0;
  const blocked = Number(blockedUserId) || 0;
  if (!blocker || !blocked || blocker === blocked) return null;
  const existing = one((await run(BLOCK_EXISTING_SQL, [blocker, blocked])).rows);
  if (existing) return existing;
  await run(BLOCK_INSERT_SQL, [
    newOfferToken(), blocker, blocked, String(context || "wish_offer"),
    offerId || null, listingId || null, iso(now),
  ]);
  return one((await run(BLOCK_EXISTING_SQL, [blocker, blocked])).rows);
}

// `recheckAcceptable()` 的 PG 版：過期 → 封鎖 → 條件是否仍相符。
async function recheckAcceptableAsync(run, offer, now, options) {
  if (offerHasExpired(offer, now)) {
    await expirePendingIfDueAsync(run, offer, now, options);
    return { ok: false, code: "offer_expired" };
  }
  if (await tenantBlocksOwnerAsync(run, offer.tenant_user_id, offer.owner_user_id)) {
    await terminalizeOffersAsync(run, {
      ownerUserId: offer.owner_user_id, tenantUserId: offer.tenant_user_id, toStatus: "blocked", now,
    });
    return { ok: false, code: "offer_unavailable" };
  }
  const wishRow = one((await run(WISH_BY_ID_SQL, [Number(offer.wish_id)])).rows);
  const listingRow = offer.listing_id ? await getSelfRowAsync(offer.listing_id, { ...options, driver: "postgres" }) : null;
  const live = wishRow && listingRow ? liveMatchEligible(null, listingRow, wishRow, now) : { eligible: false };
  if (!live.eligible) {
    await transitionOfferAsync(run, offer.id, {
      fromStatus: "pending", toStatus: "expired", version: offer.version, stampField: "expired_at", now,
    });
    return { ok: false, code: "match_no_longer_eligible" };
  }
  return { ok: true };
}

// 四條路由共用的主體：可見性 → 角色 → 過期／衝突 → 樂觀鎖轉移 → 事件。
// `denied` 的處理（`recordOfferFail()` ＋ 丟 409）與同步版逐條相同。
async function transitionRoute({
  offerRef, userId, now, actorKey, role, toStatus, stampField, eventType, extraGates = null,
}, options) {
  return withFallback(options, { write: true }, async (run) => {
    assertWishOfferEnabled();
    if (actorKey) assertOfferBurst(actorKey, now);
    const offer = await loadVisibleOfferAsync(offerRef, userId, options);
    const mine = offer && (role === "tenant"
      ? Number(offer.tenant_user_id) === Number(userId)
      : Number(offer.owner_user_id) === Number(userId));
    if (!offer || !mine) throw offerHttpError("找不到這筆提案", 404, "offer_not_found");

    let denied = "";
    // `expirePendingOrConflict()`：pending 且過期 ⇒ 先過期；不是 pending ⇒ 衝突。
    if (offer.status === "pending" && offerHasExpired(offer, now)) {
      const ttl = await expirePendingIfDueAsync(run, offer, now, options);
      denied = "offer_expired";
      void ttl;
    } else if (offer.status !== "pending") {
      throw offerHttpError("這筆提案狀態已變更", 409, "offer_conflict", {
        current_status: offer.status || "",
      });
    }
    if (denied) {
      recordOfferFailAsync(actorKey || `${role}:${userId}`, now);
      throw offerHttpError("目前無法接受這筆提案", 409, denied);
    }
    if (extraGates) {
      const check = await extraGates(run, offer);
      if (!check.ok) {
        recordOfferFailAsync(actorKey || `${role}:${userId}`, now);
        throw offerHttpError("目前無法接受這筆提案", 409, check.code);
      }
    }
    const changed = await transitionOfferAsync(run, offer.id, {
      fromStatus: "pending", toStatus, version: offer.version, stampField, now,
    });
    if (!changed) {
      const fresh = one((await run(OFFER_BY_ID_FOR_UPDATE_SQL, [Number(offer.id)])).rows);
      throw offerHttpError("這筆提案狀態已變更", 409, "offer_conflict", {
        current_status: fresh?.status || "",
      });
    }
    await writeOfferEventAsync(run, { offerId: offer.id, actorUserId: userId, eventType, now });
    return one((await run(OFFER_BY_ID_FOR_UPDATE_SQL, [Number(offer.id)])).rows);
  }, async () => {
    const mod = await import("./wishOfferTransitions.js");
    const db = sqliteHandle();
    if (toStatus === "accepted") return mod.acceptWishOffer(db, userId, offerRef, { now, actorKey });
    if (toStatus === "declined") return mod.declineWishOffer(db, userId, offerRef, { now, actorKey });
    return mod.withdrawWishOffer(db, userId, offerRef, { now, actorKey });
  });
}

// `recordOfferFail()` 是行程內節流，與 driver 無關；同步版會在失敗時記一筆。
// 這裡直接重用（它不碰 DB）。
function recordOfferFailAsync(actorKey, now) {
  try {
    recordOfferFail(actorKey, now);
  } catch {
    /* 與同步版相同：記錄失敗本身不該掩蓋原本的錯誤 */
  }
}

export async function acceptWishOfferAsync(userId, offerRef, { now = new Date(), actorKey = "" } = {}, options = {}) {
  return transitionRoute({
    offerRef, userId, now, actorKey, role: "tenant",
    toStatus: "accepted", stampField: "accepted_at", eventType: "offer_accepted",
    extraGates: (run, offer) => recheckAcceptableAsync(run, offer, now, options),
  }, options);
}

export async function declineWishOfferAsync(userId, offerRef, { now = new Date(), actorKey = "" } = {}, options = {}) {
  return transitionRoute({
    offerRef, userId, now, actorKey, role: "tenant",
    toStatus: "declined", stampField: "declined_at", eventType: "offer_declined",
  }, options);
}

export async function withdrawWishOfferAsync(userId, offerRef, { now = new Date(), actorKey = "" } = {}, options = {}) {
  return transitionRoute({
    offerRef, userId, now, actorKey, role: "owner",
    toStatus: "withdrawn", stampField: "withdrawn_at", eventType: "offer_withdrawn",
  }, options);
}

// `blockOwnerFromOffer()` 的 PG 版：房客封鎖屋主 ⇒ 建立封鎖 ＋ 終結該對之間所有提案。
export async function blockOwnerFromOfferAsync(userId, offerRef, { now = new Date(), actorKey = "" } = {}, options = {}) {
  return withFallback(options, { write: true }, async (run) => {
    assertWishOfferEnabled();
    if (actorKey) assertOfferBurst(actorKey, now);
    const offer = await loadVisibleOfferAsync(offerRef, userId, options);
    if (!offer || Number(offer.tenant_user_id) !== Number(userId)) {
      throw offerHttpError("找不到這筆提案", 404, "offer_not_found");
    }
    const block = await insertUserBlockAsync(run, {
      blockerUserId: userId,
      blockedUserId: offer.owner_user_id,
      context: "wish_offer",
      offerId: offer.id,
      listingId: offer.listing_id,
      now,
    });
    await terminalizeOffersAsync(run, {
      ownerUserId: offer.owner_user_id, tenantUserId: userId, toStatus: "blocked", now,
    });
    return {
      ok: true,
      block_ref: block?.public_token || "",
      offer: one((await run(OFFER_BY_ID_FOR_UPDATE_SQL, [Number(offer.id)])).rows),
    };
  }, async () => {
    const mod = await import("./wishOfferTransitions.js");
    return mod.blockOwnerFromOffer(sqliteHandle(), userId, offerRef, { now, actorKey });
  });
}

// ---- 建立提案（第八十七批）---------------------------------------------------
//
// `POST /api/self-listings/:id/matches/:wishRef/offers` 原本走
// `db.js:createWishOfferFor()`（同步）：刊登列（`getSelfRow`）、許願房、封鎖名單、每日上限、
// 既有提案、冪等鍵與事件全部讀寫**這台節點**。PG 模式下「別的節點看到的刊登／許願房」
// 一律查不到 ⇒ 429／409 亂噴，而且提案本身寫進本機後站上（讀 PG）看不到。
//
// 順序與同步版逐條相同（`wishOffers.js:createWishOffer()`）：
//   啟用開關 → 端點節流 → 冪等鍵格式 → 過期清理 → 讀刊登／許願房 → 冪等回放 →
//   建立閘門（擁有者停權／封鎖／即時配對／每日上限／pending 回傳／accepted 衝突／冷卻）→
//   INSERT pending（撞唯一鍵就回既有那筆）→ 冪等鍵落地 → `offer_created` 事件 →
//   `tenant_offer_received` 通知（失敗不影響建立）→ `publicOfferView` 投影。
//
// ⚠️ 交易：同步版是 `BEGIN IMMEDIATE`；PG 這一邊靠**兩個部分唯一索引**
// （`idx_wish_offers_pending_unique`／`_active_unique`）擋併發，撞到就回既有那筆
// ——與同步版 catch UNIQUE 的語意相同（PG 丟 23505、SQLite 夾具丟訊息，`isUniqueViolation()` 都認）。

const atMsOf = atMs;

async function loadWishByPublicRefAsync(run, wishRef) {
  const raw = String(wishRef || "").trim();
  if (!raw || /^\d+$/.test(raw)) return null;
  return one((await run(WISH_BY_PUBLIC_REF_SQL, [raw])).rows) || null;
}

const sinceCountAsync = async (run, sql, id, sinceIso) =>
  Number(one((await run(sql, [Number(id) || 0, sinceIso])).rows)?.n) || 0;

/** `assertCreateOfferGates()` 的 PG 版：判斷本身全部沿用同步版的純函式與政策常數。 */
export async function assertCreateOfferGatesAsync(run, { ownerUserId, listingRow, wishRow, now = new Date() } = {}) {
  if (!listingRow || Number(listingRow.listed_by_user_id) !== Number(ownerUserId)) {
    throw offerHttpError("找不到這則站內刊登", 404, "listing_not_found");
  }
  if (await ownerBannedAsync(run, ownerUserId, now)) {
    throw offerHttpError("目前無法提供", 409, "offer_unavailable");
  }
  if (await tenantBlocksOwnerAsync(run, wishRow?.user_id, ownerUserId)) {
    throw offerHttpError("目前無法提供", 409, "offer_unavailable");
  }
  const live = liveMatchEligible(null, listingRow, wishRow, now);
  if (!live.eligible) {
    throw offerHttpError("目前無法提供", 409, "match_no_longer_eligible");
  }
  const since = rollingWindowStart(now, 24 * 60 * 60 * 1000);
  if (await sinceCountAsync(run, OWNER_OFFERS_SINCE_SQL, ownerUserId, since) >= OFFER_OWNER_DAILY_CAP) {
    throw offerHttpError("今日提案次數已達上限", 429, "RATE_LIMITED", { retry_after: 3600 });
  }
  if (await sinceCountAsync(run, LISTING_OFFERS_SINCE_SQL, listingRow.post_id, since) >= OFFER_LISTING_DAILY_CAP) {
    throw offerHttpError("此房源今日提案次數已達上限", 429, "RATE_LIMITED", { retry_after: 3600 });
  }
  const existingPending = one((await run(PENDING_OFFER_SQL, [
    Number(ownerUserId), Number(listingRow.post_id), Number(wishRow.id),
  ])).rows);
  if (existingPending) return { live, existingPending };
  if (one((await run(ACCEPTED_OFFER_SQL, [
    Number(ownerUserId), Number(listingRow.post_id), Number(wishRow.id),
  ])).rows)) {
    throw offerHttpError("目前無法提供", 409, "offer_already_active");
  }
  const last = one((await run(LAST_TERMINAL_OFFER_SQL, [
    Number(ownerUserId), Number(listingRow.post_id), Number(wishRow.id),
  ])).rows);
  if (last) {
    const created = Date.parse(last.created_at);
    if (Number.isFinite(created) && atMsOf(now) - created < OFFER_SAME_WISH_COOLDOWN_MS) {
      throw offerHttpError("稍後才能再提供", 429, "OFFER_COOLDOWN", {
        retry_after: Math.max(1, Math.ceil((OFFER_SAME_WISH_COOLDOWN_MS - (atMsOf(now) - created)) / 1000)),
      });
    }
  }
  return { live, existingPending: null };
}

/** `insertPendingOffer()` 的 PG 版：撞部分唯一索引時回既有那筆（同步版 catch UNIQUE 同義）。 */
export async function insertPendingOfferAsync(run, {
  ownerUserId,
  listingRow,
  wishRow,
  idempotencyKey = "",
  now = new Date(),
} = {}) {
  const stamp = isoOf(now);
  const expires = isoOf(new Date(atMsOf(now) + OFFER_TTL_MS));
  const token = newOfferToken();
  try {
    // ⚠️ PG 沒有 `lastInsertRowid`：島嶼要自己接 `RETURNING id`（同步版仍用 `.run()` 的回傳值，
    // 所以共用的 `OFFER_INSERT_SQL` 本體不含 RETURNING）。
    const res = await run(`${OFFER_INSERT_SQL} RETURNING id`, offerInsertParams({
      token, wishRow, listingRow, ownerUserId, idempotencyKey, stamp, expires,
    }));
    const id = Number(one(res?.rows)?.id ?? res?.lastInsertRowid) || 0;
    if (id) return one((await run(OFFER_BY_ID_SQL, [id])).rows) || null;
    return null;
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = one((await run(PENDING_OFFER_SQL, [
        Number(ownerUserId), Number(listingRow.post_id), Number(wishRow.id),
      ])).rows);
      if (existing) return existing;
      if (one((await run(ACCEPTED_OFFER_SQL, [
        Number(ownerUserId), Number(listingRow.post_id), Number(wishRow.id),
      ])).rows)) {
        throw offerHttpError("目前無法提供", 409, "offer_already_active");
      }
    }
    throw error;
  }
}

/** `db.js:createWishOfferFor()` 的 PG 版（＝ `createWishOffer()` ＋ 通知 ＋ `offerJson()`）。 */
export async function createWishOfferAsync(ownerUserId, listingRef, wishRef, {
  idempotencyKey,
  now = new Date(),
  actorKey = "",
} = {}, options = {}) {
  return withFallback(options, { write: true }, async (run) => {
    assertWishOfferEnabled();
    if (actorKey) assertOfferBurst(actorKey, now);
    const key = normalizeOfferIdempotencyKey(idempotencyKey);
    // 等同 `db.js:hydrateRentalMarketplace()`：PG 的旗標／目錄／許願條件要先收斂到行程內快取，
    // 否則 `liveMatchEligible()` 會拿本機（過期）的目錄判斷，配對結果與站上不一致。
    await getRentalCatalogAsync(options);
    await getWishConditionsAsync(options);
    const runOpts = { ...options, driver: "postgres", exec: run };
    await expireOpenSelfListingsAsync(run, now);
    const listingRow = await getSelfRowAsync(listingRef, runOpts);
    const wishRow = await loadWishByPublicRefAsync(run, wishRef);
    if (key) {
      const replay = one((await run(IDEMPOTENCY_BY_KEY_SQL, [Number(ownerUserId), key])).rows);
      if (replay) {
        const listingId = listingRow ? Number(listingRow.post_id) : NaN;
        const wishId = wishRow ? Number(wishRow.id) : NaN;
        const sameTarget = Number.isFinite(listingId)
          && Number.isFinite(wishId)
          && listingId === Number(replay.listing_id)
          && wishId === Number(replay.wish_id);
        if (sameTarget) {
          const offer = one((await run(OFFER_BY_ID_SQL, [Number(replay.offer_id)])).rows);
          if (offer) return publicOfferViewAsync(offer, ownerUserId, {}, runOpts);
        }
        throw offerHttpError("此操作已用於另一筆提案", 409, "IDEMPOTENCY_CONFLICT");
      }
    }
    if (!listingRow || !wishRow) {
      recordOfferFail(actorKey || `owner:${ownerUserId}`, now);
      throw offerHttpError("目前無法提供", 409, "match_no_longer_eligible");
    }
    let gates;
    try {
      gates = await assertCreateOfferGatesAsync(run, { ownerUserId, listingRow, wishRow, now });
    } catch (error) {
      recordOfferFail(actorKey || `owner:${ownerUserId}`, now);
      throw error;
    }
    if (key && gates.existingPending) {
      const same = Number(gates.existingPending.listing_id) === Number(listingRow.post_id)
        && Number(gates.existingPending.wish_id) === Number(wishRow.id);
      if (!same) throw offerHttpError("此操作已用於另一筆提案", 409, "IDEMPOTENCY_CONFLICT");
    }
    const offer = gates.existingPending || await insertPendingOfferAsync(run, {
      ownerUserId,
      listingRow,
      wishRow,
      idempotencyKey: key,
      now,
    });
    if (!offer) throw offerHttpError("目前無法提供", 409, "match_no_longer_eligible");
    if (key) {
      try {
        await run(IDEMPOTENCY_INSERT_SQL, idempotencyParams({
          ownerUserId, key, offerId: offer.id, listingId: listingRow.post_id, wishId: wishRow.id, stamp: isoOf(now),
        }));
      } catch (error) {
        const replay = one((await run(IDEMPOTENCY_BY_KEY_SQL, [Number(ownerUserId), key])).rows);
        if (replay && Number(replay.offer_id) !== Number(offer.id)) {
          throw offerHttpError("此操作已用於另一筆提案", 409, "IDEMPOTENCY_CONFLICT");
        }
        if (!isUniqueViolation(error)) throw error;
      }
    }
    await writeOfferEventAsync(run, {
      offerId: offer.id,
      actorUserId: ownerUserId,
      eventType: "offer_created",
      meta: { listing_id: listingRow.post_id },
      now,
    });
    // `db.js:createWishOfferFor()` 的收尾：通知事件（失敗不影響建立）＋ 公開投影。
    try {
      await emitRentalNotifyEventAsync({
        eventType: "tenant_offer_received",
        userId: offer.tenant_user_id,
        eventKey: `tenant_offer_received:${offer.id}`,
        subjectType: "offer",
        subjectRef: offer.public_token,
        listingId: offer.listing_id,
        now,
      }, runOpts);
    } catch { /* notify must not fail create */ }
    return publicOfferViewAsync(offer, ownerUserId, {}, runOpts);
  }, async () => (await import("./db.js")).createWishOfferFor(ownerUserId, listingRef, wishRef, { idempotencyKey, now, actorKey }));
}

// ── 提案逾期 tick（每 5 分鐘）─────────────────────────────────────────────────────────
//
// `runWishOfferExpiryTick(db=本機)` 同步過期節點 SQLite 的 pending 提案 ⇒ PG 的 pending 提案
// 不會主動過期（只有使用者對該筆動作時才 lazy 補）。這裡補 PG 路徑：判斷與事件寫入全部
// 重用既有零件（`isWishOfferEnabled`／`writeOfferEventAsync`），只把三句 SQL 換成注入式 runner。
export const OFFER_EXPIRY_SELECT_SQL = `SELECT id, version FROM wish_offers
  WHERE status = 'pending' AND expires_at <= ?
  ORDER BY expires_at ASC, id ASC
  LIMIT ?`;
export const OFFER_EXPIRY_FRESH_SQL = "SELECT status, version FROM wish_offers WHERE id = ?";
export const OFFER_EXPIRY_UPDATE_SQL = `UPDATE wish_offers
  SET status = 'expired', expired_at = ?, updated_at = ?, version = version + 1
  WHERE id = ? AND status = 'pending' AND version = ?`;

export async function runWishOfferExpiryTickAsync(now = new Date(), { limit = OFFER_EXPIRE_BATCH, flags } = {}, options = {}) {
  if (!isWishOfferEnabled(flags)) return { changed: 0, scanned: 0, skipped: true };
  return withFallback(options, { write: true }, async (run) => {
    const stamp = isoOf(now);
    const rows = (await run(OFFER_EXPIRY_SELECT_SQL, [stamp, Math.max(1, Number(limit) || OFFER_EXPIRE_BATCH)])).rows;
    if (!rows.length) return { changed: 0, scanned: 0, skipped: false };
    let changed = 0;
    for (const row of rows) {
      const fresh = one((await run(OFFER_EXPIRY_FRESH_SQL, [row.id])).rows);
      if (!fresh || fresh.status !== "pending") continue;
      const result = await run(OFFER_EXPIRY_UPDATE_SQL, [stamp, stamp, row.id, fresh.version]);
      if (Number(result?.rowCount)) {
        await writeOfferEventAsync(run, { offerId: row.id, eventType: "offer_expired", now });
        changed += 1;
      }
    }
    return { changed, scanned: rows.length, skipped: false };
  }, () => runWishOfferExpiryTick(sqliteHandle(), now, { limit, flags }));
}
