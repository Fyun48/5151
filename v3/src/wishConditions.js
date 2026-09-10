/** 許願房「必須有／希望有／不接受」選單。預設條目與後台可編輯目錄。 */

export const WISH_FORBIDDEN_CONDITION_IDS = Object.freeze([
  "nocook", "nopet", "notax",
  "anygender", "female", "male", "student", "worker",
  "gender", "nationality", "race", "ethnicity", "religion",
  "marital", "orientation", "disability", "age", "migrant",
  "who", "suitable",
]);

/**
 * 租客意向條件。id 刻意不用刊登端否定 id（nocook/nopet/notax），
 * 避免「需要可開伙」被解讀成「要不可開伙」。
 */
export const DEFAULT_WISH_CONDITIONS = [
  { id: "need_cook", label: "需要可開伙", listing_incompatible: ["nocook"], listing_legacy_positive: ["cook"] },
  { id: "need_pet", label: "需要可養寵物", listing_incompatible: ["nopet"], listing_legacy_positive: ["pet"] },
  { id: "need_tax", label: "需要可申請租補／報稅", listing_incompatible: ["notax"], listing_legacy_positive: ["tax"] },
  { id: "elevator", label: "電梯", listing_compatible: ["elevator", "community"] },
  { id: "trash", label: "定時垃圾處理", listing_compatible: ["trash"] },
  { id: "trash24", label: "24H 垃圾回收", listing_compatible: ["trash24"] },
  { id: "parcel", label: "包裹代收", listing_compatible: ["parcel"] },
  { id: "parking_car", label: "汽車位", listing_compatible: ["parking"] },
  { id: "parking_scooter", label: "機車位" },
  { id: "manage", label: "門衛管理", listing_compatible: ["manage"] },
  { id: "short_ok", label: "可短租", listing_compatible: ["short"] },
];

const MAX_WISH_CONDITIONS = 40;
const LABEL_MAX = 40;

let catalogCache = null;

function slugConditionId(value, fallback) {
  const raw = String(value || "").trim().slice(0, 40);
  if (/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(raw) && !WISH_FORBIDDEN_CONDITION_IDS.includes(raw)) return raw;
  return fallback;
}

function cleanTraitList(value) {
  const raw = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of raw) {
    const id = String(item || "").trim().slice(0, 40);
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out.slice(0, 12);
}

export function normalizeWishConditionItems(input) {
  const src = Array.isArray(input) ? input : [];
  const out = [];
  const seen = new Set();
  src.forEach((row, index) => {
    if (!row || typeof row !== "object") return;
    const label = String(row.label || "").trim().slice(0, LABEL_MAX);
    if (!label) return;
    let id = slugConditionId(row.id, `wish_${index + 1}`);
    if (seen.has(id) || WISH_FORBIDDEN_CONDITION_IDS.includes(id)) {
      id = `wish_${index + 1}_${out.length + 1}`;
    }
    if (WISH_FORBIDDEN_CONDITION_IDS.includes(id) || seen.has(id)) return;
    seen.add(id);
    const enabled = row.enabled !== false;
    const item = {
      id,
      label,
      enabled,
      listing_incompatible: cleanTraitList(row.listing_incompatible),
      listing_compatible: cleanTraitList(row.listing_compatible),
      listing_legacy_positive: cleanTraitList(row.listing_legacy_positive),
    };
    out.push(item);
  });
  return out.slice(0, MAX_WISH_CONDITIONS);
}

export function mergeWishConditions(stored) {
  const items = normalizeWishConditionItems(stored?.items ?? stored);
  const have = new Set(items.map((row) => row.id));
  for (const row of DEFAULT_WISH_CONDITIONS) {
    if (!have.has(row.id)) items.push({ ...row, enabled: true });
  }
  return normalizeWishConditionItems(items);
}

export function setWishConditionCatalog(items) {
  catalogCache = normalizeWishConditionItems(items);
  return catalogCache;
}

export function allWishConditions() {
  return catalogCache && catalogCache.length ? catalogCache : DEFAULT_WISH_CONDITIONS.map((row) => ({ ...row, enabled: true }));
}

export function activeWishConditions() {
  return allWishConditions().filter((row) => row.enabled !== false);
}

export function publicWishConditions(items) {
  const list = normalizeWishConditionItems(items);
  return {
    items: list,
    active: list.filter((row) => row.enabled !== false).map((row) => ({ id: row.id, label: row.label })),
  };
}

export function conditionMap(catalog = allWishConditions()) {
  return new Map(catalog.map((row) => [row.id, row]));
}
