import { execFile } from "node:child_process";

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
  if (type === "price_drop") return "價格調降";
  if (type === "title_update") return "標題更新";
  if (type === "update") return "內容更新";
  return type;
}

function embedColor(type) {
  if (type === "new") return 0x1d4ed8;
  if (type === "same_source") return 0x7c3aed;
  if (type === "price_drop") return 0x15803d;
  if (type === "title_update") return 0xb45309;
  return 0xb45309;
}

export function listingPriceNum(listing) {
  const n = Number(listing?.price_num);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Number(String(listing?.price || "").replace(/[^\d]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function classifyExistingUpdate(incoming, existing) {
  if (!existing) return { type: "seen", detail: "" };
  if (existing.offline) {
    return { type: "same_source", detail: "591 已重新上架" };
  }
  const oldPrice = listingPriceNum(existing);
  const newPrice = listingPriceNum(incoming);
  const priceDropped = oldPrice > 0 && newPrice > 0 && newPrice < oldPrice;
  const priceChanged = Boolean(existing.price && incoming.price && existing.price !== incoming.price);
  const titleChanged = String(existing.title || "") !== String(incoming.title || "");

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
    return { type: "title_update", detail: "標題變更" };
  }
  if (priceChanged) {
    return { type: "update", detail: `價格 ${existing.price} → ${incoming.price}` };
  }
  return { type: "seen", detail: "" };
}

export function listingLastEvent(type, existing) {
  if (type === "seen") return existing?.last_event || "new";
  if (type === "price_drop" || type === "title_update") return "update";
  return type;
}

export function shouldDockNotify(settings, listing, type) {
  if (listing?.hidden || listing?.offline) return false;
  if (listing?.watched && settings.notifyWatchedAlways) return true;
  if (listing?.viewed && !settings.notifyViewed) return false;
  if (type === "new") return Boolean(settings.notifyNew);
  if (type === "same_source" || type === "update" || type === "price_drop" || type === "title_update") {
    return Boolean(settings.notifySameSource);
  }
  return false;
}

export function shouldWebhookNotify(settings, listing, event) {
  if (!String(settings?.discordWebhook || "").trim()) return false;
  if (listing?.hidden || listing?.offline) return false;
  const type = event?.type;
  if (type === "new") return settings.webhookNotifyNew !== false;
  if (type === "price_drop") {
    if (settings.webhookNotifyPriceDrop !== false) return true;
    return String(event.detail || "").includes("標題") && settings.webhookNotifyTitleUpdate !== false;
  }
  if (type === "title_update") return settings.webhookNotifyTitleUpdate !== false;
  return false;
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
    url: event.url,
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
      content: `**${title}**\n點標題可直接開 591。${events.length > 8 ? ` 另有 ${events.length - 8} 則未列出。` : ""}`,
      embeds,
    }),
  });
}

export async function notify(settings, events, { webhookEvents } = {}) {
  const dock = Array.isArray(events) ? events : [];
  const hook = Array.isArray(webhookEvents) ? webhookEvents : [];
  if (!dock.length && !hook.length) return;

  if (dock.length && settings.windowsToast !== false && process.platform === "win32") {
    const title = `591 有 ${dock.length} 則更新`;
    const lines = dock.slice(0, 6).map((event) => {
      return `• [${eventLabel(event.type)}] ${event.title}${event.detail ? `（${event.detail}）` : ""}`;
    });
    if (dock.length > 6) lines.push(`…還有 ${dock.length - 6} 則`);
    toastWindows(title, lines.join("\n").slice(0, 240));
  }
  if (!hook.length) return;
  try {
    await postDiscord(settings.discordWebhook, `591 有 ${hook.length} 則更新`, hook);
  } catch {
    // Discord 失敗不中斷追蹤
  }
}
