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
  if (q.rentalMode === "suite_shared" && q.categories.includes("warehouse")) {
    q.rentalMode = "any";
    q.hint = "型態條件已調整";
  }
  return queryToKinds(q);
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
      if (q.categories.includes("warehouse")) {
        q.categories = q.categories.filter((item) => item !== "warehouse");
        q.hint = "已取消倉庫";
      }
      return q;
    }
    if (q.rentalMode === "suite_shared") {
      q.rentalMode = "any";
    } else {
      q.rentalMode = "suite_shared";
      q.legacyRental = "";
      if (q.categories.includes("warehouse")) {
        q.categories = q.categories.filter((item) => item !== "warehouse");
        q.hint = "已取消倉庫";
      }
    }
    return q;
  }
  if (key === "warehouse") {
    if (q.categories.includes("warehouse")) {
      q.categories = q.categories.filter((item) => item !== "warehouse");
    } else {
      q.categories.push("warehouse");
      if (q.rentalMode === "suite_shared" || q.rentalMode === "legacy") {
        q.rentalMode = "any";
        q.legacyRental = "";
        q.hint = "已取消套房/分租";
      }
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
    if (q.categories.includes("building")) {
      q.categories = q.categories.filter((item) => item !== "building");
      q.elevatorManual = false;
      q.hint = "已取消大樓，不再限制電梯";
    } else {
      q.elevatorManual = !q.elevatorManual;
    }
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
