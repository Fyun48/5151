// 會員個人資料更新的 driver-aware 入口（PG 島嶼，2026-09-29，第六十二批）。
//
// 涵蓋的路由：`PATCH /api/profile`。
//
// 這一條的規則是「**只有帶到的欄位才改**、其餘沿用舊值」，而且 `email` 不可改、頭像／LINE QR
// 要過 URL 白名單、生日與性別要正規化。同步版讀寫節點本機的 `users`（PG 模式下使用者資料在 PG）
// ⇒ 會員改資料會「看起來成功」，但別的節點與管理後台看到的還是舊的。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteHandle } from "./db.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import {
  cleanLine,
  mediaUrl,
  normalizeBirthDate,
  normalizeGender,
  normalizeNickname,
  updateUserProfile as updateUserProfileSync,
} from "./profile.js";
import { validateEmail } from "./password.js";
import { getUserByIdAsync } from "./usersAsync.js";

export const USER_UPDATE_PROFILE_SQL = `UPDATE users SET
     nickname = $1, avatar_url = $2, home_address = $3, company_address = $4,
     contact_phone = $5, line_id = $6, line_qr_url = $7, contact_email = $8, profile_privacy_at = $9,
     profile_onboarded_at = $10, birth_date = $11, gender = $12, residence = $13
   WHERE id = $14`;

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";
const rowsOf = (raw) => (Array.isArray(raw) ? raw : (raw?.rows || []));

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// 把「這次要寫入的值」算出來——**與 `profile.js updateUserProfile()` 逐條對應**，
// 包含錯誤訊息（那些是使用者看得到的）。
export function profilePatchFrom(row, input = {}) {
  if (Object.prototype.hasOwnProperty.call(input, "email")) {
    const next = String(input.email || "").trim().toLowerCase();
    const cur = String(row.email || "").trim().toLowerCase();
    if (next && next !== cur) throw httpError("註冊 Email 不能更改", 400);
  }
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
  const nickname = has("nickname") ? normalizeNickname(input.nickname) : String(row.nickname || "");
  const avatar = has("avatar_url") ? mediaUrl(input.avatar_url, "頭像") : String(row.avatar_url || "");
  const home = has("home_address") ? cleanLine(input.home_address, 120) : String(row.home_address || "");
  const company = has("company_address") ? cleanLine(input.company_address, 120) : String(row.company_address || "");
  const phone = has("contact_phone") ? cleanLine(input.contact_phone, 40) : String(row.contact_phone || "");
  const lineId = has("line_id") ? cleanLine(input.line_id, 40) : String(row.line_id || "");
  const lineQr = has("line_qr_url") ? mediaUrl(input.line_qr_url, "LINE QR") : String(row.line_qr_url || "");
  let contactEmail = has("contact_email") ? cleanLine(input.contact_email, 120) : String(row.contact_email || "");
  if (contactEmail) {
    const ok = validateEmail(contactEmail);
    if (!ok) throw httpError("聯絡 Email 格式不對", 400);
    contactEmail = ok;
  }
  const birthDate = has("birth_date") ? normalizeBirthDate(input.birth_date) : String(row.birth_date || "");
  const gender = has("gender") ? normalizeGender(input.gender) : String(row.gender || "");
  const residence = has("residence") ? cleanLine(input.residence, 20) : String(row.residence || "");
  let privacyAt = String(row.profile_privacy_at || row.accepted_disclaimer_at || "").trim();
  if (!privacyAt) privacyAt = String(row.accepted_disclaimer_at || "").trim();
  const onboardedAt = String(row.profile_onboarded_at || "").trim() || new Date().toISOString();
  return {
    nickname, avatar_url: avatar, home_address: home, company_address: company,
    contact_phone: phone, line_id: lineId, line_qr_url: lineQr, contact_email: contactEmail,
    profile_privacy_at: privacyAt || null, profile_onboarded_at: onboardedAt,
    birth_date: birthDate, gender, residence,
  };
}

// `profile.js updateUserProfile()` 的 PG 版：驗證 → UPDATE → 回讀那一列。
export async function updateUserProfileAsync(userId, input = {}, options = {}) {
  const uid = Number(userId) || 0;
  if (!uid) throw httpError("請先登入", 401);
  if (!isPg(options)) return updateUserProfileSync(sqliteHandle(), uid, input);
  const row = await getUserByIdAsync(uid, options);
  if (!row) throw httpError("找不到這個會員", 404);
  const patch = profilePatchFrom(row, input);
  const exec = options.exec
    ? async (sql, params = []) => rowsOf(await options.exec(sql, params))
    : async (sql, params = []) => (await (options.pgDriver || (await sharedPgDriver()))
      .query(toPostgresSql(sql), params)).rows;
  try {
    await exec(USER_UPDATE_PROFILE_SQL, [
      patch.nickname, patch.avatar_url, patch.home_address, patch.company_address,
      patch.contact_phone, patch.line_id, patch.line_qr_url, patch.contact_email,
      patch.profile_privacy_at, patch.profile_onboarded_at, patch.birth_date, patch.gender,
      patch.residence, uid,
    ]);
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write: true })) throw error;
    return updateUserProfileSync(sqliteHandle(), uid, input);
  }
  return getUserByIdAsync(uid, options);
}
