import { findUserByEmail, setUserPassword } from "./members.js";
import { mailConfigured, sendMail } from "./mail.js";
import { generateTempPassword, validateEmail } from "./password.js";

const recent = new Map();
const COOLDOWN_MS = 5 * 60 * 1000;

export function forgotPasswordMessage() {
  return "若此帳號存在，臨時密碼已寄到信箱。請用信裡的密碼登入。";
}

export function tempPasswordEmail({ tempPassword }) {
  return {
    subject: "591 物件追蹤（v2）：你的臨時密碼",
    text: `你好，

有人用這個信箱申請 591 物件追蹤（v2 開發版）的臨時密碼。

臨時密碼：
${tempPassword}

請用這組密碼登入。它會取代原本的密碼。若要再換，可到登入頁再申請一次忘記密碼。

若你沒有申請，也請立刻用這組密碼登入，並再申請一組新的臨時密碼。

——591 物件追蹤（v2）
`,
  };
}

export async function requestTempPassword(conn, email, opts = {}) {
  const {
    now = Date.now(),
    cooldownMs = COOLDOWN_MS,
    attempts = recent,
    configured = mailConfigured,
    send = sendMail,
    findUser = (key) => findUserByEmail(conn, key),
    setPassword = (id, pass) => setUserPassword(conn, id, pass),
    restoreHash = (id, hash) => {
      conn.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(String(hash || ""), Number(id) || 0);
    },
    makePassword = generateTempPassword,
  } = opts;

  const key = validateEmail(email);
  if (!key) {
    const err = new Error("請輸入有效的 Email");
    err.status = 400;
    throw err;
  }
  if (!configured()) {
    const err = new Error("尚未設定寄信，請聯絡管理員在伺服器 auth.env 寫入 SMTP 設定");
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
  if (!user?.id) {
    attempts.set(key, now);
    return result;
  }

  const tempPassword = makePassword();
  const previousHash = user.password_hash;
  setPassword(user.id, tempPassword);
  try {
    const mail = tempPasswordEmail({ tempPassword });
    await send({
      to: user.email || key,
      subject: mail.subject,
      text: mail.text,
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
