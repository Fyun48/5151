// 使用者回饋（feedback）與其傳輸佇列的 driver-aware 入口（PG 島嶼，2026-09-28，第五十八批）。
//
// 涵蓋的路由：
//   POST  /api/feedback                送出回饋（`createFeedbackWithOutbox` 的原子不變式）
//   GET   /api/admin/feedback          後台列表（stats ＋ items ＋ ops_delivery）
//   PATCH /api/admin/feedback/:id      改狀態／備註（＋可選的 CRM 連結）
//
// 🚨 **這一支的核心是那個不變式**：「一筆成功寫入的 feedback ⇔ 一筆初始 outbox 事件」。
// 同步版用 `BEGIN IMMEDIATE` 包住兩句 INSERT。PG 版**必須用真的交易**
// （`pgDriver.withTransaction`）——PG 的每次 `query()` 都是自己的隱含交易，
// 分兩句寫就會出現「回饋進去了、事件沒進去」的半套狀態，而那個事件是 Ops 唯一的來源。
//
// 純判斷（honeypot、長度、狀態／類型白名單、情境裁切、洪水限制的門檻）全部留在
// `feedback.js`／`feedbackOutbox.js`，這裡只換「跑語句的人」。
import { resolveDbDriver } from "./dbDriver.js";
import {
  FEEDBACK_MAX_PER_DAY,
  FEEDBACK_MAX_PER_HOUR,
  FEEDBACK_MIN_GAP_MS,
  FEEDBACK_CONTEXT_MAX,
  FEEDBACK_BODY_MAX,
  FEEDBACK_BODY_MIN,
  FEEDBACK_CONTACT_MAX,
  FEEDBACK_NOTE_MAX,
  createFeedbackWithOutbox as createFeedbackWithOutboxSync,
  feedbackStats as feedbackStatsSync,
  listFeedback as listFeedbackSync,
  normalizeFeedbackContext,
  normalizeFeedbackKind,
  normalizeFeedbackStatus,
  updateFeedback as updateFeedbackSync,
} from "./feedback.js";
import {
  OUTBOX_DEFAULT_MAX_ATTEMPTS,
  enqueueFeedbackOutbox as enqueueFeedbackOutboxSync,
} from "./feedbackOutbox.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { sqliteHandleIsUsable } from "./sqliteHandle.js";
import { claimFeedbackAttachmentsAsync } from "./feedbackMediaAsync.js";
import { ensurePgSchema } from "./pgSchema.js";

export const FEEDBACK_TABLES = ["feedback", "feedback_outbox"];
// `feedback_outbox` 的 delivery_id／idempotency_key 是**表約束**（隱式索引），鏡射不到
// （已中六次以上）；少了它們，重送會產生重複列而 Ops 端的去重就失效了。
export const FEEDBACK_UNIQUE_INDEXES = [
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_outbox_delivery_id ON feedback_outbox(delivery_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_outbox_idempotency_key ON feedback_outbox(idempotency_key)",
];

export const FEEDBACK_INSERT_SQL = `INSERT INTO feedback(user_id, kind, body, contact, context, status, admin_note, created_at, updated_at)
   VALUES ($1, $2, $3, $4, $5, 'new', '', $6, $6) RETURNING *`;
export const FEEDBACK_BY_ID_SQL = "SELECT * FROM feedback WHERE id = $1";
// 讀回來要裝飾時一律用這一句（`decorateRow()` 需要 join 進來的 email／nickname，
// 少了它後台會顯示成空白——與同步版 `userInfo()` 的行為不同）。
export const FEEDBACK_BY_ID_JOINED_SQL =
  `SELECT f.*, COALESCE(u.email, '') AS __email, COALESCE(u.nickname, '') AS __nickname
   FROM feedback f LEFT JOIN users u ON u.id = f.user_id WHERE f.id = $1`;
export const FEEDBACK_LIST_SQL = `SELECT f.*, COALESCE(u.email, '') AS __email, COALESCE(u.nickname, '') AS __nickname
   FROM feedback f LEFT JOIN users u ON u.id = f.user_id`;
export const FEEDBACK_STATS_STATUS_SQL = "SELECT status, COUNT(*) AS n FROM feedback GROUP BY status";
export const FEEDBACK_STATS_KIND_SQL = "SELECT kind, COUNT(*) AS n FROM feedback GROUP BY kind";
export const FEEDBACK_LAST_SQL = "SELECT created_at FROM feedback WHERE user_id = $1 ORDER BY id DESC LIMIT 1";
export const FEEDBACK_COUNT_SINCE_SQL = "SELECT COUNT(*) AS n FROM feedback WHERE user_id = $1 AND created_at >= $2";
export const OUTBOX_ENQUEUE_SQL = `INSERT INTO feedback_outbox(delivery_id, idempotency_key, feedback_id, payload, status, attempts, max_attempts, next_attempt_at, created_at)
   VALUES ($1, $2, $3, $4, 'pending', 0, $5, $6, $6)`;

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";
const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);

function normalizeResult(raw) {
  if (Array.isArray(raw)) return { rows: raw, rowCount: Number(raw.rowCount ?? raw.length) || 0 };
  const rows = (raw && raw.rows) || [];
  const changes = Number(raw && raw.changes);
  return { rows, rowCount: Number((raw && raw.rowCount) ?? (Number.isFinite(changes) ? changes : rows.length)) || 0 };
}

const nowMs = (now) => (now instanceof Date ? now.getTime() : typeof now === "number" ? now : Date.now());
const iso = (now) => new Date(nowMs(now)).toISOString();

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const schemaReady = new WeakMap();
export async function ensureFeedbackStoreOnce(pgDriver) {
  if (!pgDriver) return;
  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);
  const sqlite = sqliteHandle();
  const ready = (async () => {
    await ensurePgSchema(pgDriver, sqlite, { tables: FEEDBACK_TABLES, indexes: false });
    for (const sql of FEEDBACK_UNIQUE_INDEXES) await pgDriver.exec(sql);
  })();
  schemaReady.set(pgDriver, ready);
  try {
    await ready;
  } catch (error) {
    schemaReady.delete(pgDriver);
    throw error;
  }
}

// C1：會員 email（唯讀；注入式 exec／PG／SQLite 三條路都走同一個查詢）。
export const FEEDBACK_MEMBER_EMAIL_SQL = "SELECT email FROM users WHERE id = ?";

async function memberEmailAsync(userId, options = {}) {
  const uid = Number(userId) || 0;
  if (!uid) return "";
  try {
    const exec = await execFor(options);
    // ⚠️ `execFor()` 已經回傳 `{ rows, rowCount }`（自己再包一層會拿到物件、`[0]` 永遠是 undefined）。
    const { rows } = normalizeResult(await exec(FEEDBACK_MEMBER_EMAIL_SQL, [uid]));
    return String(rows[0]?.email || "");
  } catch {
    // 讀不到會員 email 時留空（與同步版的 userInfo() 同一個容忍度）：不讓回饋因此送不出去。
    return "";
  }
}

async function execFor(options) {
  if (options.exec) {
    const injected = options.exec;
    return async (sql, params = []) => normalizeResult(await injected(sql, params));
  }
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  await ensureFeedbackStoreOnce(pgDriver);
  return async (sql, params = []) => normalizeResult(await pgDriver.query(toPostgresSql(sql), params));
}

async function withFallback(options, runPostgres, runSqlite, { write = false } = {}) {
  if (!isPg(options)) return runSqlite();
  try {
    return await runPostgres(await execFor(options));
  } catch (error) {
    if (!sqliteFallbackAllowed(options, write ? { write: true } : {})) throw error;
    return runSqlite();
  }
}

// `feedback.js assertNotFlooding()` 的 PG 版（三個查詢與門檻逐條對應）。
// ⚠️ 這一段在交易**外面**跑（與同步版相同：先在交易前擋掉）。
async function assertNotFloodingAsync(exec, userId, now) {
  const uid = Number(userId) || 0;
  if (!uid) return;
  const last = one((await exec(FEEDBACK_LAST_SQL, [uid])).rows);
  if (last && nowMs(now) - Date.parse(last.created_at) < FEEDBACK_MIN_GAP_MS) {
    throw httpError("剛剛才送出，請稍等一下再送", 429);
  }
  const hourAgo = new Date(nowMs(now) - 60 * 60 * 1000).toISOString();
  const hourly = Number(one((await exec(FEEDBACK_COUNT_SINCE_SQL, [uid, hourAgo])).rows)?.n) || 0;
  if (hourly >= FEEDBACK_MAX_PER_HOUR) throw httpError("這一小時送出的回饋已達上限，稍後再試", 429);
  const dayAgo = new Date(nowMs(now) - 24 * 60 * 60 * 1000).toISOString();
  const daily = Number(one((await exec(FEEDBACK_COUNT_SINCE_SQL, [uid, dayAgo])).rows)?.n) || 0;
  if (daily >= FEEDBACK_MAX_PER_DAY) throw httpError("今天送出的回饋已達上限，明天再試", 429);
}

// 把一列（含 LEFT JOIN 來的 email／nickname）轉成後台／API 的形狀。
// 逐欄對應 `feedback.js decorateFeedback()`；`__email`／`__nickname` 是 join 欄位。
function decorateRow(row) {
  const context = (() => {
    try {
      const parsed = JSON.parse(row.context || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  })();
  return {
    id: Number(row.id),
    user_id: Number(row.user_id) || 0,
    email: String(row.__email ?? row.email ?? ""),
    nickname: String(row.__nickname ?? row.nickname ?? ""),
    kind: normalizeFeedbackKind(row.kind),
    body: String(row.body || ""),
    contact: String(row.contact || ""),
    context,
    status: normalizeFeedbackStatus(row.status),
    admin_note: String(row.admin_note || ""),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// `feedbackOutbox.js enqueueFeedbackOutbox()` 的 PG 版（帶入呼叫端的 exec／交易）。
async function enqueueWithExec(exec, { feedbackId, data = {}, idempotencyKey = null, maxAttempts = OUTBOX_DEFAULT_MAX_ATTEMPTS, now = new Date() }) {
  const id = Number(feedbackId) || 0;
  if (!id) throw new Error("enqueueFeedbackOutbox requires feedbackId");
  const { randomUUID } = await import("node:crypto");
  const deliveryId = randomUUID();
  const idem = idempotencyKey || `feedback:${id}`;
  const payload = JSON.stringify({ delivery_id: deliveryId, idempotency_key: idem, ...data });
  const ts = iso(now);
  await exec(OUTBOX_ENQUEUE_SQL, [deliveryId, idem, id, payload, maxAttempts, ts]);
  return { deliveryId, idempotencyKey: idem, payload };
}

// `db.js submitFeedback()` 的 PG 版：**同一個交易**裡寫 feedback ＋ 初始 outbox 事件。
export async function submitFeedbackAsync(userId, input = {}, options = {}) {
  if (!isPg(options)) return createFeedbackWithOutboxSync(sqliteHandle(), userId, input);
  const uid = Number(userId) || 0;
  // honeypot：正常使用者看不到、也不會填這個欄位（與同步版同義：直接回 ok、不寫任何列）。
  if (String(input?.website || input?.hp || "").trim()) return { ok: true, id: 0 };
  const now = new Date();
  const kind = normalizeFeedbackKind(input.kind);
  const body = String(input.body || "").trim();
  if (body.length < FEEDBACK_BODY_MIN) throw httpError(`請多寫一點（至少 ${FEEDBACK_BODY_MIN} 個字）`);
  const trimmedBody = body.slice(0, FEEDBACK_BODY_MAX);
  // C1（2026-10-01 工作單）：與同步版同一條規則——聯絡方式取自「已驗證會員的 email」，
  // 不採用前端傳來的值（避免改請求偽造他人聯絡方式）。讀不到就留空，不捏造。
  const contact = await memberEmailAsync(uid, options).then((email) => email.slice(0, FEEDBACK_CONTACT_MAX));
  let contextText = JSON.stringify(normalizeFeedbackContext(input.context));
  if (contextText.length > FEEDBACK_CONTEXT_MAX) contextText = "{}";

  if (options.exec) {
    // 注入式 exec 沒有真的交易（測試／探針）：照同步版的順序跑，並在失敗時回報。
    const exec = await execFor(options);
    await assertNotFloodingAsync(exec, uid, now);
    const row = one((await exec(FEEDBACK_INSERT_SQL, [uid, kind, trimmedBody, contact, contextText, iso(now)])).rows);
    const rowFull = row || one((await exec(FEEDBACK_BY_ID_SQL, [Number(row?.id) || 0])).rows);
    const ctx = decorateRow({ ...rowFull, context: rowFull?.context ?? contextText }).context;
    // C3：附件綁定。注入式 exec 沒有真的交易（測試／探針），照同步版的順序跑並在失敗時往上丟。
    await claimFeedbackAttachmentsAsync(exec, uid, input?.attachments, Number(rowFull.id), now);
    await enqueueWithExec(exec, {
      feedbackId: Number(rowFull.id),
      data: {
        source: "v3",
        external_feedback_id: Number(rowFull.id),
        user_ref: Number(rowFull.user_id) || 0,
        kind: rowFull.kind,
        content: rowFull.body,
        contact: rowFull.contact || "",
        context: ctx,
        app_version: ctx.version || null,
        submitted_at: rowFull.created_at,
        trust_level: "untrusted",
      },
      now,
    });
    return { ok: true, id: Number(rowFull.id) };
  }

  const pgDriver = options.pgDriver || (await sharedPgDriver());
  await ensureFeedbackStoreOnce(pgDriver);
  const run = async (sql, params = []) => normalizeResult(await pgDriver.query(toPostgresSql(sql), params));
  // 交易外的洪水檢查（與同步版同義）。
  await assertNotFloodingAsync(run, uid, now);
  try {
    return await pgDriver.withTransaction(async (client) => {
      const tx = async (sql, params = []) => normalizeResult(await client.query(toPostgresSql(sql), params));
      const row = one((await tx(FEEDBACK_INSERT_SQL, [uid, kind, trimmedBody, contact, contextText, iso(now)])).rows);
      if (!row) throw new Error("feedback 寫入沒有回傳列");
      const ctx = decorateRow(row).context;
      // C3：在同一個 PG 交易內 claim；數量不符就丟 409，整筆（含 feedback 列）rollback。
      await claimFeedbackAttachmentsAsync(tx, uid, input?.attachments, Number(row.id), now);
      await enqueueWithExec(tx, {
        feedbackId: Number(row.id),
        data: {
          source: "v3",
          external_feedback_id: Number(row.id),
          user_ref: Number(row.user_id) || 0,
          kind: row.kind,
          content: row.body,
          contact: row.contact || "",
          context: ctx,
          app_version: ctx.version || null,
          submitted_at: row.created_at,
          trust_level: "untrusted",
        },
        now,
      });
      return { ok: true, id: Number(row.id) };
    });
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write: true })) throw error;
    return createFeedbackWithOutboxSync(sqliteHandle(), userId, input);
  }
}

// 只建立 outbox 事件（不建 feedback）——給已經有 feedback 列的場景用（測試／補送）。
export async function enqueueFeedbackOutboxAsync(input = {}, options = {}) {
  if (!isPg(options)) return enqueueFeedbackOutboxSync(sqliteHandle(), input);
  return withFallback(options, async (exec) => enqueueWithExec(exec, input),
    () => enqueueFeedbackOutboxSync(sqliteHandle(), input), { write: true });
}

// `db.js listFeedbackItems()` 的 PG 版（一次 LEFT JOIN users，避免 N+1）。
export async function listFeedbackAsync({ status = "", kind = "", limit = 200 } = {}, options = {}) {
  if (!isPg(options)) return listFeedbackSync(sqliteHandle(), { status, kind, limit });
  return withFallback(options, async (exec) => {
    const where = [];
    const args = [];
    const st = String(status || "").trim().toLowerCase();
    if (st && st !== "all" && ["new", "planned", "doing", "done", "declined"].includes(st)) {
      args.push(st);
      where.push(`f.status = $${args.length}`);
    }
    const kd = String(kind || "").trim().toLowerCase();
    if (kd && kd !== "all" && ["bug", "idea", "other"].includes(kd)) {
      args.push(kd);
      where.push(`f.kind = $${args.length}`);
    }
    const cap = Math.max(1, Math.min(Number(limit) || 200, 500));
    const sql = `${FEEDBACK_LIST_SQL} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY f.id DESC LIMIT ${cap}`;
    return (await exec(sql, args)).rows.map(decorateRow);
  }, () => listFeedbackSync(sqliteHandle(), { status, kind, limit }));
}

// `db.js getFeedbackStats()` 的 PG 版（bigint 字串要轉數字；狀態／類型都做白名單正規化）。
export async function feedbackStatsAsync(options = {}) {
  if (!isPg(options)) return feedbackStatsSync(sqliteHandle());
  return withFallback(options, async (exec) => {
    const out = { total: 0, byStatus: {}, byKind: {} };
    for (const id of ["new", "planned", "doing", "done", "declined"]) out.byStatus[id] = 0;
    for (const id of ["bug", "idea", "other"]) out.byKind[id] = 0;
    try {
      for (const row of (await exec(FEEDBACK_STATS_STATUS_SQL, [])).rows) {
        const id = normalizeFeedbackStatus(row.status);
        out.byStatus[id] = (out.byStatus[id] || 0) + (Number(row.n) || 0);
        out.total += Number(row.n) || 0;
      }
      for (const row of (await exec(FEEDBACK_STATS_KIND_SQL, [])).rows) {
        const id = normalizeFeedbackKind(row.kind);
        out.byKind[id] = (out.byKind[id] || 0) + (Number(row.n) || 0);
      }
    } catch (error) {
      // 同步版也是吞掉（表還沒建時回全 0）；但 strict／開閘時必須把 PG 的錯誤往上丟，
      // 否則「查詢壞掉」會被當成「統計是 0」回給後台。
      if (options.strict === true || !sqliteHandleIsUsable(sqliteHandle())) throw error;
    }
    return out;
  }, () => feedbackStatsSync(sqliteHandle()));
}

// `feedback.js updateFeedback()` 的 PG 版：只改帶到的欄位，其餘沿用；回更新後的那一列。
export async function updateFeedbackAsync(id, patch = {}, options = {}) {
  if (!isPg(options)) return updateFeedbackSync(sqliteHandle(), id, patch);
  return withFallback(options, async (exec) => {
    const row = one((await exec(FEEDBACK_BY_ID_JOINED_SQL, [Number(id) || 0])).rows);
    if (!row) throw httpError("找不到這則回饋", 404);
    const sets = [];
    const args = [];
    if (patch.status != null) {
      args.push(normalizeFeedbackStatus(patch.status));
      sets.push(`status = $${args.length}`);
    }
    if (patch.admin_note != null) {
      args.push(String(patch.admin_note || "").trim().slice(0, FEEDBACK_NOTE_MAX));
      sets.push(`admin_note = $${args.length}`);
    }
    if (!sets.length) return decorateRow(row);
    args.push(iso(new Date()));
    sets.push(`updated_at = $${args.length}`);
    args.push(Number(row.id));
    await exec(`UPDATE feedback SET ${sets.join(", ")} WHERE id = $${args.length}`, args);
    const next = one((await exec(FEEDBACK_BY_ID_JOINED_SQL, [Number(row.id)])).rows);
    return decorateRow(next);
  }, () => updateFeedbackSync(sqliteHandle(), id, patch), { write: true });
}
