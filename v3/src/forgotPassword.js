import { findUserByEmail, setUserPassword } from "./members.js";
import { mailConfigured, sendMail } from "./mail.js";
import { generateTempPassword, validateEmail } from "./password.js";
import { composeForgotPasswordMail, defaultMailTemplates } from "./siteMail.js";

const recent = new Map();
const COOLDOWN_MS = 5 * 60 * 1000;

export function forgotPasswordMessage() {
  return "若此帳號存在，臨時密碼已寄到信箱。請用信裡的密碼登入。";
}

export function tempPasswordEmail({ tempPassword, email } = {}) {
  return composeForgotPasswordMail(defaultMailTemplates(), { tempPassword, email: email || "" });
}

export async function requestTempPassword(conn, email, opts = {}) {
  const {
    smtp,
    now = Date.now(),
    cooldownMs = COOLDOWN_MS,
    attempts = recent,
    configured,
    send = sendMail,
    findUser = (key) => findUserByEmail(conn, key),
    setPassword = (id, pass) => setUserPassword(conn, id, pass),
    restoreHash = (id, hash) => {
      conn.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(String(hash || ""), Number(id) || 0);
    },
    makePassword = generateTempPassword,
    compose = tempPasswordEmail,
  } = opts;
  const mailReady = typeof configured === "function" ? configured : () => mailConfigured(smtp);

  const key = validateEmail(email);
  if (!key) {
    const err = new Error("請輸入有效的 Email");
    err.status = 400;
    throw err;
  }
  if (!mailReady()) {
    const err = new Error("尚未設定寄信，請聯絡管理員到後台填 SMTP，或在伺服器 auth.env 寫入 SMTP 設定");
    err.status = 503;
    throw err;
  }

  const last = Number(attempts.get(key) || 0);
  if (last && now - last < cooldownMs) {
    const wait = Math.max(1, Math.ceil((cooldownMs - (now - last)) / 1000));
    const err = new Error(`請 ${wait} 秒後再試`);
    err.status = 429;
    throw err;
  }

  const user = findUser(key);
  const result = { ok: true, message: forgotPasswordMessage() };
  if (!user?.id || String(user.deleted_at || "").trim()) {
    attempts.set(key, now);
    return result;
  }

  const tempPassword = makePassword();
  const previousHash = user.password_hash;
  setPassword(user.id, tempPassword);
  try {
    const mail = compose({ tempPassword, email: user.email || key });
    await send({
      to: user.email || key,
      subject: mail.subject,
      text: mail.text,
      smtp,
    });
  } catch (error) {
    try {
      restoreHash(user.id, previousHash);
    } catch {
      // 還原失敗仍回傳寄信錯誤
    }
    throw error;
  }
  attempts.set(key, now);
  return result;
}
