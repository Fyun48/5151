/** 同屋源「不是同一間」投票：先個人生效，多人同意才改全站。 */

export const MATCH_SPLIT_DAILY_LIMIT = 8;

export function votePair(a, b) {
  const left = Number(a) || 0;
  const right = Number(b) || 0;
  return left <= right ? [left, right] : [right, left];
}

export function votePairKey(a, b) {
  const [lo, hi] = votePair(a, b);
  return `${lo}:${hi}`;
}

export function pairConfidence(...rows) {
  const levels = rows.map((row) => String(row?.match_level || row?.confidence || ""));
  if (levels.includes("high")) return "high";
  if (levels.includes("medium")) return "medium";
  return "low";
}

/** 全站拆開門檻：高信心要 3 人，其餘 2 人；反對票多過拆開就不升級。 */
export function shouldPromoteGlobalSplit({ split = 0, same = 0, keep = 0, confidence = "" } = {}) {
  const against = Math.max(Number(same) || 0, Number(keep) || 0);
  const yes = Number(split) || 0;
  if (yes <= 0 || against >= yes) return false;
  return String(confidence || "") === "high" ? yes >= 3 : yes >= 2;
}
