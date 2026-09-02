import { APP_NAME } from "./brand.js";

/** 全站 SMTP 與信件樣板：管理員後台可改，寫入 settings 與 auth.env。 */

export const SMTP_ENV_KEYS = [
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_USER",
  "SMTP_PASS",
  "SMTP_FROM",
  "SMTP_FROM_NAME",
  "SMTP_SECURE",
];

export function defaultMailTemplates() {
  return {
    forgot_password: {
      subject: `${APP_NAME}：你的臨時密碼`,
      text: `你好，

有人用這個信箱申請 ${APP_NAME} 的臨時密碼。

臨時密碼：
{{tempPassword}}

請用這組密碼登入。它會取代原本的密碼。若要再換，可到登入頁再申請一次忘記密碼。

若你沒有申請，也請立刻用這組密碼登入，並再申請一組新的臨時密碼。

——${APP_NAME}
`,
    },
    listing_notify: {
      subject: `${APP_NAME}：{{event}} {{title}}`,
      text: `{{event}}

{{title}}
{{price}}
{{facts}}

{{url}}

——${APP_NAME}
`,
    },
  };
}

export function renderMailTemplate(template, vars = {}) {
  const replace = (value) => String(value || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const next = vars[key];
    return next == null ? "" : String(next);
  });
  return {
    subject: replace(template?.subject).trim().slice(0, 180),
    text: replace(template?.text),
  };
}

export function normalizeMailTemplates(input) {
  const defaults = defaultMailTemplates();
  const src = input && typeof input === "object" ? input : {};
  const out = {};
  for (const key of Object.keys(defaults)) {
    const row = src[key] && typeof src[key] === "object" ? src[key] : {};
    const subject = String(row.subject || defaults[key].subject).trim().slice(0, 180);
    const text = String(row.text || defaults[key].text).slice(0, 8000);
    out[key] = {
      subject: subject || defaults[key].subject,
      text: text || defaults[key].text,
    };
  }
  return out;
}

export function normalizeSmtp(input = {}, previous = {}) {
  const src = input && typeof input === "object" ? input : {};
  const prev = previous && typeof previous === "object" ? previous : {};
  const host = String(src.host ?? prev.host ?? "").trim().slice(0, 200);
  const port = Math.max(1, Math.min(Math.round(Number(src.port ?? prev.port) || 587), 65535));
  const user = String(src.user ?? prev.user ?? "").trim().slice(0, 200);
  const submitted = String(src.pass ?? "");
  const keepPrevious = !submitted || submitted === "(unchanged)";
  const pass = keepPrevious ? String(prev.pass || "") : submitted.slice(0, 400);
  const from = String(src.from ?? prev.from ?? "").trim().slice(0, 200);
  const fromName = String(src.fromName ?? prev.fromName ?? APP_NAME).trim().slice(0, 80) || APP_NAME;
  const secureFlag = src.secure;
  const secure = secureFlag === true || secureFlag === "1" || String(secureFlag).toLowerCase() === "true" || port === 465;
  return { host, port, user, pass, from, fromName, secure };
}

export function publicSmtp(config) {
  const row = config && typeof config === "object" ? config : {};
  return {
    host: String(row.host || ""),
    port: Number(row.port) || 587,
    user: String(row.user || ""),
    passSet: Boolean(String(row.pass || "")),
    from: String(row.from || ""),
    fromName: String(row.fromName || APP_NAME),
    secure: Boolean(row.secure),
  };
}

export function smtpToEnv(config) {
  const row = normalizeSmtp(config);
  return {
    SMTP_HOST: row.host,
    SMTP_PORT: String(row.port || 587),
    SMTP_USER: row.user,
    SMTP_PASS: row.pass,
    SMTP_FROM: row.from,
    SMTP_FROM_NAME: row.fromName,
    SMTP_SECURE: row.secure ? "1" : "0",
  };
}

export function applySmtpEnv(config) {
  const env = smtpToEnv(config);
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value;
  }
  return env;
}

export function smtpFromEnv(env = process.env) {
  const host = String(env.SMTP_HOST || "").trim();
  const from = String(env.SMTP_FROM || env.SMTP_USER || "").trim();
  const port = Number(env.SMTP_PORT || 587) || 587;
  const secureFlag = String(env.SMTP_SECURE || "").trim();
  return normalizeSmtp({
    host,
    port,
    user: String(env.SMTP_USER || "").trim(),
    pass: String(env.SMTP_PASS || ""),
    from,
    fromName: String(env.SMTP_FROM_NAME || APP_NAME).trim(),
    secure: secureFlag === "1" || secureFlag.toLowerCase() === "true" || port === 465,
  });
}

export function parseEnvFileText(text) {
  const out = {};
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export function encodeEnvValue(value) {
  const text = String(value ?? "");
  if (!text) return "";
  if (/[\s#"'=]/.test(text)) return JSON.stringify(text);
  return text;
}

export function serializeEnvMap(map) {
  const lines = [];
  for (const [key, value] of Object.entries(map || {})) {
    if (!key) continue;
    lines.push(`${key}=${encodeEnvValue(value)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function mergeEnvMap(existing, updates) {
  const next = { ...(existing && typeof existing === "object" ? existing : {}) };
  for (const [key, value] of Object.entries(updates || {})) {
    if (value == null) continue;
    next[key] = String(value);
  }
  return next;
}

export function composeForgotPasswordMail(templates, vars) {
  const defaults = defaultMailTemplates().forgot_password;
  const tpl = templates?.forgot_password || defaults;
  const rendered = renderMailTemplate(tpl, vars);
  if (!rendered.subject || !rendered.text.includes(String(vars.tempPassword || ""))) {
    return renderMailTemplate(defaults, vars);
  }
  return rendered;
}

export function composeListingNotifyMail(templates, items) {
  const defaults = defaultMailTemplates().listing_notify;
  const tpl = templates?.listing_notify || defaults;
  const list = Array.isArray(items) ? items.filter((row) => row && typeof row === "object") : [];
  if (!list.length) return { subject: "", text: "" };
  const rendered = list.map((vars) => {
    const row = renderMailTemplate(tpl, vars);
    if (!row.subject && !String(row.text || "").trim()) return renderMailTemplate(defaults, vars);
    return row;
  });
  if (rendered.length === 1) return rendered[0];
  return {
    subject: `${APP_NAME}：${rendered.length} 則更新`.slice(0, 180),
    text: rendered.map((row) => [row.subject, row.text].filter(Boolean).join("\n\n")).join("\n\n----------\n\n"),
  };
}
