// 共用的 HTTP 錯誤：帶 status，讓路由統一轉成 JSON。
export function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}
