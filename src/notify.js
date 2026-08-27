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
  if (type === "update") return "內容更新";
  return type;
}

function embedColor(type) {
  if (type === "new") return 0x1d4ed8;
  if (type === "same_source") return 0x7c3aed;
  return 0xb45309;
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

export async function notify(settings, events) {
  if (!events.length) return;
  const title = `591 有 ${events.length} 則更新`;
  const lines = events.slice(0, 6).map((event) => {
    return `• [${eventLabel(event.type)}] ${event.title}${event.detail ? `（${event.detail}）` : ""}`;
  });
  if (events.length > 6) lines.push(`…還有 ${events.length - 6} 則`);

  if (settings.windowsToast !== false && process.platform === "win32") {
    toastWindows(title, lines.join("\n").slice(0, 240));
  }
  try {
    await postDiscord(settings.discordWebhook, title, events);
  } catch {
    // Discord 失敗不中斷追蹤
  }
}
