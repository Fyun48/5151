/** 刊登生產力工具：複製自己的物件、說明範本、聯絡人快選。 */

import { containsUnsafeMarkup, sanitizeDocumentText } from "./safeContent.js";
import { sanitizeListingBodyHtml, listingBodyPlain } from "./listingBody.js";
import { isMemberMediaUrl, ownsMediaUrl } from "./memberMedia.js";
import { isSelfPhotoPublicUrl } from "./selfPhotos.js";
import {
  SELF_BODY_MAX,
  SELF_CONTACT_MAX,
  digitsPhone,
  getSelfListing,
  getSelfRow,
  insertSelfDraftListing,
  listingFormFields,
  listingPhotoUrls,
  normalizeLineUrl,
} from "./selfListings.js";

export const DESCRIPTION_TEMPLATE_LIMIT_FREE = 2;
export const DESCRIPTION_TEMPLATE_LIMIT_SPONSOR = 5;
export const DESCRIPTION_TEMPLATE_LIMIT = DESCRIPTION_TEMPLATE_LIMIT_FREE;
export const CONTACT_PROFILE_LIMIT = 2;
export const ACCOUNT_CONTACT_LABEL = "此帳號";

export function descriptionTemplateLimit({ plan, role } = {}) {
  if (String(plan || "") === "sponsor" || String(role || "") === "admin") {
    return DESCRIPTION_TEMPLATE_LIMIT_SPONSOR;
  }
  return DESCRIPTION_TEMPLATE_LIMIT_FREE;
}
export const TEMPLATE_NAME_MAX = 40;
export const CONTACT_LABEL_MAX = 40;

export const COPYABLE_FIELDS = Object.freeze([
  "title",
  "body",
  "rent",
  "address",
  "district",
  "street",
  "ping",
  "area_name",
  "layout",
  "rooms",
  "living",
  "bath",
  "floor",
  "total_floors",
  "floor_name",
  "kind",
  "role",
  "traits",
  "deposit",
  "photos",
  "contact_name",
  "phone",
  "line_url",
]);

function httpError(message, status = 400, code = "") {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function iso(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function withImmediate(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw error;
  }
}

function stripUnsafePlain(value, max) {
  let text = sanitizeDocumentText(value, max);
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  if (containsUnsafeMarkup(text)) {
    text = text
      .replace(/<\s*script[\s\S]*?>[\s\S]*?<\s*\/\s*script\s*>/gi, "")
      .replace(/<\s*(iframe|object|embed|style)[\s\S]*?>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
      .replace(/javascript\s*:/gi, "")
      .replace(/on[a-z]+\s*=/gi, "")
      .replace(/<[^>]+>/g, "");
  }
  return text.slice(0, max);
}

export function listingToolsMeta(opts = {}) {
  return {
    description_template_limit: descriptionTemplateLimit(opts),
    description_template_limit_free: DESCRIPTION_TEMPLATE_LIMIT_FREE,
    description_template_limit_sponsor: DESCRIPTION_TEMPLATE_LIMIT_SPONSOR,
    contact_profile_limit: CONTACT_PROFILE_LIMIT,
    copyable_fields: [...COPYABLE_FIELDS],
  };
}

export function ensureListingToolsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS listing_description_template (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      body TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_listing_desc_tpl_user ON listing_description_template(user_id, id);
    CREATE TABLE IF NOT EXISTS listing_contact_profile (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      contact_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      line_url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_listing_contact_profile_user ON listing_contact_profile(user_id, id);
    CREATE TABLE IF NOT EXISTS listing_copy_idempotency (
      user_id INTEGER NOT NULL,
      request_key TEXT NOT NULL,
      draft_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, request_key)
    );
  `);
  try { db.exec("ALTER TABLE listing_contact_profile ADD COLUMN is_account INTEGER NOT NULL DEFAULT 0"); } catch { /* already */ }
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_contact_one_account ON listing_contact_profile(user_id) WHERE is_account = 1");
  } catch { /* duplicates or older SQLite */ }
}

function publicTemplate(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    body: row.body,
    sort_order: Number(row.sort_order) || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function publicContact(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    label: row.label,
    contact_name: row.contact_name || "",
    phone: row.phone || "",
    line_url: row.line_url || "",
    is_account: Number(row.is_account) === 1,
    locked: Number(row.is_account) === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function accountContactFields(db, userId) {
  let user = {};
  try {
    user = db.prepare("SELECT nickname, email, contact_phone, line_id FROM users WHERE id=?").get(Number(userId) || 0) || {};
  } catch {
    try {
      user = db.prepare("SELECT nickname, email FROM users WHERE id=?").get(Number(userId) || 0) || {};
    } catch { user = {}; }
  }
  const name = String(user.nickname || "").trim() || String(user.email || "").trim() || ACCOUNT_CONTACT_LABEL;
  let lineUrl = "";
  const lineId = String(user.line_id || "").trim();
  if (lineId) {
    try { lineUrl = normalizeLineUrl(lineId.includes("http") ? lineId : `https://line.me/ti/p/${lineId}`); } catch { lineUrl = ""; }
  }
  return {
    label: ACCOUNT_CONTACT_LABEL,
    contact_name: name.slice(0, SELF_CONTACT_MAX),
    phone: digitsPhone(user.contact_phone || ""),
    line_url: lineUrl,
  };
}

export function ensureAccountContactProfile(db, userId, now = new Date()) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  ensureListingToolsSchema(db);
  const fields = accountContactFields(db, uid);
  const stamp = iso(now);
  const readAccount = () => db.prepare(
    "SELECT * FROM listing_contact_profile WHERE user_id=? AND IFNULL(is_account,0)=1 ORDER BY id LIMIT 1",
  ).get(uid);
  const upsert = () => {
    const existing = readAccount();
    if (existing) {
      db.prepare(
        "UPDATE listing_contact_profile SET label=?, contact_name=?, phone=?, line_url=?, updated_at=? WHERE id=?",
      ).run(ACCOUNT_CONTACT_LABEL, fields.contact_name, fields.phone, fields.line_url, stamp, existing.id);
      return publicContact(db.prepare("SELECT * FROM listing_contact_profile WHERE id=?").get(existing.id));
    }
    try {
      const ins = db.prepare(
        `INSERT INTO listing_contact_profile(user_id, label, contact_name, phone, line_url, is_account, created_at, updated_at)
         VALUES (?,?,?,?,?,1,?,?)`,
      ).run(uid, ACCOUNT_CONTACT_LABEL, fields.contact_name, fields.phone, fields.line_url, stamp, stamp);
      return publicContact(db.prepare("SELECT * FROM listing_contact_profile WHERE id=?").get(Number(ins.lastInsertRowid)));
    } catch (error) {
      const raced = readAccount();
      if (raced) return publicContact(raced);
      throw error;
    }
  };
  try {
    return withImmediate(db, upsert);
  } catch (error) {
    if (/transaction|within/i.test(String(error.message || ""))) return upsert();
    throw error;
  }
}

export function reusableCopyPhotos(db, userId, urls) {
  const out = [];
  for (const raw of Array.isArray(urls) ? urls : []) {
    const url = String(raw || "").trim();
    if (!url || out.includes(url)) continue;
    if (isMemberMediaUrl(url)) {
      if (ownsMediaUrl(db, userId, url)) out.push(url);
      continue;
    }
    if (isSelfPhotoPublicUrl(url)) out.push(url);
  }
  return out;
}

export function copyOwnListing(db, userId, sourceId, input = {}, now = new Date()) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  const source = getSelfRow(db, sourceId);
  if (!source) throw httpError("找不到這則刊登", 404);
  if (Number(source.listed_by_user_id) !== uid) {
    throw httpError("只能複製自己的刊登", 403, "not_owner");
  }
  const key = String(input.idempotency_key || input.idempotencyKey || "").trim().slice(0, 80);
  if (key) {
    const hit = db.prepare(
      "SELECT draft_id FROM listing_copy_idempotency WHERE user_id=? AND request_key=?",
    ).get(uid, key);
    if (hit) {
      return {
        ...copyResult(db, uid, source, getSelfListing(db, hit.draft_id, { viewerId: uid })),
        reused: true,
      };
    }
  }

  const form = listingFormFields(source);
  const photos = reusableCopyPhotos(db, uid, listingPhotoUrls(source));
  const draft = insertSelfDraftListing(db, uid, {
    title: form.title,
    body: form.body,
    rent: form.rent,
    price_num: form.rent,
    address: form.address,
    area_name: source.area_name,
    layout: source.layout,
    floor_name: source.floor_name,
    kind_name: source.kind_name,
    role_name: source.role_name,
    traits: form.traits,
    deposit: form.deposit,
    contact_name: form.contact_name,
    phone: form.phone,
    line_url: form.line_url,
    photos,
  }, now);

  if (key) {
    try {
      db.prepare(
        "INSERT INTO listing_copy_idempotency(user_id, request_key, draft_id, created_at) VALUES (?,?,?,?)",
      ).run(uid, key, draft.post_id, iso(now));
    } catch {
      const again = db.prepare(
        "SELECT draft_id FROM listing_copy_idempotency WHERE user_id=? AND request_key=?",
      ).get(uid, key);
      if (again) {
        return {
          ...copyResult(db, uid, source, getSelfListing(db, again.draft_id, { viewerId: uid })),
          reused: true,
        };
      }
    }
  }
  return copyResult(db, uid, source, draft);
}

function copyResult(_db, _userId, source, draft) {
  const form = listingFormFields(source);
  form.photos = draft.photos || form.photos;
  form.title = draft.title;
  form.body = draft.body;
  return {
    listing: draft,
    form,
    original_id: Number(source.post_id),
    unpublished: true,
    copied: true,
    inherited_import: false,
  };
}

export function listDescriptionTemplates(db, userId) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  return db.prepare(
    "SELECT * FROM listing_description_template WHERE user_id=? ORDER BY sort_order, id",
  ).all(uid).map(publicTemplate);
}

export function createDescriptionTemplate(db, userId, input = {}, now = new Date(), opts = {}) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  const name = stripUnsafePlain(input.name, TEMPLATE_NAME_MAX);
  const body = sanitizeListingBodyHtml(input.body, SELF_BODY_MAX);
  if (!name) throw httpError("請填範本名稱");
  if (!listingBodyPlain(body)) throw httpError("請填範本內容");
  const stamp = iso(now);
  const limit = descriptionTemplateLimit(opts);
  return withImmediate(db, () => {
    const n = Number(db.prepare(
      "SELECT COUNT(*) AS n FROM listing_description_template WHERE user_id=?",
    ).get(uid)?.n) || 0;
    if (n >= limit) {
      throw httpError(`說明範本最多 ${limit} 則`, 409, "template_limit");
    }
    const ins = db.prepare(
      `INSERT INTO listing_description_template(user_id, name, body, sort_order, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(uid, name, body, n, stamp, stamp);
    return publicTemplate(db.prepare("SELECT * FROM listing_description_template WHERE id=?").get(Number(ins.lastInsertRowid)));
  });
}

function ownedTemplate(db, userId, id) {
  const row = db.prepare("SELECT * FROM listing_description_template WHERE id=?").get(Number(id) || 0);
  if (!row) throw httpError("找不到這個範本", 404);
  if (Number(row.user_id) !== Number(userId)) throw httpError("只能使用自己的說明範本", 403);
  return row;
}

export function updateDescriptionTemplate(db, userId, id, input = {}, now = new Date()) {
  const row = ownedTemplate(db, userId, id);
  const name = input.name != null ? stripUnsafePlain(input.name, TEMPLATE_NAME_MAX) : row.name;
  const body = input.body != null ? sanitizeListingBodyHtml(input.body, SELF_BODY_MAX) : row.body;
  if (!name) throw httpError("請填範本名稱");
  if (!listingBodyPlain(body)) throw httpError("請填範本內容");
  db.prepare(
    "UPDATE listing_description_template SET name=?, body=?, updated_at=? WHERE id=? AND user_id=?",
  ).run(name, body, iso(now), row.id, Number(userId));
  return publicTemplate(db.prepare("SELECT * FROM listing_description_template WHERE id=?").get(row.id));
}

export function deleteDescriptionTemplate(db, userId, id) {
  ownedTemplate(db, userId, id);
  db.prepare("DELETE FROM listing_description_template WHERE id=? AND user_id=?").run(Number(id), Number(userId));
  return { deleted: true };
}

export function listContactProfiles(db, userId) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  ensureAccountContactProfile(db, uid);
  return db.prepare(
    "SELECT * FROM listing_contact_profile WHERE user_id=? ORDER BY IFNULL(is_account,0) DESC, id",
  ).all(uid).map(publicContact);
}

function sanitizeContactInput(input = {}, fallback = {}) {
  const label = stripUnsafePlain(input.label != null ? input.label : fallback.label, CONTACT_LABEL_MAX);
  const contactName = stripUnsafePlain(
    input.contact_name != null ? input.contact_name : fallback.contact_name,
    SELF_CONTACT_MAX,
  );
  const phone = digitsPhone(input.phone != null ? input.phone : fallback.phone);
  if (phone && phone.replace(/\D/g, "").length < 8) throw httpError("電話號碼太短");
  let lineUrl = "";
  const rawLine = input.line_url != null ? input.line_url : fallback.line_url;
  if (rawLine) lineUrl = normalizeLineUrl(rawLine);
  if (!label) throw httpError("請填聯絡人名稱");
  return { label, contact_name: contactName, phone, line_url: lineUrl };
}

export function createContactProfile(db, userId, input = {}, now = new Date()) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  const fields = sanitizeContactInput(input);
  const stamp = iso(now);
  return withImmediate(db, () => {
    const n = Number(db.prepare(
      "SELECT COUNT(*) AS n FROM listing_contact_profile WHERE user_id=? AND IFNULL(is_account,0)=0",
    ).get(uid)?.n) || 0;
    if (n >= CONTACT_PROFILE_LIMIT) {
      throw httpError(`聯絡人最多 ${CONTACT_PROFILE_LIMIT} 則`, 409, "contact_limit");
    }
    const ins = db.prepare(
      `INSERT INTO listing_contact_profile(user_id, label, contact_name, phone, line_url, is_account, created_at, updated_at)
       VALUES (?,?,?,?,?,0,?,?)`,
    ).run(uid, fields.label, fields.contact_name, fields.phone, fields.line_url, stamp, stamp);
    return publicContact(db.prepare("SELECT * FROM listing_contact_profile WHERE id=?").get(Number(ins.lastInsertRowid)));
  });
}

function ownedContact(db, userId, id) {
  const row = db.prepare("SELECT * FROM listing_contact_profile WHERE id=?").get(Number(id) || 0);
  if (!row) throw httpError("找不到這個聯絡人", 404);
  if (Number(row.user_id) !== Number(userId)) throw httpError("只能使用自己的聯絡人", 403);
  return row;
}

export function updateContactProfile(db, userId, id, input = {}, now = new Date()) {
  const row = ownedContact(db, userId, id);
  if (Number(row.is_account) === 1) {
    throw httpError("此帳號聯絡人會跟著個人資料更新，不能改這裡", 403, "account_contact_locked");
  }
  const fields = sanitizeContactInput(input, row);
  db.prepare(
    "UPDATE listing_contact_profile SET label=?, contact_name=?, phone=?, line_url=?, updated_at=? WHERE id=? AND user_id=?",
  ).run(fields.label, fields.contact_name, fields.phone, fields.line_url, iso(now), row.id, Number(userId));
  return publicContact(db.prepare("SELECT * FROM listing_contact_profile WHERE id=?").get(row.id));
}

export function deleteContactProfile(db, userId, id) {
  const row = ownedContact(db, userId, id);
  if (Number(row.is_account) === 1) {
    throw httpError("此帳號聯絡人不能刪除", 403, "account_contact_locked");
  }
  db.prepare("DELETE FROM listing_contact_profile WHERE id=? AND user_id=?").run(Number(id), Number(userId));
  return { deleted: true };
}

export function getOwnedContactProfile(db, userId, id) {
  return publicContact(ownedContact(db, userId, id));
}

export function getOwnedDescriptionTemplate(db, userId, id) {
  return publicTemplate(ownedTemplate(db, userId, id));
}
