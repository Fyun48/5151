/** 從各平台抓回的天然瓦斯／家俱家電標記。沒抓到就當「無」，不猜。 */

export const FURNISH_LABELS = Object.freeze([
  "床", "衣櫃", "沙發", "餐桌", "椅子", "書桌", "電視",
  "冰箱", "冷氣", "洗衣機", "烘衣機", "微波爐", "烤箱",
  "熱水器", "瓦斯熱水器", "電熱水器", "瓦斯爐", "電磁爐",
  "第四台", "網路", "寬頻", "窗帘", "鞋櫃", "書桌椅",
]);

const GAS_RE = /天然瓦斯|有瓦斯(?!費)|瓦斯：\s*有|瓦斯:\s*有/;

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    return Object.values(value).flatMap((item) => asList(item));
  }
  return String(value || "")
    .split(/[,，、|/\s]+/)
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function hayFrom(input = {}) {
  const bits = [
    input.title,
    input.address,
    input.kind_name,
    input.price_contain_text,
    input.extra_fee_text,
    input.html,
    input.text,
    ...(asList(input.tags)),
    ...(asList(input.themes)),
    ...(asList(input.conditionTags)),
    ...(asList(input.furnish)),
    ...(asList(input.include)),
  ];
  return bits.filter(Boolean).join(" ");
}

export function listingHasNaturalGas(input = {}) {
  if (input.has_natural_gas === true || Number(input.has_natural_gas) === 1) return true;
  return GAS_RE.test(hayFrom(input));
}

export function parseFurnishItems(input = {}) {
  const found = [];
  const push = (label) => {
    const name = String(label || "").trim();
    if (!name || name === "無" || found.includes(name)) return;
    if (FURNISH_LABELS.includes(name) || /^(床|衣櫃|沙發|餐桌|冰箱|冷氣|洗衣機|熱水器|電視|微波爐)$/.test(name)) {
      found.push(name);
    }
  };
  for (const item of [
    ...parseStoredFurnish(input.furnish_items),
    ...asList(input.furnish),
    ...asList(input.include),
  ]) {
    push(item);
  }
  const hay = hayFrom(input);
  for (const label of FURNISH_LABELS) {
    if (hay.includes(label)) push(label);
  }
  return found;
}

export function listingKitFrom(input = {}) {
  return {
    has_natural_gas: listingHasNaturalGas(input),
    furnish_items: parseFurnishItems(input),
  };
}

export function listingKitFields(input = {}) {
  const kit = listingKitFrom(input);
  return {
    has_natural_gas: kit.has_natural_gas ? 1 : 0,
    furnish_items: JSON.stringify(kit.furnish_items),
  };
}

export function parseStoredFurnish(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item || "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}
