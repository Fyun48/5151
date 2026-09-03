/** 取消關注時不要清掉備註，再次加入特別關注才能恢復原文。 */
export function nextWatchNote(listing, flags = {}) {
  const turningOff = flags.watched === false || flags.watched === 0;
  if (flags.watch_note === undefined) return String(listing?.watch_note || "");
  const text = String(flags.watch_note || "").replace(/\r/g, "").trim().slice(0, 300);
  if (turningOff && !text) return String(listing?.watch_note || "");
  return text;
}
