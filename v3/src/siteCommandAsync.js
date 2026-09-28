// 遠端客服（remote CS）接受開關的 driver-aware 入口（PG 島嶼，2026-09-27）。
//
// 涵蓋的路由：`GET /api/admin/remote-cs`、`PUT /api/admin/remote-cs`。
//
// 這個開關的儲存只有**一個 settings 鍵**（`ops_remote_cs_stop`，值為 "1" 或 "0"），
// 而 `remoteCsAcceptControl()` 是「env 兩個變數 ＋ 這個鍵」的純組合。所以移植很小：
// 讀寫改用 `settingsKvAsync`，判斷邏輯重用 `remoteCsAcceptControl()` 本身
// ——它吃 `(db, env)`，所以 PG 分支不能直接呼叫它（那會讀 SQLite）。
// 為了**不要複製那段判斷**，這裡把「本地停止」讀出來後，用同一個函式組結果：
// 傳進一個只實作 `prepare(...).get()` 的極薄物件，把 PG 讀到的值餵給它。
//
// ⚠️ 值一律存成字串 "1"／"0"（同步版就是這樣寫的），不要存 JSON 布林——
// `isRemoteCsStopped()` 的判斷是 `String(row?.value || "") === "1"`。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { REMOTE_CS_STOP_KEY, remoteCsAcceptControl } from "./siteCommandApply.js";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

// 把 PG 讀到的值偽裝成 db.js 那支同步 helper 期待的形狀（只需 `prepare().get()`）。
// 這樣 `remoteCsAcceptControl()` 的判斷（env_allowed／configured／local_stopped／effective）
// 就只有一份實作。
function stoppedFromValue(value) {
  const text = value == null ? "" : String(value).replace(/^"|"$/g, "");
  return {
    prepare: () => ({ get: () => ({ value: text }) }),
  };
}

// 🚨 **這裡不能用 `setSiteSettingAsync`／`getSiteSettingAsync`。**
// 同步版把這個鍵存成**原始字串** `"1"`／`"0"`，而 `isRemoteCsStopped()` 的判斷是
// `String(row.value) === "1"`——連 `siteCommandApply.js` 自己也是用原生 SQL 讀同一個鍵。
// `setSiteSettingAsync` 會 `JSON.stringify`，把 `"1"` 寫成 `"\"1\""`（含引號）⇒ 那個判斷
// 永遠不成立 ⇒ **開關在 PG 上完全失效，而且不會有任何錯誤**。
// （第一版就是這樣寫，是測試斷言「落地要是原始字串 "1"」把它抓出來的。）
export const STOP_SELECT_SQL = "SELECT value FROM settings WHERE key=?";
export const STOP_UPSERT_SQL =
  "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";

async function pgExec(options = {}) {
  if (options.exec) return options.exec;
  const pgDriver = options.pgDriver || (await (await import("./pgSharedDriver.js")).sharedPgDriver());
  const { toPostgresSql } = await import("./sqlDialect.js");
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

async function readStoppedPg(options) {
  const exec = await pgExec(options);
  const rows = await exec(STOP_SELECT_SQL, [REMOTE_CS_STOP_KEY]);
  const raw = rows?.[0]?.value;
  return raw == null ? null : String(raw);
}

export async function getRemoteCsControlAsync(options = {}) {
  if (!isPg(options)) return (await import("./db.js")).getRemoteCsControl();
  return withRead(options, async () => {
    const stopped = await readStoppedPg(options);
    return remoteCsAcceptControl(stoppedFromValue(stopped));
  }, async () => (await import("./db.js")).getRemoteCsControl());
}

export async function setRemoteCsStopAsync(stopped, options = {}) {
  const flag = Boolean(stopped);
  if (!isPg(options)) return (await import("./db.js")).setRemoteCsStop(flag);
  return withWrite(options, async () => {
    const exec = await pgExec(options);
    await exec(STOP_UPSERT_SQL, [REMOTE_CS_STOP_KEY, flag ? "1" : "0"]);
    return withRead(options, async () => {
      const stopped = await readStoppedPg(options);
      return remoteCsAcceptControl(stoppedFromValue(stopped));
    }, async () => (await import("./db.js")).getRemoteCsControl());
  }, async () => (await import("./db.js")).setRemoteCsStop(flag));
}

async function withRead(options, runPostgres, runSqlite) {
  try {
    return await runPostgres();
  } catch (error) {
    if (!sqliteFallbackAllowed(options)) throw error;
    return runSqlite();
  }
}

async function withWrite(options, runPostgres, runSqlite) {
  try {
    return await runPostgres();
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write: true })) throw error;
    return runSqlite();
  }
}
