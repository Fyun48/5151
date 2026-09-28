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
