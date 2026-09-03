/** 站內／系統推播／Webhook／郵件可獨立勾選的事件列（與設定頁表格列序一致）。 */
export const NOTIFY_CHANNELS = ["dock", "push", "webhook", "mail"];

export const NOTIFY_MATRIX_ROWS = [
  { key: "new", label: "全新物件" },
  { key: "same_source", label: "同屋源重刊" },
  { key: "price", label: "價格變動" },
  { key: "title", label: "標題變更" },
  { key: "update", label: "內容更新" },
  { key: "offline", label: "591 下架" },
  { key: "relist", label: "重新上架" },
];

const CHANNEL_DEFAULTS = { dock: true, push: true, webhook: false, mail: false };

export function defaultNotifyMatrix() {
  const out = {};
  for (const row of NOTIFY_MATRIX_ROWS) {
    out[row.key] = { ...CHANNEL_DEFAULTS };
  }
  return out;
}

export function eventMatrixKey(type) {
  if (type === "price_drop" || type === "price_update") return "price";
  if (type === "title_update") return "title";
  if (type === "new" || type === "same_source" || type === "update" || type === "offline" || type === "relist") {
    return type;
  }
  return "";
}

function cellOn(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return value !== false;
}

/**
 * 正規化勾選表。舊設定沒有 notifyMatrix 時，從 webhookNotify*／notifyNew 等旗標帶過來。
 * 站內與系統推播預設開；郵件／Webhook 為選用，缺格預設關。
 */
export function normalizeNotifyMatrix(settings = {}) {
  const next = defaultNotifyMatrix();
  const incoming = settings.notifyMatrix;
  const hasMatrix = incoming && typeof incoming === "object" && !Array.isArray(incoming);

  if (!hasMatrix) {
    next.new.dock = settings.notifyNew !== false;
    next.new.push = settings.notifyPush !== false;
    next.new.webhook = settings.webhookNotifyNew === true;
    next.same_source.dock = settings.notifySameSource !== false;
    next.price.webhook = settings.webhookNotifyPriceDrop === true;
    next.title.webhook = settings.webhookNotifyTitleUpdate === true;
    return next;
  }

  for (const row of NOTIFY_MATRIX_ROWS) {
    const cell = incoming[row.key];
    if (!cell || typeof cell !== "object") continue;
    next[row.key] = {
      dock: cellOn(cell.dock, CHANNEL_DEFAULTS.dock),
      push: cellOn(cell.push, CHANNEL_DEFAULTS.push),
      webhook: cellOn(cell.webhook, CHANNEL_DEFAULTS.webhook),
      mail: cellOn(cell.mail, CHANNEL_DEFAULTS.mail),
    };
  }
  return next;
}

export function notifyChannelOn(settings, channel, eventType) {
  const key = eventMatrixKey(eventType);
  if (!key || !NOTIFY_CHANNELS.includes(channel)) return false;
  const matrix = normalizeNotifyMatrix(settings);
  return matrix?.[key]?.[channel] === true;
}
