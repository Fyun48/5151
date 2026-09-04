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
    welcome: {
      subject: `${APP_NAME}：請確認信箱以完成註冊`,
      text: `你好，

請點下面的連結完成 ${APP_NAME} 註冊（信箱 {{email}}）。點過就會登入，這個連結只能用一次。

{{verifyUrl}}

若 3 天內沒點，連結會失效。物件／屋源提醒不會用站方信箱代寄，登入後可到「我的」選填自己的 SMTP。

——${APP_NAME}
`,
    },
    verified_welcome: {
      subject: `${APP_NAME}：恭喜你加入，信箱已開通`,
      text: `你好，

恭喜你，信箱 {{email}} 已開通，歡迎正式加入 ${APP_NAME}。

這是一個免費找房工具，用來把各來源的租金與條件看清楚一點，不是仲介、也不經手金錢。若你想知道這個站為什麼存在，可以看這裡：

{{spiritUrl}}

若這個工具幫得上忙，日後若有餘力，歡迎以你覺得自在的方式支持維護，讓它可以繼續走下去。有沒有這樣做，都不影響你現在就能用的功能。

祝找房順利。

——${APP_NAME}
`,
    },
    verify_expired: {
      subject: `${APP_NAME}：註冊確認連結已失效`,
      text: `你好，

信箱 {{email}} 的註冊確認連結已超過 3 天未點擊，已經失效。此次註冊尚未完成，不能登入。

若要加入，請再到註冊頁用同一個信箱重新註冊，我們會再寄一封新的確認信。

——${APP_NAME}
`,
    },
    password_changed: {
      subject: `${APP_NAME}：密碼已變更`,
      text: `你好，

帳號 {{email}} 的密碼已變更。

若這不是你本人操作，請立刻到登入頁使用「忘記密碼」重設。

——${APP_NAME}
`,
    },
    sponsor_thanks: {
      subject: `${APP_NAME}：感謝你的贊助`,
      text: `你好，

感謝你贊助 ${APP_NAME}。帳號 {{email}} 已標成已贊助，檢查間隔會比較密。

物件／屋源提醒仍請用你自己的 SMTP 寄出。

——${APP_NAME}
`,
    },
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
    account_deleted: {
      subject: `${APP_NAME}：會員帳號已關閉`,
      text: `你好，

帳號 {{email}} 已被關閉。

原因：
{{reason}}

此信箱資料會保留，避免被立刻重新註冊。同一信箱最多可再註冊一次；第二次刪除後就不能再用這個 Email 註冊。

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

export const ACCOUNT_MAIL_KINDS = ["welcome", "verified_welcome", "verify_expired", "password_changed", "sponsor_thanks", "account_deleted"];

export function composeAccountMail(kind, templates, vars = {}) {
  const key = String(kind || "").trim();
  const defaults = defaultMailTemplates();
  const fallback = defaults[key];
  if (!fallback) return { subject: "", text: "" };
  const tpl = templates?.[key] || fallback;
  const rendered = renderMailTemplate(tpl, vars);
  if (!rendered.subject || !String(rendered.text || "").trim()) {
    return renderMailTemplate(fallback, vars);
  }
  return rendered;
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
