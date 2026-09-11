/** 從各平台抓回的天然瓦斯／家俱家電／陽台標記。沒抓到就當「無」，不猜。 */

export const FURNISH_LABELS = Object.freeze([
  "床", "衣櫃", "沙發", "餐桌", "椅子", "書桌", "桌子", "電視",
  "冰箱", "冷氣", "洗衣機", "烘衣機", "微波爐", "烤箱",
  "熱水器", "瓦斯熱水器", "電熱水器", "瓦斯爐", "電磁爐",
  "第四台", "網路", "寬頻", "窗帘", "鞋櫃", "書桌椅", "書架",
]);

const FURNISH_ALIASES = Object.freeze({
  桌椅: "桌子",
  餐桌椅: "餐桌",
  床組: "床",
  單人床: "床",
  雙人床: "床",
  液晶電視: "電視",
  電視機: "電視",
  寬頻網路: "網路",
});

const GAS_RE = /天然瓦斯|有瓦斯(?!費)|瓦斯：\s*有|瓦斯:\s*有/;
const BALCONY_NO_RE = /無陽台|沒有陽台|0陽台/;
const KIT_SKIP_RE = /瓦斯|陽台|電梯|車位/;

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
    ...(asList(input.facility)),
  ];
  return bits.filter(Boolean).join(" ");
}

function normalizeFurnishLabel(label) {
  const raw = String(label || "").trim();
  if (!raw || raw === "無") return "";
  return FURNISH_ALIASES[raw] || raw;
}

export function listingHasNaturalGas(input = {}) {
  if (input.has_natural_gas === true || Number(input.has_natural_gas) === 1) return true;
  return GAS_RE.test(hayFrom(input));
}

export function listingHasBalcony(input = {}) {
  if (input.has_balcony === true || Number(input.has_balcony) === 1) return true;
  const bits = [
    ...asList(input.furnish),
    ...asList(input.facility),
    ...asList(input.tags),
    input.text,
  ].filter(Boolean);
  return bits.some((bit) => /陽台/.test(String(bit)) && !BALCONY_NO_RE.test(String(bit)));
}

export function parseFurnishItems(input = {}) {
  const found = [];
  const push = (label) => {
    const name = normalizeFurnishLabel(label);
    if (!name || KIT_SKIP_RE.test(name) || found.includes(name)) return;
    if (FURNISH_LABELS.includes(name) || /^(床|衣櫃|沙發|餐桌|桌子|冰箱|冷氣|洗衣機|熱水器|電視|微波爐)$/.test(name)) {
      found.push(name);
    }
  };
  for (const item of [
    ...parseStoredFurnish(input.furnish_items),
    ...asList(input.furnish),
    ...asList(input.include),
    ...asList(input.facility),
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
    has_balcony: listingHasBalcony(input),
    furnish_items: parseFurnishItems(input),
  };
}

export function listingKitFields(input = {}) {
  const kit = listingKitFrom(input);
  return {
    has_natural_gas: kit.has_natural_gas ? 1 : 0,
    has_balcony: kit.has_balcony ? 1 : 0,
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

export function active591Facilities(service) {
  return (Array.isArray(service?.facility) ? service.facility : [])
    .filter((row) => Number(row?.active) === 1)
    .map((row) => String(row?.name || "").trim())
    .filter(Boolean);
}

/** 591 明細：只採「提供設備」有勾的項目，不把未勾的冰箱／床寫進來。 */
/** 各站「有勾／has」的設備名；瓦斯／陽台不當家俱。 */
export function kitFromActiveNames(names = []) {
  const labels = (Array.isArray(names) ? names : asList(names))
    .map((name) => String(name || "").trim())
    .filter(Boolean);
  return listingKitFrom({
    furnish: labels.filter((name) => !KIT_SKIP_RE.test(name)),
    facility: labels,
    tags: labels,
    text: labels.join(" "),
  });
}

export function kitFrom591Detail(data = {}) {
  let names = active591Facilities(data.service);
  if (!names.length) {
    names = String(data?.gtm_detail_data?.facility_name || "")
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  const infoBalcony = (Array.isArray(data?.information?.data) ? data.information.data : [])
    .find((row) => row?.key === "balcony" || row?.name === "陽台");
  const infoVal = String(infoBalcony?.value || "").trim();
  const text = [...names, infoVal].filter(Boolean).join(" ");
  return listingKitFrom({
    furnish: names.filter((name) => !KIT_SKIP_RE.test(name)),
    facility: names,
    tags: names,
    text,
  });
}
