// `v3/scripts/purge-test-fixtures.mjs` 的離線測試（2026-10-11）。
//
// 這一支**不需要任何資料庫**：`runPurge()` 的 `exec` 是注入的，測試用假的 exec 記錄「送出了哪些語句」，
// 就可以逐項斷言：
//   1. 目標庫不在允許清單（指向正式庫 `5151_shadow`）⇒ 拒絕執行，連一個語句都不送（連 SELECT 都不做）。
//   2. 預設 dry-run ⇒ **只送 SELECT**，沒有任何寫入語句。
//   3. `--apply` ⇒ 刪除順序＝外鍵順序（子表在前、`users` 最後），而且每個語句都是 DELETE。
//   4. 未知旗標一律拒絕（不被靜默吞掉）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  FIXTURE_EMAIL_LIKE,
  FIXTURE_SCOPES,
  buildPurgePlan,
  runPurge,
} from "../scripts/purge-test-fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(ROOT, "v3/scripts/purge-test-fixtures.mjs");
// 指向正式庫、但保證連不上的假字串（值本身不是憑證）。
const FAKE_PROD_URL = "postgres://x@127.0.0.1:1/5151_shadow";
// 這個檔案的測試完全離線，不需要 PG ⇒ 刻意不要出現連寫的那個環境變數名稱，
// 免得被 run-pg-integration.sh 的 `grep -rl` 收進 PG job（同樣的手法見 check-pg-collection.mjs）。
const PG_TEST_TARGET_KEY = "PG_TEST" + "_URL";

// 正式庫 2026-10-11 實測到的分佈（10 張表共 444 列）。
const PROD_COUNTS = Object.freeze({
  rental_notify_deliveries: 40,
  rental_notify_events: 16,
  wish_offers: 4,
  self_listing_create_idempotency: 8,
  user_events: 292,
  user_settings: 43,
  user_search_profiles: 1,
  rental_notify_prefs: 4,
  demand_posts: 28,
  listings: 8,
});
const FIXTURE_USERS = Object.freeze([
  ...Array.from({ length: 24 }, (_, i) => ({ id: i + 4, email: `stage1.fixture.${i}@jibby.test` })),
  { id: 710002, email: "live-fixture@jibby.test" },
]);

/** 假的 exec：記錄送出的語句，依語句回傳對應的列數。 */
function fakeExec() {
  const statements = [];
  const exec = async (sql, params) => {
    statements.push({ sql, params });
    if (/^SELECT id, email FROM users/.test(sql)) return { rows: FIXTURE_USERS, rowCount: FIXTURE_USERS.length };
    const table = /FROM ([a-z_]+)/.exec(sql)?.[1];
    if (/^DELETE FROM users/.test(sql)) return { rows: [], rowCount: FIXTURE_USERS.length };
    if (/^DELETE FROM/.test(sql)) return { rows: [], rowCount: PROD_COUNTS[table] ?? 0 };
    if (/^SELECT COUNT/.test(sql)) return { rows: [{ count: PROD_COUNTS[table] ?? 0 }], rowCount: 1 };
    throw new Error(`不該送出的語句：${sql}`);
  };
  return { exec, statements };
}

test("dry-run：只送 SELECT，一個寫入語句都沒有，而且報表列出 id 與逐表筆數", async () => {
  const { exec, statements } = fakeExec();
  const lines = [];
  const result = await runPurge({ exec, apply: false, log: (...args) => lines.push(args.join(" ")) });

  assert.equal(result.applied, false);
  assert.equal(result.users.length, 25, "要列出 25 個夾具帳號");
  assert.equal(result.total, 444, "10 張表合計 444 列");
  for (const entry of result.counts) assert.equal(entry.rows, PROD_COUNTS[entry.table]);

  assert.equal(statements.length, 1 + FIXTURE_SCOPES.length, "只查帳號與 10 張表的筆數");
  for (const { sql } of statements) {
    assert.match(sql, /^SELECT /, `dry-run 只能送 SELECT：${sql}`);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|CREATE|TRUNCATE|ALTER)\b/i, `dry-run 不得有寫入：${sql}`);
  }
  for (const { params } of statements) assert.deepEqual(params, [FIXTURE_EMAIL_LIKE]);

  const report = lines.join("\n");
  assert.match(report, /DRY-RUN/);
  assert.match(report, /夾具帳號 25 筆/);
  assert.match(report, /710002/);
  assert.match(report, /%@jibby\.test/);
  assert.match(report, /關聯列合計 444/);
  assert.match(report, /user_events\.user_id = 292/);
  assert.match(report, /listings\.listed_by_user_id = 8/);
});

test("--apply：刪除順序＝外鍵順序（子表在前、users 最後），且每個語句都是 DELETE", async () => {
  const { exec, statements } = fakeExec();
  const result = await runPurge({ exec, apply: true, log: () => {} });

  assert.equal(result.applied, true);
  const deletes = statements.filter(({ sql }) => sql.startsWith("DELETE"));
  assert.equal(deletes.length, FIXTURE_SCOPES.length + 1);
  for (const { sql } of deletes) assert.match(sql, /^DELETE FROM /);

  const order = deletes.map(({ sql }) => /^DELETE FROM ([a-z_]+)/.exec(sql)[1]);
  assert.deepEqual(order, [...FIXTURE_SCOPES.map((scope) => scope.table), "users"]);
  assert.equal(order.at(-1), "users", "users 必須最後刪（外鍵）");
  // 具體的關鍵次序：deliveries 先於 events、offers 先於 demand_posts、idempotency 先於 listings。
  assert.ok(order.indexOf("rental_notify_deliveries") < order.indexOf("rental_notify_events"));
  assert.ok(order.indexOf("wish_offers") < order.indexOf("demand_posts"));
  assert.ok(order.indexOf("self_listing_create_idempotency") < order.indexOf("listings"));

  assert.equal(result.deletedTotal, 444 + 25, "10 張表 444 列 ＋ 25 個帳號");
  // 報表／計畫是同一個順序（避免兩邊各寫一份而漂移）。
  assert.deepEqual(buildPurgePlan().map((step) => step.table), order);
});

test("buildPurgePlan：每一張表都指名使用者欄位，而且樣式是 .test 保留 TLD", () => {
  const plan = buildPurgePlan();
  assert.equal(plan.length, 11);
  assert.deepEqual(plan.slice(0, -1).map((step) => step.table), FIXTURE_SCOPES.map((scope) => scope.table));
  assert.equal(plan.find((step) => step.table === "wish_offers").column, "owner_user_id");
  assert.equal(plan.find((step) => step.table === "listings").column, "listed_by_user_id");
  for (const step of plan.slice(0, -1)) assert.match(step.sql, /\$1/);
  assert.equal(FIXTURE_EMAIL_LIKE, "%@jibby.test");
});

function runCli(args, { env = {} } = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, PG_URL: "", [PG_TEST_TARGET_KEY]: "", ALLOW_PRODUCTION_PG_TARGET: "", ...env },
  });
  return { status: res.status, out: `${res.stdout || ""}${res.stderr || ""}` };
}

test("拒絕：PG_URL 指向 5151_shadow 時，dry-run 與 --apply 都在連線前就被擋（不做任何查詢）", () => {
  for (const args of [[], ["--apply"]]) {
    const { status, out } = runCli(args, { env: { PG_URL: FAKE_PROD_URL } });
    assert.equal(status, 1, `應該 exit 1：${out}`);
    assert.match(out, /不在允許清單/, "要明講為什麼被擋");
    assert.doesNotMatch(out, /ECONNREFUSED/, "必須在建立連線之前就擋下來");
    assert.ok(!out.includes(FAKE_PROD_URL), "不得把連線字串印出來");
  }
});

test("拒絕：完全沒有給 PG_URL 時不猜目標（exit 2）", () => {
  const { status, out } = runCli([]);
  assert.equal(status, 2);
  assert.match(out, /需要 PG_URL/);
});

test("拒絕：未知旗標不被靜默吞掉（exit 2 並指名那個旗標）", () => {
  const { status, out } = runCli(["--appply"], { env: { PG_URL: FAKE_PROD_URL } });
  assert.equal(status, 2);
  assert.match(out, /--appply/);
});
