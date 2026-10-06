/**
 * 許願房「租金已包含」五個獨立條件（B1）。
 *
 * 這一支是純函式島，被 demand.js（儲存）、rentalMatch.js（配對）與 listingCost.js（房源端判定）共用，
 * 目的是讓「許願房端」與「房源端」用同一組 key 與同一則標籤，不會各寫一份而漂移。
 *
 * 儲存格式：`demand_posts.fee_includes` 是 TEXT 欄位。
 *   - `''`（空字串）⇒ 不曾用新制儲存過（未指定，或只有舊的 includes_management）
 *   - `'{"items":[...]}'` ⇒ 用新制儲存過；`{"items":[]}` 是**有效的**「明確全部未指定」
 * 這個區別是舊資料相容的核心：才分得出「沒編輯過」與「編輯過但全部不勾」。
 *
 * 舊欄位 `includes_management`（一個合併布林，標籤寫「水電＋管理費」但欄位名只有管理費）
 * 真正的業務意義無法確定（歷史上也**沒有**參與配對，純顯示），因此**不拆分、不推論**：
 * 只要 fee_includes 非空就用新制，否則才落回舊旗標顯示原字串。
 */

export const FEE_INCLUDE_KEYS = Object.freeze([
  "utilities",
  "management",
  "parking_car",
  "parking_scooter",
  "internet",
]);

export const FEE_INCLUDE_LABELS = Object.freeze({
  utilities: "租金含水電",
  management: "租金含管理費",
  parking_car: "租金含停汽車位",
  parking_scooter: "租金含停機車位",
  internet: "租金含網路",
});

/** 舊合併欄位的顯示字串：只給無法拆分的歷史資料用，不當成新條件的推論來源。 */
export const LEGACY_FEE_INCLUDE_LABEL = "含水電／管理費（舊資料，未拆分）";

const KEY_SET = new Set(FEE_INCLUDE_KEYS);

function uniqueOrderedKeys(input) {
  const raw = Array.isArray(input) ? input : [];
  const out = [];
  for (const item of raw) {
    const key = String(item || "").trim();
    if (KEY_SET.has(key) && !out.includes(key)) out.push(key);
  }
  // 固定排序（不受使用者點選順序影響），讓相同內容產生相同字串，方便比對與測試。
  return FEE_INCLUDE_KEYS.filter((key) => out.includes(key));
}

function itemsFromRaw(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return uniqueOrderedKeys(parsed);
    return uniqueOrderedKeys(parsed?.items);
  } catch {
    // 內容壞掉時當成「未指定」，不要讓一筆壞資料讓整則許願房讀不出來。
    return [];
  }
}

/**
 * 把 API 輸入正規化成儲存字串。
 * - `null` / `undefined` ⇒ 回 `null`，代表「這次沒有要用新制」（呼叫端保留原值）
 * - 陣列（含空陣列）或 JSON 字串 ⇒ 回 `'{"items":[...]}'`
 */
export function normalizeFeeIncludes(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return JSON.stringify({ items: uniqueOrderedKeys(value) });
  if (typeof value === "object") return JSON.stringify({ items: uniqueOrderedKeys(value.items) });
  return JSON.stringify({ items: itemsFromRaw(value) });
}

/**
 * 讀出一列的費用條件狀態。
 * 回傳 `{ state, keys, legacy }`：
 *   - `split`：新制生效，`keys` 是勾選的項目（可能是空陣列）
 *   - `legacy`：只有舊合併布林，無法拆分
 *   - `none`：都沒指定
 * 注意：`split` 一律優先，即使舊旗標還是 1 也不讓它生效（避免新舊同時生效）。
 */
export function parseFeeIncludes(row = {}) {
  const raw = String(row?.fee_includes == null ? "" : row.fee_includes).trim();
  if (raw) return { state: "split", keys: itemsFromRaw(raw), legacy: false };
  if (Number(row?.includes_management) === 1) return { state: "legacy", keys: [], legacy: true };
  return { state: "none", keys: [], legacy: false };
}

export function feeIncludeLabels(keys) {
  const list = Array.isArray(keys) ? keys : [];
  return list.map((key) => FEE_INCLUDE_LABELS[key]).filter(Boolean);
}

/** 給前端顯示用的欄位（許願房詳情／卡片／公開頁共用同一份）。 */
export function publicFeeIncludes(row = {}) {
  const parsed = parseFeeIncludes(row);
  return {
    fee_includes: parsed.keys,
    fee_includes_state: parsed.state,
    fee_includes_labels: feeIncludeLabels(parsed.keys),
    fee_includes_legacy: parsed.legacy,
  };
}
