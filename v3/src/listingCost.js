/** 租金與額外月費：辨識已含／另計，押金等一次性費用不列入月租上限。 */

const ONE_TIME =
  /押金|保證金|禮金|仲介費|服務費|開辦費|手續費|鑰匙|訂金|轉租費|違約|一次性|一次繳/;
const INCLUDED =
  /已含|內含|含在租金|租金內含|含於租金|租金已含|包[在於]租金|含在房租|房租已含/;
const EXTRA_HINT = /另計|另付|另繳|另租|另收|外加|不含|未含|須另|需另|須加|需加|額外|另外支付|另外計/;
const FEE_KIND =
  /管理費|清潔費|停車費|車位費|車位|停車|水費|電費|瓦斯費|瓦斯|網路費|網路|第四台|垃圾費|垃圾代收|公共基金|修繕費/;

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
  if (Number.isFinite(n) && n > 0) return Math.round(n);
  const parsed = parseTwdAmount(listing.price);
  return parsed > 0 ? parsed : 0;
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

export function feeFieldsFromBlob({ extraFee = 0, extraFeeText = "", containText = "", blob = "" } = {}) {
  const listing = {
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
