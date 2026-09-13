/** 同屋源交叉比對與費用變更註記（規則化，不呼叫外部模型）。 */

import { decodeEntities } from "./htmlEntities.js";
import { extraMonthlyAmount, listingCompareCost, parseJsonFees, rentAmount } from "./listingCost.js";
import { preferPrimaryListing, sortGroupListings } from "./match.js";
import { formatFloorDisplay } from "./floors.js";

function normFeeText(value) {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .replace(/[()（），,]/g, "")
    .replace(/元\/月|元/g, "")
    .toLowerCase();
}

function feeRowsText(listing) {
  const rows = parseJsonFees(listing?.extra_fees)
    .filter((row) => row?.value && row.value !== "--")
    .map((row) => `${row.name || ""} ${row.value}`.replace(/\s+/g, " ").trim());
  if (rows.length) return rows.join("、");
  return String(listing?.extra_fee_text || listing?.price_contain_text || "").trim();
}

export function feeSignature(listing) {
  const rows = parseJsonFees(listing?.extra_fees)
    .map((row) => `${normFeeText(row.name)}:${normFeeText(row.value)}:${Number(row.amount) || 0}`)
    .sort()
    .join(";");
  return [
    rentAmount(listing) || 0,
    Number(listing?.extra_fee) || 0,
    extraMonthlyAmount(listing) || 0,
    rows,
    normFeeText(listing?.extra_fee_text),
    normFeeText(listing?.price_contain_text),
  ].join("|");
}

export function incomingHasFeePayload(listing) {
  if (Number(listing?.extra_fee) > 0) return true;
  if (String(listing?.extra_fee_text || "").trim()) return true;
  if (String(listing?.price_contain_text || "").trim()) return true;
  return parseJsonFees(listing?.extra_fees).length > 0;
}

export function feeFieldsChanged(incoming, existing) {
  if (!incoming || !existing) return false;
  if (!incomingHasFeePayload(incoming)) return false;
  return feeSignature(incoming) !== feeSignature(existing);
}

export function isCostChangeType(type) {
  return type === "price_drop" || type === "price_update" || type === "fee_update";
}

export function formatTwMoney(n) {
  const num = Number(n);
  if (!Number.isFinite(num) || num <= 0) return "";
  return num.toLocaleString("zh-TW");
}

export function costChangeLabel(type) {
  if (type === "price_drop") return "租金調降";
  if (type === "price_update") return "租金變更";
  if (type === "fee_update") return "費用變更";
  return "費用變更";
}

export function listingCostSnapshot(listing) {
  const rent = rentAmount(listing);
  const extra = extraMonthlyAmount(listing);
  return {
    rent,
    extra_monthly: extra,
    total: rent > 0 ? rent + extra : 0,
    price: listing?.price || "",
  };
}

export function feeChangeDetail(existing, incoming) {
  const bits = [];
  const oldRent = rentAmount(existing);
  const newRent = rentAmount(incoming);
  if (oldRent && newRent && oldRent !== newRent) {
    bits.push(`租金 ${existing.price || formatTwMoney(oldRent) || oldRent} → ${incoming.price || formatTwMoney(newRent) || newRent}`);
  }
  const oldExtra = extraMonthlyAmount(existing);
  const newExtra = extraMonthlyAmount(incoming);
  if (oldExtra !== newExtra) {
    bits.push(`額外月費 ${formatTwMoney(oldExtra) || 0} → ${formatTwMoney(newExtra) || 0}`);
  }
  const oldText = feeRowsText(existing);
  const newText = feeRowsText(incoming);
  if (normFeeText(oldText) !== normFeeText(newText) && (oldText || newText)) {
    bits.push(`費用說明 ${oldText || "—"} → ${newText || "—"}`);
  }
  return bits.join("；") || "服務費或其它費用有改";
}

function namedFee(listing, needles) {
  const rows = parseJsonFees(listing?.extra_fees);
  for (const row of rows) {
    const name = normFeeText(row.name);
    if (needles.some((needle) => name.includes(needle))) {
      return String(row.value || formatTwMoney(row.amount) || "").trim();
    }
  }
  const blob = `${listing?.extra_fee_text || ""} ${listing?.price_contain_text || ""}`;
  const blobNeedles = needles.filter((needle) => needle.length >= 2 && !["水", "電"].includes(needle));
  if (blobNeedles.some((needle) => normFeeText(blob).includes(needle))) {
    return String(blob).trim();
  }
  return "";
}

function hay(listing) {
  return `${listing?.title || ""} ${listing?.kind_name || ""} ${listing?.tags || ""} ${listing?.self_body || ""}`;
}

function yesNoFromHay(listing, yesRe, noRe) {
  const text = hay(listing);
  if (noRe.test(text)) return "否";
  if (yesRe.test(text)) return "是";
  return "";
}

function furnishText(listing) {
  const items = Array.isArray(listing?.furnish_items)
    ? listing.furnish_items
    : (() => {
      try { return JSON.parse(listing?.furnish_items || "[]"); } catch { return []; }
    })();
  return (items || []).filter(Boolean).join("、");
}

const COMPARE_FIELDS = [
  ["price", "租金", (row) => String(row.price || formatTwMoney(rentAmount(row)) || "").trim()],
  ["extra", "額外月費", (row) => formatTwMoney(extraMonthlyAmount(row)) || "0"],
  ["total", "總月費", (row) => formatTwMoney(listingCompareCost(row, { includeExtras: true })) || "0"],
  ["fees", "費用說明", feeRowsText],
  ["deposit", "押金", (row) => namedFee(row, ["押金"])],
  ["agency", "仲介／服務費", (row) => namedFee(row, ["仲介", "服務費", "服務費"])],
  ["mgmt", "管理費", (row) => namedFee(row, ["管理費"])],
  ["water", "水費", (row) => namedFee(row, ["水費", "水"])],
  ["electric", "電費", (row) => namedFee(row, ["電費", "電"])],
  ["internet", "網路費", (row) => namedFee(row, ["網路", "寬頻"])],
  ["parking_fee", "車位費", (row) => namedFee(row, ["車位費", "停車費"])],
  ["pet", "可否寵物", (row) => yesNoFromHay(row, /可寵物|寵物友善/, /不可寵物|禁寵|不准寵物/)],
  ["cook", "可否開伙", (row) => yesNoFromHay(row, /可開伙|開伙/, /不可開伙|禁開伙|不准開伙/)],
  ["elevator", "電梯", (row) => yesNoFromHay(row, /有電梯|電梯大樓|電梯公寓/, /無電梯|沒有電梯/)],
  ["gas", "天然瓦斯", (row) => (
    Number(row.has_natural_gas) === 1 ? "有" : yesNoFromHay(row, /天然瓦斯/, /無瓦斯|沒有瓦斯/)
  )],
  ["balcony", "陽台", (row) => (
    Number(row.has_balcony) === 1 ? "有" : yesNoFromHay(row, /有陽台/, /無陽台|沒有陽台/)
  )],
  ["furnish", "家具設備", furnishText],
  ["restriction", "入住限制", (row) => String(row.move_in_limit || row.restriction || "").trim()],
  ["subsidy", "租補", (row) => yesNoFromHay(row, /可租補|符合租補/, /不適用租補/)],
  ["available", "可入住日", (row) => String(row.available_date || row.move_in_date || "").trim()],
  ["role", "房東／仲介角色", (row) => String(row.role_name || row.contact_role || "").trim()],
  ["source_note", "來源特殊備註", (row) => String(row.source_note || "").trim()],
  ["area", "坪數", (row) => String(row.area_name || "").trim()],
  ["floor", "樓層", (row) => formatFloorDisplay(row.floor_name)],
  ["layout", "格局", (row) => String(row.layout || "").trim()],
  ["title", "標題", (row) => String(row.title || "").trim()],
  ["source", "來源", (row) => String(row.source_label || row.source || "").trim()],
  ["offline", "物件狀態", (row) => (
    Number(row.offline_confirmed) === 1
      ? "確認已下架"
      : Number(row.offline) === 1
        ? "下架確認中"
        : "刊登中"
  )],
];

export const SOURCE_CONFLICT_NOTE = "不同來源資訊不一致";

export function compareListingDiffs(mine, other) {
  const diffs = [];
  for (const [field, label, pick] of COMPARE_FIELDS) {
    const a = pick(mine);
    const b = pick(other);
    if (!a && !b) continue;
    if (normFeeText(a) === normFeeText(b)) continue;
    diffs.push({ field, label, mine: a || "—", theirs: b || "—" });
  }
  return diffs;
}

function sourceName(row) {
  return String(row?.source_label || row?.source || "").trim() || `#${row?.post_id || ""}`;
}

export function compareHouseHeadline(listings = []) {
  const group = (listings || []).filter(Boolean).slice(0, 3);
  if (group.length < 2) return "";
  const snaps = group.map((row) => ({
    row,
    snap: listingCostSnapshot(row),
    src: sourceName(row),
  }));
  const priced = snaps.filter((item) => item.snap.total > 0);
  const bits = [];
  if (priced.length >= 2) {
    const cheap = priced.reduce((best, item) => (item.snap.total < best.snap.total ? item : best));
    const dear = priced.reduce((best, item) => (item.snap.total > best.snap.total ? item : best));
    const gap = dear.snap.total - cheap.snap.total;
    if (gap > 0) {
      bits.push(`總月費差 ${formatTwMoney(gap)} 元，${cheap.src}最便宜、${dear.src}最貴`);
    }
  }
  const extras = snaps.filter((item) => item.snap.extra_monthly > 0);
  if (extras.length && extras.length < snaps.length) {
    bits.push(`${extras.map((item) => item.src).join("、")}另有額外月費`);
  } else if (new Set(extras.map((item) => item.snap.extra_monthly)).size > 1) {
    bits.push("額外月費不同");
  }
  const rents = priced.map((item) => item.snap.rent).filter((n) => n > 0);
  if (rents.length >= 2 && new Set(rents).size === 1 && extras.length) {
    bits.push("租金相同，差在額外月費");
  }
  if (!bits.length) {
    const sources = [...new Set(snaps.map((item) => item.src))];
    if (sources.length >= 2) bits.push(`來源：${sources.join("、")}`);
  }
  const prefix = `${group.length} 則屋源`;
  return bits.length ? `${prefix}：${bits.join("；")}` : `${prefix}，標價與條件幾乎相同`;
}

/** 最多 3 筆：只列有差異的欄，並給一句重點。 */
export function compareHouseGroup(listings = []) {
  const uniq = [];
  const seen = new Set();
  for (const row of listings || []) {
    const id = Number(row?.post_id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    uniq.push(row);
  }
  if (uniq.length < 2) return null;
  const primary = uniq.reduce((best, row) => preferPrimaryListing(best, row), uniq[0]);
  const others = uniq
    .filter((row) => Number(row.post_id) !== Number(primary.post_id))
    .sort((a, b) => listingCompareCost(b, { includeExtras: true }) - listingCompareCost(a, { includeExtras: true }));
  const group = [primary, ...others].slice(0, 3);
  const labels = group.map((row) => sourceName(row));
  const rows = [];
  for (const [field, label, pick] of COMPARE_FIELDS) {
    const values = group.map((row) => String(pick(row) || "").trim());
    const norms = values.map((value) => normFeeText(value) || "—");
    if (new Set(norms).size <= 1) continue;
    rows.push({
      field,
      label,
      values: values.map((value) => value || "—"),
      conflict: true,
      note: SOURCE_CONFLICT_NOTE,
    });
  }
  return {
    headline: compareHouseHeadline(group),
    count: group.length,
    labels,
    ids: group.map((row) => Number(row.post_id)),
    rows,
  };
}

export function compareListingNotes(mine, other) {
  const notes = [];
  const a = listingCostSnapshot(mine);
  const b = listingCostSnapshot(other);
  if (a.total > 0 && b.total > 0 && a.total !== b.total) {
    const gap = a.total - b.total;
    if (gap > 0) {
      notes.push(`這則總月費 ${formatTwMoney(a.total)}，另一則 ${formatTwMoney(b.total)}，貴 ${formatTwMoney(gap)}`);
    } else {
      notes.push(`這則總月費 ${formatTwMoney(a.total)}，比另一則便宜 ${formatTwMoney(-gap)}`);
    }
  }
  if (a.rent > 0 && b.rent > 0 && a.rent === b.rent && a.extra !== b.extra) {
    notes.push(`租金相同，但這則額外月費 ${formatTwMoney(a.extra) || 0}，另一則 ${formatTwMoney(b.extra) || 0}`);
  }
  if (Number(mine.offline) === 1 && Number(other.offline) !== 1) {
    notes.push("這則已下架或確認中，打這支可能空號；另一則仍在刊登");
  }
  if (Number(mine.offline) !== 1 && Number(other.offline) === 1) {
    notes.push("另一則已下架，這則仍可聯絡");
  }
  const srcA = String(mine.source || "");
  const srcB = String(other.source || "");
  if (srcA && srcB && srcA !== srcB) {
    notes.push(`來源不同：這則在${mine.source_label || srcA}，另一則在${other.source_label || srcB}`);
  }
  const extraDiffs = compareListingDiffs(mine, other).filter((row) => !["price", "extra", "total", "title", "source", "offline"].includes(row.field));
  if (extraDiffs.length) {
    notes.push(SOURCE_CONFLICT_NOTE);
  }
  return notes;
}

export function publicSameHousePeer(row) {
  const snap = listingCostSnapshot(row);
  return {
    post_id: Number(row.post_id),
    title: decodeEntities(row.title || ""),
    url: row.url || "",
    source: String(row.source || "591") || "591",
    source_label: row.source_label || "",
    price: row.price || "",
    price_num: snap.rent,
    extra_monthly: snap.extra_monthly,
    total: snap.total,
    fee_text: feeRowsText(row),
    floor_name: row.floor_name || "",
    area_name: row.area_name || "",
    layout: row.layout || "",
    offline: Number(row.offline) === 1,
    offline_confirmed: Number(row.offline_confirmed) === 1,
    hidden: Number(row.hidden) === 1,
    refresh_time: row.refresh_time || "",
    last_seen_at: row.last_seen_at || "",
    match_verdict: row.match_verdict || "",
    match_level: row.match_level || "",
    cost_changed_at: row.cost_changed_at || "",
    cost_change_detail: row.cost_change_detail || "",
    cost_change_type: row.cost_change_type || "",
  };
}

export function sameHouseBundle(listing, peers = []) {
  const group = [listing, ...peers].filter(Boolean);
  const uniq = [];
  const seen = new Set();
  for (const row of group) {
    const id = Number(row.post_id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    uniq.push(row);
  }
  if (uniq.length < 2) return null;
  const confirmed = uniq.some((row) => (
    row.match_verdict === "yes" || /已確認同一間/.test(String(row.match_detail || ""))
  ));
  const primary = uniq.reduce((best, row) => preferPrimaryListing(best, row), uniq[0]);
  const primaryId = Number(primary.post_id);
  const mineId = Number(listing.post_id);
  const ordered = sortGroupListings(uniq);
  const visibleIds = new Set(ordered.slice(0, 3).map((row) => Number(row.post_id)));
  const others = ordered
    .filter((row) => Number(row.post_id) !== mineId && visibleIds.has(Number(row.post_id)))
    .slice(0, 2);
  const collapsed = ordered
    .filter((row) => !visibleIds.has(Number(row.post_id)))
    .map((row) => ({
      post_id: Number(row.post_id),
      title: decodeEntities(row.title || ""),
      source: String(row.source || "591"),
      source_label: row.source_label || "",
      url: row.url || "",
    }));
  const mineSnap = listingCostSnapshot(listing);
  const primarySnap = listingCostSnapshot(primary);
  const cheaperGap = mineSnap.total > 0 && primarySnap.total > 0 ? mineSnap.total - primarySnap.total : 0;
  const bundle = {
    status: confirmed ? "confirmed" : "suspected",
    is_primary: mineId === primaryId,
    primary_id: primaryId,
    cheaper_exists: cheaperGap > 0,
    cheaper_gap: cheaperGap > 0 ? cheaperGap : 0,
    mine_total: mineSnap.total,
    primary_total: primarySnap.total,
    peer_count: Math.max(0, uniq.length - 1),
    hidden_count: collapsed.length,
    fold_label: collapsed.length ? `另有 ${collapsed.length} 筆同物件來源` : "",
    collapsed,
    compare: compareHouseGroup([listing, ...others]),
    peers: others.map((row) => {
      const pub = publicSameHousePeer(row);
      return {
        ...pub,
        role: Number(row.post_id) === primaryId ? "primary" : "affiliate",
        diffs: compareListingDiffs(row, listing),
        notes: compareListingNotes(row, listing),
      };
    }),
  };
  return bundle;
}

export function costChangePayload(row) {
  const at = row?.cost_changed_at || "";
  const type = row?.cost_change_type || "";
  const detail = row?.cost_change_detail || "";
  if (!at && !type && !detail) return null;
  return { at, type, detail };
}
