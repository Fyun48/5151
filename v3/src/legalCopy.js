/** 免責聲明與個資宣告：後台可改，註冊勾選與會員頁沿用同一份。 */

export const DEFAULT_DISCLAIMER_TEXT = `這是免費的個人租屋追蹤工具，用來幫忙看 591 刊登，不是仲介、不是保證、也不是正式服務。

591 上的價格、是否還在、地址與現況可能延遲、缺漏或與現場不符。請以 591 原頁與實際看屋為準。

使用本系統即表示你了解以上限制。贊助是自願的；有沒有贊助都不改變「這是免費系統」。未來若有贊助方案，只會影響檢查間隔或覆蓋範圍，不會變成付費才能用。

超過約兩個月沒有登入，系統會暫停主動向外抓取與通知，以節省資源；你再登入後會自動恢復，不會另外寄信。若長達一年完全沒使用，未來可能停權或刪除帳號（目前仍在評估，尚未執行）。`;

export const DEFAULT_PRIVACY_TEXT =
  "這些欄位只存在你的會員資料，預設不公開、也不會自動出現在刊登。本站依提供服務所需處理，不做專責保管、不轉售、也不主動散給第三人；除非法律要求，或你另外同意公開。可隨時改或清空。請勿填無法承受外洩的機密。";

export const DEFAULT_DISCLAIMER_CHECK =
  "我已閱讀並同意免責聲明：這是免費系統，贊助是自願的。";

export const DEFAULT_PRIVACY_CHECK =
  "我已閱讀並同意個資說明：個人資料只用於本站服務，預設不公開。";

export const DEFAULT_LEGAL_VERSION = "2026-09-04";

const MAX_LONG = 4000;
const MAX_CHECK = 160;

function clip(value, fallback, max) {
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  return text.slice(0, max);
}

export function defaultLegalCopy() {
  return {
    version: DEFAULT_LEGAL_VERSION,
    disclaimer: DEFAULT_DISCLAIMER_TEXT,
    disclaimerCheck: DEFAULT_DISCLAIMER_CHECK,
    privacy: DEFAULT_PRIVACY_TEXT,
    privacyCheck: DEFAULT_PRIVACY_CHECK,
  };
}

export function normalizeLegalCopy(value = {}) {
  const src = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const defaults = defaultLegalCopy();
  return {
    version: clip(src.version, defaults.version, 40) || defaults.version,
    disclaimer: clip(src.disclaimer, defaults.disclaimer, MAX_LONG),
    disclaimerCheck: clip(src.disclaimerCheck, defaults.disclaimerCheck, MAX_CHECK),
    privacy: clip(src.privacy, defaults.privacy, MAX_LONG),
    privacyCheck: clip(src.privacyCheck, defaults.privacyCheck, MAX_CHECK),
  };
}

export function publicLegalCopy(value) {
  const copy = normalizeLegalCopy(value);
  return {
    version: copy.version,
    text: copy.disclaimer,
    disclaimer: copy.disclaimer,
    disclaimerCheck: copy.disclaimerCheck,
    privacy: copy.privacy,
    privacyCheck: copy.privacyCheck,
    privacy_text: copy.privacy,
  };
}
