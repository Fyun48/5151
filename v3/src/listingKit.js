/** 從各平台抓回的天然瓦斯／家俱家電／陽台標記。未知不能當「無」。 */

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

const FURNISH_PARENTS = Object.freeze({
  熱水器: ["電熱水器", "瓦斯熱水器"],
});

const LIST_HIGHLIGHT_IDS = new Set(["天然瓦斯", "陽台", "共用陽台"]);
const KIT_SKIP_RE = /^(天然瓦斯|陽台|共用陽台|電梯|車位|停車位)$/;
const GAS_NEG_RE = /無天然瓦斯|沒有天然瓦斯|不含天然瓦斯|不附天然瓦斯|未提供天然瓦斯|沒天然瓦斯/;
const GAS_POS_RE = /天然瓦斯/;
const BALCONY_NO_RE = /無陽台|沒有陽台|0陽台|陽台0|陽台已外推|原陽台已外推/;
const FURNISH_NEG_BEFORE = /(?:不附贈|不附|不提供|未提供|不含|沒有|無|非|可自行(?:購買|準備)?|需自備|請自備)\s*$/;

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

function boolFlag(value) {
  if (value === true || Number(value) === 1) return true;
  if (value === false || Number(value) === 0) return false;
  return null;
}

function classifyFromHay(hay, { posRe, negRe }) {
  const text = String(hay || "");
  if (negRe.test(text)) return { value: false, state: "known" };
  if (posRe.test(text)) return { value: true, state: "known" };
  return { value: null, state: "unknown" };
}

export function classifyNaturalGas(input = {}) {
  const explicit = boolFlag(input.has_natural_gas);
  if (explicit === true) return { value: true, state: "known", basis: "source_flag" };
  if (explicit === false && input.gas_state === "known") {
    return { value: false, state: "known", basis: "source_flag" };
  }
  const hay = hayFrom(input);
  if (GAS_NEG_RE.test(hay)) return { value: false, state: "known", basis: "negation" };
  if (GAS_POS_RE.test(hay)) return { value: true, state: "known", basis: "source_text" };
  return { value: null, state: "unknown", basis: "not_provided" };
}

export function classifyBalcony(input = {}) {
  const explicit = boolFlag(input.has_balcony);
  if (explicit === true) return { value: true, state: "known", basis: "source_flag" };
  if (explicit === false && input.balcony_state === "known") {
    return { value: false, state: "known", basis: "source_flag" };
  }
  const bits = [
    ...asList(input.furnish),
    ...asList(input.facility),
    ...asList(input.tags),
    input.text,
    input.layout,
  ].filter(Boolean);
  if (bits.some((bit) => BALCONY_NO_RE.test(String(bit)))) {
    return { value: false, state: "known", basis: "negation" };
  }
  if (bits.some((bit) => /陽台/.test(String(bit)) && !BALCONY_NO_RE.test(String(bit)))) {
    return { value: true, state: "known", basis: "source_text" };
  }
  const hay = hayFrom(input);
  return classifyFromHay(hay, { posRe: /陽台/, negRe: BALCONY_NO_RE });
}

export function listingHasNaturalGas(input = {}) {
  return classifyNaturalGas(input).value === true;
}

export function listingHasBalcony(input = {}) {
  return classifyBalcony(input).value === true;
}

function textAffirmsLabel(hay, label) {
  const text = String(hay || "");
  if (!text.includes(label)) return false;
  let from = 0;
  while (from < text.length) {
    const idx = text.indexOf(label, from);
    if (idx < 0) return false;
    const before = text.slice(Math.max(0, idx - 8), idx);
    const after = text.slice(idx + label.length, idx + label.length + 8);
    if (FURNISH_NEG_BEFORE.test(before) || /^(?:可自行|需自備|請自備)/.test(after)) {
      from = idx + label.length;
      continue;
    }
    return true;
  }
  return false;
}

function dropParentDuplicates(found) {
  return found.filter((name) => {
    const children = FURNISH_PARENTS[name];
    return !children || !children.some((child) => found.includes(child));
  });
}

function hasStructuredFacilities(input = {}) {
  if (input.furnish_complete === true || input.kit_complete === true) return true;
  if (Array.isArray(input.furnish) && input.furnish.length) return true;
  if (Array.isArray(input.facility) && input.facility.length) return true;
  if (Array.isArray(input.include) && input.include.length) return true;
  return false;
}

export function parseFurnishItems(input = {}) {
  const found = [];
  const push = (label) => {
    const name = normalizeFurnishLabel(label);
    if (!name || KIT_SKIP_RE.test(name) || found.includes(name)) return;
    if (FURNISH_LABELS.includes(name) || /^(床|衣櫃|沙發|餐桌|桌子|冰箱|冷氣|洗衣機|熱水器|電視|微波爐|瓦斯爐)$/.test(name)) {
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
    if (textAffirmsLabel(hay, label)) push(label);
  }
  return dropParentDuplicates(found);
}

export function listingKitFrom(input = {}) {
  const gas = classifyNaturalGas(input);
  const balcony = classifyBalcony(input);
  const furnish_items = parseFurnishItems(input);
  return {
    has_natural_gas: gas.value === true,
    has_balcony: balcony.value === true,
    furnish_items,
    gas_state: gas.state,
    balcony_state: balcony.state,
    furnish_complete: hasStructuredFacilities(input),
    furnish_state: hasStructuredFacilities(input) || furnish_items.length ? "known" : "unknown",
  };
}

export function listingKitFields(input = {}) {
  const kit = listingKitFrom(input);
  return {
    has_natural_gas: kit.has_natural_gas ? 1 : 0,
    has_balcony: kit.has_balcony ? 1 : 0,
    furnish_items: JSON.stringify(kit.furnish_items),
    gas_state: kit.gas_state,
    balcony_state: kit.balcony_state,
    furnish_complete: kit.furnish_complete ? 1 : 0,
  };
}

export function mergeKitColumns(existing = {}, incoming = {}) {
  const next = listingKitFrom(incoming);
  const keepGas = next.gas_state !== "known";
  const keepBalcony = next.balcony_state !== "known";
  const incomingItems = Array.isArray(next.furnish_items) ? next.furnish_items : parseStoredFurnish(incoming.furnish_items);
  const existingItems = parseStoredFurnish(existing.furnish_items);
  const writeFurnish = next.furnish_complete === true || incoming.furnish_complete === true || incomingItems.length > 0;
  return {
    has_natural_gas: keepGas ? (Number(existing.has_natural_gas) === 1 ? 1 : 0) : (next.has_natural_gas ? 1 : 0),
    has_balcony: keepBalcony ? (Number(existing.has_balcony) === 1 ? 1 : 0) : (next.has_balcony ? 1 : 0),
    furnish_items: writeFurnish ? incomingItems : existingItems,
  };
}

export function listHighlightLabels(kit = {}) {
  return [
    kit.has_natural_gas ? "天然瓦斯" : null,
    kit.has_balcony ? (kit.balcony_shared ? "共用陽台" : "陽台") : null,
  ].filter(Boolean);
}

export function tooltipFurnishItems(items = []) {
  return (Array.isArray(items) ? items : parseStoredFurnish(items))
    .map((item) => normalizeFurnishLabel(item))
    .filter((name) => name && !LIST_HIGHLIGHT_IDS.has(name) && !KIT_SKIP_RE.test(name));
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

/** 各站「有勾／has」的設備名；天然瓦斯／陽台不當家俱。 */
export function kitFromActiveNames(names = []) {
  const labels = (Array.isArray(names) ? names : asList(names))
    .map((name) => String(name || "").trim())
    .filter(Boolean);
  return listingKitFrom({
    furnish: labels.filter((name) => !KIT_SKIP_RE.test(name) && name !== "天然瓦斯" && name !== "陽台"),
    facility: labels,
    tags: labels,
    text: labels.join(" "),
    kit_complete: true,
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
    furnish: names.filter((name) => !KIT_SKIP_RE.test(name) && name !== "天然瓦斯" && name !== "陽台"),
    facility: names,
    tags: names,
    text,
    kit_complete: true,
  });
}
