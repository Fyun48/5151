// data_revision bump 寫入的失敗計數（2026-10-09，訪客快取前置：補 bump 覆蓋面）。
//
// 為什麼獨立成一個檔案、而且**故意不叫 `*Async.js`**：與 `adminAuditHealth.js` 同一理由——
// 這支完全不碰資料庫，只是一個行程內的計數器。`v3/scripts/route-data-map.mjs` 會把
// 「從 `*Async.js` 匯入的函式」一律算成 PG 路徑；若把 `revisionBumpFailureStats()` 放在
// `revisionBumpAsync.js`，`GET /api/health` 會被誤判成 PG（那條路由其實沒有 DB 存取）。
//
// 背景：補 bump 覆蓋面時，每個 bump 都是 best-effort（SAVEPOINT 隔離／try-catch），失敗不得
// 讓主寫入 rollback；但「bump 失敗」是訪客快取失效漏掉的直接原因，不能像以前那樣完全隱形。
// 這裡把失敗累計起來，接到 `/api/health` 的 `revision_bump_failures`，Owner 看得到
// 「今天有多少次 bump 失敗」。

let failures = 0;
let lastFailure = null;
// 印 log 的節奏用**自己的**計數器，刻意不與 failures 共用（與 adminAuditHealth 同理由）。
let logCount = 0;
const LOG_EVERY = 100;

export function noteRevisionBumpFailure(error) {
  failures += 1;
  lastFailure = { at: new Date().toISOString(), message: String(error?.message || error || "unknown") };
  logCount += 1;
  if (logCount === 1 || logCount % LOG_EVERY === 0) {
    console.error(`[revision] data_revision bump 寫入失敗（累計 ${failures} 筆）：${lastFailure.message}`);
  }
}

/** 給 /api/health 用的快照。只回數字與最後一次的訊息，不含實體 id／event。 */
export function revisionBumpFailureStats() {
  return { failures, last: lastFailure };
}

/** 只給測試用：把計數器歸零，讓每個 test 從乾淨狀態開始。 */
export function resetRevisionBumpFailureStats() {
  failures = 0;
  lastFailure = null;
  logCount = 0;
}
