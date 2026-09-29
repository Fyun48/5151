// 許願房建立（`POST /api/demand` ＋ `POST /api/wish-rooms`）的 **live PG** 驗證（2026-09-29 第六十五批）。
//
// 離線 parity 用的是記憶體 SQLite 替身，證明不了四件事——而它們正好是這一包的核心風險：
//
//   1. **`INSERT … RETURNING id` 在真 PG 上真的要回 id**（同步版靠 SQLite 的 `lastInsertRowid`；
//      PG 沒有那個東西）。
//   2. **「一人一則」的部分唯一索引真的存在於 PG**：離線夾具是測試自己 `CREATE UNIQUE INDEX`
//      造出來的，正式庫要靠 `ensureDemandStoreOnce()` 的 `ensurePgSchema(…, indexes: true)`。
//      少了它，**並發**建立兩則公開許願房都會成功（站上就出現兩則）。
//   3. **23505 的訊息要對得上索引名**：`isUniqueUserConstraint()` 只在訊息含
//      `idx_demand_one_(open|draft|mutable)` 時才把它當成「一人一則」；PG 的訊息是英文的
//      `duplicate key value violates unique constraint "…"`，只有在真 PG 上才驗得到這個對應。
//      這條用**真的並發**（`Promise.allSettled`）走 23505，不是靠先查再擋。
//   4. **建立是原子的**：注入「lifecycle UPDATE 一定失敗」的同一個交易物件，列**不得**留著。
//
// ⚠️ 安全設計照抄 `demand-live-pg.test.js`：**不吃 `PG_TEST_URL`**（本機那個指向 `5151_shadow`
// 正式影子庫），只認 `PG_LIVE_REPRO_URL` 且資料庫名要在允許清單內。
// `demand_posts`／`users` 是共用表，所以只碰自己那三個測試帳號。
//
// ⚠️ 這一檔必須**序列**執行（`node --test --test-concurrency=1 …`，也就是
// `v3/scripts/run-pg-integration.sh` 的預設）：它與 `demand-live-pg.test.js` 共用同一張
// `demand_posts`，並行時別的檔的 `setval`／清理會插進來（實測：並行時這一檔會紅）。
// 其中一項刻意用**真的並發**（`Promise.allSettled`）驗 23505，那是本檔內部的並發，不受影響。
import { after, test } from "node:test";
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

const OLD = "2026-01-01T00:00:00.000Z";
const USER_SERIAL = 772101;   // 單筆建立
const USER_RACE = 772102;     // 並發建立（23505）
const USER_ATOMIC = 772103;   // 交易回滾
const USERS = [USER_SERIAL, USER_RACE, USER_ATOMIC];
const WISH_INPUT = { districts: ["1-8"], body: "live PG 建立測試：找士林區兩房", rent_max: 30000 };

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-demandcreate-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

test("live PG：建立許願房（RETURNING id、部分唯一索引的 23505、交易原子性）", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const demandAsync = await import("../src/demandAsync.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  const who = (await query("SELECT current_database() AS db"))[0];
  assert.equal(who.db, DB, "連到的資料庫必須與 URL 一致");

  const cleanup = async () => {
    await query("DELETE FROM demand_posts WHERE user_id = ANY($1)", [USERS]);
    await query("DELETE FROM users WHERE id = ANY($1)", [USERS]);
  };
  t.after(async () => {
    try { await cleanup(); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });
  await cleanup();
  for (const [table, column] of [["users", "id"], ["demand_posts", "id"]]) {
    await query(`SELECT setval(pg_get_serial_sequence($1, $2), GREATEST((SELECT COALESCE(MAX(${column}),0) FROM ${table}), 1))`, [table, column]);
  }
  await query(
    "INSERT INTO users(id, email, created_at) SELECT u, 'live-demandcreate-' || u || '@example.com', $2 FROM unnest($1::bigint[]) AS u",
    [USERS, OLD],
  );

  // ---- 0) 「一人一則」的部分唯一索引真的在 PG（靠 ensureDemandStoreOnce 補的）----
  const indexes = (await query(
    "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'demand_posts' AND indexname LIKE 'idx_demand_one_%'")).map((r) => r.indexname);
  for (const name of ["idx_demand_one_open", "idx_demand_one_mutable"]) {
    assert.ok(indexes.includes(name), `PG 必須有 ${name}（否則並發建立會出現兩則公開許願房）：${indexes.join(",")}`);
  }

  // ---- 1) 單筆建立：RETURNING id ＋ 落地內容 ----
  const created = await demandAsync.createDemandAsync(USER_SERIAL, WISH_INPUT, { driver: "postgres", pgDriver });
  assert.ok(Number(created.id) > 0, `RETURNING id 必須回一個真的 id，實際 ${created.id}`);
  assert.equal(created.status, "open");
  assert.deepEqual(created.districts, ["1-8"]);
  assert.ok(created.public_token, "建立後要拿得到 public_token（惰性補上並落地）");
  const row = (await query("SELECT * FROM demand_posts WHERE id = $1", [Number(created.id)]))[0];
  assert.ok(row, "PG 上必須真的有這一列");
  assert.equal(Number(row.user_id), USER_SERIAL);
  assert.equal(row.lifecycle, "active", "open 的許願房 lifecycle=active");
  assert.equal(row.public_token, created.public_token, "回傳的 token 必須與落地值相同");
  assert.ok(row.expires_at, "到期時間必須有值");

  // ---- 2) 並發建立：一則成功、一則必須被對應成 wish_active_limit（真的走 23505）----
  const settled = await Promise.allSettled([
    demandAsync.createDemandAsync(USER_RACE, WISH_INPUT, { driver: "postgres", pgDriver }),
    demandAsync.createDemandAsync(USER_RACE, WISH_INPUT, { driver: "postgres", pgDriver }),
  ]);
  const ok = settled.filter((r) => r.status === "fulfilled");
  const failed = settled.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1, `並發建立只能成功一次，實際成功 ${ok.length} 次`);
  assert.equal(failed.length, 1, "另一個必須失敗");
  assert.equal(failed[0].reason?.code, "wish_active_limit",
    `23505 必須被對應成 wish_active_limit（不是原始的唯一鍵錯誤）：${failed[0].reason?.message}`);
  const raceRows = await query("SELECT id FROM demand_posts WHERE user_id = $1 AND status = 'open'", [USER_RACE]);
  assert.equal(raceRows.length, 1, "並發之後不得留下兩則公開許願房");

  // ---- 3) 交易原子性：插入之後的語句失敗 ⇒ 整批回滾 ----
  const refusingDriver = {
    query: (sql, params) => pgDriver.query(sql, params),
    // `ensureDemandStoreOnce()` 會先跑 `ensurePgSchema()`（`CREATE TABLE IF NOT EXISTS` ＋ 索引），
    // 那條路用 `driver.exec()`；少了它會在 schema 階段就炸成 TypeError（第一版就是這樣）。
    exec: (sql) => pgDriver.exec(sql),
    withTransaction: (fn) => pgDriver.withTransaction((client) => fn({
      query: (sql, params) => (/UPDATE\s+demand_posts\s+SET\s+lifecycle/i.test(toPostgresSql(sql))
        ? Promise.reject(new Error("live-probe: lifecycle update refused"))
        : client.query(toPostgresSql(sql), params)),
    })),
  };
  await assert.rejects(
    () => demandAsync.createDemandAsync(USER_ATOMIC, WISH_INPUT, { driver: "postgres", pgDriver: refusingDriver }),
    /lifecycle update refused/,
  );
  const atomicRows = await query("SELECT id FROM demand_posts WHERE user_id = $1", [USER_ATOMIC]);
  assert.equal(atomicRows.length, 0,
    "同一個交易內的後續語句失敗時，INSERT 必須一起回滾（沒有回滾＝插入其實跑在交易外）");
});
