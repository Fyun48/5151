// 投影／fold 刷新的失敗計數（2026-10-10，收斂 fold_* 刷新那包）。
//
// 為什麼獨立成一個檔案、而且**故意不叫 `*Async.js`**：與 adminAuditHealth.js 同一理由——
// 這支完全不碰資料庫，只是一個行程內的計數器。route-data-map 會把「從 `*Async.js` 匯入的函式」
// 一律算成 PG 路徑；若把 `refreshFailureStats()` 放在 `*Async.js`，`GET /api/health` 會被誤判成 PG。
//
// 背景：投影／fold 刷新失敗時，往往「主寫入與刷新在同一個 PG 交易裡」，而 PG 的規矩是交易內
// 任何一句失敗就讓整個交易進入 `aborted`（25P02 current transaction is aborted），在 ROLLBACK
// 之前任何後續陳述（包括把失敗寫回 rental_analytics_daily 的計數）都會被擋。因此**行程內計數器
// 才是唯一可靠的失敗訊號**；DB 的 bumpAnalytics 只是「非緊急的第二副本」，允許失敗。

let projectionFailures = 0;
let projectionLast = null;
let foldFailures = 0;
let foldLast = null;

export function noteRefreshFailure(kind, error) {
  const message = String(error?.message || error || "unknown");
  const at = new Date().toISOString();
  if (kind === "fold") {
    foldFailures += 1;
    foldLast = { at, message };
  } else {
    projectionFailures += 1;
    projectionLast = { at, message };
  }
}

/** 給 /api/health 用的快照。只回數字與最後一次的訊息，不含實體 id。 */
export function refreshFailureStats() {
  return {
    projection: { failures: projectionFailures, last: projectionLast },
    fold: { failures: foldFailures, last: foldLast },
  };
}

/** 只給測試用：把計數器歸零，讓每個 test 從乾淨狀態開始。 */
export function resetRefreshFailureStats() {
  projectionFailures = 0;
  projectionLast = null;
  foldFailures = 0;
  foldLast = null;
}
