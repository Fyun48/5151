// Driver-aware similarity/insight admin (POSTGRES_SWITCH_PLAN ④, first half).
//
// 問題：listingSimilarity.js 的語句全部跑在 SQLite handle 上。`DB_DRIVER=postgres` 時站台把資料
// 寫進 PostgreSQL，但審核 UI（`GET /api/admin/similarity`、`PUT /api/admin/phash`、
// `POST /api/admin/similarity/:id/review`）讀的是本機 v3.db → 後台永遠看到舊的（或空的）建議與洞察。
//
// 這個模組給那幾條路徑一個 driver-aware 入口（照 ③ 的形狀）：
//   • sqlite   - 原 db.js／listingSimilarity.js 函式，行為完全不變（正式站預設）
//   • postgres - repository/listingSimilarity.js 的同一份語句文字，經 sharedPgDriver()
//
// Fail-open：PostgreSQL 出錯就退回 SQLite 呼叫（與 crawlerReads.js／notifyQueueAsync.js 同一套）；
// `options.strict` 關掉它（測試與探針用）。
//
// 表：三張附屬表在 PostgreSQL 上可能還不存在（這個功能從未在 PG 模式啟用過），所以 PostgreSQL 路徑
// 先用 pgSchema.ensurePgSchema() 從 SQLite schema 鏡射建表（idempotent，跟 SQLite 每次都跑
// ensureListingSimilaritySchema() 同一個精神）。
//
// 仍在 SQLite（第二段）：佇列寫入 recordListingPhash／suggestFromNewHash／recordCrawlInsight 與
// enqueueListingSimilarity（含 LLM provider 的讀取）。
import { sqliteHandle } from "./db.js";
import {
  INSIGHT_APPLY_SETTING_KEY,
  PACK7_PHASH_BASELINE,
  PHASH_SETTING_KEY,
  enqueueListingSimilarity as enqueueListingSimilaritySync,
  getSimilarityAdmin as getSimilarityAdminSync,
  hardVetoReasons,
  isInsightApplyEnabled as isInsightApplyEnabledSync,
  isPhashEnabled as isPhashEnabledSync,
  listRecentInsights as listRecentInsightsSync,
  listSimilaritySuggestions as listSimilaritySuggestionsSync,
  recordCrawlInsight as recordCrawlInsightSync,
  recordListingPhash as recordListingPhashSync,
  reviewSimilarity as reviewSimilaritySync,
  savePhashSettings as savePhashSettingsSync,
  shouldAskLlm,
  shouldEnqueueSimilarity as shouldEnqueueSimilaritySync,
  suggestFromNewHash as suggestFromNewHashSync,
} from "./listingSimilarity.js";
import * as repo from "./repository/listingSimilarity.js";
import { matchVeto, scoreMatch } from "./match.js";
import { budgetStore } from "./budgetStore.js";
import {
  PHASH_ALGO,
  PHASH_SIMILAR_MAX,
  imageKeyFromUrl,
  normalizePhashHex,
  pairwiseSimilarHashes,
  phashFromImageUrl,
} from "./phash.js";
import {
  compareSameHouseWithLlm,
  extractCrawlInsight,
  sourceTextHash,
} from "./providers/llm.js";
import { resolveDbDriver } from "./dbDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { ensurePgSchema } from "./pgSchema.js";

// 與 listingSimilarity.js 相同的對外說明（兩邊輸出必須一致）。
export const SIMILARITY_LEGAL =
  "指紋與建議只留在本站。漢明距離不是同戶判決。通過或駁回不會改會員手動併入／拆分。關掉開關後舊規則不變，已算過的指紋仍保留。";

const REVIEW_STATES = new Set(["pending", "accepted", "rejected"]);

function iso(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// 與 listingSimilarity.js readJsonSetting() 同一套語意：JSON → "1"/"true" → "0"/"false" → fallback。
export function settingValueFromRow(row, fallback) {
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    const text = String(row.value || "").trim().toLowerCase();
    if (text === "1" || text === "true") return true;
    if (text === "0" || text === "false") return false;
    return fallback;
  }
}

function parseEvidence(raw) {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// 與 listingSimilarity.js publicSuggestion() 同一個輸出形狀（title_* 來自 listings）。
function publicSuggestionFrom(row, a, b) {
  const evidence = parseEvidence(row.evidence_json);
  return {
    id: Number(row.id),
    listing_a: Number(row.listing_a),
    listing_b: Number(row.listing_b),
    title_a: a?.title || `#${row.listing_a}`,
    title_b: b?.title || `#${row.listing_b}`,
    review_state: row.review_state,
    review_state_label: row.review_state === "accepted" ? "已通過" : row.review_state === "rejected" ? "已駁回" : "待審",
    hamming: evidence.hamming ?? null,
    match_level: evidence.match_level || null,
    veto: evidence.veto || [],
    blocked_by_veto: evidence.blocked_by_veto || [],
    llm: evidence.llm || null,
    created_at: row.created_at,
    reviewed_at: row.reviewed_at || null,
  };
}

// 與 listingSimilarity.js listRecentInsights() 的 map 相同。
function insightToPublic(row) {
  return {
    id: Number(row.id),
    post_id: Number(row.post_id),
    title: row.title || `#${row.post_id}`,
    hints: parseEvidence(row.hints_json),
    apply_state: row.apply_state,
    apply_state_label: row.apply_state === "applied_empty" ? "只補空白欄" : "只當提示",
    created_at: row.created_at,
  };
}

async function listingRowById(exec, postId) {
  const query = repo.listingRowQuery(postId);
  return (await exec(query.sql, query.params))?.[0] || null;
}

async function ensurePgSimilaritySchema(pgDriver) {
  await ensurePgSchema(pgDriver, sqliteHandle(), { tables: repo.SIMILARITY_TABLES });
}

// driver 分派：postgres → 注入的 exec（或 sharedPgDriver 的 pool）；其他錯誤 fail-open 回 SQLite，
// 除非呼叫端要求 strict（測試／探針）。
async function withFallback(options, runPostgres, runSqlite) {
  const driver = options.driver || resolveDbDriver();
  if (driver !== "postgres") return runSqlite();
  try {
    // 測試／探針可以自帶 exec（此時表由呼叫端準備，不連線也不建表）。
    if (options.exec) return await runPostgres(options.exec);
    const pgDriver = options.pgDriver || (await sharedPgDriver());
    await ensurePgSimilaritySchema(pgDriver);
    const exec = (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
    return await runPostgres(exec);
  } catch (error) {
    if (options.strict) throw error;
    return runSqlite();
  }
}

// sqlite 側一律用 db.js 的 handle（可用 options.sqliteHandle 覆寫，測試方便）。
function sqliteFor(options = {}) {
  return options.sqliteHandle || sqliteHandle();
}

// listingSimilarity.js isPhashEnabled()
export function isPhashEnabledAsync(options = {}) {
  return withFallback(
    options,
    async (exec) => settingValueFromRow(await repo.readSetting(exec, PHASH_SETTING_KEY), false) === true,
    () => isPhashEnabledSync(sqliteFor(options)),
  );
}

// listingSimilarity.js isInsightApplyEnabled()
export function isInsightApplyEnabledAsync(options = {}) {
  return withFallback(
    options,
    async (exec) => settingValueFromRow(await repo.readSetting(exec, INSIGHT_APPLY_SETTING_KEY), false) === true,
    () => isInsightApplyEnabledSync(sqliteFor(options)),
  );
}

// listingSimilarity.js shouldEnqueueSimilarity()
export function shouldEnqueueSimilarityAsync(options = {}) {
  return withFallback(
    options,
    async (exec) => {
      if (settingValueFromRow(await repo.readSetting(exec, PHASH_SETTING_KEY), false) === true) return true;
      return repo.insightProviderEnabled(exec, "llm_crawl_insight");
    },
    () => shouldEnqueueSimilaritySync(sqliteFor(options)),
  );
}

// listingSimilarity.js savePhashSettings()
export function savePhashSettingsAsync(input = {}, options = {}) {
  return withFallback(
    options,
    async (exec) => {
      if (Object.prototype.hasOwnProperty.call(input, "enabled") || Object.prototype.hasOwnProperty.call(input, "phash_enabled")) {
        await repo.writeSetting(exec, PHASH_SETTING_KEY, Boolean(input.enabled ?? input.phash_enabled));
      }
      if (Object.prototype.hasOwnProperty.call(input, "insight_apply_enabled")) {
        await repo.writeSetting(exec, INSIGHT_APPLY_SETTING_KEY, Boolean(input.insight_apply_enabled));
      }
      return {
        phash_enabled: settingValueFromRow(await repo.readSetting(exec, PHASH_SETTING_KEY), false) === true,
        insight_apply_enabled: settingValueFromRow(await repo.readSetting(exec, INSIGHT_APPLY_SETTING_KEY), false) === true,
      };
    },
    () => savePhashSettingsSync(sqliteFor(options), input),
  );
}

// listingSimilarity.js listSimilaritySuggestions()
export function listSimilaritySuggestionsAsync(args = {}, options = {}) {
  return withFallback(
    options,
    async (exec) => {
      const rows = await repo.listSuggestions(exec, args);
      const out = [];
      for (const row of rows) {
        const a = await listingRowById(exec, row.listing_a);
        const b = await listingRowById(exec, row.listing_b);
        out.push(publicSuggestionFrom(row, a, b));
      }
      return out;
    },
    () => listSimilaritySuggestionsSync(sqliteFor(options), args),
  );
}

// listingSimilarity.js listRecentInsights()
export function listRecentInsightsAsync(limit = 20, options = {}) {
  return withFallback(
    options,
    async (exec) => (await repo.listInsights(exec, limit)).map(insightToPublic),
    () => listRecentInsightsSync(sqliteFor(options), limit),
  );
}

// listingSimilarity.js reviewSimilarity()
export function reviewSimilarityAsync(id, input = {}, userId = 0, options = {}) {
  return withFallback(
    options,
    async (exec) => {
      const sid = Number(id) || 0;
      const next = String(input.review_state || input.state || "").trim();
      if (!sid) throw httpError("missing suggestion");
      if (!REVIEW_STATES.has(next) || next === "pending") throw httpError("review_state 必須是 accepted 或 rejected");
      const row = await repo.suggestionById(exec, sid);
      if (!row) throw httpError("找不到這筆建議", 404);
      await repo.reviewSuggestion(exec, sid, next, iso(input.now), userId);
      const updated = await repo.suggestionById(exec, sid);
      const a = await listingRowById(exec, updated.listing_a);
      const b = await listingRowById(exec, updated.listing_b);
      return publicSuggestionFrom(updated, a, b);
    },
    () => reviewSimilaritySync(sqliteFor(options), id, input, userId),
  );
}

// listingSimilarity.js getSimilarityAdmin()
export function getSimilarityAdminAsync(options = {}) {
  return withFallback(
    options,
    async (exec) => ({
      baseline: PACK7_PHASH_BASELINE,
      phash_enabled: settingValueFromRow(await repo.readSetting(exec, PHASH_SETTING_KEY), false) === true,
      insight_apply_enabled: settingValueFromRow(await repo.readSetting(exec, INSIGHT_APPLY_SETTING_KEY), false) === true,
      legal: SIMILARITY_LEGAL,
      suggestions: await listSimilaritySuggestionsAsync({ review_state: "pending", limit: 50 }, { ...options, exec }),
      insights: (await repo.listInsights(exec, 20)).map(insightToPublic),
    }),
    () => getSimilarityAdminSync(sqliteFor(options)),
  );
}

// Exposed for tests/diagnostics: the builders the PostgreSQL admin path runs.
export function listingSimilarityAdminContext() {
  return repo;
}

// listingSimilarity.js recordListingPhash()
export function recordListingPhashAsync(listing, options = {}) {
  return withFallback(
    options,
    async (exec) => {
      const postId = Number(listing?.post_id) || 0;
      const url = String(listing?.cover || listing?.image_url || "").trim();
      const imageKey = imageKeyFromUrl(url);
      if (!postId || !imageKey) return null;
      const hex = await phashFromImageUrl(url, options);
      const phash = normalizePhashHex(hex);
      if (!phash) return null;
      const algoVersion = options.algoVersion || PHASH_ALGO;
      const stamp = iso(options.now);
      await repo.insertPhash(exec, { postId, url, imageKey, algoVersion, phash, stamp });
      return { post_id: postId, image_url: url, image_key: imageKey, algo_version: algoVersion, phash, computed_at: stamp };
    },
    () => recordListingPhashSync(sqliteFor(options), listing, options),
  );
}

// listingSimilarity.js suggestFromNewHash()：配對、veto／LLM evidence、upsert 建議。
export function suggestFromNewHashAsync(listing, recorded, options = {}) {
  return withFallback(
    options,
    async (exec) => {
      const postId = Number(listing?.post_id || recorded?.post_id) || 0;
      if (!postId || !recorded?.phash) return [];
      const algoVersion = recorded.algo_version || PHASH_ALGO;
      const others = await repo.otherHashes(exec, algoVersion, postId);
      const pairs = pairwiseSimilarHashes([{ post_id: postId, phash: recorded.phash }, ...others], {
        maxDistance: options.maxDistance ?? PHASH_SIMILAR_MAX,
      }).filter((pair) => pair.listing_a === postId || pair.listing_b === postId);

      const created = [];
      for (const pair of pairs) {
        const peerId = pair.listing_a === postId ? pair.listing_b : pair.listing_a;
        const peer = (await listingRowById(exec, peerId)) || { post_id: peerId };
        const veto = matchVeto(listing, peer);
        const hard = hardVetoReasons(listing, peer);
        const matchHit = scoreMatch(listing, peer);
        const evidence = {
          signals: ["phash"],
          hamming: pair.hamming,
          algo_version: algoVersion,
          phash_a: pair.phash_a,
          phash_b: pair.phash_b,
          veto,
          match_level: matchHit?.level || null,
          llm: null,
        };
        if (hard.length) {
          evidence.blocked_by_veto = hard;
        } else if (shouldAskLlm({ hamming: pair.hamming, veto, matchHit }) && await budgetStore({ sqliteDb: sqliteFor(options), options }).loadEnabled("llm")) {
          // 2.4：provider／budget 已改走 driver-aware store（同一個 store 讀金鑰與額度）。
          try {
            const llm = await compareSameHouseWithLlm(sqliteFor(options), listing, peer, options);
            if (llm) evidence.llm = llm;
          } catch {
            evidence.llm = null;
          }
        }
        const row = await upsertSuggestionPair(exec, pair, evidence, options.now);
        if (row && !row.kept) {
          const a = await listingRowById(exec, row.listing_a);
          const b = await listingRowById(exec, row.listing_b);
          created.push(publicSuggestionFrom(row, a, b));
        }
      }
      return created;
    },
    () => suggestFromNewHashSync(sqliteFor(options), listing, recorded, options),
  );
}

// listingSimilarity.js upsertSuggestion()：非 pending 的人工判定優先保留（kept）。
async function upsertSuggestionPair(exec, pair, evidence, now) {
  const lo = Math.min(Number(pair.listing_a), Number(pair.listing_b));
  const hi = Math.max(Number(pair.listing_a), Number(pair.listing_b));
  if (!lo || !hi || lo === hi) return null;
  const existing = await repo.suggestionPair(exec, lo, hi);
  if (existing && existing.review_state !== "pending") {
    return { ...existing, listing_a: lo, listing_b: hi, kept: true };
  }
  await repo.upsertSuggestion(exec, lo, hi, evidence, iso(now));
  return repo.suggestionPairRow(exec, lo, hi);
}

// ---- 第二段：佇列寫入（phash／建議／洞察）----
//
// 資料本體（listing_image_phash／listing_similarity_suggestion／listing_crawl_insight）寫進
// **與 UI 同一個 store**（PG 模式就是 PostgreSQL）——這正是「後台讀得到、佇列卻填不進去」的修法。
//
// ⚠️ 這一節的資料本體寫進與 UI 同一個 store；provider 呼叫（compareSameHouseWithLlm／
// extractCrawlInsight）內部的預算保留與金鑰讀取，自 2.4 起也走同一個 driver-aware store
// （budgetStore），所以 PG 模式下讀寫都落在 PostgreSQL。
const APPLY_STATES = new Set(["hint_only", "applied_empty", "skipped"]);

// listingSimilarity.js enqueueListingSimilarity()：整個佇列的入口。
export function enqueueListingSimilarityAsync(listing, options = {}) {
  return withFallback(
    options,
    async (exec) => {
      const out = { phash: null, suggestions: [], insight: null, skipped: null };
      if (!listing?.post_id) {
        out.skipped = "no_listing";
        return out;
      }
      const phashOn = await isPhashEnabledAsync({ ...options, exec });
      if (phashOn) {
        out.phash = await recordListingPhashAsync(listing, { ...options, exec });
        if (out.phash) out.suggestions = await suggestFromNewHashAsync(listing, out.phash, { ...options, exec });
      }
      if (await budgetStore({ sqliteDb: sqliteFor(options), options }).loadEnabled("llm_crawl_insight")) {
        out.insight = await recordCrawlInsightAsync(listing, { ...options, exec });
      }
      if (!out.phash && !out.insight && !out.suggestions.length) {
        out.skipped = phashOn ? "no_fingerprint" : "disabled";
      }
      return out;
    },
    () => enqueueListingSimilaritySync(sqliteFor(options), listing, options),
  );
}

// listingSimilarity.js recordCrawlInsight()
export function recordCrawlInsightAsync(listing, options = {}) {
  return withFallback(
    options,
    async (exec) => {
      const postId = Number(listing?.post_id) || 0;
      if (!postId) return null;
      const hints = await extractCrawlInsight(sqliteFor(options), listing, options); // provider 島：見上
      if (!hints) return null;
      const hash = sourceTextHash(listing);
      let applyState = "hint_only";
      if ((await isInsightApplyEnabledAsync(options)) && Number(hints.confidence) >= 0.85) {
        applyState = await maybeFillEmptyStructuredAsync(exec, listing, hints);
      }
      await repo.insertInsight(
        exec,
        postId,
        hash,
        hints,
        APPLY_STATES.has(applyState) ? applyState : "hint_only",
        iso(options.now),
      );
      return repo.insightRow(exec, postId, hash);
    },
    () => recordCrawlInsightSync(sqliteFor(options), listing, options),
  );
}

// listingSimilarity.js maybeFillEmptyStructured()：只補空白欄，回傳 apply_state。
async function maybeFillEmptyStructuredAsync(exec, listing, hints) {
  if (!listing?.post_id || !hints) return "hint_only";
  const emptyFloor = !String(listing.floor_name || "").trim() && hints.floor;
  if (!emptyFloor) return "hint_only";
  try {
    await repo.applyFloorHint(exec, listing.post_id, hints.floor);
    return "applied_empty";
  } catch {
    return "hint_only";
  }
}

