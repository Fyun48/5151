// CRM 遞送 loop 本體（startCrmDeliveryLoop / startCrmDeliveryLoopAsync）的離線測試。
//
// 背景：PG 遷移後 CRM 遞送 worker 是「非路由殘留」之一——同步版 startCrmDeliveryLoop(opsDeliveryDb(), …)
// 只讀本機 SQLite 的 crm_outbox，PG 模式下佇列會永遠 pending。crmOutboxAsync.js 的 claim／sent／
// failure／stats／control 早已 driver-aware，缺的是 loop 本體與 server.js 的接線。
//
// 這一支釘住 loop 本體的行為（env 閘門、stop 函式、注入的 ops、local_stopped 短路、不重入），
// 並驗證新的 startCrmDeliveryLoopAsync 在 PG 模式下確實把 PG 的 crm_outbox 送出去。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-crm-loop-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file locked while the process holds it.
  }
});

const crmDelivery = await import("../src/crmDelivery.js");
const crmOutboxAsync = await import("../src/crmOutboxAsync.js");
const crmOutbox = await import("../src/crmOutbox.js");
const app = await import("../src/db.js");

const db = app.sqliteHandle();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function envOn(overrides = {}) {
  return {
    OPS_CRM_DELIVERY: "1",
    OPS_INGEST_URL: "http://127.0.0.1:9/ops/api/ingest/crm",
    OPS_INGEST_SECRET: "secret",
    OPS_CRM_DELIVERY_INTERVAL_MS: "5",
    ...overrides,
  };
}

// 假 store：記錄 call 次數，claim 回一筆待送的 row。用來釘 loop 本體的行為（不碰真實 DB）。
function fakeOps({ stopped = async () => false, claimDelayMs = 0 } = {}) {
  const calls = { claim: 0, sent: 0, failure: 0, stopped: 0 };
  return {
    calls,
    store: {
      stopped: async () => { calls.stopped += 1; return stopped(); },
      claim: async () => {
        calls.claim += 1;
        if (claimDelayMs) await sleep(claimDelayMs);
        return [{ id: 7, payload: '{"delivery_id":"d-7"}', delivery_id: "d-7", attempts: 0, max_attempts: 8 }];
      },
      sent: async () => { calls.sent += 1; },
      failure: async () => { calls.failure += 1; },
      stats: async () => ({ pending: 0, sending: 0, sent: 0, failed: 0, dead: 0, total: 0 }),
    },
  };
}

test("未啟用或未設定 URL/secret 時 loop 是 no-op（不開 interval、不碰 ops）", async () => {
  for (const env of [
    envOn({ OPS_CRM_DELIVERY: "0" }),
    envOn({ OPS_INGEST_URL: "" }),
    envOn({ OPS_INGEST_SECRET: "" }),
  ]) {
    const fake = fakeOps();
    const stop = crmDelivery.startCrmDeliveryLoop(null, env, { ops: fake.store });
    await sleep(15);
    stop();
    assert.equal(fake.calls.claim, 0, "未啟用時不該 claim");
    assert.equal(fake.calls.stopped, 0, "未啟用時不該問 stopped（no-op 根本沒開 interval）");
  }
});

test("啟用時 loop 用注入的 ops 遞送（claim→sent→log 摘要）", async () => {
  const fake = fakeOps();
  const logs = [];
  const stop = crmDelivery.startCrmDeliveryLoop(null, envOn(), {
    fetchImpl: async () => ({ status: 200 }),
    log: (tag, info) => logs.push({ tag, info }),
    ops: fake.store,
  });
  try {
    await sleep(60);
    assert.ok(fake.calls.claim >= 1, "至少要 tick 一次並 claim");
    assert.ok(fake.calls.sent >= 1, "成功的遞送要走 ops.sent");
    assert.ok(logs.length >= 1, "有 claim 就要 log 摘要");
    assert.equal(logs[0].tag, "ops-crm-delivery");
    assert.equal(typeof logs[0].info.sent, "number");
  } finally {
    stop();
  }
});

test("local_stopped 為真時 tick 短路（問過 stopped 但永不 claim）", async () => {
  const fake = fakeOps({ stopped: async () => true });
  const stop = crmDelivery.startCrmDeliveryLoop(null, envOn(), { ops: fake.store });
  try {
    await sleep(20);
    assert.equal(fake.calls.claim, 0);
    assert.ok(fake.calls.stopped >= 1, "要真的問過 stopped");
  } finally {
    stop();
  }
});

test("不重入：一個 tick 未完成時不開第二個（claim 被串行化）", async () => {
  const fake = fakeOps({ claimDelayMs: 15 });
  const stop = crmDelivery.startCrmDeliveryLoop(null, envOn(), {
    fetchImpl: async () => ({ status: 200 }),
    ops: fake.store,
  });
  try {
    await sleep(50);
    // claim 每次至少 15ms；可重入的話 50ms/5ms ≈ 10 次並行 claim，串行應只有 3～4 次。
    assert.ok(fake.calls.claim >= 1, "至少要 tick 一次");
    assert.ok(fake.calls.claim <= 6, `claim 次數應受限於不重入（實際 ${fake.calls.claim}）`);
  } finally {
    stop();
  }
});

// PostgreSQL exec 的離線替身（同 crm-parity.test.js 的 pgShimOn）：$n → ?，跑同一個 SQLite fixture。
function pgShimOn(handle) {
  return async (sql, params = []) => {
    const text = String(sql).replace(/\$(\d+)/g, "?");
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(text.trim())) { handle.exec(text.trim()); return []; }
    const statement = handle.prepare(text);
    const isRead = /^\s*(select|with)/i.test(text) || /returning/i.test(text);
    if (isRead) {
      const rows = statement.all(...params);
      rows.rowCount = Array.isArray(rows) ? rows.length : 0;
      return rows;
    }
    const info = statement.run(...params);
    const out = [];
    out.rowCount = Number(info && info.changes) || 0;
    return out;
  };
}

test("startCrmDeliveryLoopAsync（PG 模式）把 crm_outbox 送出去", async () => {
  crmOutbox.ensureCrmOutboxSchema(db);
  db.prepare("DELETE FROM crm_outbox").run();
  const seeded = crmOutbox.enqueueCrmOutbox(db, { contactId: 424242, data: { loop: true }, now: new Date(Date.now() - 60_000) });
  assert.ok(seeded, "fixture 要能排進一筆");

  const pgOptions = { driver: "postgres", exec: pgShimOn(db), strict: true };
  const stop = crmOutboxAsync.startCrmDeliveryLoopAsync(envOn(), {
    fetchImpl: async () => ({ status: 200 }),
    options: pgOptions,
  });
  try {
    await sleep(80);
    const row = db.prepare("SELECT status, contact_id FROM crm_outbox WHERE contact_id = 424242").get();
    assert.equal(row.status, "sent", "loop 要走 PG 路徑把該列標成 sent（走本機同步版就會 pending 到底）");
  } finally {
    stop();
  }
});
