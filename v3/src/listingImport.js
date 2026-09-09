/** 贊助會員外部物件匯入：一次複製成草稿，不即時同步、不直接刊登。 */

import { getEffectiveDocument, publicDocumentView } from "./contentDocuments.js";
import { recordConsent } from "./memberConsents.js";
import { assertUploadBytes } from "./imageProcess.js";
import { countActiveMedia, deleteMemberMedia, mediaQuotaForPlan, saveMemberMedia } from "./memberMedia.js";
import { fetchPublic5168Listing } from "./import5168.js";
import { fetchPublic591Listing } from "./import591.js";
import { normalizeImportUrl } from "./importProviders.js";
import { sanitizeImportedText, sanitizeImportedTitle } from "./importSanitize.js";
import {
  FETCH_LIMITS,
  safeFetchBuffer,
  safeFetchText,
} from "./safeFetch.js";
import {
  abandonImportedDraftListing,
  createImportedDraftListing,
  getSelfListing,
  publishImportedDraftListing,
  updateImportedDraftListing,
} from "./selfListings.js";

export const IMPORT_STATUSES = {
  PENDING: "pending",
  FETCHING: "fetching",
  READY_FOR_REVIEW: "ready_for_review",
  FAILED: "failed",
  CANCELLED: "cancelled",
  CONFIRMED: "confirmed",
};

export const ACTIVE_IMPORT_STATUSES = [
  IMPORT_STATUSES.PENDING,
  IMPORT_STATUSES.FETCHING,
  IMPORT_STATUSES.READY_FOR_REVIEW,
];

const IMPORT_DECLARATION_TYPE = "external_import_declaration";

function httpError(message, status = 400, code = "") {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function iso(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function asJson(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}

export function isSponsorPlan(plan) {
  return String(plan || "") === "sponsor";
}

export function canUseListingImport({ plan, role } = {}) {
  return isSponsorPlan(plan) || String(role || "") === "admin";
}

export function assertSponsorMember(plan, role = "") {
  if (canUseListingImport({ plan, role })) return;
  throw httpError("贊助會員或管理員才能使用 591 / 5168 物件匯入", 403, "sponsor_required");
}

export function ensureListingImportSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS listing_import (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      original_source_url TEXT NOT NULL,
      normalized_source_url TEXT NOT NULL,
      source_listing_id TEXT,
      status TEXT NOT NULL,
      imported_title TEXT,
      imported_text TEXT,
      listing_id INTEGER,
      terms_document_id INTEGER,
      declaration_version INTEGER,
      declaration_content_hash TEXT,
      created_at TEXT NOT NULL,
      fetched_at TEXT,
      confirmed_at TEXT,
      failure_code TEXT,
      failure_reason TEXT,
      photo_errors TEXT,
      media_ids TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_listing_import_user ON listing_import(user_id, status, id);
    CREATE INDEX IF NOT EXISTS idx_listing_import_source ON listing_import(user_id, normalized_source_url, status);
  `);
}

function rowToImport(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    provider: row.provider,
    original_source_url: row.original_source_url,
    normalized_source_url: row.normalized_source_url,
    source_listing_id: row.source_listing_id || "",
    status: row.status,
    imported_title: row.imported_title || "",
    imported_text: row.imported_text || "",
    listing_id: row.listing_id == null ? null : Number(row.listing_id),
    terms_document_id: row.terms_document_id == null ? null : Number(row.terms_document_id),
    declaration_version: row.declaration_version == null ? null : Number(row.declaration_version),
    declaration_content_hash: row.declaration_content_hash || "",
    created_at: row.created_at,
    fetched_at: row.fetched_at || null,
    confirmed_at: row.confirmed_at || null,
    failure_code: row.failure_code || "",
    failure_reason: row.failure_reason || "",
    photo_errors: asJson(row.photo_errors, []),
    media_ids: asJson(row.media_ids, []),
  };
}

export function getListingImport(db, id) {
  return rowToImport(db.prepare("SELECT * FROM listing_import WHERE id=?").get(Number(id) || 0));
}

export function listMineListingImports(db, userId, { limit = 20 } = {}) {
  return db.prepare(
    "SELECT * FROM listing_import WHERE user_id=? ORDER BY id DESC LIMIT ?",
  ).all(Number(userId) || 0, Math.min(50, Number(limit) || 20)).map(rowToImport);
}

export function listAdminListingImports(db, { limit = 50 } = {}) {
  return db.prepare(
    `SELECT i.*, u.email AS member_email
     FROM listing_import i
     LEFT JOIN users u ON u.id = i.user_id
     ORDER BY i.id DESC LIMIT ?`,
  ).all(Math.min(200, Number(limit) || 50)).map((row) => ({
    ...rowToImport(row),
    member_email: row.member_email || "",
  }));
}

export function findActiveImportBySource(db, userId, normalizedUrl) {
  return rowToImport(db.prepare(
    `SELECT * FROM listing_import
     WHERE user_id=? AND normalized_source_url=? AND status IN (${ACTIVE_IMPORT_STATUSES.map(() => "?").join(",")})
     ORDER BY id DESC LIMIT 1`,
  ).get(Number(userId), normalizedUrl, ...ACTIVE_IMPORT_STATUSES));
}

export function importMeta(db, { plan = "free", now = new Date() } = {}) {
  const doc = getEffectiveDocument(db, IMPORT_DECLARATION_TYPE, { now });
  return {
    sponsor: isSponsorPlan(plan),
    declaration: publicDocumentView(doc),
    check_label: "我確認本人有權使用及刊登以上匯入的文字與圖片，並同意本站相關刊登規範。",
    limits: { ...FETCH_LIMITS, quota: mediaQuotaForPlan(plan) },
    providers: [
      { id: "591", hosts: ["rent.591.com.tw", "www.591.com.tw"], url_hint: "https://rent.591.com.tw/12345678" },
      { id: "5168", hosts: ["rent.houseprice.tw"], url_hint: "https://rent.houseprice.tw/house/16705651" },
    ],
  };
}

function assertOwner(row, userId) {
  if (!row) throw httpError("找不到這筆匯入", 404);
  if (Number(row.user_id) !== Number(userId)) throw httpError("只能操作自己的匯入", 403);
  return row;
}

async function cleanupImportedMedia(db, userId, mediaIds) {
  for (const id of mediaIds || []) {
    try {
      deleteMemberMedia(db, userId, id);
    } catch {
      // 已被引用或已刪
    }
  }
}

function makePageFetcher(parsed, deps) {
  return (url) => safeFetchText(url, {
    allowedHosts: parsed.pageHosts,
    maxBytes: FETCH_LIMITS.htmlMaxBytes,
    timeoutMs: FETCH_LIMITS.timeoutMs,
    fetchImpl: deps.fetchImpl,
    lookupImpl: deps.lookupImpl,
  });
}

async function fetchParsedListing(parsed, deps) {
  const fetchText = makePageFetcher(parsed, deps);
  if (parsed.provider === "591") return fetchPublic591Listing(parsed.normalized, { fetchText });
  if (parsed.provider === "5168") return fetchPublic5168Listing(parsed.normalized, { fetchText });
  throw httpError("不支援的來源", 400, "UNSUPPORTED_URL");
}

function isAllowedImageUrl(raw, imageHosts) {
  try {
    const url = new URL(String(raw || ""));
    return url.protocol === "https:" && imageHosts.includes(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

async function importPhotos(db, userId, photoUrls, { plan, imageHosts, deps, remaining }) {
  const errors = [];
  const items = [];
  const budget = Math.max(0, Math.min(FETCH_LIMITS.maxPhotos, Number(remaining) || 0));
  const candidates = (photoUrls || []).filter((url) => isAllowedImageUrl(url, imageHosts));
  const skippedQuota = Math.max(0, candidates.length - budget);
  if (skippedQuota) {
    errors.push({ code: "PHOTO_IMPORT_PARTIAL", message: `素材庫剩餘 ${budget} 張，只匯入前 ${budget} 張` });
  }
  for (const url of candidates.slice(0, budget)) {
    try {
      const got = await safeFetchBuffer(url, {
        allowedHosts: imageHosts,
        maxBytes: FETCH_LIMITS.imageMaxBytes,
        timeoutMs: FETCH_LIMITS.timeoutMs,
        accept: "image/jpeg,image/png,image/webp,image/avif",
        fetchImpl: deps.fetchImpl,
        lookupImpl: deps.lookupImpl,
      });
      assertUploadBytes(got.body);
      const item = await saveMemberMedia(db, userId, got.body, {
        plan,
        processor: deps.processor,
        originalName: url.split("/").pop() || "import.jpg",
      });
      items.push(item);
    } catch (error) {
      errors.push({
        url,
        code: error.code || "PHOTO_FAILED",
        message: error.message || "照片無法匯入",
      });
    }
  }
  return { items, errors, considered: candidates.length };
}

export async function startListingImport(db, userId, input = {}, opts = {}) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  assertSponsorMember(opts.plan, opts.role);
  const parsed = normalizeImportUrl(input.url);
  const existing = findActiveImportBySource(db, uid, parsed.normalized);
  if (existing) {
    return { ...publicImport(db, existing, { reused: true }), reused: true };
  }

  const now = opts.now || new Date();
  const stamp = iso(now);
  const insert = db.prepare(`
    INSERT INTO listing_import(
      user_id, provider, original_source_url, normalized_source_url, source_listing_id,
      status, created_at
    ) VALUES (?,?,?,?,?,?,?)
  `).run(uid, parsed.provider, parsed.original, parsed.normalized, parsed.source_listing_id, IMPORT_STATUSES.PENDING, stamp);
  const importId = Number(insert.lastInsertRowid);
  db.prepare("UPDATE listing_import SET status=? WHERE id=?").run(IMPORT_STATUSES.FETCHING, importId);

  const deps = {
    fetchImpl: opts.fetchImpl,
    lookupImpl: opts.lookupImpl,
    processor: opts.processor,
  };

  try {
    let parsedListing;
    try {
      parsedListing = await fetchParsedListing(parsed, deps);
    } catch (error) {
      failImport(db, importId, error.code || "FETCH_BLOCKED", error.message);
      throw error;
    }

    const title = sanitizeImportedTitle(parsedListing.title);
    const text = sanitizeImportedText(parsedListing.text);
    if (!title && !text) {
      failImport(db, importId, "PARSE_FAILED", "無法從公開頁解析標題或說明");
      throw httpError("無法從公開頁解析標題或說明", 400, "PARSE_FAILED");
    }

    const used = countActiveMedia(db, uid);
    const quota = mediaQuotaForPlan(opts.plan);
    const remaining = Math.max(0, quota - used);
    const photoResult = await importPhotos(db, uid, parsedListing.photos, {
      plan: opts.plan,
      imageHosts: parsed.imageHosts,
      deps,
      remaining,
    });

    let listing;
    try {
      listing = createImportedDraftListing(db, uid, {
        title,
        body: text,
        photos: photoResult.items.map((item) => item.url),
        address: parsedListing.address || "",
        floor_name: parsedListing.floor_name || "",
        community: parsedListing.community || "",
        layout: parsedListing.layout || "",
        area_name: parsedListing.area_name || "",
        kind: parsedListing.kind || "",
      }, now);
    } catch (error) {
      await cleanupImportedMedia(db, uid, photoResult.items.map((item) => item.id));
      failImport(db, importId, error.code || "FAILED", error.message);
      throw error;
    }

    const failureCode = photoResult.errors.length ? "PHOTO_IMPORT_PARTIAL" : "";
    db.prepare(`
      UPDATE listing_import SET
        status=?, imported_title=?, imported_text=?, listing_id=?, fetched_at=?,
        failure_code=?, failure_reason=?, photo_errors=?, media_ids=?
      WHERE id=?
    `).run(
      IMPORT_STATUSES.READY_FOR_REVIEW,
      title,
      text,
      listing.post_id,
      iso(now),
      failureCode,
      failureCode ? "部分照片未能匯入" : "",
      JSON.stringify(photoResult.errors),
      JSON.stringify(photoResult.items.map((item) => item.id)),
      importId,
    );
    return publicImport(db, getListingImport(db, importId), { listing });
  } catch (error) {
    const row = getListingImport(db, importId);
    if (row && row.status !== IMPORT_STATUSES.FAILED) {
      failImport(db, importId, error.code || "FAILED", error.message);
    }
    throw error;
  }
}

function failImport(db, id, code, reason) {
  db.prepare(
    "UPDATE listing_import SET status=?, failure_code=?, failure_reason=? WHERE id=?",
  ).run(IMPORT_STATUSES.FAILED, String(code || "FAILED").slice(0, 40), String(reason || "").slice(0, 240), Number(id));
}

export function publicImport(db, row, extra = {}) {
  const listing = extra.listing || (row.listing_id ? safeListing(db, row.listing_id, row.user_id) : null);
  return {
    id: row.id,
    provider: row.provider,
    original_source_url: row.original_source_url,
    normalized_source_url: row.normalized_source_url,
    source_listing_id: row.source_listing_id,
    status: row.status,
    imported_title: row.imported_title,
    imported_text: row.imported_text,
    listing_id: row.listing_id,
    listing,
    photos: listing?.photos || [],
    terms_document_id: row.terms_document_id,
    declaration_version: row.declaration_version,
    declaration_content_hash: row.declaration_content_hash,
    created_at: row.created_at,
    fetched_at: row.fetched_at,
    confirmed_at: row.confirmed_at,
    failure_code: row.failure_code,
    failure_reason: row.failure_reason,
    photo_errors: row.photo_errors,
    reused: Boolean(extra.reused),
    live_sync: false,
  };
}

function safeListing(db, postId, userId) {
  try {
    return getSelfListing(db, postId, { viewerId: userId });
  } catch {
    return null;
  }
}

export function getOwnedListingImport(db, userId, id) {
  return assertOwner(getListingImport(db, id), userId);
}

export function reviewListingImport(db, userId, id, input = {}) {
  const row = getOwnedListingImport(db, userId, id);
  if (row.status !== IMPORT_STATUSES.READY_FOR_REVIEW) {
    throw httpError("這筆匯入目前不能修改", 409, row.status);
  }
  const title = input.title != null ? sanitizeImportedTitle(input.title) : row.imported_title;
  const text = input.body != null || input.imported_text != null
    ? sanitizeImportedText(input.body ?? input.imported_text)
    : row.imported_text;
  const keep = Array.isArray(input.photos) ? input.photos : null;
  let listing = null;
  if (row.listing_id) {
    listing = updateImportedDraftListing(db, userId, row.listing_id, {
      title,
      body: text,
      photos: keep,
    });
  }
  db.prepare("UPDATE listing_import SET imported_title=?, imported_text=? WHERE id=?").run(title, text, row.id);
  return publicImport(db, { ...row, imported_title: title, imported_text: text }, { listing });
}

export async function cancelListingImport(db, userId, id, { now = new Date() } = {}) {
  const row = getOwnedListingImport(db, userId, id);
  if (row.status === IMPORT_STATUSES.CONFIRMED) throw httpError("已確認的匯入不能取消", 409);
  if (row.status === IMPORT_STATUSES.CANCELLED) return publicImport(db, row);
  if (row.listing_id) abandonImportedDraftListing(db, userId, row.listing_id, now);
  await cleanupImportedMedia(db, userId, row.media_ids);
  db.prepare("UPDATE listing_import SET status=? WHERE id=?").run(IMPORT_STATUSES.CANCELLED, row.id);
  return publicImport(db, getListingImport(db, row.id));
}

export function confirmListingImport(db, userId, id, input = {}, { now = new Date() } = {}) {
  const row = getOwnedListingImport(db, userId, id);
  if (row.status !== IMPORT_STATUSES.READY_FOR_REVIEW) {
    throw httpError("這筆匯入還不能確認", 409, row.status);
  }
  if (input.accept !== true && input.accepted !== true) {
    throw httpError("請勾選匯入聲明後再確認", 400);
  }
  const current = getEffectiveDocument(db, IMPORT_DECLARATION_TYPE, { now });
  if (!current) throw httpError("目前無法取得有效的匯入聲明", 503);
  const submitted = {
    document_id: Number(input.document_id || input.terms_document_id) || 0,
    version: Number(input.version || input.declaration_version) || 0,
    content_hash: String(input.content_hash || input.declaration_content_hash || "").trim(),
  };
  if (
    submitted.document_id !== current.id
    || submitted.version !== current.version
    || submitted.content_hash !== current.content_hash
  ) {
    throw httpError("匯入聲明已更新，請重新閱讀目前有效版本後再確認", 409, "declaration_stale");
  }
  recordConsent(db, userId, {
    document_type: IMPORT_DECLARATION_TYPE,
    document_id: current.id,
    version: current.version,
    content_hash: current.content_hash,
    source: "import",
  }, { now });
  db.prepare(`
    UPDATE listing_import SET
      status=?, terms_document_id=?, declaration_version=?, declaration_content_hash=?, confirmed_at=?
    WHERE id=?
  `).run(IMPORT_STATUSES.CONFIRMED, current.id, current.version, current.content_hash, iso(now), row.id);
  return publicImport(db, getListingImport(db, row.id));
}

export function publishConfirmedImport(db, userId, id, input = {}, opts = {}) {
  const row = getOwnedListingImport(db, userId, id);
  if (row.status !== IMPORT_STATUSES.CONFIRMED) {
    throw httpError("請先確認匯入聲明，才能走一般刊登流程", 409);
  }
  if (!row.listing_id) throw httpError("這筆匯入沒有草稿", 409);
  return publishImportedDraftListing(db, userId, row.listing_id, input, opts.now || new Date(), {
    matchCandidates: opts.matchCandidates,
  });
}
