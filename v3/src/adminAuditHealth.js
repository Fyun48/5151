// 稽核寫入的失敗計數（2026-09-27）。
//
// 為什麼獨立成一個檔案、而且**故意不叫 `*Async.js`**：
//   1. 語意上它不是 driver-aware 的 DB 入口——這裡完全不碰資料庫，只是一個行程內的計數器。
//   2. 工具面：`v3/scripts/route-data-map.mjs` 把「從 `*Async.js` 匯入的函式」一律算成 PG 路徑，
//      所以如果把 `auditFailureStats()` 放在 `adminAuditAsync.js`，`GET /api/health` 會被
//      誤判成 PG——那條路由其實**完全沒有 DB 存取**。本系列的進度數字就是靠那支工具量的，
//      一次誤判就是一次過度回報。
//
// 背景：正式站的 `admin_audit.id` identity 序列落後，導致 #521 之後的每一筆稽核寫入都撞主鍵，
// 而 `auditReq()` 的 fire-and-forget `.catch(() => {})` 讓它完全隱形 12 天。
// 詳見 `docs/handoffs/PG-IDENTITY-SEQUENCE-DEFECT-20260927.md`。

let failures = 0;
let lastFailure = null;
// 印 log 的節奏用**自己的**計數器，刻意不與 failures 共用。
// 原因：`failures % 100 === 0` 在計數器壞掉（停在 0）時恆為真 ⇒ 反而每次都印、變成洗版。
// 「算得準」與「印得省」是兩個關注點，不該互相耦合；各自的突變測試也才分得開。
let logCount = 0;
const LOG_EVERY = 100;

export function noteAuditFailure(error) {
  failures += 1;
  lastFailure = { at: new Date().toISOString(), message: String(error?.message || error || "unknown") };
  logCount += 1;
  if (logCount === 1 || logCount % LOG_EVERY === 0) {
    console.error(`[audit] PG 稽核寫入失敗（累計 ${failures} 筆）：${lastFailure.message}`);
  }
}

/** 給 /api/health 用的快照。刻意只回數字與最後一次的訊息，不含 actor／target。 */
export function auditFailureStats() {
  return { failures, last: lastFailure };
}

/** 只給測試用：把計數器歸零，讓每個 test 從乾淨狀態開始。 */
export function resetAuditFailureStats() {
  failures = 0;
  lastFailure = null;
  logCount = 0;
}
