// 第 7 包：圖片指紋附屬表、同源建議、爬蟲洞察。不改 match.js 預設判決。
// 不鏈式合併；人工判定優先；關開關＝舊路徑；原始資料保留。

import { matchVeto, scoreMatch } from "./match.js";
import { loadEnabledProvider } from "./budgetGuard.js";
import {
  PHASH_ALGO,
  PHASH_SIMILAR_MAX,
  hammingDistance,
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

export const PACK7_PHASH_BASELINE = "pack7-phash-v1";
export const PHASH_SETTING_KEY = "phash_enabled";
export const INSIGHT_APPLY_SETTING_KEY = "llm_insight_apply_enabled";

const REVIEW_STATES = new Set(["pending", "accepted", "rejected"]);
const APPLY_STATES = new Set(["hint_only", "applied_empty", "skipped"]);

function iso(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function readJsonSetting(db, key, fallback) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    if (!row) return fallback;
    try {
      return JSON.parse(row.value);
    } catch {
      const text = String(row.value || "").trim().toLowerCase();
      if (text === "1" || text === "true") return true;
      if (text === "0" || text === "false") return false;
      return fallback;
    }
  } catch {
    return fallback;
  }
}

function writeJsonSetting(db, key, value) {
  db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, JSON.stringify(value));
}

export function ensureListingSimilaritySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS listing_image_phash (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      image_url TEXT NOT NULL,
      image_key TEXT NOT NULL,
      algo_version TEXT NOT NULL DEFAULT '${PHASH_ALGO}',
      phash TEXT NOT NULL,
      computed_at TEXT NOT NULL,
      UNIQUE(post_id, image_key, algo_version)
    );
    CREATE INDEX IF NOT EXISTS idx_listing_image_phash_hash
      ON listing_image_phash(phash);
    CREATE INDEX IF NOT EXISTS idx_listing_image_phash_post
      ON listing_image_phash(post_id);

    CREATE TABLE IF NOT EXISTS listing_similarity_suggestion (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_a INTEGER NOT NULL,
      listing_b INTEGER NOT NULL,
      evidence_json TEXT NOT NULL,
      review_state TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      reviewed_at TEXT,
      reviewed_by INTEGER,
      UNIQUE(listing_a, listing_b)
    );
    CREATE INDEX IF NOT EXISTS idx_listing_similarity_review
      ON listing_similarity_suggestion(review_state, id);

    CREATE TABLE IF NOT EXISTS listing_crawl_insight (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      source_text_hash TEXT NOT NULL,
      hints_json TEXT NOT NULL,
      apply_state TEXT NOT NULL DEFAULT 'hint_only',
      created_at TEXT NOT NULL,
      UNIQUE(post_id, source_text_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_listing_crawl_insight_post
      ON listing_crawl_insight(post_id, id);
  `);
}

export function isPhashEnabled(db) {
  return readJsonSetting(db, PHASH_SETTING_KEY, false) === true;
}

export function isInsightApplyEnabled(db) {
  return readJsonSetting(db, INSIGHT_APPLY_SETTING_KEY, false) === true;
}

export function savePhashSettings(db, input = {}) {
  if (Object.prototype.hasOwnProperty.call(input, "enabled") || Object.prototype.hasOwnProperty.call(input, "phash_enabled")) {
    writeJsonSetting(db, PHASH_SETTING_KEY, Boolean(input.enabled ?? input.phash_enabled));
  }
  if (Object.prototype.hasOwnProperty.call(input, "insight_apply_enabled")) {
    writeJsonSetting(db, INSIGHT_APPLY_SETTING_KEY, Boolean(input.insight_apply_enabled));
  }
  return {
    phash_enabled: isPhashEnabled(db),
    insight_apply_enabled: isInsightApplyEnabled(db),
  };
}

export function shouldEnqueueSimilarity(db) {
  try {
    if (isPhashEnabled(db)) return true;
    const insight = db.prepare(
      "SELECT is_enabled FROM system_provider_configs WHERE category = ? AND is_enabled = 1 LIMIT 1",
    ).get("llm_crawl_insight");
    return Number(insight?.is_enabled) === 1;
  } catch {
    return false;
  }
}

function listingRow(db, postId) {
  try {
    return db.prepare("SELECT * FROM listings WHERE post_id = ?").get(Number(postId)) || null;
  } catch {
    return null;
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

export function hardVetoReasons(a, b) {
  return matchVeto(a, b).filter((reason) => (
    reason === "house_number_mismatch" || reason === "floor_mismatch"
  ));
}

export function shouldAskLlm({ hamming, veto = [], matchHit }) {
  if (veto.includes("house_number_mismatch") || veto.includes("floor_mismatch")) return false;
  if (matchHit?.level === "high") return false;
  if (hamming == null || hamming > PHASH_SIMILAR_MAX) return false;
  return true;
}

export async function recordListingPhash(db, listing, opts = {}) {
  ensureListingSimilaritySchema(db);
  const postId = Number(listing?.post_id) || 0;
  const url = String(listing?.cover || listing?.image_url || "").trim();
  const imageKey = imageKeyFromUrl(url);
  if (!postId || !imageKey) return null;
  const stamp = iso(opts.now);
  return Promise.resolve(phashFromImageUrl(url, opts)).then((hex) => {
    const phash = normalizePhashHex(hex);
    if (!phash) return null;
    db.prepare(`
      INSERT INTO listing_image_phash(post_id, image_url, image_key, algo_version, phash, computed_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(post_id, image_key, algo_version) DO UPDATE SET
        image_url = excluded.image_url,
        phash = excluded.phash,
        computed_at = excluded.computed_at
    `).run(postId, url.slice(0, 500), imageKey, opts.algoVersion || PHASH_ALGO, phash, stamp);
    return {
      post_id: postId,
      image_url: url,
      image_key: imageKey,
      algo_version: opts.algoVersion || PHASH_ALGO,
      phash,
      computed_at: stamp,
    };
  }).catch(() => null);
}

function upsertSuggestion(db, pair, evidence, now) {
  const lo = Math.min(Number(pair.listing_a), Number(pair.listing_b));
  const hi = Math.max(Number(pair.listing_a), Number(pair.listing_b));
  if (!lo || !hi || lo === hi) return null;
  const stamp = iso(now);
  const existing = db.prepare(
    "SELECT id, review_state, evidence_json FROM listing_similarity_suggestion WHERE listing_a = ? AND listing_b = ?",
  ).get(lo, hi);
  if (existing && existing.review_state !== "pending") {
    return { ...existing, listing_a: lo, listing_b: hi, kept: true };
  }
  db.prepare(`
    INSERT INTO listing_similarity_suggestion(listing_a, listing_b, evidence_json, review_state, created_at)
    VALUES (?, ?, ?, 'pending', ?)
    ON CONFLICT(listing_a, listing_b) DO UPDATE SET
      evidence_json = excluded.evidence_json
    WHERE listing_similarity_suggestion.review_state = 'pending'
  `).run(lo, hi, JSON.stringify(evidence), stamp);
  return db.prepare(
    "SELECT * FROM listing_similarity_suggestion WHERE listing_a = ? AND listing_b = ?",
  ).get(lo, hi);
}

export async function suggestFromNewHash(db, listing, recorded, opts = {}) {
  ensureListingSimilaritySchema(db);
  const postId = Number(listing?.post_id || recorded?.post_id) || 0;
  if (!postId || !recorded?.phash) return [];
  const others = db.prepare(`
    SELECT post_id, phash, image_key
    FROM listing_image_phash
    WHERE algo_version = ? AND post_id != ?
  `).all(recorded.algo_version || PHASH_ALGO, postId);
  const pairs = pairwiseSimilarHashes([{ post_id: postId, phash: recorded.phash }, ...others], {
    maxDistance: opts.maxDistance ?? PHASH_SIMILAR_MAX,
  }).filter((pair) => pair.listing_a === postId || pair.listing_b === postId);

  const created = [];
  for (const pair of pairs) {
    const peerId = pair.listing_a === postId ? pair.listing_b : pair.listing_a;
    const peer = listingRow(db, peerId) || { post_id: peerId };
    const veto = matchVeto(listing, peer);
    const hard = hardVetoReasons(listing, peer);
    const matchHit = scoreMatch(listing, peer);
    const evidence = {
      signals: ["phash"],
      hamming: pair.hamming,
      algo_version: recorded.algo_version || PHASH_ALGO,
      phash_a: pair.phash_a,
      phash_b: pair.phash_b,
      veto,
      match_level: matchHit?.level || null,
      llm: null,
    };
    if (hard.length) {
      evidence.blocked_by_veto = hard;
    } else if (shouldAskLlm({ hamming: pair.hamming, veto, matchHit }) && loadEnabledProvider(db, "llm")) {
      try {
        const llm = await compareSameHouseWithLlm(db, listing, peer, opts);
        if (llm) evidence.llm = llm;
      } catch {
        evidence.llm = null;
      }
    }
    const row = upsertSuggestion(db, pair, evidence, opts.now);
    if (row) created.push(publicSuggestion(db, row));
  }
  return created;
}

function maybeFillEmptyStructured(db, listing, hints) {
  if (!listing?.post_id || !hints) return "hint_only";
  const emptyFloor = !String(listing.floor_name || "").trim() && hints.floor;
  if (!emptyFloor) return "hint_only";
  try {
    db.prepare("UPDATE listings SET floor_name = ? WHERE post_id = ? AND IFNULL(floor_name, '') = ''")
      .run(String(hints.floor).slice(0, 40), listing.post_id);
    return "applied_empty";
  } catch {
    return "hint_only";
  }
}

export async function recordCrawlInsight(db, listing, opts = {}) {
  ensureListingSimilaritySchema(db);
  const postId = Number(listing?.post_id) || 0;
  if (!postId) return null;
  const hints = await extractCrawlInsight(db, listing, opts);
  if (!hints) return null;
  const hash = sourceTextHash(listing);
  let applyState = "hint_only";
  if (isInsightApplyEnabled(db) && Number(hints.confidence) >= 0.85) {
    applyState = maybeFillEmptyStructured(db, listing, hints);
  }
  const stamp = iso(opts.now);
  db.prepare(`
    INSERT INTO listing_crawl_insight(post_id, source_text_hash, hints_json, apply_state, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(post_id, source_text_hash) DO UPDATE SET
      hints_json = excluded.hints_json,
      apply_state = excluded.apply_state
  `).run(postId, hash, JSON.stringify(hints), APPLY_STATES.has(applyState) ? applyState : "hint_only", stamp);
  return db.prepare(
    "SELECT * FROM listing_crawl_insight WHERE post_id = ? AND source_text_hash = ?",
  ).get(postId, hash);
}

export async function enqueueListingSimilarity(db, listing, opts = {}) {
  ensureListingSimilaritySchema(db);
  const out = { phash: null, suggestions: [], insight: null, skipped: null };
  if (!listing?.post_id) {
    out.skipped = "no_listing";
    return out;
  }
  if (isPhashEnabled(db)) {
    out.phash = await recordListingPhash(db, listing, opts);
    if (out.phash) out.suggestions = await suggestFromNewHash(db, listing, out.phash, opts);
  }
  if (loadEnabledProvider(db, "llm_crawl_insight")) {
    out.insight = await recordCrawlInsight(db, listing, opts);
  }
  if (!out.phash && !out.insight && !out.suggestions.length) {
    out.skipped = isPhashEnabled(db) ? "no_fingerprint" : "disabled";
  }
  return out;
}

function publicSuggestion(db, row) {
  const evidence = parseEvidence(row.evidence_json);
  const a = listingRow(db, row.listing_a);
  const b = listingRow(db, row.listing_b);
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

export function listSimilaritySuggestions(db, { review_state = "pending", limit = 50 } = {}) {
  ensureListingSimilaritySchema(db);
  const take = Math.max(1, Math.min(100, Number(limit) || 50));
  const rows = review_state === "all"
    ? db.prepare("SELECT * FROM listing_similarity_suggestion ORDER BY id DESC LIMIT ?").all(take)
    : db.prepare(
      "SELECT * FROM listing_similarity_suggestion WHERE review_state = ? ORDER BY id DESC LIMIT ?",
    ).all(review_state, take);
  return rows.map((row) => publicSuggestion(db, row));
}

export function reviewSimilarity(db, id, input = {}, userId = 0) {
  ensureListingSimilaritySchema(db);
  const sid = Number(id) || 0;
  const next = String(input.review_state || input.state || "").trim();
  if (!sid) throw httpError("missing suggestion");
  if (!REVIEW_STATES.has(next) || next === "pending") throw httpError("review_state 必須是 accepted 或 rejected");
  const row = db.prepare("SELECT * FROM listing_similarity_suggestion WHERE id = ?").get(sid);
  if (!row) throw httpError("找不到這筆建議", 404);
  db.prepare(`
    UPDATE listing_similarity_suggestion
    SET review_state = ?, reviewed_at = ?, reviewed_by = ?
    WHERE id = ?
  `).run(next, iso(input.now), Number(userId) || null, sid);
  return publicSuggestion(db, db.prepare("SELECT * FROM listing_similarity_suggestion WHERE id = ?").get(sid));
}

export function listRecentInsights(db, limit = 20) {
  ensureListingSimilaritySchema(db);
  const take = Math.max(1, Math.min(50, Number(limit) || 20));
  return db.prepare(`
    SELECT i.*, l.title
    FROM listing_crawl_insight i
    LEFT JOIN listings l ON l.post_id = i.post_id
    ORDER BY i.id DESC
    LIMIT ?
  `).all(take).map((row) => ({
    id: Number(row.id),
    post_id: Number(row.post_id),
    title: row.title || `#${row.post_id}`,
    hints: parseEvidence(row.hints_json),
    apply_state: row.apply_state,
    apply_state_label: row.apply_state === "applied_empty" ? "只補空白欄" : "只當提示",
    created_at: row.created_at,
  }));
}

export function getSimilarityAdmin(db) {
  ensureListingSimilaritySchema(db);
  return {
    baseline: PACK7_PHASH_BASELINE,
    phash_enabled: isPhashEnabled(db),
    insight_apply_enabled: isInsightApplyEnabled(db),
    legal: "指紋與建議只留在本站。漢明距離不是同戶判決。通過或駁回不會改會員手動併入／拆分。關掉開關後舊規則不變，已算過的指紋仍保留。",
    suggestions: listSimilaritySuggestions(db, { review_state: "pending", limit: 50 }),
    insights: listRecentInsights(db, 20),
  };
}

export function suggestionDoesNotTouchManualMerge() {
  return true;
}

export { hammingDistance, pairwiseSimilarHashes };
