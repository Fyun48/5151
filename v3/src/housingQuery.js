/** 七按鈕房屋條件：租賃型態、類別與電梯的共用契約。前後端同一套 reducer。 */

export const HOUSING_KIND_CHIPS = Object.freeze([
  "whole",
  "suite_shared",
  "building",
  "apartment_huaxia",
  "shop",
  "warehouse",
  "elevator",
]);

export const LEGACY_RENTAL_KINDS = Object.freeze(["suite", "yafang", "share", "coliving"]);
export const HOUSING_CATEGORY_KINDS = Object.freeze(["building", "apartment_huaxia", "shop", "warehouse"]);
export const HOUSING_APPEARANCE_KINDS = Object.freeze(["building", "apartment_huaxia"]);
export const HOUSING_COMMERCIAL_KINDS = Object.freeze(["shop", "warehouse"]);

export const HOUSING_KINDS = Object.freeze([
  ...HOUSING_KIND_CHIPS,
  ...LEGACY_RENTAL_KINDS,
  "apartment",
]);

export const HOUSING_KIND_GROUPS = Object.freeze({
  building: ["elevator", "apartment", "building", "apartment_huaxia"],
  dwelling: ["suite", "yafang", "share", "coliving", "suite_shared", "whole", "shop", "warehouse"],
});

const RENTAL_KEYS = new Set(["whole", "suite_shared", ...LEGACY_RENTAL_KINDS]);

export function parseHousingKinds(kind) {
  const raw = Array.isArray(kind) ? kind : String(kind || "").split(/[,|]/);
  const keys = [];
  for (const item of raw) {
    const key = String(item || "").trim();
    if (HOUSING_KINDS.includes(key) && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

export function emptyHousingQuery() {
  return { rentalMode: "any", categories: [], elevatorManual: false, legacyRental: "", hint: "" };
}

export function defaultHousingQuery() {
  return { rentalMode: "whole", categories: [], elevatorManual: false, legacyRental: "", hint: "" };
}

export function kindsToQuery(kind) {
  const keys = parseHousingKinds(kind);
  const q = emptyHousingQuery();
  if (keys.includes("suite_shared")) q.rentalMode = "suite_shared";
  else if (keys.includes("whole")) q.rentalMode = "whole";
  else {
    const legacy = keys.filter((key) => LEGACY_RENTAL_KINDS.includes(key));
    if (legacy.length) {
      q.rentalMode = "legacy";
      q.legacyRental = legacy[legacy.length - 1];
    }
  }
  for (const cat of HOUSING_CATEGORY_KINDS) {
    if (keys.includes(cat)) q.categories.push(cat);
  }
  if (keys.includes("apartment") && !q.categories.includes("apartment_huaxia")) {
    q.categories.push("apartment_huaxia");
  }
  q.elevatorManual = keys.includes("elevator");
  return q;
}

export function queryToKinds(query = emptyHousingQuery()) {
  const q = query && typeof query === "object" ? query : emptyHousingQuery();
  const kinds = [];
  if (q.rentalMode === "whole") kinds.push("whole");
  if (q.rentalMode === "suite_shared") kinds.push("suite_shared");
  if (q.rentalMode === "legacy" && q.legacyRental) kinds.push(q.legacyRental);
  for (const cat of HOUSING_CATEGORY_KINDS) {
    if ((q.categories || []).includes(cat)) kinds.push(cat);
  }
  if (q.elevatorManual) kinds.push("elevator");
  return kinds;
}

export function migrateHousingKinds(kind) {
  const keys = parseHousingKinds(kind);
  const q = emptyHousingQuery();
  const legacy = keys.filter((key) => LEGACY_RENTAL_KINDS.includes(key));
  if (keys.includes("suite_shared") || legacy.length) q.rentalMode = "suite_shared";
  if (keys.includes("whole") && q.rentalMode !== "suite_shared") q.rentalMode = "whole";
  if (keys.includes("whole") && keys.includes("suite_shared")) q.rentalMode = "any";
  for (const cat of HOUSING_CATEGORY_KINDS) {
    if (keys.includes(cat)) q.categories.push(cat);
  }
  if (keys.includes("apartment") && !q.categories.includes("apartment_huaxia")) {
    q.categories.push("apartment_huaxia");
  }
  q.elevatorManual = keys.includes("elevator");
  if (q.categories.includes("shop") && q.categories.includes("warehouse")) {
    q.categories = q.categories.filter((item) => item !== "shop");
    q.hint = "已取消店面";
  }
  return queryToKinds(q);
}

/** 只選整層或套房、沒指定建築樣式或店面／倉庫時，大樓與公寓／華廈都算進去。 */
export function effectiveAppearanceCategories(query) {
  const q = query && typeof query === "object" ? query : kindsToQuery(query);
  const cats = q.categories || [];
  const appearance = cats.filter((key) => HOUSING_APPEARANCE_KINDS.includes(key));
  const commercial = cats.filter((key) => HOUSING_COMMERCIAL_KINDS.includes(key));
  const rentalOn = q.rentalMode === "whole" || q.rentalMode === "suite_shared" || q.rentalMode === "legacy";
  if (rentalOn && !appearance.length && !commercial.length) {
    return ["building", "apartment_huaxia"];
  }
  return appearance;
}

export function commercialCategories(query) {
  const q = query && typeof query === "object" ? query : kindsToQuery(query);
  return (q.categories || []).filter((key) => HOUSING_COMMERCIAL_KINDS.includes(key));
}

export function elevatorRequired(query) {
  const q = query && typeof query === "object" ? query : kindsToQuery(query);
  return Boolean(q.elevatorManual || (q.categories || []).includes("building"));
}

export function applyHousingQueryChip(query, chip) {
  const key = String(chip || "").trim();
  const q = {
    rentalMode: query?.rentalMode || "any",
    categories: [...(query?.categories || [])],
    elevatorManual: Boolean(query?.elevatorManual),
    legacyRental: query?.legacyRental || "",
    hint: "",
  };
  if (key === "whole") {
    q.rentalMode = q.rentalMode === "whole" ? "any" : "whole";
    q.legacyRental = "";
    return q;
  }
  if (key === "suite_shared" || LEGACY_RENTAL_KINDS.includes(key)) {
    if (key !== "suite_shared") {
      if (q.rentalMode === "legacy" && q.legacyRental === key) {
        q.rentalMode = "any";
        q.legacyRental = "";
        return q;
      }
      q.rentalMode = "legacy";
      q.legacyRental = key;
      return q;
    }
    if (q.rentalMode === "suite_shared") {
      q.rentalMode = "any";
    } else {
      q.rentalMode = "suite_shared";
      q.legacyRental = "";
    }
    return q;
  }
  if (key === "shop" || key === "warehouse") {
    if (q.categories.includes(key)) {
      q.categories = q.categories.filter((item) => item !== key);
    } else {
      q.categories = q.categories.filter((item) => item !== "shop" && item !== "warehouse");
      q.categories.push(key);
      q.hint = key === "warehouse" && query?.categories?.includes("shop")
        ? "已取消店面"
        : key === "shop" && query?.categories?.includes("warehouse")
          ? "已取消倉庫"
          : "";
    }
    return q;
  }
  if (key === "building") {
    if (q.categories.includes("building")) {
      q.categories = q.categories.filter((item) => item !== "building");
    } else {
      q.categories.push("building");
    }
    return q;
  }
  if (key === "elevator") {
    q.elevatorManual = !q.elevatorManual;
    if (q.categories.includes("building")) q.hint = "大樓一定有電梯";
    return q;
  }
  const category = key === "apartment" ? "apartment_huaxia" : key;
  if (HOUSING_CATEGORY_KINDS.includes(category)) {
    if (q.categories.includes(category)) {
      q.categories = q.categories.filter((item) => item !== category);
    } else {
      q.categories.push(category);
    }
  }
  return q;
}

export function toggleHousingKind(selected, next) {
  const key = String(next || "").trim();
  if (!HOUSING_KINDS.includes(key)) return parseHousingKinds(selected);
  return queryToKinds(applyHousingQueryChip(kindsToQuery(selected), key));
}

export function resolveHousingKinds(kind) {
  return queryToKinds(kindsToQuery(kind));
}

export function housingKindConflicts(a, b) {
  if (!a || !b || a === b) return false;
  const left = kindsToQuery([a]);
  const right = applyHousingQueryChip(left, b);
  const next = queryToKinds(right);
  return !(next.includes(a) && next.includes(b));
}

export function normalizeDistrictSelection(selected, available) {
  const all = [...new Set((available || []).map((name) => String(name || "").trim()).filter(Boolean))];
  const picked = [...new Set((selected || []).map((name) => String(name || "").trim()).filter(Boolean))]
    .filter((name) => all.includes(name));
  if (!picked.length || (all.length && picked.length === all.length && all.every((name) => picked.includes(name)))) {
    return [];
  }
  return picked;
}
