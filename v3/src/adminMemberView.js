// 後台會員列表的**純**投影（2026-09-28，第五十四批）。
//
// 為什麼要抽出來：這個形狀是**前端契約**（`public/admin.html` 直接吃這些欄位），
// 同步版與 PG 版必須逐欄相同。原本它藏在 `db.js` 的私有 `publicAdminMember()` 裡，
// 而那一版會自己去讀 `getSettings()`／`countWatched()`／`countOpenSelfListings()`
// ——三個都是節點本機的讀取。抽成純函式之後，兩個 driver 只差「誰去把那三個值準備好」。
import { isUserDeleted } from "./members.js";
import { planIntervalMinutes } from "./settingsState.js";

export function adminMemberView(user, { settings = {}, watchCount = 0, listingCount = 0 } = {}) {
  if (!user) return null;
  return {
    id: Number(user.id),
    email: user.email,
    role: user.role || "member",
    plan: user.plan || "free",
    created_at: user.created_at || "",
    accepted_disclaimer_at: user.accepted_disclaimer_at || "",
    signup_count: Number(user.signup_count) || 1,
    deleted: isUserDeleted(user),
    deleted_at: user.deleted_at || "",
    deleted_by: user.deleted_by || "",
    deleted_reason: user.deleted_reason || "",
    last_login_at: user.last_login_at || "",
    intervalMinutes: Number(settings.intervalMinutes) || planIntervalMinutes(user.plan),
    intervalAdminSet: settings.intervalAdminSet === true,
    watchCount: Number(watchCount) || 0,
    listingCount: Number(listingCount) || 0,
  };
}
