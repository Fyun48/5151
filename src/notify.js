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

async function postDiscord(webhook, title, lines) {
  if (!webhook) return;
  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: `**${title}**\n${lines.join("\n")}`.slice(0, 1900),
    }),
  });
}

export function eventLabel(type) {
  if (type === "new") return "全新物件";
  if (type === "same_source") return "同屋源更新";
  if (type === "update") return "內容更新";
  return type;
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
    await postDiscord(settings.discordWebhook, title, lines);
  } catch {
    // Discord 失敗不中斷追蹤
  }
}
