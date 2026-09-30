// `/api/*` 的 JSON 保底回應（2026-09-30，第八十九批）。
//
// 為什麼需要這一支：`server.js` 原本**沒有任何錯誤中介層、也沒有 API 專屬的 404**，
// 所以兩種情況會回 Express 預設的 **HTML** 頁面：
//
//   1. 打到不存在的 `/api/...`（例：舊版前端、打錯字、路由改名）→ HTML 404。
//   2. 路由把錯誤拋出 try/catch 之外（`/api/me` 就是沒有 try/catch 的那一種）→ HTML 500。
//
// 前端一律用 `res.json()` 讀，於是使用者看到的是一句天書：
//   `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`
// （2026-09-30 正式站實際回報，截圖見 PR #589 說明）。
//
// 契約（給前端與監控）：
//   - `/api/*` 的任何失敗一律是 JSON，形狀 `{ error, code }`。
//   - 4xx 的 `error` 可以直接顯示給使用者（沿用路由原本的訊息）。
//   - 5xx **不洩漏內部訊息**（正式站顯示通用句；訊息只進 server log）。
//   - `res.headersSent` 之後不再插話，交還 Express 預設處理（避免 double-send）。

/** 5xx 給使用者的通用訊息（內部訊息只寫 log）。 */
export const GENERIC_SERVER_ERROR = "伺服器暫時無法處理，請稍後再試";

/** body-parser 之類的「請求本身壞掉」：400，而且訊息要看得懂。 */
function friendlyClientMessage(error) {
  const message = String(error?.message || "");
  if (error?.type === "entity.parse.failed" || /Unexpected token|JSON at position/i.test(message)) {
    return "請求內容格式不正確";
  }
  if (error?.type === "entity.too.large") return "請求內容過大";
  return message || "請求不正確";
}

/** status 的合法範圍：路由丟出的 `err.status` 可能是 0／undefined／亂填。 */
export function statusOfApiError(error) {
  return statusOf(error);
}

function statusOf(error) {
  const raw = Number(error?.status ?? error?.statusCode);
  if (!Number.isFinite(raw) || raw < 400 || raw > 599) return 500;
  return Math.trunc(raw);
}

/**
 * 把錯誤轉成 `/api/*` 的 JSON 回應內容（純函式，方便測試）。
 * @returns {{status: number, body: {error: string, code: string}}}
 */
export function apiErrorBody(error) {
  const status = statusOf(error);
  const code = String(error?.code || "") || (status === 500 ? "internal" : "");
  if (status >= 500) {
    return { status, body: { error: GENERIC_SERVER_ERROR, code: code || "internal" } };
  }
  return { status, body: { error: friendlyClientMessage(error), code } };
}

/** 掛在所有 `/api` 路由之後（`app.use("/api", …)`）：未知路徑回 JSON 404，不是 HTML。 */
export function apiNotFoundHandler() {
  return (req, res) => {
    res.status(404).json({ error: "找不到這個 API 路徑", code: "api_not_found" });
  };
}

/**
 * 最後一道錯誤中介層。`/api/*` 回 JSON；其他路徑維持 Express 預設的 HTML
 * （靜態頁面與瀏覽器導覽要的是 HTML，不是 JSON）。
 */
export function apiErrorHandler({ logger = console } = {}) {
  // eslint-disable-next-line no-unused-vars -- Express 以 4 個參數辨識錯誤中介層
  return (error, req, res, next) => {
    if (res.headersSent) return next(error);
    const isApi = String(req.path || req.url || "").startsWith("/api/") || req.path === "/api";
    if (!isApi) return next(error);
    const { status, body } = apiErrorBody(error);
    try {
      logger.error(
        `[api] ${req.method} ${req.path} → ${status} ${body.code || ""} :: ${error?.message || error}`,
      );
    } catch { /* log 失敗不該蓋掉回應 */ }
    res.status(status).json(body);
  };
}
