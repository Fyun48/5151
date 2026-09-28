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
import { getSelfRowAsync } from "./selfListingsAsync.js";
import {
  OFFER_REPORT_DAILY_CAP,
  OFFER_REPORT_DETAIL_MAX,
  OFFER_REPORT_REASONS,
  assertOfferBurst,
  assertWishOfferEnabled,
  createOfferReport as createOfferReportSync,
  loadFreshOffer as loadFreshOfferSync,
  loadVisibleOffer as loadVisibleOfferSync,
  newOfferToken,
  offerHttpError,
  publicOfferViewWith,
} from "./wishOffers.js";
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
export const OFFER_BY_ID_SQL = "SELECT * FROM wish_offers WHERE id = ?";
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
