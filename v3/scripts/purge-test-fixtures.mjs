#!/usr/bin/env node
// 測試夾具清除腳本（2026-10-11）—— 清掉 live 測試誤寫進（正式）PG 的 `*@jibby.test` 夾具帳號與關聯列。
//
// 為什麼會有這支：
//   live 測試直接拿 `PG_TEST_URL` 當連線去寫，而本機／開發機的 `PG_TEST_URL` 就是**正式庫**
//   `5151_shadow`。2026-09-18 與 09-24 兩批留下了 25 個 `*@jibby.test` 夾具帳號
//   （`stage1.fixture.*@jibby.test` id 4–27、`live-fixture@jibby.test` id 710002）
//   與散在 10 張表的 444 筆關聯列。防呆（跑之前先過 `assertPgTargetAllowed`）在同一個 PR 補上；
//   這一支負責**把已經寫進去的清掉**。
//
// 用法：
//   PG_URL=<允許清單內的庫> node v3/scripts/purge-test-fixtures.mjs            # dry-run（預設）
//   PG_URL=<允許清單內的庫> node v3/scripts/purge-test-fixtures.mjs --apply    # 真的刪
//
// 安全（三重）：
//   1. 目標庫一律先過 `assertPgTargetAllowed()`；不在白名單（repro／tracker_test／repro2／
//      crawl_sandbox）就**拒絕執行**——正式庫 `5151_shadow` 預設被擋，除非明確設
//      `ALLOW_PRODUCTION_PG_TARGET=1`（本腳本不代設）。
//   2. **預設 dry-run**：只送 SELECT，一個字都不寫；要真的刪必須明講 `--apply`。
//   3. `--apply` 在同一個交易內依外鍵順序刪（先子表、最後 `users`），中途失敗整批 rollback。
//   連線字串本身不會被印出來（只印資料庫名稱）。
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";

export const PURGE_TOOL = "purge-test-fixtures";

/** 夾具帳號的樣式（`.test` 是保留 TLD，正式使用者不可能拿到）。 */
export const FIXTURE_EMAIL_LIKE = "%@jibby.test";

/**
 * 關聯表清單 ＝ **刪除順序**（子表在前、`users` 最後，才不會撞外鍵）。
 * 2026-10-11 對正式庫實測到的分佈（10 張表共 444 列）：
 *   user_events 292／rental_notify_deliveries 40／user_settings 43／demand_posts 28／
 *   listings.listed_by_user_id 8／self_listing_create_idempotency 8／rental_notify_events 16／
 *   rental_notify_prefs 4／wish_offers.owner_user_id 4／user_search_profiles 1。
 */
export const FIXTURE_SCOPES = Object.freeze([
  // rental_notify_deliveries.event_id → rental_notify_events.id ⇒ 先刪 deliveries
  { table: "rental_notify_deliveries", column: "user_id" },
  { table: "rental_notify_events", column: "user_id" },
  // wish_offers 指到 demand_posts／listings ⇒ 先刪 offers
  { table: "wish_offers", column: "owner_user_id" },
  { table: "self_listing_create_idempotency", column: "user_id" },
  { table: "user_events", column: "user_id" },
  { table: "user_settings", column: "user_id" },
  { table: "user_search_profiles", column: "user_id" },
  { table: "rental_notify_prefs", column: "user_id" },
  // 被誤建的業務列：先子表、後這些主體列
  { table: "demand_posts", column: "user_id" },
  { table: "listings", column: "listed_by_user_id" },
]);

const SELECT_FIXTURE_USERS_SQL = `SELECT id, email FROM users WHERE email ILIKE $1 ORDER BY id`;
const DELETE_FIXTURE_USERS_SQL = `DELETE FROM users WHERE email ILIKE $1`;

/** 逐表筆數（純 SELECT）。 */
export function countScopeSql(scope) {
  return `SELECT COUNT(*)::int AS count FROM ${scope.table}`
    + ` WHERE ${scope.column} IN (SELECT id FROM users WHERE email ILIKE $1)`;
}

/** 逐表刪除（外鍵順序由 FIXTURE_SCOPES 決定）。 */
export function deleteScopeSql(scope) {
  return `DELETE FROM ${scope.table}`
    + ` WHERE ${scope.column} IN (SELECT id FROM users WHERE email ILIKE $1)`;
}

export function selectFixtureUsersSql() {
  return SELECT_FIXTURE_USERS_SQL;
}

export function deleteFixtureUsersSql() {
  return DELETE_FIXTURE_USERS_SQL;
}

/** 刪除順序（含最後的 `users`）＝ 可離線斷言的計畫。 */
export function buildPurgePlan(scopes = FIXTURE_SCOPES) {
  return [
    ...scopes.map((scope) => ({ table: scope.table, column: scope.column, sql: deleteScopeSql(scope) })),
    { table: "users", column: "email", sql: DELETE_FIXTURE_USERS_SQL },
  ];
}

const rowsOf = (res) => (Array.isArray(res) ? res : (res?.rows || []));
const rowCountOf = (res) => Number(res?.rowCount ?? rowsOf(res).length) || 0;

/**
 * 產生報表；`apply === false` 時**只送 SELECT**。
 *
 * @param {{exec: (sql: string, params?: unknown[]) => Promise<unknown>, apply?: boolean,
 *          scopes?: readonly {table: string, column: string}[], pattern?: string,
 *          log?: (...args: unknown[]) => void}} opts
 *        `exec` 由呼叫端注入（CLI 給真的 driver，測試給假的），回傳 `{ rows, rowCount }`
 *        或直接回傳 rows 陣列（兩種都接受）。
 */
export async function runPurge({
  exec,
  apply = false,
  scopes = FIXTURE_SCOPES,
  pattern = FIXTURE_EMAIL_LIKE,
  log = (...args) => console.log(...args),
} = {}) {
  if (typeof exec !== "function") throw new Error("runPurge 需要注入 exec(sql, params)");

  const users = rowsOf(await exec(SELECT_FIXTURE_USERS_SQL, [pattern]));
  const counts = [];
  for (const scope of scopes) {
    const rows = rowsOf(await exec(countScopeSql(scope), [pattern]));
    counts.push({ table: scope.table, column: scope.column, rows: Number(rows[0]?.count) || 0 });
  }
  const total = counts.reduce((sum, entry) => sum + entry.rows, 0);

  log(`[purge] 夾具樣式：${pattern}`);
  log(`[purge] 夾具帳號 ${users.length} 筆：${users.length ? users.map((u) => u.id).join(", ") : "（沒有）"}`);
  for (const entry of counts) log(`[purge]   ${entry.table}.${entry.column} = ${entry.rows}`);
  log(`[purge] 關聯列合計 ${total}（10 張表）`);

  if (!apply) {
    log("[purge] DRY-RUN：以上全部是 SELECT，沒有送出任何寫入語句。要真的刪請加 --apply。");
    return { applied: false, users, counts, total, deleted: [] };
  }

  const deleted = [];
  for (const scope of scopes) {
    deleted.push({ table: scope.table, column: scope.column, rows: rowCountOf(await exec(deleteScopeSql(scope), [pattern])) });
  }
  deleted.push({ table: "users", column: "email", rows: rowCountOf(await exec(DELETE_FIXTURE_USERS_SQL, [pattern])) });
  const deletedTotal = deleted.reduce((sum, entry) => sum + entry.rows, 0);
  log(`[purge] APPLY：同一交易內刪除 ${deletedTotal} 列`);
  for (const entry of deleted) log(`[purge]   ${entry.table}.${entry.column} = ${entry.rows}`);
  return { applied: true, users, counts, total, deleted, deletedTotal };
}

const USAGE = [
  "用法：PG_URL=<允許清單內的庫> node v3/scripts/purge-test-fixtures.mjs [--apply]",
  "  預設 dry-run（只 SELECT、只列報表）；--apply 才真的刪（同一交易、外鍵順序）。",
  "  目標庫不在允許清單（repro／tracker_test／repro2／crawl_sandbox）一律拒絕。",
].join("\n");

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const unknown = argv.filter((flag) => flag !== "--apply");
  if (unknown.length) {
    // 未知旗標一律拒絕，不吃掉（被靜默忽略的旗標會讓「回報成功」變成假的）。
    console.error(`[purge] ✗ 不認識的參數：${unknown.join(" ")}\n${USAGE}`);
    return 2;
  }
  const apply = argv.includes("--apply");

  const url = String(process.env.PG_URL || process.env.PG_TEST_URL || "").trim();
  if (!url) {
    console.error(`[purge] ✗ 需要 PG_URL（或 PG_TEST_URL）\n${USAGE}`);
    return 2;
  }

  let db;
  try {
    db = assertPgTargetAllowed("purge-test-fixtures", url, { env: process.env });
  } catch (err) {
    console.error(`[purge] ✗ ${err && err.message ? err.message : err}`);
    console.error("[purge] ✗ 目標庫不在允許清單 ⇒ 拒絕執行（連 SELECT 都不做）");
    return 1;
  }

  console.log(`[purge] 目標資料庫：${db}｜模式：${apply ? "APPLY（會真的刪）" : "DRY-RUN（只讀）"}`);
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const driver = await createPostgresDriver({ connectionString: url });
  try {
    if (apply) {
      await driver.withTransaction(async (client) => {
        await runPurge({ exec: (sql, params) => client.query(sql, params), apply: true });
      });
      console.log("[purge] ✓ 已提交（單一交易）");
    } else {
      await runPurge({ exec: (sql, params) => driver.query(sql, params), apply: false });
      console.log("[purge] ✓ dry-run 完成（未寫入任何資料）");
    }
  } finally {
    await driver.close();
  }
  return 0;
}

const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      console.error(`[purge] ✗ ${err && err.stack ? err.stack : err}`);
      process.exitCode = 1;
    });
}

export { main };
