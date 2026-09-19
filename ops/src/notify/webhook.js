// OPS 對外通知：通用 webhook（Discord / Slack incoming / 自訂 JSON）。
// 未設定 URL → 不送、不假造送達。Payload 只含 metadata，不帶聯絡人／user_ref。

export function notifyConfig(env = process.env) {
  const url = String(env.OPS_NOTIFY_WEBHOOK_URL || "").trim();
  return {
    configured: /^https:\/\//i.test(url),
    url,
    timeoutMs: Number(env.OPS_NOTIFY_TIMEOUT_MS || 8000),
    onIngest: env.OPS_NOTIFY_ON_INGEST === "1",
    channel: detectChannel(url),
  };
}

export function detectChannel(url) {
  const u = String(url || "").toLowerCase();
  if (u.includes("discord.com/api/webhooks") || u.includes("discordapp.com/api/webhooks")) return "discord";
  if (u.includes("hooks.slack.com")) return "slack";
  return "generic";
}

export function buildWebhookPayload({ event, title, text, fields = [], channel = "generic" } = {}) {
  const safeFields = (Array.isArray(fields) ? fields : []).map((f) => ({
    name: String(f.name || "field").slice(0, 80),
    value: String(f.value == null ? "" : f.value).slice(0, 500),
  }));
  const body = {
    source: "5151-ops",
    event: String(event || "ops.event"),
    title: String(title || "OPS 通知").slice(0, 160),
    text: String(text || "").slice(0, 1800),
    fields: safeFields,
  };
  if (channel === "discord") {
    return {
      content: body.title,
      embeds: [{
        title: body.title,
        description: body.text || undefined,
        color: 0x2f6f4f,
        fields: safeFields.map((f) => ({ name: f.name, value: f.value || "—", inline: true })),
        footer: { text: "5151 OPS" },
      }],
    };
  }
  if (channel === "slack") {
    const lines = [body.title, body.text, ...safeFields.map((f) => `• ${f.name}: ${f.value}`)].filter(Boolean);
    return { text: lines.join("\n") };
  }
  return body;
}

export async function deliverWebhook(url, payload, { timeoutMs = 8000, fetchImpl = fetch } = {}) {
  if (!url || !/^https:\/\//i.test(url)) {
    return { ok: false, reason: "no_adapter_configured" };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(500, Number(timeoutMs) || 8000));
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    return { ok: true, status: res.status };
  } catch (err) {
    const reason = err?.name === "AbortError" ? "timeout" : "network_error";
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

export async function sendOpsNotification({
  event,
  title,
  text,
  fields,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  const cfg = notifyConfig(env);
  if (!cfg.configured) return { ok: false, reason: "no_adapter_configured" };
  const payload = buildWebhookPayload({ event, title, text, fields, channel: cfg.channel });
  return deliverWebhook(cfg.url, payload, { timeoutMs: cfg.timeoutMs, fetchImpl });
}
