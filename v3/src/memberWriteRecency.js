// 會員「寫後新鮮期」路由提示（2026-10-12 會員讀待機路由包）。
//
// 為什麼需要：會員列表的唯讀快照要改讀 PostgreSQL **待機**節點（`PG_RO_URL`，見
// `v3/src/pgReadReplica.js`），但待機有複製延遲（正式機 2026-10-12 實測 0.88 秒）。而
// `/api/listings` 的回傳除了房源本身，還含**該會員自己剛寫下的狀態**：
// `user_listing_flags`（watched／viewed／hidden／watch_note）、`user_settings`（通勤與篩選預設）、
// `user_same_house_members`（會員自己的同屋源群組）、`user_match_votes`（會員自己的「不是同一間」票）。
// 不處理的話，會員按下「特別關注」後立刻重整，可能在複製延遲窗口內看到舊狀態。
//
// 這一支**只是路由提示，不是資料快取**：唯一的狀態是「uid → 最近一次寫入的時刻」，
// 沒有任何資料列、物件或回應被存下來；提示只決定「這個請求的唯讀快照走 primary 還是待機」。
//
// 什麼時候用得上（最壞後果見 runbook §「最壞後果」與測試）：
//   * 行程重啟：提示清空 ⇒ 之後的請求走待機 ⇒ 最壞是複製延遲窗口內的自身狀態。
//   * 多節點（web-A／web-B 各自一個行程）：各記各的 ⇒ 在 A 寫、去 B 讀時，B 沒有提示 ⇒ 同上。
//   兩個情況的後果都被「待機目前落後多少」封頂，而且**只會回稍舊的自身狀態，不會回別的會員
//   或錯的房源**；提示失效的方向永遠是「少走一次待機」（保守）。
export const MEMBER_WRITE_HINT_ENV = "MEMBER_READ_FRESHNESS_MS";
export const DEFAULT_MEMBER_WRITE_HINT_MS = 5000;

/** 新鮮期長度（毫秒）。未設／非數值／負數一律回預設；`0` 代表關掉這條提示（一律走待機）。 */
export function memberWriteHintMs(env = process.env) {
  const raw = Number(env?.[MEMBER_WRITE_HINT_ENV]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_MEMBER_WRITE_HINT_MS;
}

/**
 * 建立一個獨立的提示表（測試用多實例，模擬多節點／重啟後的不同步）。
 * `now` 可注入，讓「新鮮期到期」不需要真的等 5 秒。
 */
export function createMemberWriteRecency({ windowMs = null, now = () => Date.now() } = {}) {
  const writtenAt = new Map();
  const window = () => (Number.isFinite(windowMs) ? Math.floor(Number(windowMs)) : memberWriteHintMs());
  return {
    markWrite(userId) {
      const uid = Number(userId) || 0;
      if (uid > 0) writtenAt.set(uid, now());
    },
    isFresh(userId) {
      const uid = Number(userId) || 0;
      if (!uid) return false;
      const at = writtenAt.get(uid);
      if (at == null) return false;
      const ms = window();
      // `MEMBER_READ_FRESHNESS_MS=0`：明確關掉提示（一律走待機），記憶體也立刻釋放。
      if (!(ms > 0)) { writtenAt.delete(uid); return false; }
      if (now() - at < ms) return true;
      // 過期就刪掉：這張表的大小因此封頂在「最近 N 毫秒內寫過的會員數」，不會隨會員總數長大。
      writtenAt.delete(uid);
      return false;
    },
    /** 目前還在提示表裡的 uid 數（診斷用，不含已過期項）。 */
    size() { return writtenAt.size; },
    clear() { writtenAt.clear(); },
  };
}

/** 正式路徑用的共用實例（env 於每次查詢時讀取 ⇒ 測試可即時切換）。 */
export const memberWriteRecency = createMemberWriteRecency();

export function markMemberWrite(userId) { return memberWriteRecency.markWrite(userId); }
export function isMemberWriteFresh(userId) { return memberWriteRecency.isFresh(userId); }
