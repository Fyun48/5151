/** 同屋源交叉比對與費用變更註記（規則化，不呼叫外部模型）。 */

import { extraMonthlyAmount, listingCompareCost, parseJsonFees, rentAmount } from "./listingCost.js";
import { preferPrimaryListing } from "./match.js";

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

export function compareListingDiffs(mine, other) {
  const fields = [
    ["price", "租金", (row) => String(row.price || formatTwMoney(rentAmount(row)) || "").trim()],
    ["extra", "額外月費", (row) => formatTwMoney(extraMonthlyAmount(row)) || "0"],
    ["total", "總月費", (row) => formatTwMoney(listingCompareCost(row, { includeExtras: true })) || "0"],
    ["fees", "費用說明", feeRowsText],
    ["area", "坪數", (row) => String(row.area_name || "").trim()],
    ["floor", "樓層", (row) => String(row.floor_name || "").trim()],
    ["layout", "格局", (row) => String(row.layout || "").trim()],
    ["title", "標題", (row) => String(row.title || "").trim()],
    ["source", "來源", (row) => String(row.source_label || row.source || "").trim()],
    ["offline", "上架", (row) => (
      Number(row.offline_confirmed) === 1
        ? "確認已下架"
        : Number(row.offline) === 1
          ? "下架確認中"
          : "刊登中"
    )],
  ];
  const diffs = [];
  for (const [field, label, pick] of fields) {
    const a = pick(mine);
    const b = pick(other);
    if (!a && !b) continue;
    if (normFeeText(a) === normFeeText(b)) continue;
    diffs.push({ field, label, mine: a || "—", theirs: b || "—" });
  }
  return diffs;
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
  return notes;
}

export function publicSameHousePeer(row) {
  const snap = listingCostSnapshot(row);
  return {
    post_id: Number(row.post_id),
    title: row.title || "",
    url: row.url || "",
    source: String(row.source || "591") || "591",
    source_label: row.source_label || "",
    price: row.price || "",
    price_num: snap.rent,
    extra_monthly: snap.extra_monthly,
    total: snap.total,
    floor_name: row.floor_name || "",
    area_name: row.area_name || "",
    layout: row.layout || "",
    offline: Number(row.offline) === 1,
    offline_confirmed: Number(row.offline_confirmed) === 1,
    hidden: Number(row.hidden) === 1,
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
  const others = uniq.filter((row) => Number(row.post_id) !== mineId);
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
    peer_count: others.length,
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
