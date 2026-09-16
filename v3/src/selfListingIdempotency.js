import { createHash } from "node:crypto";

export const SELF_LISTING_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export function normalizeSelfListingIdempotencyKey(raw) {
  if (raw == null) return "";
  const key = String(raw).trim();
  if (!key) return "";
  if (!SELF_LISTING_IDEMPOTENCY_KEY_RE.test(key)) {
    const err = new Error("idempotency_key 格式不正確");
    err.status = 400;
    err.code = "INVALID_IDEMPOTENCY_KEY";
    throw err;
  }
  return key;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = stableValue(value[key]);
      return acc;
    }, {});
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return String(value ?? "");
}

export function selfListingCreateFingerprint(input = {}) {
  const canon = stableValue({
    district: input.district || "",
    districts: Array.isArray(input.districts) ? input.districts : [],
    rent: input.rent ?? input.price_num ?? 0,
    ping: input.ping ?? input.area ?? "",
    kind: input.kind || input.housing_type || "",
    role: input.role || "",
    floor: input.floor ?? 0,
    total_floors: input.total_floors ?? 0,
    rooms: input.rooms ?? 0,
    living: input.living ?? 0,
    bath: input.bath ?? 0,
    contact_name: input.contact_name || "",
    street: input.street || input.address || "",
    phone: input.phone || input.mobile || "",
    line_url: input.line_url || "",
    photos: input.photos || input.photo_urls || [],
    cover: input.cover || input.photo_url || "",
    title: input.title || "",
    body: input.body || "",
    traits: input.traits || [],
    listing_values: input.listing_values || {},
    deposit: input.deposit || "",
    accept_pledge: input.accept_pledge === true,
  });
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex");
}

export function ensureSelfListingIdempotencySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS self_listing_create_idempotency (
      user_id INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      post_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, idempotency_key)
    );
  `);
}
