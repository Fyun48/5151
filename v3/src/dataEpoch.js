/** 只有「已有舊 epoch 且與目前不同」才整庫清空。缺 stamp 只補上、不清資料。 */
export const DATA_EPOCH = "wipe-20260831";

export function shouldResetForEpoch(stored, current = DATA_EPOCH) {
  const previous = String(stored || "").trim();
  const next = String(current || "").trim();
  if (!next || !previous) return false;
  return previous !== next;
}
