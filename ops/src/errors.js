// 共用的 HTTP 錯誤：帶 status，讓路由統一轉成 JSON。
export function httpError(message, status = 400, extra = {}) {
  const err = new Error(message);
  err.status = status;
  if (extra && extra.code) err.code = extra.code;
  return err;
}
