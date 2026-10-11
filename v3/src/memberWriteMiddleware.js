// 會員寫入的「路由提示」middleware（2026-10-12 會員讀待機路由包）。
//
// 只做一件事：請求是 mutating 且**回成功**時，記下 `uid → 時刻`（`memberWriteRecency.js`）。
// 會員列表的唯讀快照（`/api/listings`）據此在 `MEMBER_READ_FRESHNESS_MS`（預設 5000ms）內整趟
// 走 primary，其餘走待機（`PG_RO_URL`）。這一條**不改任何回應內容**，也不碰 DB。
//
// 為什麼掛在全部 mutating 請求，而不是逐條會員狀態路由：會員自身狀態的寫入點很多
// （`user_listing_flags`／`user_settings`／`user_same_house_members`／`user_match_votes`／
// `users`…），逐條列一定漏；漏掉的代價是「剛寫完看到舊的自己」，
// 而多記的代價只是那個會員接下來幾秒多走一次 primary（方向保守）。
//
// `userIdOf` 由呼叫端注入（正式路徑＝`readSession(req)?.userId`），所以這條 middleware
// 可以離線測試，不必拉起整個 server。
import { markMemberWrite } from "./memberWriteRecency.js";

export function memberWriteMiddleware({ userIdOf = null, onWrite = markMemberWrite } = {}) {
  return function memberWriteHintMiddleware(req, res, next) {
    const method = String(req.method || "").toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
    res.on("finish", () => {
      // 失敗的寫入不算「剛寫過」：那種請求沒有改到任何會員狀態。
      if (res.statusCode >= 400) return;
      const uid = Number(userIdOf?.(req)) || 0;
      if (uid > 0) onWrite(uid);
    });
    next();
  };
}
