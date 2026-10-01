/** 租金與額外月費：辨識已含／另計，押金等一次性費用不列入月租上限。 */

const ONE_TIME =
  /押金|保證金|禮金|仲介費|服務費|開辦費|手續費|鑰匙|訂金|轉租費|違約|一次性|一次繳/;
const INCLUDED =
  /已含|內含|含在租金|租金內含|含於租金|租金已含|包[在於]租金|含在房租|房租已含/;
const EXTRA_HINT = /另計|另付|另繳|另租|另收|外加|不含|未含|須另|需另|須加|需加|額外|另外支付|另外計/;
// `水電` 一定要在 `水費`／`電費` 之前：很多來源只寫「水電費 500 另計」，
// 少了這一個詞就整筆認不出來（費用少算，而且「水電另計」也判斷不出來）。
const FEE_KIND =
  /管理費|清潔費|停車費|車位費|車位|停車|水電|水費|電費|瓦斯費|瓦斯|網路費|網路|第四台|垃圾費|垃圾代收|公共基金|修繕費/;

function toHalfWidth(text) {
  return String(text || "")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 48))
    .replace(/[，]/g, ",")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[/／]/g, "/");
}

export function parseJsonFees(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || text === "[]") return [];
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function parseTwdAmount(text) {
  const raw = toHalfWidth(text);
  if (!raw) return 0;
  if (/不需|不用|免費|無管理|管理費無|--|—|無此/.test(raw) && !/\d/.test(raw)) return 0;
  const wan = raw.match(/(\d+(?:\.\d+)?)\s*萬/);
  if (wan) {
    const n = Math.round(Number(wan[1]) * 10000);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  const m = raw.match(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/);
  if (!m) return 0;
  const n = Number(String(m[1]).replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > 200000) return 0;
  return Math.round(n);
}

function rowBlob(row) {
  if (!row || typeof row !== "object") return "";
  return toHalfWidth(`${row.name || ""} ${row.value || ""} ${row.key || ""}`);
}

function isOneTimeFee(text) {
  return ONE_TIME.test(text);
}

function isIncludedFee(text) {
  return INCLUDED.test(text) && !EXTRA_HINT.test(text);
}

export function feeRowMonthlyAmount(row, { rent = 0 } = {}) {
  const blob = rowBlob(row);
  if (!blob) return 0;
  if (isOneTimeFee(blob)) return 0;
  if (isIncludedFee(blob)) return 0;
  const tagged = Number(row?.amount);
  if (Number.isFinite(tagged) && tagged > 0) {
    if (rent > 0 && tagged >= rent * 1.5) return 0;
    if (tagged > 80000) return 0;
    return Math.round(tagged);
  }
  const parsed = parseTwdAmount(blob);
  if (parsed <= 0) return 0;
  if (rent > 0 && parsed >= rent * 1.5) return 0;
  return parsed;
}

function pushUniqueRow(rows, row) {
  const name = String(row?.name || "").trim() || "額外費用";
  const value = String(row?.value || "").trim();
  const key = String(row?.key || "");
  if (!value && !(Number(row?.amount) > 0)) return;
  const sig = `${key}|${name}|${value}|${Number(row?.amount) || 0}`;
  if (rows.some((item) => `${item.key || ""}|${item.name}|${item.value}|${Number(item.amount) || 0}` === sig)) {
    return;
  }
  rows.push({
    name,
    value: value || (Number(row?.amount) > 0 ? `${Number(row.amount).toLocaleString("zh-TW")}元/月` : ""),
    key,
    amount: Number(row?.amount) > 0 ? Math.round(Number(row.amount)) : undefined,
  });
}

export function parseNamedMonthlyFees(text, { requireExtraHint = true } = {}) {
  const raw = toHalfWidth(text);
  if (!raw) return [];
  const kindRe = new RegExp(FEE_KIND.source, "g");
  const hits = [...raw.matchAll(kindRe)];
  const out = [];
  for (let i = 0; i < hits.length; i += 1) {
    const kindStart = hits[i].index;
    const prefix = raw.slice(Math.max(0, kindStart - 16), kindStart);
    const until = i + 1 < hits.length ? hits[i + 1].index : Math.min(raw.length, kindStart + 80);
    const tail = raw.slice(kindStart, until).trim();
    const bit = `${prefix}${tail}`.trim();
    if (!tail || isOneTimeFee(bit)) continue;
    const included = isIncludedFee(bit) || (/含水|含電|含瓦斯|含網路|含第四台/.test(bit) && !EXTRA_HINT.test(bit));
    const kind = hits[i][0];
    if (included) {
      out.push({ name: kind, value: bit.slice(0, 80), key: "contain", amount: 0, included: true });
      continue;
    }
    if (requireExtraHint && !EXTRA_HINT.test(bit)) continue;
    const amount = parseTwdAmount(tail);
    if (amount <= 0) continue;
    out.push({
      name: kind,
      value: bit.slice(0, 80),
      key: "extra",
      amount,
      included: false,
    });
  }
  return out;
}

function listingBlob(listing) {
  const tags = Array.isArray(listing?.tags)
    ? listing.tags.join(" ")
    : typeof listing?.tags === "string"
      ? listing.tags
      : "";
  return toHalfWidth([tags, listing?.fee_blob].filter(Boolean).join("\n"));
}

function namedMonthlySum(text, opts) {
  return parseNamedMonthlyFees(text, opts).reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
}

export function extraMonthlyAmount(listing = {}) {
  const rent = rentAmount(listing);
  const rows = parseJsonFees(listing.extra_fees);
  let fromRows = 0;
  for (const row of rows) {
    fromRows += feeRowMonthlyAmount(row, { rent });
  }
  if (fromRows > 0) return fromRows;
  const col = Number(listing.extra_fee);
  if (Number.isFinite(col) && col > 0) return Math.round(col);
  const fromText = namedMonthlySum(listing.extra_fee_text, { requireExtraHint: false });
  if (fromText > 0) return fromText;
  return namedMonthlySum(listingBlob(listing), { requireExtraHint: true });
}

export function extraFeeRows(listing = {}) {
  const rows = [];
  for (const row of parseJsonFees(listing.extra_fees)) {
    pushUniqueRow(rows, row);
  }
  const contain = String(listing.price_contain_text || "").replace(/[()（）]/g, "").trim();
  if (contain && !rows.some((row) => row.key === "contain" || row.value.includes(contain))) {
    pushUniqueRow(rows, { name: "租金含", value: contain, key: "contain" });
  }
  for (const row of parseNamedMonthlyFees(listing.extra_fee_text, { requireExtraHint: false })) {
    pushUniqueRow(rows, row);
  }
  for (const row of parseNamedMonthlyFees(listingBlob(listing), { requireExtraHint: true })) {
    pushUniqueRow(rows, row);
  }
  const extraText = String(listing.extra_fee_text || "").replace(/[()（）]/g, "").trim();
  const extraAmt = Number(listing.extra_fee) || 0;
  const namedSum = rows.reduce((sum, row) => sum + feeRowMonthlyAmount(row), 0);
  if ((extraText || extraAmt > 0) && namedSum <= 0) {
    pushUniqueRow(rows, {
      name: "額外費用",
      value: extraText || `${extraAmt.toLocaleString("zh-TW")}元/月`,
      key: "extra",
      amount: extraAmt > 0 ? extraAmt : undefined,
    });
  }
  return rows;
}

export function rentAmount(listing = {}) {
  const n = Number(listing.price_num);
  const fromNum = Number.isFinite(n) && n > 0 ? n : 0;
  // 部分來源把 3.8萬存成 3.8；小於 1000 的數字當月租不合理，改回萬元。
  if (fromNum >= 1000) return Math.round(fromNum);
  const fromText = parseTwdAmount(listing.price);
  if (fromText >= 1000) return fromText;
  if (fromNum > 0 && fromNum < 1000) return Math.round(fromNum * 10000);
  return fromText > 0 ? fromText : 0;
}

export function listingCompareCost(listing = {}, { includeExtras = false } = {}) {
  const rent = rentAmount(listing);
  if (!includeExtras) return rent;
  if (rent <= 0) return 0;
  return rent + extraMonthlyAmount(listing);
}

export function passesPriceFilter(listing, settings = {}) {
  const min = Number(settings.priceMin) || 0;
  const max = Number(settings.priceMax) || 0;
  if (min <= 0 && max <= 0) return true;
  const includeExtras = settings.priceMaxIncludesExtras === true;
  const cost = listingCompareCost(listing, { includeExtras });
  if (cost <= 0) return true;
  if (min > 0 && cost < min) return false;
  if (max > 0 && cost > max) return false;
  return true;
}

/**
 * B1：房源端的「租金已包含」判定。
 *
 * 回傳 `{ utilities, management, parking_car, parking_scooter, internet }`，
 * 每個值是 `"present"`（標示已含）／`"absent"`（標示另計）／`"unknown"`（沒有可靠資料）。
 *
 * 兩條原則：
 *   1. **沒有資料一律 unknown，不推定**。
 *   2. 其他站來源常常只寫泛用的「車位／停車」，分不出汽車位或機車位 —— 這種情況
 *      `parking_car` 與 `parking_scooter` 都必須是 unknown；只有明確寫出「汽車位」或
 *      「機車位」才判定。同一項目同時出現「已含」與「另計」時也回 unknown。
 */
/**
 * 費用的**組成項目**。判定「租金含水電」時必須同時看到水與電，不能只看其中一項。
 * `cable`（第四台）故意不屬於任何許願房條件：第四台已含不等於網路已含。
 */
const FEE_COMPONENTS = Object.freeze({
  water: /水費/,
  electricity: /電費/,
  combined_utilities: /水電/,
  management: /管理費|公共基金/,
  parking_car: /汽車位/,
  parking_scooter: /機車位/,
  internet: /網路費|網路|寬頻/,
  cable: /第四台|有線電視/,
});

/** 一個許願房條件由哪些組成項目支撐；全部都涵蓋才算「已含」。 */
const FEE_REQUIREMENTS = Object.freeze({
  utilities: ["water", "electricity"],
  management: ["management"],
  parking_car: ["parking_car"],
  parking_scooter: ["parking_scooter"],
  internet: ["internet"],
});

function explicitFeeIncludes(listing) {
  const raw = listing?.fee_includes;
  if (raw == null || raw === "") return null;
  let parsed = raw;
  if (typeof raw === "string") {
    try { parsed = JSON.parse(raw); } catch { return null; }
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

const FEE_UTILITY_KEYS = new Set(["water", "electricity"]);

function collectFeeSignals(rows) {
  const present = new Set();
  const absent = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = toHalfWidth(String(row?.name || "")).trim();
    if (!name) continue;
    // extraFeeRows 在沒有具名費用時會補一列泛用的「額外費用」，它的 value 只是原文片段：
    // 拿它比對會把原文裡的關鍵字誤判成「該費用已含／另計」，所以整列略過。
    if (name === "額外費用") continue;
    const kind = row?.included === true || String(row?.key || "") === "contain"
      ? present
      : String(row?.key || "") === "extra" ? absent : null;
    if (!kind) continue;
    // name + value 一起比對：parseNamedMonthlyFees 只把命中片段當 name（例如「汽車位費」會被
    // FEE_KIND 截成「車位費」），「汽車位／機車位」的上下文留在 value 裡。
    const blob = `${name} ${toHalfWidth(String(row?.value || ""))}`.trim();
    if (name === "租金含") {
      // `price_contain_text` 會被造出一列 name="租金含"，只代表「已含」，不會是另計。
      for (const [key, re] of Object.entries(FEE_COMPONENTS)) if (re.test(blob)) present.add(key);
      continue;
    }
    for (const [key, re] of Object.entries(FEE_COMPONENTS)) if (re.test(blob)) kind.add(key);
  }
  return { present, absent };
}

function feeStateForRequirement(components, signals, explicit) {
  if (explicit) return explicit;
  const { present, absent } = signals;
  // 「水電」這種合寫直接同時代表水與電。
  const hasPresent = (key) => present.has(key) || (FEE_UTILITY_KEYS.has(key) && present.has("combined_utilities"));
  const hasAbsent = (key) => absent.has(key) || (FEE_UTILITY_KEYS.has(key) && absent.has("combined_utilities"));
  const anyAbsent = components.some(hasAbsent);
  const allPresent = components.every(hasPresent);
  // 只要有一個必要項目明確「另計」，這個要求就不成立（例如水費另計 ⇒ 不是含水電）。
  if (anyAbsent) return "absent";
  if (allPresent) return "present";
  // 只有部分證據（例如只看到「水費已含」）⇒ 不足以推論整項已含。
  return "unknown";
}

export function feeInclusionStates(listing = {}) {
  // 1) 站內刊登自己填的三態（最可靠；未知的 key 才往下找來源資料）
  const explicit = explicitFeeIncludes(listing);
  const explicitStates = {};
  if (explicit) {
    for (const key of Object.keys(FEE_REQUIREMENTS)) {
      const value = explicit[key];
      if (value === 1 || value === true || value === "present" || value === "included") explicitStates[key] = "present";
      else if (value === 0 || value === false || value === "absent" || value === "extra") explicitStates[key] = "absent";
    }
  }
  // 2) 其他站來源：沿用既有費用解析器。**逐項判定，不做過度概括**：
  //    「只有水費已含」不足以說水電已含；「只有第四台已含」不足以說網路已含。
  const signals = collectFeeSignals(extraFeeRows(listing));
  const states = {};
  for (const [key, components] of Object.entries(FEE_REQUIREMENTS)) {
    states[key] = feeStateForRequirement(components, signals, explicitStates[key]);
  }
  return states;
}

export const FEE_INCLUDE_KEYS_FOR_MATCH = Object.freeze(Object.keys(FEE_REQUIREMENTS));

export function feeFieldsFromBlob({ extraFee = 0, extraFeeText = "", containText = "", blob = "" } = {}) {  const listing = {
    extra_fee: extraFee,
    extra_fee_text: extraFeeText,
    price_contain_text: containText,
    extra_fees: [],
    fee_blob: blob,
  };
  const amount = extraMonthlyAmount(listing);
  const rows = extraFeeRows({ ...listing, extra_fee: amount });
  const text =
    String(extraFeeText || "").trim() ||
    (amount > 0 ? `另計約 ${amount.toLocaleString("zh-TW")}元/月` : "");
  return {
    extra_fee: amount,
    extra_fee_text: text,
    price_contain_text: String(containText || "").trim(),
    extra_fees: JSON.stringify(rows),
  };
}
