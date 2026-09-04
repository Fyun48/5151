/** 後台公告／最新消息／贊助提醒：轉頁時安靜出現，可按 X 暫時不看。 */

import { sanitizeHttpUrl } from "./sponsorLinks.js";

export const BROADCAST_KINDS = [
  { id: "announcement", label: "公告", kicker: "公告" },
  { id: "news", label: "最新消息", kicker: "消息" },
  { id: "sponsor", label: "贊助提醒", kicker: "維護" },
];

const MAX_TITLE = 48;
const MAX_BODY = 220;

function emptyKind() {
  return { enabled: false, title: "", body: "", url: "", hops: 3 };
}

export function emptyBroadcasts() {
  const items = {};
  for (const row of BROADCAST_KINDS) items[row.id] = emptyKind();
  return { items };
}

function clean(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function normalizeItem(input = {}) {
  const src = input && typeof input === "object" ? input : {};
  const hops = Math.max(1, Math.min(20, Number(src.hops) || 3));
  const title = clean(src.title, MAX_TITLE);
  const body = clean(src.body, MAX_BODY);
  return {
    enabled: src.enabled === true && Boolean(title || body),
    title,
    body,
    url: sanitizeHttpUrl(src.url),
    hops,
  };
}

export function normalizeBroadcasts(input = {}) {
  const src = input && typeof input === "object" ? input : {};
  const incoming = src.items && typeof src.items === "object" ? src.items : src;
  const items = {};
  for (const row of BROADCAST_KINDS) items[row.id] = normalizeItem(incoming[row.id]);
  return { items };
}

export function publicBroadcasts(input = {}) {
  const cfg = normalizeBroadcasts(input);
  return BROADCAST_KINDS.map((row) => {
    const item = cfg.items[row.id];
    if (!item.enabled) return null;
    return {
      id: row.id,
      kicker: row.kicker,
      title: item.title,
      body: item.body,
      url: item.url,
      hops: item.hops,
    };
  }).filter(Boolean);
}

export function adminBroadcastsView(input = {}) {
  return {
    kinds: BROADCAST_KINDS.map((row) => ({ ...row })),
    config: normalizeBroadcasts(input),
  };
}
