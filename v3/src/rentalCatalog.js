/** Canonical Rental Condition Catalog v2。
 * 有房刊登與許願房共用 identity；前台 UI 可以不同。
 * 不碰 listingScore / sortListingsRows。
 */

import { SELF_TRAIT_GROUPS, LEGACY_TRAIT_LABELS } from "./selfTraits.js";
import { DEFAULT_WISH_CONDITIONS, WISH_FORBIDDEN_CONDITION_IDS } from "./wishConditions.js";

export const CATALOG_VALUE_TYPES = Object.freeze(["boolean", "enum", "number", "range", "date"]);
export const WISH_ACTIONS = Object.freeze(["unspecified", "want", "avoid"]);
export const LISTING_VALUES = Object.freeze(["unknown", "present", "absent", "allowed", "not_allowed"]);
export const POLARITY_CONDITION_IDS = Object.freeze(["need_cook", "need_pet", "need_tax"]);

const PROTECTED_PERSONAL_EXACT = Object.freeze([
  "女性", "男性", "男女", "小姐", "男生", "女生", "gender",
  "國籍", "種族", "族群", "宗教", "年齡", "婚姻", "性向", "性傾向",
]);
const PROTECTED_PERSONAL_PATTERNS = Object.freeze([
  /限女|限男|女性專|男性專|只限女|只限男|onlyfemale|onlymale|gender|性別限制|限性別/,
  /國籍|種族|族群|外籍|本國人|外國人|ethnic|nationalit|族裔|限本國|不收外/,
  /宗教|佛教徒|基督教|天主教|伊斯蘭|回教|道教|信仰|religion/,
  /性向|性傾向|同志|同性戀|lgbt|orientation/,
  /婚姻|已婚|未婚|限單身|夫妻限定|marital/,
  /限年齡|年齡限制|歲以上|歲以下|年輕人限定|不收老人|agelimit/,
  /移工|外勞|看護工|migrantworker/,
  /適合對象|限學生|上班族佳/,
]);

export function isAccessibilityHousingFeature(label) {
  const text = normalizeConditionLabel(label);
  return /無障礙|輪椅通行|斜坡道|accessible/.test(text);
}

export function isProtectedPersonalAttribute(label) {
  const text = normalizeConditionLabel(label);
  if (!text || isAccessibilityHousingFeature(text)) return false;
  if (PROTECTED_PERSONAL_EXACT.includes(text)) return true;
  return PROTECTED_PERSONAL_PATTERNS.some((re) => re.test(text));
}

export function assertCatalogConditionAllowed(label, aliases = []) {
  const texts = [label, ...(Array.isArray(aliases) ? aliases : [])];
  for (const item of texts) {
    if (isProtectedPersonalAttribute(item)) {
      throw catalogError("這個條件涉及個人敏感屬性，不能加入租屋配對目錄");
    }
  }
}

export function assertCatalogSafe(catalog) {
  for (const row of normalizeCatalog(catalog).conditions) {
    assertCatalogConditionAllowed(row.label, row.aliases);
  }
  return catalog;
}

const LABEL_MAX = 40;
const ID_MAX = 40;
const ALIAS_MAX = 12;

export function normalizeConditionLabel(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u3000\s]+/g, "")
    .trim()
    .toLowerCase();
}

export function generateSystemId(label, existing = []) {
  const taken = new Set((existing || []).map((id) => String(id)));
  const ascii = String(label || "")
    .normalize("NFKD")
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase()
    .slice(0, ID_MAX);
  let base = /^[a-z][a-z0-9_]{0,39}$/.test(ascii) ? ascii : "";
  if (!base || WISH_FORBIDDEN_CONDITION_IDS.includes(base)) {
    base = `cond_${Math.abs(hashLabel(label)).toString(36)}`;
  }
  let id = base;
  let n = 2;
  while (taken.has(id) || WISH_FORBIDDEN_CONDITION_IDS.includes(id)) {
    id = `${base}_${n}`.slice(0, ID_MAX);
    n += 1;
  }
  return id;
}

function hashLabel(value) {
  const text = normalizeConditionLabel(value) || "cond";
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h || 1;
}

export const DEFAULT_CATALOG_CATEGORIES = Object.freeze([
  { id: "living_lease", label: "生活與租賃", sort_order: 10 },
  { id: "building", label: "建物與社區", sort_order: 20 },
  { id: "mail_trash", label: "收件與垃圾", sort_order: 30 },
  { id: "furniture", label: "家具", sort_order: 40 },
  { id: "appliance", label: "家電", sort_order: 50 },
  { id: "media", label: "網路與影音", sort_order: 60 },
  { id: "parking", label: "交通與停車", sort_order: 70 },
]);

/** 既有 wish / self trait id 對到 canonical id。不得 bulk rename。 */
export const LEGACY_ID_TO_CANONICAL = Object.freeze({
  need_cook: "need_cook",
  need_pet: "need_pet",
  need_tax: "need_tax",
  short_ok: "short_ok",
  short: "short_ok",
  elevator: "elevator",
  community: "community",
  courtyard: "courtyard",
  balcony: "balcony",
  manage: "manage",
  parcel: "parcel",
  trash: "trash",
  trash24: "trash24",
  bed: "bed",
  closet: "closet",
  sofa: "sofa",
  dining: "dining",
  ac: "ac",
  fridge: "fridge",
  washer: "washer",
  tv: "tv",
  heater: "heater",
  heater_e: "heater_e",
  net: "net",
  cable: "cable",
  parking_car: "parking_car",
  parking_scooter: "parking_scooter",
  parking: "parking_car",
  nocook: "need_cook",
  nopet: "need_pet",
  notax: "need_tax",
  cook: "need_cook",
  pet: "need_pet",
  tax: "need_tax",
});

export const DEFAULT_CATALOG_CONDITIONS = Object.freeze([
  living("need_cook", "可開伙", { wish_allow_avoid: false, listing_negative: "nocook", listing_legacy: "cook", aliases: ["能煮飯", "可炊"] }),
  living("need_pet", "可養寵物", { wish_allow_avoid: false, listing_negative: "nopet", listing_legacy: "pet", aliases: ["養寵物"] }),
  living("need_tax", "可申請租補／報稅", { wish_allow_avoid: false, listing_negative: "notax", listing_legacy: "tax", aliases: ["可報稅", "可租補"] }),
  living("short_ok", "可短租", { listing_positive: ["short"] }),
  building("elevator", "電梯", { listing_positive: ["elevator"], aliases: ["有電梯"] }),
  building("community", "電梯大樓", { listing_positive: ["community"], wish_enabled: false }),
  building("courtyard", "中庭", { listing_positive: ["courtyard"] }),
  building("balcony", "陽台", { listing_positive: ["balcony"] }),
  building("manage", "門衛／管理", { listing_positive: ["manage"], aliases: ["門衛管理", "有門衛"] }),
  mail("parcel", "包裹代收", { listing_positive: ["parcel"] }),
  mail("trash", "定時／定點垃圾處理", { listing_positive: ["trash"] }),
  mail("trash24", "24H 垃圾回收", { listing_positive: ["trash24"] }),
  furniture("bed", "床", { listing_positive: ["bed"] }),
  furniture("closet", "衣櫃", { listing_positive: ["closet"] }),
  furniture("sofa", "沙發", { listing_positive: ["sofa"] }),
  furniture("dining", "餐桌", { listing_positive: ["dining"] }),
  appliance("ac", "冷氣", { listing_positive: ["ac"] }),
  appliance("fridge", "冰箱", { listing_positive: ["fridge"], aliases: ["電冰箱", "冷藏冰箱"] }),
  appliance("washer", "洗衣機", { listing_positive: ["washer"] }),
  appliance("tv", "電視", { listing_positive: [] }),
  appliance("heater", "瓦斯熱水器", { listing_positive: ["heater"] }),
  appliance("heater_e", "電熱水器", { listing_positive: ["heater_e"] }),
  media("net", "網路", { listing_positive: ["net"] }),
  media("cable", "第四台", { listing_positive: ["cable"] }),
  parking("parking_car", "汽車位", { listing_positive: ["parking"], aliases: ["車位", "有車位"] }),
  parking("parking_scooter", "機車位", { listing_positive: [] }),
]);

function living(id, label, extra) { return cond(id, label, "living_lease", extra); }
function building(id, label, extra) { return cond(id, label, "building", extra); }
function mail(id, label, extra) { return cond(id, label, "mail_trash", extra); }
function furniture(id, label, extra) { return cond(id, label, "furniture", extra); }
function appliance(id, label, extra) { return cond(id, label, "appliance", extra); }
function media(id, label, extra) { return cond(id, label, "media", extra); }
function parking(id, label, extra) { return cond(id, label, "parking", extra); }

function cond(id, label, category_id, extra = {}) {
  return {
    id,
    label,
    category_id,
    enabled: true,
    listing_enabled: extra.listing_enabled !== false,
    wish_enabled: extra.wish_enabled !== false,
    matching_enabled: extra.matching_enabled !== false,
    wish_allow_want: extra.wish_allow_want !== false,
    wish_allow_avoid: extra.wish_allow_avoid !== false,
    value_type: extra.value_type || "boolean",
    aliases: extra.aliases || [],
    listing_positive: extra.listing_positive || [],
    listing_negative: extra.listing_negative || "",
    listing_legacy: extra.listing_legacy || "",
    sort_order: extra.sort_order,
  };
}

export function defaultCatalog() {
  return normalizeCatalog({
    version: 1,
    categories: DEFAULT_CATALOG_CATEGORIES,
    conditions: DEFAULT_CATALOG_CONDITIONS,
  });
}

export function normalizeCategory(input = {}, index = 0) {
  const src = input && typeof input === "object" ? input : {};
  const label = String(src.label || "").trim().slice(0, LABEL_MAX);
  const id = slugId(src.id, `cat_${index + 1}`);
  return {
    id,
    label: label || id,
    enabled: src.enabled !== false,
    sort_order: Number.isFinite(Number(src.sort_order)) ? Number(src.sort_order) : (index + 1) * 10,
  };
}

export function normalizeCondition(input = {}, index = 0, { existingIds = [], existingLabels = [] } = {}) {
  const src = input && typeof input === "object" ? input : {};
  const label = String(src.label || "").trim().slice(0, LABEL_MAX);
  if (!label) return null;
  const key = normalizeConditionLabel(label);
  if (existingLabels.includes(key)) return null;
  let id = slugId(src.id, "");
  if (id && existingIds.includes(id)) return null;
  if (!id || WISH_FORBIDDEN_CONDITION_IDS.includes(id)) {
    id = generateSystemId(label, existingIds);
  }
  const valueType = CATALOG_VALUE_TYPES.includes(src.value_type) ? src.value_type : "boolean";
  return {
    id,
    label,
    category_id: slugId(src.category_id, "living_lease"),
    enabled: src.enabled !== false,
    listing_enabled: src.listing_enabled !== false,
    wish_enabled: src.wish_enabled !== false,
    matching_enabled: src.matching_enabled !== false,
    wish_allow_want: src.wish_allow_want !== false,
    wish_allow_avoid: src.wish_allow_avoid !== false,
    value_type: valueType,
    aliases: cleanAliases(src.aliases),
    listing_positive: cleanIds(src.listing_positive),
    listing_negative: String(src.listing_negative || "").trim().slice(0, ID_MAX),
    listing_legacy: String(src.listing_legacy || "").trim().slice(0, ID_MAX),
    sort_order: Number.isFinite(Number(src.sort_order)) ? Number(src.sort_order) : (index + 1) * 10,
  };
}

function slugId(value, fallback) {
  const raw = String(value || "").trim().slice(0, ID_MAX);
  if (/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(raw) && !WISH_FORBIDDEN_CONDITION_IDS.includes(raw)) return raw;
  return fallback;
}

function cleanAliases(value) {
  const raw = Array.isArray(value) ? value : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const label = String(item || "").trim().slice(0, LABEL_MAX);
    const key = normalizeConditionLabel(label);
    if (!label || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out.slice(0, ALIAS_MAX);
}

function cleanIds(value) {
  const raw = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of raw) {
    const id = String(item || "").trim().slice(0, ID_MAX);
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  return out.slice(0, 12);
}

export function normalizeCatalog(input = {}) {
  const src = input && typeof input === "object" ? input : {};
  const categories = [];
  const seenCat = new Set();
  const catSrc = Array.isArray(src.categories) ? src.categories : DEFAULT_CATALOG_CATEGORIES;
  catSrc.forEach((row, index) => {
    const item = normalizeCategory(row, index);
    if (!item.id || seenCat.has(item.id)) return;
    seenCat.add(item.id);
    categories.push(item);
  });
  if (!categories.length) {
    DEFAULT_CATALOG_CATEGORIES.forEach((row, index) => categories.push(normalizeCategory(row, index)));
  }
  const conditions = [];
  const seenId = new Set();
  const seenLabel = [];
  const condSrc = Array.isArray(src.conditions) ? src.conditions : DEFAULT_CATALOG_CONDITIONS;
  condSrc.forEach((row, index) => {
    const item = normalizeCondition(row, index, { existingIds: [...seenId], existingLabels: seenLabel });
    if (!item) return;
    seenId.add(item.id);
    seenLabel.push(normalizeConditionLabel(item.label));
    for (const alias of item.aliases) seenLabel.push(normalizeConditionLabel(alias));
    if (!categories.some((cat) => cat.id === item.category_id)) item.category_id = categories[0].id;
    conditions.push(item);
  });
  return {
    version: Math.max(1, Number(src.version) || 1),
    removed_ids: cleanIds(src.removed_ids),
    categories: categories.sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id)),
    conditions: conditions.sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id)),
  };
}

export function mergeDefaultCatalog(stored) {
  const current = normalizeCatalog(stored);
  const have = new Set(current.conditions.map((row) => row.id));
  const haveCat = new Set(current.categories.map((row) => row.id));
  const removed = new Set(current.removed_ids || []);
  const seed = defaultCatalog();
  for (const cat of seed.categories) {
    if (!haveCat.has(cat.id)) current.categories.push(cat);
  }
  for (const row of seed.conditions) {
    if (have.has(row.id) || removed.has(row.id)) continue;
    current.conditions.push({
      ...row,
      enabled: false,
      wish_enabled: false,
      listing_enabled: false,
    });
  }
  return normalizeCatalog(current);
}

export function upsertCategory(catalog, input = {}) {
  const next = normalizeCatalog(catalog);
  const label = String(input.label || "").trim().slice(0, LABEL_MAX);
  if (!label) throw catalogError("請填分類名稱");
  if (input.id) {
    const row = next.categories.find((item) => item.id === input.id);
    if (!row) throw catalogError("找不到這個分類", 404);
    if (input.enabled === false) row.enabled = false;
    if (input.enabled === true) row.enabled = true;
    row.label = label;
    if (input.sort_order != null) row.sort_order = Number(input.sort_order) || row.sort_order;
    return normalizeCatalog(next);
  }
  const id = generateSystemId(label, next.categories.map((row) => row.id));
  next.categories.push(normalizeCategory({
    id,
    label,
    enabled: input.enabled !== false,
    sort_order: input.sort_order,
  }, next.categories.length));
  return normalizeCatalog(next);
}

export function upsertCondition(catalog, input = {}) {
  const next = normalizeCatalog(catalog);
  const label = String(input.label || "").trim().slice(0, LABEL_MAX);
  if (!label) throw catalogError("請填條件名稱");
  const aliases = cleanAliases(input.aliases);
  assertCatalogConditionAllowed(label, aliases);
  const key = normalizeConditionLabel(label);
  const clash = next.conditions.find((row) => {
    if (input.id && row.id === input.id) return false;
    if (normalizeConditionLabel(row.label) === key) return true;
    return row.aliases.some((alias) => normalizeConditionLabel(alias) === key)
      || aliases.some((alias) => normalizeConditionLabel(alias) === normalizeConditionLabel(row.label));
  });
  if (clash) throw catalogError("已有相同名稱的條件，請用別名而不是再建一筆");
  if (input.id) {
    const row = next.conditions.find((item) => item.id === input.id);
    if (!row) throw catalogError("找不到這個條件", 404);
    const updated = normalizeCondition({ ...row, ...input, id: row.id, label }, 0, {
      existingIds: next.conditions.filter((item) => item.id !== row.id).map((item) => item.id),
      existingLabels: [],
    });
    Object.assign(row, updated, { id: row.id });
    return normalizeCatalog(next);
  }
  const id = generateSystemId(label, next.conditions.map((row) => row.id));
  const created = normalizeCondition({ ...input, id, label }, next.conditions.length, {
    existingIds: next.conditions.map((row) => row.id),
    existingLabels: next.conditions.map((row) => normalizeConditionLabel(row.label)),
  });
  if (!created) throw catalogError("無法建立這個條件");
  next.conditions.push(created);
  return normalizeCatalog(next);
}

export function moveCondition(catalog, conditionId, categoryId) {
  const next = normalizeCatalog(catalog);
  const row = next.conditions.find((item) => item.id === conditionId);
  if (!row) throw catalogError("找不到這個條件", 404);
  if (!next.categories.some((cat) => cat.id === categoryId)) throw catalogError("找不到這個分類", 404);
  row.category_id = categoryId;
  return normalizeCatalog(next);
}

export function canHardDeleteCondition(conditionId, references = {}) {
  const used = Number(references.wish || 0) + Number(references.listing || 0) + Number(references.historical || 0);
  return used === 0;
}

export function deleteOrDisableCondition(catalog, conditionId, references = {}) {
  const next = normalizeCatalog(catalog);
  const idx = next.conditions.findIndex((item) => item.id === conditionId);
  if (idx < 0) throw catalogError("找不到這個條件", 404);
  if (!canHardDeleteCondition(conditionId, references)) {
    next.conditions[idx].enabled = false;
    return { catalog: normalizeCatalog(next), action: "disabled" };
  }
  next.conditions.splice(idx, 1);
  const seedIds = new Set(defaultCatalog().conditions.map((row) => row.id));
  if (seedIds.has(conditionId)) {
    next.removed_ids = [...new Set([...(next.removed_ids || []), conditionId])];
  }
  return { catalog: normalizeCatalog(next), action: "deleted" };
}

export function catalogDiff(from, to) {
  const a = normalizeCatalog(from);
  const b = normalizeCatalog(to);
  const aMap = new Map(a.conditions.map((row) => [row.id, row]));
  const bMap = new Map(b.conditions.map((row) => [row.id, row]));
  const added = [];
  const changed = [];
  const disabled = [];
  for (const row of b.conditions) {
    const prev = aMap.get(row.id);
    if (!prev) added.push(row.id);
    else if (JSON.stringify(publicCondition(prev)) !== JSON.stringify(publicCondition(row))) {
      changed.push(row.id);
      if (prev.enabled !== false && row.enabled === false) disabled.push(row.id);
    }
  }
  for (const row of a.conditions) {
    if (!bMap.has(row.id)) disabled.push(row.id);
  }
  return {
    added: added.length,
    changed: changed.length,
    disabled: disabled.length,
    added_ids: added,
    changed_ids: changed,
    disabled_ids: [...new Set(disabled)],
  };
}

function publicCondition(row) {
  return {
    id: row.id,
    label: row.label,
    category_id: row.category_id,
    enabled: row.enabled !== false,
    listing_enabled: row.listing_enabled !== false,
    wish_enabled: row.wish_enabled !== false,
    matching_enabled: row.matching_enabled !== false,
    wish_allow_want: row.wish_allow_want !== false,
    wish_allow_avoid: row.wish_allow_avoid !== false,
    value_type: row.value_type,
    aliases: row.aliases,
    sort_order: row.sort_order,
  };
}

export const SUITE_LITE_CONDITION_IDS = Object.freeze([
  "need_cook", "need_pet", "short_ok", "elevator", "fridge", "washer", "ac", "bed", "net",
]);

export function defaultTemplates() {
  const full = defaultCatalog();
  const liteIds = new Set(SUITE_LITE_CONDITION_IDS);
  return [
    { id: "jibby_full", label: "吉比完整租屋條件", catalog: full },
    {
      id: "suite_lite",
      label: "套房精簡版",
      catalog: normalizeCatalog({
        ...full,
        conditions: full.conditions.map((row) => (
          liteIds.has(row.id)
            ? row
            : { ...row, enabled: false, wish_enabled: false, listing_enabled: false }
        )),
      }),
    },
  ];
}

export function normalizeTemplate(input = {}, existingIds = []) {
  const src = input && typeof input === "object" ? input : {};
  const label = String(src.label || "").trim().slice(0, 40);
  if (!label) throw catalogError("請填範本名稱");
  const id = slugId(src.id, generateSystemId(label, existingIds));
  const catalog = normalizeCatalog(src.catalog);
  assertCatalogSafe(catalog);
  return {
    id,
    label,
    catalog,
  };
}

export function applyTemplateDraft(published, template) {
  const current = normalizeCatalog(published);
  const next = normalizeCatalog(template?.catalog || template);
  return {
    draft: next,
    diff: catalogDiff(current, next),
  };
}

export function wishChoicesFromLegacy(mustHave = [], niceToHave = [], avoid = []) {
  const choices = {};
  const leftoverNice = [];
  for (const raw of mustHave || []) {
    const id = canonicalId(raw);
    if (id) choices[id] = "want";
  }
  for (const raw of avoid || []) {
    const id = canonicalId(raw);
    if (!id || choices[id] === "want") continue;
    choices[id] = "avoid";
  }
  for (const raw of niceToHave || []) {
    const id = canonicalId(raw);
    if (!id || choices[id]) {
      leftoverNice.push(String(raw));
      continue;
    }
    leftoverNice.push(id);
  }
  return { choices, nice_to_have_legacy: leftoverNice };
}

export function legacyGroupsFromChoices(choices = {}, niceLegacy = []) {
  const must_have = [];
  const avoid = [];
  for (const [id, action] of Object.entries(choices || {})) {
    if (action === "want") must_have.push(id);
    if (action === "avoid") avoid.push(id);
  }
  return { must_have, nice_to_have: [...niceLegacy], avoid };
}

export function isWishConditionActive(row, categories = []) {
  if (!row || row.enabled === false || row.wish_enabled === false) return false;
  const cat = (categories || []).find((item) => item.id === row.category_id);
  return !cat || cat.enabled !== false;
}

export function isListingConditionActive(row, categories = []) {
  if (!row || row.enabled === false || row.listing_enabled === false) return false;
  const cat = (categories || []).find((item) => item.id === row.category_id);
  return !cat || cat.enabled !== false;
}

export function applyBulkWishActions(catalog, categoryId, action, current = {}) {
  const normalized = normalizeCatalog(catalog);
  const next = { ...current };
  const cat = normalized.categories.find((row) => row.id === categoryId);
  if (!cat || cat.enabled === false) return next;
  const rows = normalized.conditions.filter((row) => (
    isWishConditionActive(row, normalized.categories)
    && row.category_id === categoryId
  ));
  for (const row of rows) {
    if (action === "clear") {
      delete next[row.id];
      continue;
    }
    if (action === "want" && row.wish_allow_want !== false) next[row.id] = "want";
    if (action === "avoid" && row.wish_allow_avoid !== false) next[row.id] = "avoid";
  }
  return next;
}

export function sanitizeWishChoices(catalog, choices = {}, { retainHistorical = false } = {}) {
  const normalized = normalizeCatalog(catalog);
  const map = new Map(normalized.conditions.map((row) => [row.id, row]));
  const out = {};
  for (const [rawId, action] of Object.entries(choices || {})) {
    const id = canonicalId(rawId);
    const row = map.get(id);
    if (!row) continue;
    const inactive = !isWishConditionActive(row, normalized.categories);
    if (inactive && !retainHistorical) continue;
    if (action === "want" && (row.wish_allow_want !== false || (retainHistorical && inactive))) out[id] = "want";
    else if (action === "avoid" && (row.wish_allow_avoid !== false || (retainHistorical && inactive))) out[id] = "avoid";
  }
  return out;
}

export function resolveWishChoices(catalog, choices = {}) {
  return sanitizeWishChoices(catalog, choices, { retainHistorical: true });
}

export function mergeHistoricalWishChoices(catalog, incoming = {}, previous = {}) {
  const next = sanitizeWishChoices(catalog, incoming);
  const historical = resolveWishChoices(catalog, previous);
  const normalized = normalizeCatalog(catalog);
  const map = new Map(normalized.conditions.map((row) => [row.id, row]));
  for (const [id, action] of Object.entries(historical)) {
    const row = map.get(id);
    if (!row) continue;
    if (!isWishConditionActive(row, normalized.categories)) next[id] = action;
  }
  return next;
}

export function catalogConditionLookup(catalog, { includeInactive = false } = {}) {
  const normalized = normalizeCatalog(catalog);
  return normalized.conditions
    .filter((row) => includeInactive || isWishConditionActive(row, normalized.categories))
    .map((row) => ({
      id: row.id,
      label: row.label,
      enabled: row.enabled !== false,
      wish_enabled: row.wish_enabled !== false,
      listing_incompatible: row.listing_negative ? [row.listing_negative] : [],
      listing_compatible: row.listing_positive || [],
      listing_legacy_positive: row.listing_legacy ? [row.listing_legacy] : [],
      wish_allow_want: row.wish_allow_want !== false,
      wish_allow_avoid: row.wish_allow_avoid !== false,
    }));
}

export function isPolarityCondition(row = {}) {
  return POLARITY_CONDITION_IDS.includes(row.id) || Boolean(row.listing_negative && row.listing_legacy);
}

export function listingValuesFromKnownTraits(traitIds = [], catalog = defaultCatalog()) {
  const all = listingValuesFromTraits(traitIds, catalog);
  const out = {};
  for (const [id, value] of Object.entries(all)) {
    if (value && value !== "unknown") out[id] = value;
  }
  return out;
}

export function normalizeListingValues(input = {}, catalog = defaultCatalog()) {
  const map = new Map(normalizeCatalog(catalog).conditions.map((row) => [row.id, row]));
  const out = {};
  for (const [rawId, raw] of Object.entries(input || {})) {
    const id = canonicalId(rawId);
    if (!map.has(id)) continue;
    const value = String(raw || "").trim();
    if (!LISTING_VALUES.includes(value) || value === "unknown") continue;
    out[id] = value;
  }
  return out;
}

export function traitsFromListingValues(values = {}, catalog = defaultCatalog(), extraTraitIds = []) {
  const ids = [];
  const push = (id) => {
    const key = String(id || "").trim();
    if (key && !ids.includes(key)) ids.push(key);
  };
  for (const id of extraTraitIds || []) push(id);
  for (const row of normalizeCatalog(catalog).conditions) {
    const value = values[row.id];
    if (value === "not_allowed" && row.listing_negative) push(row.listing_negative);
    else if (value === "allowed" && row.listing_legacy) push(row.listing_legacy);
    else if (value === "present") {
      if ((row.listing_positive || []).length) row.listing_positive.forEach(push);
      else push(row.id);
    } else if (value === "absent") {
      /* polarity/presence absent is represented by omission, not a dedicated trait id */
    }
  }
  return ids.slice(0, 40);
}

export function mergeListingConditionValues(catalog, inputValues = {}, inputTraits = [], previousValues = {}, previousTraits = []) {
  const incoming = {
    ...listingValuesFromKnownTraits(inputTraits, catalog),
    ...normalizeListingValues(inputValues, catalog),
  };
  const previous = {
    ...listingValuesFromKnownTraits(previousTraits, catalog),
    ...normalizeListingValues(previousValues, catalog),
  };
  const normalized = normalizeCatalog(catalog);
  const map = new Map(normalized.conditions.map((row) => [row.id, row]));
  const out = { ...incoming };
  for (const [id, value] of Object.entries(previous)) {
    const row = map.get(id);
    if (!row) continue;
    if (!isListingConditionActive(row, normalized.categories)) out[id] = value;
  }
  return out;
}

export function listingValuesFromTraits(traitIds = [], catalog = defaultCatalog()) {
  const ids = new Set((traitIds || []).map((id) => String(id)));
  const values = {};
  for (const row of normalizeCatalog(catalog).conditions) {
    if (row.listing_negative && ids.has(row.listing_negative)) values[row.id] = "not_allowed";
    else if (row.listing_legacy && ids.has(row.listing_legacy)) values[row.id] = "allowed";
    else if ((row.listing_positive || []).some((id) => ids.has(id))) values[row.id] = "present";
    else values[row.id] = "unknown";
  }
  return values;
}

export function compatibilityForChoice(condition, wishAction, listingValue) {
  if (!wishAction || wishAction === "unspecified") return "unknown";
  if (wishAction === "want") {
    if (listingValue === "not_allowed" || listingValue === "absent") return "conflict";
    if (listingValue === "allowed" || listingValue === "present") return "compatible";
    return "unknown";
  }
  if (wishAction === "avoid") {
    if (listingValue === "present" || listingValue === "allowed") return "conflict";
    if (listingValue === "absent" || listingValue === "not_allowed") return "compatible";
    return "unknown";
  }
  return "unknown";
}

export function catalogAsWishConditions(catalog) {
  const normalized = normalizeCatalog(catalog);
  return normalized.conditions
    .filter((row) => isWishConditionActive(row, normalized.categories))
    .map((row) => ({
      id: row.id,
      label: row.label,
      enabled: true,
      listing_incompatible: row.listing_negative ? [row.listing_negative] : [],
      listing_compatible: row.listing_positive || [],
      listing_legacy_positive: row.listing_legacy ? [row.listing_legacy] : [],
      wish_allow_want: row.wish_allow_want !== false,
      wish_allow_avoid: row.wish_allow_avoid !== false,
    }));
}

export function catalogAsSelfTraitGroups(catalog, { includeInactive = false } = {}) {
  const cats = normalizeCatalog(catalog);
  return cats.categories
    .filter((cat) => includeInactive || cat.enabled !== false)
    .map((cat) => ({
      id: cat.id,
      label: cat.label,
      items: cats.conditions
        .filter((row) => row.category_id === cat.id && (includeInactive || (row.enabled !== false && row.listing_enabled !== false)))
        .map((row) => {
          const polarity = isPolarityCondition(row);
          return {
            id: polarity ? row.id : (row.listing_positive[0] || row.id),
            label: row.label,
            canonical_id: row.id,
            input: polarity ? "polarity" : "presence",
            listing_negative: row.listing_negative || "",
            listing_legacy: row.listing_legacy || "",
            enabled: isListingConditionActive(row, cats.categories),
          };
        }),
    }))
    .filter((group) => group.items.length);
}

export const SYSTEM_TEMPLATE_IDS = Object.freeze(["jibby_full", "suite_lite"]);

export function isSystemCatalogTemplate(id) {
  return SYSTEM_TEMPLATE_IDS.includes(String(id || ""));
}

export function catalogReferenceTokens(conditionId, catalog = defaultCatalog()) {
  const normalized = normalizeCatalog(catalog);
  const id = canonicalId(conditionId);
  const row = normalized.conditions.find((item) => item.id === id);
  const tokens = new Set([id, String(conditionId || "").trim()].filter(Boolean));
  for (const [legacy, canonical] of Object.entries(LEGACY_ID_TO_CANONICAL)) {
    if (canonical === id) tokens.add(legacy);
  }
  if (row) {
    (row.listing_positive || []).forEach((token) => tokens.add(token));
    if (row.listing_negative) tokens.add(row.listing_negative);
    if (row.listing_legacy) tokens.add(row.listing_legacy);
  }
  return [...tokens];
}

function collectIdsFromBlob(blob) {
  if (blob == null || blob === "") return [];
  let parsed = blob;
  if (typeof blob === "string") {
    try { parsed = JSON.parse(blob); } catch { return [blob]; }
  }
  const ids = [];
  const walk = (value) => {
    if (value == null) return;
    if (typeof value === "string") {
      ids.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value === "object") {
      for (const [key, val] of Object.entries(value)) {
        ids.push(key);
        walk(val);
      }
    }
  };
  walk(parsed);
  return ids;
}

export function blobReferencesCondition(blob, tokens) {
  const tokenSet = new Set(tokens || []);
  return collectIdsFromBlob(blob).some((id) => tokenSet.has(id) || tokenSet.has(canonicalId(id)));
}

export function countCatalogReferences(rows = [], conditionId, catalog = defaultCatalog()) {
  const tokens = catalogReferenceTokens(conditionId, catalog);
  let n = 0;
  for (const row of rows || []) {
    const blobs = [
      row.must_have,
      row.nice_to_have,
      row.avoid,
      row.condition_choices,
      row.self_traits,
      row.listing_condition_values,
    ];
    if (blobs.some((blob) => blobReferencesCondition(blob, tokens))) n += 1;
  }
  return n;
}

function listingNegativeLabel(row) {
  if (row.id === "need_cook") return "不可開伙";
  if (row.id === "need_pet") return "不可養寵物";
  if (row.id === "need_tax") return "不可報稅／不可租補";
  return `不可${row.label}`;
}

export function canonicalId(raw) {
  const id = String(raw || "").trim();
  if (!id) return "";
  return LEGACY_ID_TO_CANONICAL[id] || id;
}

export function publicAdminCatalog(catalog, { revealIds = false } = {}) {
  const row = normalizeCatalog(catalog);
  return {
    version: row.version,
    categories: row.categories,
    conditions: row.conditions.map((item) => ({
      ...publicCondition(item),
      aliases: item.aliases,
      technical: revealIds ? {
        id: item.id,
        listing_positive: item.listing_positive,
        listing_negative: item.listing_negative,
        listing_legacy: item.listing_legacy,
      } : undefined,
    })),
  };
}

export function seedUsesExistingDomains() {
  const wishIds = DEFAULT_WISH_CONDITIONS.map((row) => row.id);
  const traitIds = SELF_TRAIT_GROUPS.flatMap((group) => group.items.map((item) => item.id));
  return { wishIds, traitIds, legacyLabels: Object.keys(LEGACY_TRAIT_LABELS) };
}

function catalogError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}
