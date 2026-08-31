import { execFile } from "node:child_process";
import { passesDisplayFilters } from "./floors.js";
import { notifyChannelOn } from "./notifyMatrix.js";
import { trackedListingUrl } from "./openLink.js";

function toastWindows(title, body) {
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.Visible = $true
$n.BalloonTipTitle = ${JSON.stringify(title)}
$n.BalloonTipText = ${JSON.stringify(body)}
$n.ShowBalloonTip(8000)
Start-Sleep -Milliseconds 8500
$n.Dispose()
`;
  execFile(
    "powershell.exe",
    ["-NoProfile", "-STA", "-Command", script],
    { windowsHide: true },
    () => {},
  );
}

export function eventLabel(type) {
  if (type === "new") return "全新物件";
  if (type === "same_source") return "同屋源更新";
  if (type === "relist") return "重新上架";
  if (type === "offline") return "591 已下架";
  if (type === "price_drop") return "價格調降";
  if (type === "price_update") return "價格變更";
  if (type === "title_update") return "標題更新";
  if (type === "update") return "內容更新";
  return type;
}

function embedColor(type) {
  if (type === "new") return 0x1d4ed8;
  if (type === "relist") return 0x0369a1;
  if (type === "offline") return 0x475569;
  if (type === "same_source") return 0x7c3aed;
  if (type === "price_drop") return 0x15803d;
  if (type === "price_update") return 0x15803d;
  if (type === "title_update") return 0xb45309;
  return 0xb45309;
}

export function listingPriceNum(listing) {
  const n = Number(listing?.price_num);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Number(String(listing?.price || "").replace(/[^\d]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normText(value) {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .replace(/,/g, "")
    .trim();
}

function sameishAddress(a, b) {
  const left = normText(a);
  const right = normText(b);
  if (!left && !right) return true;
  if (!left || !right) return false;
  if (left === right) return true;
  // 詳情／社區補齊後地址常比列表長，或互有前後綴，不當成內容變更
  return left.includes(right) || right.includes(left);
}

function sameishArea(a, b) {
  const left = normText(a).replace(/坪/g, "");
  const right = normText(b).replace(/坪/g, "");
  if (left === right) return true;
  const na = Number(left);
  const nb = Number(right);
  return Number.isFinite(na) && Number.isFinite(nb) && Math.abs(na - nb) < 0.05;
}

function sameishFloor(a, b) {
  const left = normText(a).replace(/樓/g, "F").toUpperCase();
  const right = normText(b).replace(/樓/g, "F").toUpperCase();
  return left === right;
}

function contentDiff(incoming, existing) {
  const fields = [
    ["layout", "格局"],
    ["floor_name", "樓層"],
    ["area_name", "坪數"],
    ["address", "地址"],
    ["kind_name", "類型"],
  ];
  const bits = [];
  for (const [key, label] of fields) {
    const a = String(existing?.[key] || "").trim();
    const b = String(incoming?.[key] || "").trim();
    // 列表偶發空白、詳情較完整 → 不算變更
    if (!normText(b) && normText(a)) continue;
    if (key === "address" && sameishAddress(a, b)) continue;
    if (key === "area_name" && sameishArea(a, b)) continue;
    if (key === "floor_name" && sameishFloor(a, b)) continue;
    if (key === "layout" && normText(a) === normText(b)) continue;
    if (key === "kind_name" && normText(a) === normText(b)) continue;
    if (normText(a) === normText(b)) continue;
    bits.push(`${label} ${a || "—"} → ${b || "—"}`);
  }
  return bits;
}

export function classifyExistingUpdate(incoming, existing) {
  if (!existing) return { type: "seen", detail: "" };
  if (existing.offline && !existing.offline_confirmed) {
    return { type: "relist", detail: "591 已重新上架（尚未確認下架前）" };
  }
  const oldPrice = listingPriceNum(existing);
  const newPrice = listingPriceNum(incoming);
  const priceDropped = oldPrice > 0 && newPrice > 0 && newPrice < oldPrice;
  const priceRaised = oldPrice > 0 && newPrice > 0 && newPrice > oldPrice;
  const priceChanged = Boolean(existing.price && incoming.price && existing.price !== incoming.price);
  const titleChanged = normText(existing.title) !== normText(incoming.title);
  const extras = contentDiff(incoming, existing);

  if (priceDropped && titleChanged) {
    return { type: "price_drop", detail: `價格 ${existing.price} → ${incoming.price}；標題變更` };
  }
  if (priceDropped) {
    return { type: "price_drop", detail: `價格 ${existing.price} → ${incoming.price}` };
  }
  if (titleChanged && priceChanged) {
    return { type: "title_update", detail: `標題變更；價格 ${existing.price} → ${incoming.price}` };
  }
  if (titleChanged) {
    return { type: "title_update", detail: `標題：${existing.title} → ${incoming.title}` };
  }
  if (priceRaised) {
    return { type: "price_update", detail: `價格 ${existing.price} → ${incoming.price}` };
  }
  if (priceChanged) {
    return { type: "price_update", detail: `價格 ${existing.price} → ${incoming.price}` };
  }
  if (extras.length) {
    return { type: "update", detail: extras.join("；") };
  }
  return { type: "seen", detail: "" };
}

export function listingLastEvent(type, existing) {
  if (type === "seen") return existing?.last_event || "new";
  if (type === "price_drop" || type === "price_update" || type === "title_update") return "update";
  if (type === "relist") return "same_source";
  if (type === "offline") return "offline";
  return type;
}

/** 浮動視窗與 webhook 共用：全新物件一律通知；同屋源重刊不通知（除非已特別關注）；特別關注才通知變更／下架／重新上架。 */
export function isWatchedListing(listing) {
  return Number(listing?.watched) === 1;
}

export function shouldNotify(settings, listing, event) {
  if (listing?.hidden || Number(listing?.hidden) === 1) return false;
  // 與列表「整層／排除 1F」勾選一致，避免通知出現已排除樓層
  if (!passesDisplayFilters(listing, settings)) return false;
  const type = event?.type;
  const watched = isWatchedListing(listing);
  // 房仲刪掉重刊會變成新 post_id；已判成同屋源時不要當「全新物件」吵
  if (type === "same_source") return watched;
  if (type === "new") return true;
  // 內容／價格／標題更新：只有特別關注才通知
  if (type === "price_drop" || type === "price_update" || type === "title_update" || type === "update") {
    return watched;
  }
  if (!watched) return false;
  if (type === "offline" || type === "relist") return true;
  if (listing?.offline || Number(listing?.offline) === 1) return false;
  return false;
}

export function shouldDockNotify(settings, listing, event) {
  return shouldNotify(settings, listing, event) && notifyChannelOn(settings, "dock", event?.type);
}

export function shouldWebhookNotify(settings, listing, event) {
  if (!String(settings?.discordWebhook || "").trim()) return false;
  return shouldNotify(settings, listing, event) && notifyChannelOn(settings, "webhook", event?.type);
}

function formatFeeLine(event) {
  let rows = event.extra_fees;
  if (typeof rows === "string") {
    try {
      rows = JSON.parse(rows);
    } catch {
      rows = [];
    }
  }
  const bits = (Array.isArray(rows) ? rows : [])
    .filter((row) => row?.value && row.value !== "--")
    .map((row) => `${row.name} ${row.value}`.trim());
  if (bits.length) return bits.join(" · ");
  return String(event.extra_fee_text || "").replace(/[()（）]/g, "").trim();
}

async function postDiscord(webhook, title, events) {
  if (!webhook) return;
  const embeds = events.slice(0, 8).map((event) => ({
    title: String(event.title || "591 物件").slice(0, 250),
    url: trackedListingUrl(event.post_id, event.url),
    color: embedColor(event.type),
    description: [
      `**${eventLabel(event.type)}**${event.detail ? ` · ${event.detail}` : ""}`,
      event.price ? `${event.price} 元/月` : "",
      formatFeeLine(event),
      [event.address, event.layout, event.floor_name, event.kind_name].filter(Boolean).join(" · "),
    ]
      .filter(Boolean)
      .join("\n")
      .slice(0, 1000),
  }));
  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: `**${title}**\n點標題會先記成已瀏覽再打開 591。${events.length > 8 ? ` 另有 ${events.length - 8} 則未列出。` : ""}`,
      embeds,
    }),
  });
}

export async function notify(settings, events, { webhookEvents } = {}) {
  const dock = Array.isArray(events) ? events : [];
  const hook = Array.isArray(webhookEvents) ? webhookEvents : [];
  if (!dock.length && !hook.length) return;
  if (!hook.length) return;
  try {
    await postDiscord(settings.discordWebhook, `591 有 ${hook.length} 則更新`, hook);
  } catch {
    // Discord 失敗不中斷追蹤
  }
}
