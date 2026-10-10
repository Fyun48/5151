// 許願房完成問卷（completion survey）的 driver-aware 入口（PG 島嶼，2026-09-28）。
//
// 涵蓋的路由：
//   `GET  /api/wish-rooms/:id/survey` → `getCompletionSurveyAsync`
//   `POST /api/wish-rooms/:id/survey` → `submitCompletionSurveyAsync`
//
// 為什麼這一包便宜：`rentalSurvey.js` 只有 72 行，而且兩個前置條件都已經在島上
// ——`getDemandPostAsync()`（同步版走 `db.js getDemand()`）與 `bumpAnalyticsAsync()`
// （第三十六批 36.5 就搬好了）。這裡只補「跑語句」。
//
// ⚠️ 三個一定要處理的地方（原本的「第四個：兩個 store 的鏡射」已於 2026-10-10 SQLite 退場 P5a
// 刪除：正式站 `PG_NO_SQLITE_OPEN=1` 時那幾句必拋 `business SQLite is closed`，會員送出問卷
// 會拿到 400。Owner 裁決：正式讀寫不回退節點 SQLite，PG 是唯一來源）。
//
//   1. **`rental_completion_surveys` 的唯一鍵在 PG 上不存在**。SQLite 的 DDL 是
//      `wish_id INTEGER NOT NULL UNIQUE` 與 `public_token TEXT NOT NULL UNIQUE`——
//      兩者都是**表約束**，而 `ensurePgSchema()` 只從 `PRAGMA table_info` 重建欄位／主鍵／預設值，
//      表約束那種隱式索引抓不到（本系列已中過四次）。少了它們，PG 上的「一人一則」與
//      「token 不重複」會整個失效，而且不會有任何錯誤。所以 `ensureSurveyStoreOnce()`
//      除了鏡射建表，還要自己補這兩條 unique index（與 `rentalNotifyWriteAsync` 同一個做法）。
//   2. **沒有交易**（PG 走連線池）：同步版靠 UNIQUE 例外吞掉重複送出，PG 版除了先查再寫，
//      還要認得 23505——補了 unique index 之後，兩個 driver 的語意才會一致。
//   3. **`COUNT(*)` 在 PG 回來的是字串**（bigint → string），SQLite 是數字。同步版的
//      `surveyAggregate()` 把列原樣往外送（admin 的 `survey_breakdown` 直接用），
//      所以 PG 版一定要把 `n` 正規化成數字，否則前端會拿到 `"3"`。
import { randomBytes } from "node:crypto";
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { ensurePgSchema } from "./pgSchema.js";
import { getDemandPostAsync } from "./demandAsync.js";
import { bumpAnalyticsAsync } from "./rentalAnalyticsAsync.js";
import { rentalNotifyHttpError } from "./rentalNotify.js";
// ⚠️ 與 `demandAsync.js` 同一個理由：同步版的包裝（`db.js getCompletionSurveyFor()`）
// 第一件事是 `getWishConditions()`；`getDemandPostAsync()` 本身不灌行程內快取，
// 但 `getDemandPost`／`decoratePostWith` 的公開視圖會用到那些旗標，所以照抄同樣的順序。
import { getWishConditionsAsync } from "./rentalCatalogAsync.js";
import {
  SURVEY_BY_WISH_SQL,
  SURVEY_INSERT_SQL,
  SURVEY_WISH_SQL,
  publicSurvey,
  surveyAggregateSql,
  surveyFields,
  surveyMetric,
} from "./rentalSurvey.js";

export const SURVEY_TABLES = ["rental_completion_surveys"];
export const SURVEY_UNIQUE_INDEXES = [
  "CREATE UNIQUE INDEX IF NOT EXISTS rental_survey_wish_unique ON rental_completion_surveys(wish_id)",
  "CREATE UNIQUE INDEX IF NOT EXISTS rental_survey_token_unique ON rental_completion_surveys(public_token)",
];

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

function normalizeResult(raw) {
  if (Array.isArray(raw)) return { rows: raw, rowCount: Number(raw.rowCount ?? raw.length) || 0 };
  const rows = (raw && raw.rows) || [];
  return { rows, rowCount: Number((raw && raw.rowCount) ?? rows.length) || 0 };
}

const one = (rows) => (Array.isArray(rows) && rows.length ? rows[0] : null);

const schemaReady = new WeakMap();
export async function ensureSurveyStoreOnce(pgDriver) {
  if (!pgDriver) return;
  if (schemaReady.has(pgDriver)) return schemaReady.get(pgDriver);
  const ready = (async () => {
    await ensurePgSchema(pgDriver, sqliteHandle(), { tables: SURVEY_TABLES });
    for (const sql of SURVEY_UNIQUE_INDEXES) await pgDriver.exec(sql);
  })();
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
    await ensureSurveyStoreOnce(pgDriver);
    const exec = async (sql, params = []) => normalizeResult(await pgDriver.query(toPostgresSql(sql), params));
    return await runPostgres(exec);
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write })) throw error;
    return runSqlite();
  }
}

const nested = (options, run) => ({ ...options, driver: "postgres", exec: run });
const nowOf = (options) => (options.now ? new Date(options.now) : new Date());

// 23505 = PG 的 unique_violation；SQLite 走的是訊息（同步版也是用訊息判斷）。
function isUniqueViolation(error) {
  if (String(error?.code || "") === "23505") return true;
  return /UNIQUE constraint failed/i.test(String(error?.message || ""));
}

// `db.js getCompletionSurveyFor()` 的 PG 版。形狀與同步版相同：
// 找不到許願房就照 `getDemandPostAsync()` 的規則丟 404；沒有問卷列則回 `{submitted:false}`。
export async function getCompletionSurveyAsync(userId, wishRef, options = {}) {
  const uid = Number(userId) || 0;
  return withFallback(options, {}, async (run) => {
    await getWishConditionsAsync(options);
    const wish = await getDemandPostAsync(wishRef, { viewerId: uid }, nested(options, run));
    const row = one((await run(SURVEY_BY_WISH_SQL, [Number(wish.id) || 0, uid])).rows);
    return publicSurvey(row);
  }, async () => (await import("./db.js")).getCompletionSurveyFor(uid, wishRef));
}

// `db.js submitCompletionSurveyFor()` 的 PG 版。
export async function submitCompletionSurveyAsync(userId, wishRef, input = {}, options = {}) {
  const uid = Number(userId) || 0;
  const now = nowOf(options);
  return withFallback(options, { write: true }, async (run) => {
    await getWishConditionsAsync(options);
    const wish = await getDemandPostAsync(wishRef, { viewerId: uid }, nested(options, run));
    // 同步版會再用 `getCompletionSurveyOn()` 前重讀一次 `demand_posts`（`getDemand()` 回的
    // 是**裝飾過**的視圖，不是原始列）。這裡逐字照抄：生命週期的判斷要用資料庫那一列。
    const raw = one((await run(SURVEY_WISH_SQL, [Number(wish.id) || 0])).rows);
    if (!raw || Number(raw.user_id) !== uid) {
      throw rentalNotifyHttpError("找不到這則許願房", 404, "wish_not_found");
    }
    if (String(raw.lifecycle || "") !== "completed") {
      throw rentalNotifyHttpError("完成找房後才能填回饋", 409, "survey_not_due");
    }
    const existing = one((await run(SURVEY_BY_WISH_SQL, [Number(raw.id), uid])).rows);
    if (existing) return publicSurvey(existing, { already: true });
    const { found, via, helpful, detail } = surveyFields(input);
    const stamp = now.toISOString();
    // `public_token`（`survey_ref`）由這裡產生、直接落地到 PG——PG 是唯一來源。
    // 🚫 原本還會「兩個 store 用同一個 token」鏡射寫本機 SQLite，2026-10-10（P5a）已刪。
    const token = randomBytes(16).toString("base64url");
    try {
      await run(SURVEY_INSERT_SQL, [token, Number(raw.id), uid, found, via, helpful, detail, stamp]);
    } catch (error) {
      // 競態：另一條請求搶先寫入。同步版靠 UNIQUE 例外，PG 版靠自己補的 unique index。
      if (isUniqueViolation(error)) {
        return publicSurvey(one((await run(SURVEY_BY_WISH_SQL, [Number(raw.id), uid])).rows), { already: true });
      }
      throw error;
    }
    // 🚫 本機鏡射已刪（SQLite 退場 P5a）：原本會在 PG 寫成功後再查／寫本機
    // `rental_completion_surveys`（`rentalOpsSummary()` 那時讀本機）。開閘時那幾句必拋
    // `business SQLite is closed` ⇒ 會員送出問卷收到 400（PG 其實已寫成功）。
    // Owner 裁決：不回退節點 SQLite，PG 是唯一來源。
    await bumpAnalyticsAsync(surveyMetric(found), now, 1, nested(options, run));
    return publicSurvey(one((await run(SURVEY_BY_WISH_SQL, [Number(raw.id), uid])).rows), { already: false });
  }, async () => (await import("./db.js")).submitCompletionSurveyFor(uid, wishRef, input, now));
}

// `rentalSurvey.js surveyAggregate()` 的 PG 版（admin 的 `survey_breakdown` 在用；
// 目前只有 `rentalOpsSummary()` 呼叫它，那一支還沒搬，所以這裡先把零件備好並釘住 parity）。
export async function surveyAggregateAsync(range = {}, options = {}) {
  const { from, to } = range || {};
  return withFallback(options, {}, async (run) => {
    const { sql, params } = surveyAggregateSql({ from, to });
    const rows = (await run(sql, params)).rows || [];
    // PG 的 COUNT(*) 是 bigint ⇒ 回來是字串；SQLite 是數字。同步版把列原樣往外送，
    // 所以這裡要正規化，否則兩個 driver 的 admin 回應會一個 `3`、一個 `"3"`。
    return rows.map((row) => ({ ...row, n: Number(row.n) || 0 }));
  }, async () => (await import("./rentalSurvey.js")).surveyAggregate(sqliteHandle(), { from, to }));
}
