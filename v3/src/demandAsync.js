// 許願房（demand）寫入的 driver-aware 入口（PG 島嶼，2026-09-28）。
//
// 涵蓋的路由（三條都原本只差「一個同步函式」）：
//   `POST /api/demand/:id/report` → `reportDemandAsync`
//   `POST /api/demand/:id/reply`  → `addDemandReplyAsync`
//   `POST /api/demand/:id/close`  → `closeDemandPostAsync`
//
// 為什麼挑這三支而不是整支 `demand.js`：`demand.js` 是 1700 行、約 20 個吃 handle 的函式，
// 但這三支的**主要資料**都只落在三張表（`demand_posts`／`demand_replies`／`demand_reports`），
// 而且它們**沒有**把自己以外的模組一起拉進來。（`GET /api/demand/:id` 那兩條讀取路由卡在
// `getDemandPost()`，那一支會把 `content_documents`、`demand_match_districts` 一起拉進來，
// 是另一批，刻意不在這裡做。）
//
// ⚠️ 副作用刻意留在 `demand.js`：
//   - `reportDemand` 達到檢舉門檻後的「隱藏」會呼叫 `writeLifecycle()`（模組內私有）與
//     `notifyWishOfferLifecycle()`（`wishOffers.js` 註冊的 hook，那個模組整支還在 SQLite handle 上）。
//   - `closeDemandPost` 會呼叫 `syncDemandMatchDistricts()` 與同一組 hook。
//   兩者都改成**呼叫 `demand.js` 匯出的共用副作用函式**（`applyReportHideEffects`／
//   `applyClosedPostEffects`），而不是在 PG 分支裡重寫一份——這樣兩個 driver 的語意不可能漂移，
//   而且 hook 那條線仍留在本機 handle 上，尺規會正確地把它算進 sqlite 集合（不假裝搬完）。
//
// ⚠️ 方言：`pgExec()` 在注入 `exec` 時**不經過** `toPostgresSql`，所以語句一律寫兩邊都合法、
// 且轉譯器不會再改它的形式（不要 `IFNULL`、不要 `LIMIT -1`、不要純量 `MIN(a,b)`）。
//
// ⚠️ **PG 沒有 `demand_reports` 的唯一鍵**：SQLite 的 DDL 也沒有（只有 `id` 主鍵），
// 所以「同一人重複檢舉」是靠這裡的**先查再寫**擋掉的，跟同步版一樣、不是靠約束。
// 這也是本檔案不做 `ON CONFLICT` 的原因——沒有那個約束，寫了只會拿到 `42P10`。
import { resolveDbDriver } from "./dbDriver.js";
// SQLite 分支需要 handle（`demand.js` 的函式吃 `(db, …)`），與 `selfListingsAsync.js` 同一模式。
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { ensurePgSchema } from "./pgSchema.js";
// 可見性與公開視圖是**純函式**，直接重用（與 closeSelfListing 那批同一個做法）。
import { WISH_SURFACE, wishVisibleOnSurface } from "./stage1FixtureIsolation.js";
import { createPublicToken, publicInactiveWishView } from "./wishLifecycle.js";
import {
  DEMAND_REPLY_MAX,
  DEMAND_REPLY_MAX_PER_HOUR,
  DEMAND_REPLY_MIN_GAP_MS,
  DEMAND_REPORT_HIDE_AFTER,
  DEMAND_MAX_OPEN,
  COUNT_MUTABLE_EXCEPT_SQL,
  COUNT_MUTABLE_SQL,
  WISH_CONTACT_PROFILE_SQL,
  WRITE_ROW_SQL,
  addDemandReply as addDemandReplySync,
  applyClosedPostEffects,
  applyClosedPostEffectsAsync,
  applyPublishInPlace,
  applyPublishInPlaceAsync,
  applyReopenInPlace,
  applyReopenInPlaceAsync,
  applyReportHideEffects,
  applyReportHideEffectsAsync,
  assertMatureAccount,
  assertNotCollapsed,
  assertPublishable,
  classifyWishPublishState,
  closeDemandPost as closeDemandPostSync,
  contactFields,
  currentRentalMarketplaceFlags,
  decoratePostWith,
  getDemandPost as getDemandPostSync,
  httpError,
  isUniqueUserConstraintError,
  matchesFilters,
  normalizeWishFields,
  publishWishRoom as publishWishRoomSync,
  reopenWishRoom as reopenWishRoomSync,
  reportDemand as reportDemandSync,
  stripUnsafePlain,
  throwActiveLimit,
  updateWishRoom as updateWishRoomSync,
  writeRow,
  writeRowParams,
  assertPublicFields,
  EXPIRE_CONFIRM_SQL,
  EXPIRE_PAUSE_SQL,
  EXPIRE_LEGACY_SQL,
  EXPIRE_CONFIRM_PARAMS,
  EXPIRE_PAUSE_PARAMS,
  EXPIRE_LEGACY_PARAMS,
  PRUNE_MATCH_DISTRICTS_SQL,
  expireGraceCutoff,
  expireOpenPosts,
  isWishLifecycleExpiryEnabled,
  publicWishRoomView,
} from "./demand.js";
// 生命週期的兩個純判斷：`reopen` 要與同步版逐條相同（completed 不能重開、blocked 不能重開）。
import { isWishLifecycleEnabled } from "./rentalMarketplaceFlags.js";
import { mapLegacyLifecycle } from "./wishLifecycle.js";
// ⚠️ 這個 import 是**語意必需**、不是方便：`getWishConditionsAsync()` 會把 PG 上的
// marketplace flags 與租屋目錄灌進 `demand.js` 的模組快取，而 `normalizeWishFields()`
// 讀的正是那兩個快取（同步版的 `*For` 包裝也是先呼叫 `getWishConditions()`）。
import { getWishConditionsAsync } from "./rentalCatalogAsync.js";

// 這三支只碰這三張表。`ensurePgSchema` 會由 SQLite 的實際 schema 鏡射建表，並把
// `sqlite_master` 裡有 `sql` 的索引一併補建（`createIndexStatements()` 逐字沿用 SQLite 的
// `CREATE … INDEX … WHERE …`，部分索引與 UNIQUE 都會帶過去）。實查 `5151_shadow`：
// 這三張表在 PG 上**只有 pkey**，SQLite 定義的索引一個都沒有——所以要靠這裡補
// （含「同一人只能有一則 open」的 `idx_demand_one_open`，那是**部分**唯一索引）。
export const DEMAND_TABLES = ["demand_posts", "demand_replies", "demand_reports"];

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

// 統一成 `{ rows, rowCount }`（與 `crmOutboxAsync.js` 同一個形狀）：PG 的 `pg` 回 rowCount，
// 注入式替身可能只回陣列。寫入要判斷「到底有沒有寫進去」就必須拿到 rowCount。
function normalizeResult(raw) {
  if (Array.isArray(raw)) return { rows: raw, rowCount: Number(raw.rowCount ?? raw.length) || 0 };
  const rows = (raw && raw.rows) || [];
  return { rows, rowCount: Number((raw && raw.rowCount) ?? rows.length) || 0 };
}

const schemaReady = new WeakMap();
export async function ensureDemandStoreOnce(pgDriver) {
  if (!pgDriver) return;
  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);
  const ready = ensurePgSchema(pgDriver, sqliteHandle(), { tables: DEMAND_TABLES });
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
    await ensureDemandStoreOnce(pgDriver);
    const exec = async (sql, params = []) => normalizeResult(await pgDriver.query(toPostgresSql(sql), params));
    return await runPostgres(exec);
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write })) throw error;
    return runSqlite();
  }
}

// ⚠️ 注入式 `exec` 的統一形狀是 `{ rows, rowCount }`（`crmOutboxAsync.js` 起的慣例），
// 不是「一列一列的陣列」。`one()` 收到的是 `run(...)` 的 **`.rows`**——
// 這裡踩過一次：把整個 `{rows,rowCount}` 餵給 `one()`，它回 null，於是每一筆檢舉
// 都被判成「找不到要檢舉的內容」（整條路徑 404），而 SQL 其實跑得好好的。
// 副作用有兩半，**必須分開對待**（2026-09-28 CI 的 live PG 測試抓到）：
//   1. 「跟這張表有關」的那半（把 `status` 改成 hidden／closed、寫 lifecycle）——
//      **如果只寫本機 handle，PG 上的那一列不會變**。站上的讀取（`listDemand`／
//      `getDemandPost`／公開頁）在島嶼還沒搬完之前讀的是節點 SQLite，所以本機那一列也要改；
//      但當這三張表搬到 PG 之後（＝現在），**只改本機等於什麼都沒做**。
//      ⇒ 這半要**兩邊都寫**：PG 是真的來源，本機 handle 是為了讓還沒搬完的讀取看到一致的狀態。
//   2. 跨模組的那半（`syncDemandMatchDistricts`／`notifyWishOfferLifecycle`／hook）——
//      那些函式吃 handle 且整支還在 SQLite 上，所以照舊只跑本機 handle。
// 這個區分是 live PG 測試逼出來的：第一版只寫本機 handle，於是
// 「檢舉達門檻之後 PG 的 status 還是 open」——在真的 PG 上就是功能失效。
function pgEffects(target) {
  const exec = typeof target === "function" ? target : (sql, params = []) => target.run(sql, params);
  return {
    run: (sql, params = []) => exec(sql, params).then(() => undefined),
    hasColumn: () => true, // PG 的 demand_posts 由 ensurePgSchema 鏡射，lifecycle 一定在
  };
}

const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);
const iso = (now) => (now instanceof Date ? now : new Date(now ?? Date.now())).toISOString();

// 逐字對應 demand.js 的語句。
export const REPORT_TARGET_REPLY_SQL = "SELECT id FROM demand_replies WHERE id = ?";
export const REPORT_TARGET_POST_SQL = "SELECT id FROM demand_posts WHERE id = ?";
// 檢舉目標的存在檢查：同步版用三元式選語句，這裡用查表。
export const TARGET_EXISTS_SQL = { reply: REPORT_TARGET_REPLY_SQL, post: REPORT_TARGET_POST_SQL };
export const REPORT_DUPLICATE_SQL =
  "SELECT id FROM demand_reports WHERE target_type = ? AND target_id = ? AND user_id = ?";
export const REPORT_INSERT_SQL =
  "INSERT INTO demand_reports(target_type, target_id, user_id, reason, created_at) VALUES (?, ?, ?, ?, ?)";
export const REPORT_COUNT_SQL =
  "SELECT COUNT(*) AS n FROM demand_reports WHERE target_type = ? AND target_id = ?";

// `db.js reportDemandItem()` 的 PG 版：規則（登入、目標存在、同一人不重複、達門檻才隱藏）
// 與同步版逐條相同，只換掉跑語句的人。
export async function reportDemandAsync(userId, input = {}, options = {}) {
  const { targetType, targetId, reason } = input || {};
  return withFallback(options, { write: true }, async (run) => {
    const uid = Number(userId) || 0;
    if (!uid) throw httpError("請先登入才能檢舉", 401);
    const kind = targetType === "reply" ? "reply" : "post";
    const id = Number(targetId) || 0;
    if (!id) throw httpError("請指定要檢舉的內容");
    const exists = one((await run(TARGET_EXISTS_SQL[kind], [id])).rows);
    if (!exists) throw httpError("找不到要檢舉的內容", 404);
    const already = one((await run(REPORT_DUPLICATE_SQL, [kind, id, uid])).rows);
    if (already) return { ok: true, already: true };
    const now = new Date();
    await run(REPORT_INSERT_SQL, [kind, id, uid, String(reason || "").trim().slice(0, 200), iso(now)]);
    const count = Number(one((await run(REPORT_COUNT_SQL, [kind, id])).rows)?.n) || 0;
    const hide = count >= DEMAND_REPORT_HIDE_AFTER;
    if (hide) {
      // 先寫 PG（真的來源），再讓本機 handle 追上，這樣兩個讀取路徑看到一致的狀態。
      await applyReportHideEffectsAsync(run, kind, id, now);
      applyReportHideEffects(sqliteHandle(), kind, id, now);
    }
    return { ok: true, hidden: hide };
  }, () => reportDemandSync(sqliteHandle(), userId, input));
}

// ── 回覆 ────────────────────────────────────────────────────────────────────
// 🚫 **2026-09-28：這一支還沒接線，`POST /api/demand/:id/reply` 仍走同步版。**
// 理由（CI 的 live PG 測試逼出來的）：回覆寫進 PG 之後，站上的讀取（`listDemand`／
// `getDemandPost`／公開頁）**還是讀節點 SQLite**（那些函式是這一塊島嶼剩下的部分）。
// 接線就會變成「寫 PG、讀 SQLite」的雙寫分歧：回覆在 PG，頁面卻看不到。
// **前置條件是 `getDemandPost()`／`listDemand()` 先搬上 PG**；在那之前不要接。
// 程式與測試都留著（parity 測試在驗它），但路由不接。
// 逐字對應 demand.js 的語句。
export const REPLY_LAST_SQL =
  "SELECT created_at FROM demand_replies WHERE user_id = ? ORDER BY id DESC LIMIT 1";
export const REPLY_HOURLY_SQL =
  "SELECT COUNT(*) AS n FROM demand_replies WHERE user_id = ? AND created_at >= ?";
export const REPLY_INSERT_SQL =
  "INSERT INTO demand_replies(post_id, user_id, body, created_at, hidden) VALUES (?, ?, ?, ?, 0)";
export const POST_STATUS_SQL = "SELECT status FROM demand_posts WHERE id = ?";

// 同步版為了擋洗版，用「本機 handle」讀三件事：帳號建立時間、上一則回覆時間、這一小時的則數。
// PG 版把這三個查詢搬上 PG（同一批語句），其餘（登入、24 小時門檻、長度、間隔、每小時上限）
// 全部沿用 demand.js 的共用判斷與常數，不重寫。
//
// ⚠️ 這裡**刻意**沒把 `assertMatureAccount()` 的查詢也寫成 PG 語句：那支吃 handle，
// 所以 PG 模式下是用本機 SQLite 的 `users.created_at` 判斷。`users` 兩台本來就可能不同步，
// 但這是**既有**的落差（`readSession` 那一類），不是這一批造成的；要一起解的話屬於
// session／users 那一條線。先在這裡寫明，不假裝它已經同源。
export async function addDemandReplyAsync(userId, postId, body, options = {}) {
  return withFallback(options, { write: true }, async (run) => {
    const uid = Number(userId) || 0;
    if (!uid) throw httpError("請先登入才能回覆", 401);
    assertMatureAccount(sqliteHandle(), uid, new Date(), "回覆");
    const id = Number(postId) || 0;
    const post = one((await run(POST_STATUS_SQL, [id])).rows);
    if (!post || post.status !== "open") throw httpError("這則許願房已關閉或過期", 400);
    const text = stripUnsafePlain(body, DEMAND_REPLY_MAX);
    if (text.length < 2) throw httpError("回覆請至少寫 2 個字");
    const now = new Date();
    const last = one((await run(REPLY_LAST_SQL, [uid])).rows);
    if (last && now.getTime() - Date.parse(last.created_at) < DEMAND_REPLY_MIN_GAP_MS) {
      throw httpError("回覆太密集，請稍候再試", 429);
    }
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const hourly = Number(one((await run(REPLY_HOURLY_SQL, [uid, hourAgo])).rows)?.n) || 0;
    if (hourly >= DEMAND_REPLY_MAX_PER_HOUR) throw httpError("這一小時回覆次數已達上限", 429);
    await run(REPLY_INSERT_SQL, [id, uid, text, iso(now)]);
    // ⚠️ 回傳封包與同步版**不同**，這是刻意的：同步版回傳整則許願房（含剛寫入的回覆），
    // 那一支 `getDemandPost()` 還沒搬上 PG。PG 分支若照抄去讀本機 handle，會拿到
    // **還沒寫進去的回覆**（寫 PG、讀 SQLite），那是比不回傳更糟的假資料。
    // 實測客戶端（`v3/public/index.html` 的 `readApi`）只用 `res.ok` 與 `data.error`，
    // 成功後一律 `await loadDemand()` 重新載入，所以這裡回一個誠實的最小封包。
    return { ok: true, id, replied: true };
  }, () => addDemandReplySync(sqliteHandle(), userId, postId, body));
}

// ── 關閉 ────────────────────────────────────────────────────────────────────
// 🚫 **2026-09-28：這一支也還沒接線，`POST /api/demand/:id/close` 仍走同步版**，
// 理由與 `addDemandReplyAsync()` 完全相同（關閉之後的列表／詳情仍讀節點 SQLite）。
export const POST_OWNER_SQL = "SELECT * FROM demand_posts WHERE id = ?";

export async function closeDemandPostAsync(userId, postId, opts = {}, options = {}) {
  const { admin = false } = opts || {};
  return withFallback(options, { write: true }, async (run) => {
    const id = Number(postId) || 0;
    const row = one((await run(POST_OWNER_SQL, [id])).rows);
    if (!row) throw httpError("找不到這則許願房", 404);
    if (!admin && Number(row.user_id) !== Number(userId)) throw httpError("只能關閉自己的許願房", 403);
    const now = new Date();
    // 先寫 PG（真的來源），再讓本機 handle 追上；理由與 `reportDemandAsync` 的隱藏相同。
    await applyClosedPostEffectsAsync(run, id, now);
    applyClosedPostEffects(sqliteHandle(), id, now);
    // 同上：同步版回傳整則許願房，這裡只回最小封包，理由與 `addDemandReplyAsync()` 相同。
    return { ok: true, id, status: "closed" };
  }, () => closeDemandPostSync(sqliteHandle(), userId, postId, opts));
}

// ── 讀取（許願房列表與詳情）──────────────────────────────────────────────────
//
// 這一塊是 `getDemandPost()`／`listDemandPosts()` 的 PG 版，也是 reply／close 能夠接線的
// **前置條件**：在那之前，寫 PG 而讀 SQLite 會讓新寫入的資料在頁面上看不到。
//
// 共用邏輯全部重用 demand.js（`decoratePostWith` 吃 loader、`matchesFilters`、
// `publicWishRoomView`、`assertPublicFields`、`wishVisibleOnSurface`），
// 這裡只負責「跑語句」與「套篩選／排序／可見性」。
export const POST_BY_ID_SQL = "SELECT * FROM demand_posts WHERE id = ?";
export const POST_BY_TOKEN_SQL = "SELECT * FROM demand_posts WHERE public_token = ?";
export const POSTS_MINE_SQL = `SELECT * FROM demand_posts
       WHERE user_id = ?
       ORDER BY COALESCE(updated_at, published_at, created_at) DESC, id DESC LIMIT 50`;
export const POSTS_PUBLIC_SQL = `SELECT * FROM demand_posts
       WHERE status = 'open'
         AND (fixture_namespace IS NULL OR fixture_namespace = '')
       ORDER BY COALESCE(updated_at, published_at, created_at) DESC, id DESC LIMIT 80`;
export const REPLIES_BY_POST_SQL = `SELECT r.id, r.user_id, r.body, r.created_at, r.hidden
     FROM demand_replies r
     WHERE r.post_id = ?
     ORDER BY r.id ASC`;
export const AUTHOR_NAME_SQL = "SELECT nickname FROM users WHERE id = ?";
export const ACTIVITY_LOGIN_SQL = "SELECT last_login_at FROM users WHERE id = ?";
export const ACTIVITY_FLAGS_SQL = `SELECT MAX(viewed_at) AS viewed_at, MAX(watched_at) AS watched_at
       FROM user_listing_flags WHERE user_id = ?`;
export const TOKEN_UPDATE_SQL = "UPDATE demand_posts SET public_token = ? WHERE id = ?";

// 過期掃描（讀取時順便寫入，與同步版同一個契約）。⚠️ 兩個 store 都要寫：
// PG 是真的來源；本機 handle 追上，讓還沒搬完的讀取看到一致狀態。
export async function expireOpenPostsAsync(run, now = new Date()) {
  const stamp = iso(now);
  // 本機 handle 也要跑一次：還沒搬完的讀取（以及讀取失敗時的回退）看的是它。
  // 這與 reportDemand 的隱藏同一個處置——PG 是真的來源，本機追上才不會兩個 store 不一致。
  expireOpenPosts(sqliteHandle(), now);
  if (isWishLifecycleExpiryEnabled()) {
    await run(EXPIRE_CONFIRM_SQL, EXPIRE_CONFIRM_PARAMS(stamp));
    await run(EXPIRE_PAUSE_SQL, EXPIRE_PAUSE_PARAMS(stamp, expireGraceCutoff(now)));
  } else {
    await run(EXPIRE_LEGACY_SQL, EXPIRE_LEGACY_PARAMS(stamp));
  }
  await run(PRUNE_MATCH_DISTRICTS_SQL, []);
}

// PG 版的 loader：五個操作與 `syncDecorateLoader()` 一一對應，語句逐字相同。
// `hasColumn` 一律 true——PG 的 demand_posts 由 `ensurePgSchema` 鏡射建表，欄位一定在。
function pgDecorateLoader(run, cache) {
  return {
    replies: (row) => cache.replies.get(Number(row.id)) || [],
    authorName: (userId) => cache.authors.get(Number(userId)) || "會員",
    activitySignals: (row) => cache.signals.get(Number(row.id)) || {
      last_confirmed_at: row.last_confirmed_at,
      wish_edited_at: row.updated_at,
    },
    // 惰性補 token：與同步版相同，只有 public_token 是空的時候才會走到（那是 UPDATE）。
    ensureToken: (row) => {
      for (let i = 0; i < 5; i += 1) {
        const token = createPublicToken();
        cache.pendingTokenWrites.push({ token, id: Number(row.id) });
        return token;
      }
      return "";
    },
    hasColumn: () => true,
  };
}

// 先把整批列需要的中間資料一次抓齊（同步版是每一列各查一次，這裡刻意批次化：
// 這一塊原本就是 N+1，PG 上更不該每一列都來回一趟）。
async function hydrateForRows(run, rows, viewerId) {
  const cache = {
    replies: new Map(),
    authors: new Map(),
    signals: new Map(),
    writtenTokens: new Map(),
    pendingTokenWrites: [],
  };
  const ids = rows.map((row) => Number(row.id));
  const owners = new Set(rows.map((row) => Number(row.user_id)));
  for (const id of ids) {
    const res = await run(REPLIES_BY_POST_SQL, [id]);
    cache.replies.set(id, res.rows || []);
  }
  const authorIds = new Set(owners);
  for (const list of cache.replies.values()) for (const r of list) authorIds.add(Number(r.user_id));
  for (const uid of authorIds) {
    const res = await run(AUTHOR_NAME_SQL, [uid]);
    const nick = String(one(res.rows)?.nickname || "").trim();
    if (nick) cache.authors.set(uid, nick);
  }
  // 活動訊號只有「自己的」許願房會用到（與 decoratePostWith 的判斷相同）。
  if (Number(viewerId)) {
    const res = await run(ACTIVITY_LOGIN_SQL, [viewerId]);
    const lastLogin = one(res.rows)?.last_login_at;
    const flags = one((await run(ACTIVITY_FLAGS_SQL, [viewerId])).rows);
    const extra = { last_login_at: lastLogin || undefined, viewed_at: flags?.viewed_at || undefined, watched_at: flags?.watched_at || undefined };
    for (const row of rows) {
      if (Number(row.user_id) !== Number(viewerId)) continue;
      cache.signals.set(Number(row.id), {
        last_confirmed_at: row.last_confirmed_at,
        wish_edited_at: row.updated_at,
        ...Object.fromEntries(Object.entries(extra).filter(([, v]) => v)),
      });
    }
  }
  return cache;
}

// 惰性補 token 的寫入要真的落地（同步版在 `ensurePublicToken()` 裡直接 UPDATE）。
async function flushTokenWrites(run, loaderCache) {
  for (const { token, id } of loaderCache.pendingTokenWrites) {
    await run(TOKEN_UPDATE_SQL, [token, id]);
    loaderCache.writtenTokens.set(token, { token });
  }
  loaderCache.pendingTokenWrites.length = 0;
}

async function rowsToViews(run, rows, { viewerId = 0, includeHiddenReplies = false } = {}) {
  const cache = await hydrateForRows(run, rows, viewerId);
  const loader = pgDecorateLoader(run, cache);
  const decorated = rows.map((row) => decoratePostWith(loader, row, { viewerId, includeHiddenReplies }));
  if (cache.pendingTokenWrites.length) {
    await flushTokenWrites(run, cache);
    // 補完 token 之後重算一次，讓回傳值帶到新 token（同步版是在組裝前就補好）。
    const again = rows.map((row) => decoratePostWith(loader, row, { viewerId, includeHiddenReplies }));
    return again;
  }
  return decorated;
}

// `listDemandPosts()` 的 PG 版。
export async function listDemandPostsAsync(options = {}, filters = {}) {
  const { viewerId = 0, mine = false, ...rest } = filters;
  return withFallback(options, {}, async (run) => {
    await expireOpenPostsAsync(run, new Date());
    const res = mine && viewerId
      ? await run(POSTS_MINE_SQL, [Number(viewerId)])
      : await run(POSTS_PUBLIC_SQL, []);
    const rows = res.rows || [];
    const filtered = mine ? rows : rows.filter((row) => matchesFilters(row, rest));
    filtered.sort((a, b) => {
      const ta = recencyOf(a);
      const tb = recencyOf(b);
      if (ta !== tb) return tb.localeCompare(ta);
      return Number(b.id) - Number(a.id);
    });
    const decorated = await rowsToViews(run, filtered, { viewerId });
    return mine
      ? decorated
      : decorated.map((row) => assertPublicFields(publicWishRoomView({ ...row, mine: false, replies: row.replies })));
  }, async () => (await import("./db.js")).listDemand({ viewerId, mine, ...rest }));
}

const recencyOf = (row) => row.updated_at || row.published_at || row.created_at || "";

// `getDemandPost()` 的 PG 版。可見性與 404 的**順序**照抄同步版（順序錯了會把 404 變成 200
// ＝洩漏），需要的判斷全部重用 demand.js 的純函式。
export const POST_VISIBILITY_SQL = "SELECT 1"; // 佔位：可見性靠純函式，不需查詢

export async function getDemandPostAsync(postId, opts = {}, options = {}) {
  const { viewerId = 0, publicOnly = false, allowNumeric = false, includeActorReplies = false } = opts;
  return withFallback(options, {}, async (run) => {
    await expireOpenPostsAsync(run, new Date());
    const ref = String(postId || "").trim();
    const numeric = /^\d+$/.test(ref);
    const row = numeric
      ? one((await run(POST_BY_ID_SQL, [Number(ref) || 0])).rows)
      : one((await run(POST_BY_TOKEN_SQL, [ref])).rows);
    if (!row) throw httpError("找不到這則許願房", 404);
    const mine = Number(row.user_id) === Number(viewerId);
    const surface = mine && !publicOnly ? WISH_SURFACE.MINE : WISH_SURFACE.PUBLIC_DETAIL;
    if (!wishVisibleOnSurface(row, { surface, viewerId })) throw httpError("找不到這則許願房", 404);
    if (numeric && !allowNumeric && (publicOnly || !mine) && !Number(row.legacy_numeric_share)) {
      throw httpError("找不到這則許願房", 404);
    }
    if (row.status === "hidden" && !mine) throw httpError("這則許願房已隱藏", 404);
    if (row.status === "draft" && !mine) throw httpError("找不到這則許願房", 404);
    if (publicOnly && row.status !== "open") {
      if (isWishLifecycleExpiryEnabled() || row.status !== "draft") {
        return assertPublicFields({
          ...publicInactiveWishView(),
          id: Number(row.id),
          public_path: row.public_token ? `/w/${row.public_token}` : `/w/${row.id}`,
        });
      }
      throw httpError("找不到這則許願房", 404);
    }
    if (!mine && row.status !== "open") throw httpError("找不到這則許願房", 404);
    const [decorated] = await rowsToViews(run, [row], { viewerId, includeHiddenReplies: false });
    if (!mine || publicOnly) {
      const view = assertPublicFields(publicWishRoomView(decorated));
      if (includeActorReplies) return { ...view, replies: decorated.replies };
      return view;
    }
    return decorated;
  }, () => getDemandPostSync(sqliteHandle(), postId, opts));
}

// ── 屋主的許願房摘要與待處理報價數 ───────────────────────────────────────────
//
// `wishRoomOwnerSummaryFor()`（db.js）是列表與 `/mine` 這幾條路由最後的卡點之一。
// 它做四件事：過期掃描、列出自己的許願房、`wish_room_example` 有沒有範例、以及
// **待處理報價數**（`wish_offers` 那張表）；前者已在這一支、後者只是 COUNT。
export const OWNER_POSTS_SQL = "SELECT * FROM demand_posts WHERE user_id = ? ORDER BY id DESC";
export const HAS_EXAMPLE_SQL = "SELECT user_id FROM wish_room_example WHERE user_id = ?";
export const PENDING_OFFER_COUNT_SQL =
  "SELECT COUNT(*) AS n FROM wish_offers WHERE tenant_user_id = ? AND status = 'pending'";

// ⚠️ 逐鍵對齊同步版——**連它自己前後不一致的地方也要照抄**：
// 同步版 `uid = 0` 的早退分支回 `{active,draft,closed,has_example}`（有 `closed`、沒有
// `can_create`），而正常分支回 `{active,draft,has_example,can_create}`（相反）。
// 第一版我兩邊都「整理乾淨」，parity 立刻紅——這正是 parity 要抓的漂移。
// 要改這個不一致，應該改同步版並另開一批，不是在 PG 版偷偷對齊。
const EMPTY_OWNER_SUMMARY_ZERO = { active: null, draft: null, closed: [], has_example: false };

// `pendingInboxCount()` 的 PG 版（wishOfferQueries.js 那一支只吃 handle）。
export async function pendingOfferCountAsync(run, userId) {
  const uid = Number(userId) || 0;
  if (!uid) return 0;
  return Number(one((await run(PENDING_OFFER_COUNT_SQL, [uid])).rows)?.n) || 0;
}

// `wishRoomOwnerSummaryFor()` 的 PG 版：形狀與同步版逐鍵相同（`can_create` 也在內）。
export async function wishRoomOwnerSummaryAsync(userId, options = {}) {
  return withFallback(options, {}, async (run) => {
    const uid = Number(userId) || 0;
    if (!uid) return { ...EMPTY_OWNER_SUMMARY_ZERO };
    await expireOpenPostsAsync(run, new Date());
    const rows = (await run(OWNER_POSTS_SQL, [uid])).rows || [];
    const active = rows.find((row) => row.status === "open") || null;
    const draft = rows.find((row) => row.status === "draft") || null;
    const decorated = await rowsToViews(run, [active, draft].filter(Boolean), { viewerId: uid });
    const byId = new Map(decorated.map((view) => [Number(view.id), view]));
    const hasExample = Boolean(one((await run(HAS_EXAMPLE_SQL, [uid])).rows));
    return {
      active: active ? byId.get(Number(active.id)) || null : null,
      draft: draft ? byId.get(Number(draft.id)) || null : null,
      has_example: hasExample,
      can_create: !active,
    };
  }, async () => (await import("./db.js")).wishRoomOwnerSummaryFor(userId));
}

// ── 許願房生命週期寫入（更新／刊登／重開）────────────────────────────────────
//
// 涵蓋的路由：
//   `PATCH /api/wish-rooms/:id`         → `updateWishRoomAsync`
//   `POST  /api/wish-rooms/:id/publish` → `publishWishRoomAsync`
//   `POST  /api/wish-rooms/:id/reopen`  → `reopenWishRoomAsync`
//
// 這三條原本各差「一組吃 handle 的同步函式」（`demand.js` 的實作 ＋ `db.js` 的 `*For` 包裝），
// 主要資料都只落在 `demand_posts`，其餘部分（`getDemandPostAsync`／`expireOpenPostsAsync`）
// 都已經在島上。規則**全部**重用 `demand.js`，這裡只負責「跑語句」：
// `normalizeWishFields`（純核心）／`classifyWishPublishState`／`assertNotCollapsed`／
// `assertPublishable`／`countMutable` 的語句／`applyPublishInPlaceAsync`／`applyReopenInPlaceAsync`。
//
// ⚠️ 三個一定要處理的耦合（少一個就會出錯，這裡寫明理由）：
//
//   1. **行程內快取**：`db.js` 的 `*For` 包裝第一件事是 `getWishConditions()`，它會把
//      `marketplaceFlags`／`catalogCacheV2` 灌進 `demand.js` 的模組變數——而
//      `normalizeWishFields()` 讀的正是那兩個。PG 分支若跳過這一步，會拿**空目錄**去正規化
//      （條件選項整批消失、生命週期開關判錯），而且只有在真的改了條件選項時才看得出來。
//      所以每一支都先 `await getWishConditionsAsync(options)`（PG 版的 settings 讀取，
//      跑的是同一組 setter）。
//
//   2. **兩個 store 都要寫**：PG 是真的來源；本機 handle 也要寫，讓還沒搬完的讀取
//      （`aggregateDemand`／`homepageDemandExposure` 那幾支仍吃 handle）看到一致的狀態。
//      順序固定「PG 先、本機後」，與 `reportDemandAsync`／`closeDemandPostAsync` 相同。
//
//   3. **沒有交易**：PG 走連線池，用 `run()` 下 `BEGIN` 不保證同一條連線（反而會把
//      `BEGIN` 留在池子裡的某條連線上）。同步版的 `withImmediate()` 在這裡沒有對應物，
//      「同時只能有一則 open」改靠 `ensurePgSchema` 從 SQLite 鏡射過去的部分唯一索引
//      （`idx_demand_one_open`／`idx_demand_one_mutable`）擋；撞到就轉成與同步版**同一個**
//      `wish_active_limit` 錯誤（`isUniqueUserConstraintError()`）。
//
// ⚠️ 回傳值與同步版相同（整則許願房）：`getDemandPostAsync()` 已經在島上，讀的是 PG，
// 所以不會出現「寫 PG、讀 SQLite」那種拿到舊資料的假回應（那正是 reply／close 兩支
// 當初只能回最小封包的原因，現在那個前置條件已經滿足）。
export const POST_OWNER_ROW_SQL = "SELECT * FROM demand_posts WHERE id = ?";

// 巢狀讀取（回傳整則許願房）用：把當前這條 runner 直接傳下去，不要再解一次 driver／schema。
const nested = (options, run) => ({ ...options, driver: "postgres", exec: run });

// 時間的測試縫：與 `listingSimilarityAsync` 同一個寫法（`iso(options.now)`）。
// 有注入就用注入的，沒有就用當下——正式路徑不傳，行為與同步版的預設參數相同。
const nowOf = (options) => (options.now ? new Date(options.now) : new Date());

async function countMutableAsync(run, userId, exceptId = 0) {
  const res = exceptId
    ? await run(COUNT_MUTABLE_EXCEPT_SQL, [userId, exceptId])
    : await run(COUNT_MUTABLE_SQL, [userId]);
  return Number(one(res.rows)?.n) || 0;
}

// `normalizeWishFields()` 需要「已經查好的聯絡人列」，但那個查詢是非同步的、而 thunk 必須在
// **原本的位置**才被呼叫（見 `demand.js` 的說明：同時有多個錯誤時，先丟哪一個要與同步版一致）。
// 所以這裡先查、後把結果包成同步 thunk；查不到時 thunk 才丟 404——與同步版的順序相同。
async function contactThunkFor(run, userId, input, fallback) {
  const profileId = Number(input?.contact_profile_id) || 0;
  if (!profileId) return () => contactFields(userId, input, fallback, null);
  let row = null;
  let failed = false;
  try {
    row = one((await run(WISH_CONTACT_PROFILE_SQL, [profileId])).rows);
  } catch {
    failed = true;
  }
  return () => {
    if (failed || !row) throw httpError("找不到這個聯絡人", 404);
    return contactFields(userId, input, fallback, row);
  };
}

async function wishFieldsAsync(run, userId, input, fallback) {
  return normalizeWishFields(userId, input, fallback, await contactThunkFor(run, userId, input, fallback));
}

// 撞到「一人一則」的部分唯一索引時，PG 丟的是 23505，同步版丟的是 `wish_active_limit`。
// 兩邊的**錯誤形狀**必須相同，否則前端看到的訊息會隨 driver 改變。
function rethrowActiveLimit(error) {
  if (isUniqueUserConstraintError(error)) throwActiveLimit();
  throw error;
}

// `updateWishRoomFor()`（db.js）的 PG 版。
export async function updateWishRoomAsync(userId, postId, input = {}, options = {}) {
  return withFallback(options, { write: true }, async (run) => {
    const uid = Number(userId) || 0;
    if (!uid) throw httpError("請先登入", 401);
    await getWishConditionsAsync(options);
    const id = Number(postId) || 0;
    const row = one((await run(POST_OWNER_ROW_SQL, [id])).rows);
    if (!row) throw httpError("找不到這則許願房", 404);
    if (Number(row.user_id) !== uid) throw httpError("只能修改自己的許願房", 403);
    if (row.status === "hidden") throw httpError("已隱藏的許願房不能再改", 400);
    const fields = await wishFieldsAsync(run, uid, input || {}, row);
    if (row.status === "open") assertPublishable(fields);
    const extra = { updated_at: iso(nowOf(options)) };
    await run(WRITE_ROW_SQL, writeRowParams(row.id, fields, extra));
    // 本機 handle 追上（`writeRow()` 內含 `syncDemandMatchDistricts()`，那一支吃 handle）。
    writeRow(sqliteHandle(), row.id, fields, extra);
    return getDemandPostAsync(row.id, { viewerId: uid }, nested(options, run));
  }, () => updateWishRoomSync(sqliteHandle(), userId, postId, input));
}

// `publishWishRoomFor()`（db.js）的 PG 版。順序照抄同步版：成熟度 → 過期掃描 → 狀態分類。
export async function publishWishRoomAsync(userId, postId, input = {}, options = {}) {
  return withFallback(options, { write: true }, async (run) => {
    const uid = Number(userId) || 0;
    if (!uid) throw httpError("請先登入", 401);
    await getWishConditionsAsync(options);
    const now = nowOf(options);
    // 與 `addDemandReplyAsync` 同一個已知落差：帳號成熟度讀的是**本機** `users.created_at`
    // （`assertMatureAccount()` 吃 handle）。真正同源要跟 session／users 那條線一起解。
    assertMatureAccount(sqliteHandle(), uid, now, "刊登許願房");
    await expireOpenPostsAsync(run, now);
    const id = Number(postId) || 0;
    const row = one((await run(POST_OWNER_ROW_SQL, [id])).rows);
    if (!row) throw httpError("找不到這則許願房", 404);
    if (Number(row.user_id) !== uid) throw httpError("只能刊登自己的許願房", 403);
    if (classifyWishPublishState(row) === "already_open") {
      return getDemandPostAsync(row.id, { viewerId: uid }, nested(options, run));
    }
    const fields = await wishFieldsAsync(run, uid, input || {}, row);
    assertPublishable(fields);
    if (await countMutableAsync(run, uid, row.id) >= DEMAND_MAX_OPEN) throwActiveLimit();
    try {
      await applyPublishInPlaceAsync(run, row, fields, now);
    } catch (error) {
      rethrowActiveLimit(error);
    }
    applyPublishInPlace(sqliteHandle(), row, fields, now);
    return getDemandPostAsync(row.id, { viewerId: uid }, nested(options, run));
  }, () => publishWishRoomSync(sqliteHandle(), userId, postId, input));
}

// `reopenWishRoomFor()`（db.js）的 PG 版。
export async function reopenWishRoomAsync(userId, postId, options = {}) {
  return withFallback(options, { write: true }, async (run) => {
    const uid = Number(userId) || 0;
    if (!uid) throw httpError("請先登入", 401);
    await getWishConditionsAsync(options);
    const now = nowOf(options);
    assertMatureAccount(sqliteHandle(), uid, now, "重新公開許願房");
    await expireOpenPostsAsync(run, now);
    const id = Number(postId) || 0;
    const row = one((await run(POST_OWNER_ROW_SQL, [id])).rows);
    if (!row) throw httpError("找不到這則許願房", 404);
    if (Number(row.user_id) !== uid) throw httpError("只能重開自己的許願房", 403);
    if (row.status === "open") return getDemandPostAsync(row.id, { viewerId: uid }, nested(options, run));
    if (row.status === "hidden") throw httpError("已隱藏的許願房不能重開", 400);
    if (row.status === "draft") throw httpError("草稿請改用刊登", 400);
    assertNotCollapsed(row);
    if (await countMutableAsync(run, uid, row.id) >= DEMAND_MAX_OPEN) throwActiveLimit();
    const fields = await wishFieldsAsync(run, uid, {}, row);
    assertPublishable(fields);
    // ⚠️ 這兩個判斷讀的是**行程內快取**（`getWishConditionsAsync()` 剛灌好），與同步版相同。
    const flags = currentRentalMarketplaceFlags();
    if (mapLegacyLifecycle(row) === "completed" && isWishLifecycleEnabled(flags)) {
      throw httpError("已找到房的許願房請另開新的一則", 400, "wish_completed");
    }
    if (mapLegacyLifecycle(row) === "blocked") throw httpError("已封鎖的許願房不能重開", 400, "wish_blocked");
    try {
      await applyReopenInPlaceAsync(run, row, fields, now);
    } catch (error) {
      rethrowActiveLimit(error);
    }
    applyReopenInPlace(sqliteHandle(), row, fields, now);
    return getDemandPostAsync(row.id, { viewerId: uid }, nested(options, run));
  }, () => reopenWishRoomSync(sqliteHandle(), userId, postId));
}
