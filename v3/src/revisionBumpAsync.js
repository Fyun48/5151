// data_revision bump 的 PG 寫入端（訪客快取前置：補 bump 覆蓋面，2026-10-09）。
//
// 寫入端早就是 driver-aware（`createWritePath.bumpRevision`），但只接在 `persistListing`
// 一條路上。會改變訪客可見性結果集的其他寫入（下架確認／來源停用／拆合併／自租隱藏…）
// 沒有 bump ⇒ 訪客快取（以 `data_revision.MAX(id)` 當 generation）在 TTL 內仍回舊結果。
//
// 這裡集中兩個 bump 原語：
//   1. `bumpRevisionPgClient()`：在既有 PG 交易 client 上做 SAVEPOINT-bounded bump
//      （失敗回捲這一段、不毒化主交易——與 db.js `persistListing` 同一語意）。
//   2. `bumpRevisionPgExec()`：注入式 exec（測試夾具／無交易）上的 best-effort bump。
// 失敗一律 `noteRevisionBumpFailure()` 累計（接到 /api/health 的 `revision_bump_failures`）。
//
// ⚠️ 「主寫入 + bump 同一個交易」的包裹器（`writeThenBump`）刻意**不**放這裡，而是留在
// `crawlerWrites.js` 當同模組的 driver-aware 函式：route-data-map 的 `driverAwareLocalNames`
// 只認**同模組**、本文帶 driver 判斷的函式當 fallback 包裹器；放進 `*Async.js` 再 import
// 會讓 `markListingOfflineSync` 這類 fallback 引數被誤判成真呼叫（詳見 crawlerWrites.js）。
import { noteRevisionBumpFailure } from "./dataRevisionHealth.js";

const BUMP_SQL = "INSERT INTO data_revision (entity_type, entity_id, event_type, created_at) VALUES (?, ?, ?, ?)";
const BUMP_SQL_PG = "INSERT INTO data_revision (entity_type, entity_id, event_type, created_at) VALUES ($1, $2, $3, $4)";

export function revisionBumpParams({ entityType, entityId = null, eventType, now = Date.now() } = {}) {
  if (!entityType || !eventType) throw new Error("bumpRevision requires entityType and eventType");
  return [String(entityType), entityId == null ? null : Number(entityId), String(eventType), Number(now) || Date.now()];
}

// 在既有 PG 交易 client 上 bump（SAVEPOINT 隔離）。回傳是否成功；失敗只記錄、不往上丟。
export async function bumpRevisionPgClient(client, payload) {
  try {
    await client.query("SAVEPOINT revision_bump");
    await client.query(BUMP_SQL_PG, revisionBumpParams(payload));
    await client.query("RELEASE SAVEPOINT revision_bump");
    return true;
  } catch (error) {
    try {
      await client.query("ROLLBACK TO SAVEPOINT revision_bump");
    } catch {
      // 交易已不可用就讓外層處理
    }
    noteRevisionBumpFailure(error);
    return false;
  }
}

// 在注入式 exec（測試夾具／無交易）上 bump：無 SAVEPOINT（沒有交易可隔離）。
export async function bumpRevisionPgExec(exec, payload) {
  try {
    await exec(BUMP_SQL, revisionBumpParams(payload));
    return true;
  } catch (error) {
    noteRevisionBumpFailure(error);
    return false;
  }
}
