// 「可用的 SQLite handle」判準（升級層 D-0021 第二包）。
//
// 為什麼需要：PG_NO_SQLITE_OPEN=1（且 DB_DRIVER=postgres）時，db.js 的 `db` 是
// createNoOpenSqliteProxy() 回傳的 Proxy——它 truthy，但碰任何 method 就拋
// 「business SQLite is closed」。任何用 `if (sqliteDb)`（truthy）的地方都會把這個
// proxy 誤當成「有 handle」而誤走 SQLite 鏡射／同步路徑。
//
// 這裡集中單一判準：
//   - null / undefined                  ⇒ 不可用
//   - 帶 DSH_NO_OPEN_MARKER 的 proxy     ⇒ 不可用（開閘時的拋錯 proxy）
//   - 其餘（真實 DatabaseSync／guardCrawlSqlite 包裝）⇒ 可用
//
// marker 用不可枚舉的 Symbol 屬性，掛在 createNoOpenSqliteProxy 的 target 上；該 proxy 的
// get trap 對 symbol 一律回 undefined，所以掛 marker 前後 `handle[symbol]` 的結果不變，
// 不影響既有對外行為。辨識走 hasOwnProperty（[[GetOwnProperty]]，不經 get trap）。

export const DSH_NO_OPEN_MARKER = Symbol.for("dsh.pgNoOpenSqlite");

export function sqliteHandleIsUsable(handle) {
  if (handle == null) return false;
  if (Object.prototype.hasOwnProperty.call(handle, DSH_NO_OPEN_MARKER)) return false;
  return true;
}
