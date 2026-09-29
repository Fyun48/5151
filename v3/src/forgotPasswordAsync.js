// 忘記密碼（臨時密碼）的 driver-aware 入口（PG 島嶼，2026-09-28，第五十三批）。
//
// 涵蓋的路由：`POST /api/forgot-password`。
//
// 這一支特別乾淨：`forgotPassword.js` 的 `requestTempPassword(conn, email, opts)` **本來就是
// async**，而且把資料層全部做成可注入（`findUser`／`setPassword`／`restoreHash`／`compose`／
// `send`／`smtp`／`configured`）。所以 PG 版不需要重寫規則，只要換掉那幾個回呼——
// 「驗證碼冷卻、信件內容、失敗時把舊雜湊寫回去」這些規則仍然只有一份實作。
//
// ⚠️ `restoreHash` 要直接寫**舊雜湊**（不是明文）⇒ 需要 usersAsync 的 `setPasswordHashAsync()`，
// 不能拿 `setUserPasswordAsync()` 代替（那會重新 validate + hash，兩者不同）。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { requestTempPassword as requestTempPasswordCore } from "./forgotPassword.js";
import { composeForgotPasswordMail } from "./siteMail.js";
import { mailConfigured } from "./mail.js";
import { getMailTemplatesAsync, getStoredSmtpAsync } from "./adminSettingsAsync.js";
import { requestTempPassword as requestTempPasswordSync } from "./db.js";
import { findUserByEmailAsync, setPasswordHashAsync, setUserPasswordAsync } from "./usersAsync.js";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

// `db.js requestTempPassword()` 的 PG 版（SMTP 與信件範本也從 PG 的 settings 讀）。
export async function requestTempPasswordAsync(email, options = {}) {
  if (!isPg(options)) return requestTempPasswordSync(email);
  const [templates, smtp] = await Promise.all([
    getMailTemplatesAsync(options),
    getStoredSmtpAsync(options),
  ]);
  // ⚠️ 刻意把 `options` 一起展開：核心函式只認得它自己的鍵，其餘（`send`／`makePassword`／
  // `now`／`cooldownMs`／`attempts`）是**測試與探針的接縫**——少了它，離線測試會真的去連 SMTP。
  return requestTempPasswordCore(sqliteHandle(), email, {
    ...options,
    smtp,
    configured: () => mailConfigured(smtp),
    compose: (vars) => composeForgotPasswordMail(templates, vars),
    findUser: (key) => findUserByEmailAsync(key, options),
    setPassword: (id, pass) => setUserPasswordAsync(id, pass, options),
    restoreHash: (id, hash) => setPasswordHashAsync(id, hash, options),
  });
}
