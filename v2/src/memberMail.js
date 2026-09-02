import { defaultMailTemplates, normalizeMailTemplates, normalizeSmtp, publicSmtp } from "./siteMail.js";

export const GMAIL_APP_PASSWORD_HINT =
  "Gmail 不能用平常登入的密碼。請到 Google 帳戶 → 安全性 → 兩步驟驗證 → 應用程式密碼，產生 16 碼後填在這裡。";

export function listingMailPresets() {
  const detailed = defaultMailTemplates().listing_notify;
  return [
    {
      id: "concise",
      name: "簡潔",
      subject: "591 物件追蹤：{{event}} {{title}}",
      text: `{{event}}
{{title}}
{{url}}
`,
    },
    {
      id: "detailed",
      name: "詳細（含地址與通勤）",
      subject: detailed.subject,
      text: detailed.text,
    },
    {
      id: "facts",
      name: "重點條列",
      subject: "591 物件追蹤：{{event}} {{title}}",
      text: `{{event}} · {{title}}
{{price}}
{{facts}}
{{url}}
`,
    },
  ];
}

export function listingMailPresetById(id) {
  const key = String(id || "").trim();
  return listingMailPresets().find((row) => row.id === key) || listingMailPresets().find((row) => row.id === "detailed");
}

export function looksLikeGmail({ host, user, from } = {}) {
  const blob = [host, user, from].map((value) => String(value || "").toLowerCase()).join(" ");
  return /\bgmail\.com\b|\bgooglemail\.com\b|\bsmtp\.gmail\b/.test(blob);
}

export function gmailSmtpDefaults() {
  return { host: "smtp.gmail.com", port: 587, secure: false };
}

export function smtpReady(config) {
  const row = normalizeSmtp(config || {});
  return Boolean(row.host && (row.from || row.user));
}

export function normalizeMemberMailTemplates(input) {
  const listing = normalizeMailTemplates({
    listing_notify: input?.listing_notify || input,
  }).listing_notify;
  return { listing_notify: listing };
}

export function publicMemberMail(smtp, templates, preset) {
  const ready = smtpReady(smtp);
  return {
    smtp: publicSmtp(smtp),
    templates: normalizeMemberMailTemplates(templates),
    preset: listingMailPresetById(preset).id,
    presets: listingMailPresets().map((row) => ({ id: row.id, name: row.name })),
    configured: ready,
    gmail: looksLikeGmail(smtp),
    gmailHint: GMAIL_APP_PASSWORD_HINT,
  };
}
