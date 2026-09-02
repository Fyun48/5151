import { mailConfigured, sendMail } from "./mail.js";
import { composeAccountMail } from "./siteMail.js";

/** 帳號／贊助等系統信：一律走管理員後台 SMTP，不帶會員 smtp。 */
export async function sendAccountMail({
  kind,
  to,
  vars = {},
  templates,
  send = sendMail,
  configured = mailConfigured,
} = {}) {
  const addr = String(to || "").trim();
  if (!addr) return { sent: false, reason: "no_to" };
  if (typeof configured === "function" ? !configured() : !configured) {
    return { sent: false, reason: "not_configured" };
  }
  const mail = composeAccountMail(kind, templates, { email: addr, ...vars });
  if (!mail.subject || !String(mail.text || "").trim()) {
    return { sent: false, reason: "empty" };
  }
  await send({
    to: addr,
    subject: mail.subject,
    text: mail.text,
  });
  return { sent: true };
}

export function queueAccountMail(opts) {
  return sendAccountMail(opts).catch((error) => {
    console.warn("系統信失敗：", error?.message || error);
    return { sent: false, reason: "error", error };
  });
}
