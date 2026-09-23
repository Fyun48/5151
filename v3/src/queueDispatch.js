// 佇列的分派入口（2.3a）：依 DB_DRIVER 決定用 PostgreSQL 版或 SQLite 版的 job 佇列。
//
// jobQueue.js 裡的 createJobQueue() 兩種實作都有，但先前沒有任何呼叫端（等於寫好沒接線）。
// 這個模組負責「拿 driver、拿連線、回傳對應實作」，呼叫端只認 queue 介面：
//   enqueue / claim / complete / fail / reclaimExpired
import { resolveDbDriver } from "./dbDriver.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { createJobQueue, ensurePgJobQueueIndex } from "./jobQueue.js";

export async function jobQueueFor({ driver = null, sqliteDb = null, pgPool = null } = {}) {
  const target = driver || resolveDbDriver();
  if (target === "postgres") {
    const pool = pgPool || (await sharedPgDriver());
    await ensurePgJobQueueIndex(pool);
    return createJobQueue({ driver: "postgres", pgPool: pool });
  }
  const handle = sqliteDb || (await import("./db.js")).sqliteHandle();
  return createJobQueue({ driver: "sqlite", sqliteDb: handle });
}

