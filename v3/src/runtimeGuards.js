// 啟動檢查（G4）：正式部署的 DB driver 與 SQLite fallback 政策 gate。
//
// 背景：v3/src/dbDriver.js 的 resolveDbDriver() 在 DB_DRIVER 未設或拼錯時一律回傳
// "sqlite"（不 throw），所以「正式部署忘了設 DB_DRIVER=postgres」或「拼成 postgress」
// 會讓容器悄悄退回節點本機 SQLite。同樣地，sqliteFallback.js 的 fallbackMode() 若回
// "open"，正式站就會在 PG 失敗時把寫入回退到沒有人在讀的 SQLite（無聲的資料分歧）。
//
// 這支 guard 在 server.js 與 watcher.js 的啟動路徑上跑（fail-fast）：
//   ① 有 PG 連線 env（PG_URL／DATABASE_URL／POSTGRES_URL／PGHOST／…）但 driver ≠ postgres ⇒ 拒絕
//   ② driver = postgres 但 PG_SQLITE_FALLBACK=open ⇒ 拒絕（Owner :60 不收逃生門）
//   ③ DB_DRIVER=sqlite 且沒有 PG 連線 ⇒ 放行（本機開發／測試不受影響）
//   ④ 有 PG 連線 env 但沒開閘（未設 PG_NO_SQLITE_OPEN=1）⇒ 拒絕（節點不得再開業務 SQLite）
//      唯一的例外：爬蟲沙盒（CRAWL_SANDBOX_REPORT 有值）——沙盒刻意還不能開閘，見第④刀的註解
//   ⑤ 有 PG 連線 env 但 PG_SQLITE_FALLBACK 不是 strict（未設＝closed）⇒ 拒絕（只准 strict）
//
// 逃生機制：只有明確設定 DB_RUNTIME_GUARD=off 才跳過，且會高調警告（不要偷偷放行）。
// 訊息只印鍵名與 driver 值，不印任何連線字串／密碼。
import { resolveDbDriver } from "./dbDriver.js";
import { fallbackMode, PG_SQLITE_FALLBACK_ENV } from "./sqliteFallback.js";

export const DB_RUNTIME_GUARD_ENV = "DB_RUNTIME_GUARD";
// 開閘鍵（db.js:509）：只有 PG_NO_SQLITE_OPEN=1 代表節點真的不開業務 SQLite。
export const PG_NO_SQLITE_OPEN_ENV = "PG_NO_SQLITE_OPEN";
// 爬蟲沙盒的**既存**標記（不新增變數名；全 repo 只有兩處：docker-compose.crawl-sandbox.yml:48
// 設定、v3/scripts/crawl-sandbox.mjs:184 讀取）。
export const CRAWL_SANDBOX_REPORT_ENV = "CRAWL_SANDBOX_REPORT";

// 與 dbDriverPostgres.js 的 resolvePostgresConfig() 對齊：這些 env 只要有一個非空，
// 就代表「有 PG 連線」，driver 必須解析成 postgres。
const PG_URL_KEYS = ["PG_URL", "DATABASE_URL", "POSTGRES_URL"];
const PG_HOST_KEYS = ["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"];

function nonEmpty(env, key) {
  const raw = env?.[key];
  return typeof raw === "string" && raw.trim() !== "";
}

// 回傳「有設值」的 PG 連線 env 鍵名（只回鍵名，不回值——值可能含密碼）。
export function pgConnectionKeys(env = process.env) {
  return [...PG_URL_KEYS, ...PG_HOST_KEYS].filter((key) => nonEmpty(env, key));
}

export function assertRuntimeDbGuard(env = process.env) {
  if (String(env?.[DB_RUNTIME_GUARD_ENV] || "").trim().toLowerCase() === "off") {
    console.warn(
      `[runtime-guard] ${DB_RUNTIME_GUARD_ENV}=off：啟動檢查已停用（逃生旗標）。` +
        "這會跳過「錯 driver／SQLite fallback 逃生門」的拒絕；正式部署請勿設定此旗標。",
    );
    return;
  }
  const driver = resolveDbDriver(env);
  const pgKeys = pgConnectionKeys(env);
  if (pgKeys.length > 0 && driver !== "postgres") {
    throw new Error(
      `[runtime-guard] 啟動拒絕：偵測到 PG 連線環境變數（${pgKeys.join("、")}）` +
        `但 DB_DRIVER 解析成「${driver}」而非「postgres」。` +
        "正式部署必須明確指定 DB_DRIVER=postgres；請修正 DB_DRIVER（常見是拼錯），或移除 PG 連線變數。",
    );
  }
  if (driver === "postgres" && fallbackMode(env) === "open") {
    throw new Error(
      `[runtime-guard] 啟動拒絕：DB_DRIVER=postgres 但 ${PG_SQLITE_FALLBACK_ENV}=open。` +
        "正式部署不收 SQLite fallback 逃生門（寫入會回退到節點本機 SQLite）；請設為 strict（或移除該變數）。",
    );
  }
  if (pgKeys.length > 0) {
    // ④ 開閘：有 PG 連線卻沒開閘，節點還是會開業務 SQLite（回退路徑仍在）。
    //
    // 唯一的沙盒例外（CRAWL_SANDBOX_REPORT 有值 ⇒ 放行，即使閘未設或為 0）：
    // 爬蟲沙盒**刻意**還不能開閘——爬蟲的落地路徑 db.js `storedSearchKeys()` 仍是同步
    // `db.prepare("SELECT DISTINCT search_key FROM listings")`，開閘後每輪都在該點以
    // `business SQLite is closed (PG_NO_SQLITE_OPEN=1 …)` 失敗（實跑 3 輪 fetched:0／jobs:0，
    // 見 evidence/sqlite-exit/next-package.md:9-16）。P6 把該同步讀點遷完後，
    // **這個例外與 docker-compose.crawl-sandbox.yml 的 `:-0` 預設一起移除**。
    // 這是全 repo 唯一一個開閘例外，且只放行第④刀；第⑤刀（fallback 必須 strict）照樣對沙盒生效。
    const sandboxReport = String(env?.[CRAWL_SANDBOX_REPORT_ENV] || "").trim();
    const gateOpen = String(env?.[PG_NO_SQLITE_OPEN_ENV] || "").trim() === "1";
    if (!gateOpen && sandboxReport === "") {
      throw new Error(
        `[runtime-guard] 啟動拒絕：偵測到 PG 連線環境變數（${pgKeys.join("、")}）` +
          `但未設 ${PG_NO_SQLITE_OPEN_ENV}=1。正式部署必須開閘（節點不得再開業務 SQLite）；` +
          `請設 ${PG_NO_SQLITE_OPEN_ENV}=1。` +
          `回退＝部署「不含這道第④刀」的舊 image，或在故障應變時臨時設 ${DB_RUNTIME_GUARD_ENV}=off` +
          `（${DB_RUNTIME_GUARD_ENV}=off 只准故障應變，不准寫進正式 compose；` +
          `已經有部署預設 ${PG_NO_SQLITE_OPEN_ENV}=1，刪掉 .env 那一行不會回到舊行為）。`,
      );
    }
    // ⑤ 回退政策：開閘後只准 strict；closed／open 都還留著 SQLite 回退語意，
    //    會讓真 PG 錯誤被「business SQLite is closed」蓋掉。
    const mode = fallbackMode(env);
    if (mode !== "strict") {
      throw new Error(
        `[runtime-guard] 啟動拒絕：有 PG 連線但 ${PG_SQLITE_FALLBACK_ENV}=${mode}（未設視為 closed）。` +
          "開閘後只准 strict（讀寫都不回退）；" +
          `請設 ${PG_SQLITE_FALLBACK_ENV}=strict。`,
      );
    }
  }
}
