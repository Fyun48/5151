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
  addDemandReply as addDemandReplySync,
  applyClosedPostEffects,
  applyClosedPostEffectsAsync,
  applyReportHideEffects,
  applyReportHideEffectsAsync,
  assertMatureAccount,
  closeDemandPost as closeDemandPostSync,
  decoratePostWith,
  getDemandPost as getDemandPostSync,
  matchesFilters,
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
  httpError,
  reportDemand as reportDemandSync,
  stripUnsafePlain,
} from "./demand.js";

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
