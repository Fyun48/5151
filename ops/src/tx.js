// 單一序列化交易：讀 → 算 → 寫 全部包在一個 BEGIN IMMEDIATE 內。
// BEGIN IMMEDIATE 會立即取得 RESERVED 寫鎖，配合 PRAGMA busy_timeout，
// 兩個並發寫入不會各自以相同的前一列為基礎而分岔（fork）；後到者會等待或按 busy_timeout 重試。
// 任何錯誤一律 ROLLBACK，確保「要嘛全部提交、要嘛全部回滾」。
export function withImmediateTx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  let result;
  try {
    result = fn();
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 若連線已在錯誤狀態，ROLLBACK 可能再拋；吞掉以保留原始錯誤。
    }
    throw err;
  }
  db.exec("COMMIT");
  return result;
}
