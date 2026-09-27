// 2026-09-27 診斷能力的鎖：PG driver 必須在查詢失敗時記下「跑了多久」。
//
// 為什麼這條日誌是關鍵（不是為了好看）：
//   正式站 App 經由 HAProxy 連 PG，而 HAProxy 設了 `timeout client 30s` / `timeout server 30s`。
//   兩種完全不同的原因都會產生同一句 `Connection terminated unexpectedly`：
//     (a) 某個查詢本身跑超過 30 秒        → timeout server（要修查詢或調逾時）
//     (b) 拿到已被切斷的閒置連線才失敗     → timeout client（要修連線池）
//   沒有「失敗前跑了多久」這個欄位，兩者在日誌裡長得一模一樣，只能猜。
//   跑滿 ~30 秒 → (a)；幾乎瞬間失敗 → (b)。
//
// 這個檔用注入的假 `pg` 模組驗證那條日誌真的會出現、且真的含耗時與 SQL，
// 不需要真 PostgreSQL 就能跑。
import test from "node:test";
import assert from "node:assert/strict";

import { createPostgresDriver } from "../src/dbDriverPostgres.js";

// 假的 pg.Pool：可以指定 query 的行為（延遲、失敗、成功）。
function fakePg({ onQuery } = {}) {
  class FakePool {
    constructor() {
      this.handlers = {};
      this.ended = false;
    }
    on(event, handler) { this.handlers[event] = handler; return this; }
    emit(event, arg) { this.handlers[event]?.(arg); }
    async query(text, params) {
      if (onQuery) return onQuery(text, params);
      return { rows: [{ ok: 1 }], rowCount: 1 };
    }
    async connect() {
      return {
        query: (text, params) => this.query(text, params),
        release() {},
      };
    }
    async end() { this.ended = true; }
  }
  return { Pool: FakePool };
}

async function withCapturedWarnings(run) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return warnings;
}

async function makeDriver(pgOptions, env = {}) {
  return createPostgresDriver({
    connectionString: "postgres://user:secret@127.0.0.1:1/example",
    env: { PG_SLOW_QUERY_MS: "5", ...env },
    importPg: async () => fakePg(pgOptions),
  });
}

test("查詢失敗時必須記下耗時、錯誤訊息與 SQL（這是分辨兩種逾時的唯一依據）", async () => {
  const driver = await makeDriver({
    onQuery: async () => {
      await new Promise((r) => setTimeout(r, 25));
      throw new Error("Connection terminated unexpectedly");
    },
  });

  const warnings = await withCapturedWarnings(async () => {
    await assert.rejects(
      () => driver.query("SELECT * FROM listings WHERE post_id = $1", [1]),
      /Connection terminated unexpectedly/,
    );
  });

  assert.equal(warnings.length, 1, `應只有一筆警告，實際：${JSON.stringify(warnings)}`);
  const line = warnings[0];
  assert.match(line, /^\[pg\] failed query after \d+ms ::/);
  assert.match(line, /Connection terminated unexpectedly/);
  assert.match(line, /SELECT \* FROM listings WHERE post_id = \$1/);

  // 耗時必須是可讀的數字，而且要能分辨「跑滿 30 秒」與「瞬間失敗」。
  const ms = Number(/after (\d+)ms/.exec(line)[1]);
  assert.ok(ms >= 20, `耗時應反映實際等待（>=20ms），實際 ${ms}ms`);
});

test("錯誤必須原樣往上拋，instrumentation 不得改變行為", async () => {
  const boom = new Error("boom");
  const driver = await makeDriver({ onQuery: async () => { throw boom; } });
  await withCapturedWarnings(async () => {
    await assert.rejects(() => driver.query("SELECT 1"), (err) => err === boom);
  });
});

test("成功但超過門檻的查詢要留下 slow 記錄", async () => {
  const driver = await makeDriver({
    onQuery: async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { rows: [], rowCount: 0 };
    },
  });

  const warnings = await withCapturedWarnings(async () => {
    await driver.query("SELECT pg_sleep(1)");
  });

  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /^\[pg\] slow query \d+ms :: SELECT pg_sleep\(1\)/);
});

test("門檻以下的成功查詢不得產生任何日誌（避免洗版）", async () => {
  const driver = await makeDriver(
    { onQuery: async () => ({ rows: [], rowCount: 0 }) },
    { PG_SLOW_QUERY_MS: "60000" },
  );
  const warnings = await withCapturedWarnings(async () => {
    await driver.query("SELECT 1");
  });
  assert.deepEqual(warnings, []);
});

test("SQL 標籤必須壓成單行並截斷，避免一行日誌被整包 SQL 撐爆", async () => {
  const longSql = `SELECT ${"col, ".repeat(200)}1`;
  const driver = await makeDriver({ onQuery: async () => { throw new Error("x"); } });

  const warnings = await withCapturedWarnings(async () => {
    await assert.rejects(() => driver.query(`SELECT 1\n  FROM t\n  WHERE a = 1`));
    await assert.rejects(() => driver.query(longSql));
  });

  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /:: SELECT 1 FROM t WHERE a = 1$/);
  assert.ok(!warnings[0].includes("\n"), "不得含換行");
  const longLabel = warnings[1].split(":: ").pop();
  assert.ok(longLabel.length <= 220, `SQL 標籤應截斷，實際長度 ${longLabel.length}`);
});

test("閒置連線被切斷（pool error）必須留下日誌，不能只收進陣列", async () => {
  // 這正是假設 (b)（拿到已被 HAProxy 切斷的閒置連線）在正式站的可見訊號；
  // 先前它只被 push 進 poolErrors 而不寫日誌，等於完全看不到。
  let captured = null;
  const driver = await createPostgresDriver({
    connectionString: "postgres://user:secret@127.0.0.1:1/example",
    env: {},
    importPg: async () => {
      const pg = fakePg({});
      captured = pg;
      return pg;
    },
  });

  const warnings = await withCapturedWarnings(async () => {
    driver.pool.emit("error", new Error("Connection terminated unexpectedly"));
  });

  assert.equal(warnings.length, 1, JSON.stringify(warnings));
  assert.match(warnings[0], /idle pool connection error/);
  assert.match(warnings[0], /Connection terminated unexpectedly/);
  // 原本的行為仍要保留：錯誤要被收進 poolErrors 供診斷查詢。
  assert.equal(driver.poolErrors.length, 1);
  assert.equal(driver.poolErrors[0].message, "Connection terminated unexpectedly");
});
