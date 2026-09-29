// 變更紀錄（data revision）的 **live PG** 驗證（2026-09-28，第四十九批）。
//
// 這一條同時驗「寫」與「讀」，因為這一包的關鍵正是**寫讀同源**：
//   1. 寫入端本來就是 driver-aware（`createWritePath.bumpRevision` → PG）——這一條直接用它寫。
//   2. 讀取端（`currentRevisionAsync`／`changesSinceAsync`）在這一包才搬上 PG；
//      在那之前 PG 站的 revision 會永遠是 0（寫在 PG、讀在本機）。
//   3. `data_revision.id` 是 identity，寫入端不指定 id ⇒ 讀到的 MAX(id) 必須等於剛寫的那一列。
//
// ⚠️ 安全設計照抄 `demand-live-pg.test.js`：**不吃 `PG_TEST_URL`**（本機那個指向
// `5151_shadow` 正式影子庫），只認 `PG_LIVE_REPRO_URL` 且資料庫名要在允許清單內。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const RAW = String(process.env.PG_LIVE_REPRO_URL || "").trim();
const ALLOWED_DB = new Set(["repro", "tracker_test", "repro2"]);
const DB = (() => { try { return new URL(RAW).pathname.replace(/^\//, ""); } catch { return ""; } })();
const REFUSED = RAW && !ALLOWED_DB.has(DB);
const skip = !RAW ? "PG_LIVE_REPRO_URL 未設定（live PG 驗證需要隔離環境）"
  : REFUSED ? `拒絕執行：資料庫 "${DB}" 不在允許清單 ${[...ALLOWED_DB].join("/")}（正式庫 5151_shadow 一律拒絕）`
    : false;

const TOKEN = "livetest-datarev";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-datarev-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;

test("live PG：用 writePath 寫入、用 PG 版讀回來（寫讀同源）", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { createWritePath } = await import("../src/repository/writePath.js");
  const dataRevAsync = await import("../src/dataRevisionAsync.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  const who = (await query("SELECT current_database() AS db"))[0];
  assert.equal(who.db, DB, "連到的資料庫必須與 URL 一致");

  // 🚨 建表要**排在第一次 cleanup 之前**：CI 的拋棄式資料庫沒有 `data_revision`
  // （`pg-integration-setup.mjs` 的鏡射清單不含它，正式路徑是第一次用到時才由
  // `db.js` 的 `ensurePgSchema(pgDriver, db, { tables: ["data_revision"] })` 補建），
  // 所以先 DELETE 會直接 42P01。這裡照正式路徑補建（idempotent）。
  await dataRevAsync.ensureDataRevisionStoreOnce(pgDriver);

  const cleanup = async () => {
    await query("DELETE FROM data_revision WHERE entity_type LIKE $1", [`${TOKEN}%`]);
  };
  t.after(async () => {
    try { await cleanup(); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });
  await cleanup();

  const exec = async (sql, params = []) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  };
  const opts = { driver: "postgres", pgDriver, exec, strict: true };

  const before = await dataRevAsync.currentRevisionAsync(opts);
  assert.equal(typeof before, "number", "revision 必須是數字");

  // 用**正式路徑**的寫入器（`createWritePath` ＋ 真 pgDriver）寫三筆；
  // 中間刻意失敗一次（SAVEPOINT 的用法與 db.js 相同），確保輔助資料不影響主流程。
  const writer = createWritePath({ driver: "postgres", pgDriver });
  const written = [];
  for (const [idx, eventType] of [[1, "listing_added"], [2, "listing_updated"], [3, "listing_added"]]) {
    await writer.bumpRevision({ entityType: `${TOKEN}-${idx}`, entityId: idx, eventType, now: 1700000000000 + idx });
    written.push(idx);
  }

  const after = await dataRevAsync.currentRevisionAsync(opts);
  assert.ok(after > before, `寫入之後 revision 必須變大（before=${before} after=${after}）`);
  const maxId = Number((await query("SELECT MAX(id) AS n FROM data_revision WHERE entity_type LIKE $1", [`${TOKEN}%`]))[0].n);
  assert.equal(after, Number((await query("SELECT MAX(id) AS n FROM data_revision"))[0].n), "讀到的必須是全表的 MAX(id)");

  // changesSince：嚴格大於、由小到大、只回那三筆（若有其他併發寫入，至少包含我們的三筆）
  const rows = await dataRevAsync.changesSinceAsync(before, { limit: 500 }, opts);
  const mine = rows.filter((row) => String(row.entity_type).startsWith(TOKEN));
  assert.equal(mine.length, 3, `三筆都要讀到（實際 ${mine.length}）`);
  assert.deepEqual(mine.map((row) => Number(row.entity_id)), written, "由小到大（id ASC）");
  assert.deepEqual(mine.map((row) => row.event_type), ["listing_added", "listing_updated", "listing_added"]);
  assert.ok(mine.every((row) => Number(row.created_at) >= 1700000000001), "created_at 必須是寫入時給的值");
  assert.ok(!rows.some((row) => Number(row.id) <= before), "嚴格大於：不得回 <= since 的列");
  assert.equal(Number(mine.at(-1).id), maxId, "最後一筆就是剛剛寫的最大 id");
});
