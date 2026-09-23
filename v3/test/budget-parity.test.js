// 2.4 parity：provider／budget store 在兩個 driver 上要走出一樣的結果。
//
// 三段：
//   1. sqlite 模式：budgetStore（async 介面）與 budgetGuard.js 的同步函式輸出相同。
//   2. postgres 路徑（離線 exec 替身）：reserve→settle／release／hold 的「桶子三個數字 ＋
//      reservation 狀態 ＋ usage log ＋ 後台 payload」與 sqlite 路徑逐項相同。
//   3. live（PG_TEST_URL）：影子站真的跑一輪 reserve→settle、重播（reused）與 reserve→release。
//
// ⚠️ 金額路徑的重點不是「有沒有紅」，而是兩邊的**數字**要一模一樣，所以步驟紀錄把
// bucket 的 (limit, reserved, settled) 與 reservation.job_state 全部寫進字串比對。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-budget-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows keeps the file locked */
  }
});

const app = await import("../src/db.js");
const budget = await import("../src/budgetGuard.js");
const budgetAsync = await import("../src/budgetGuardAsync.js");
const budgetStoreModule = await import("../src/budgetStore.js");

const db = app.sqliteHandle();
budget.ensureBudgetSchema(db);

// SQLite 當 PG 的離線替身：$n 還原成 ?，有 RETURNING 的走 all()（node:sqlite 支援）。
function shim(sql, params = []) {
  const text = String(sql).replace(/\$(\d+)/g, "?");
  const statement = db.prepare(text);
  if (/^\s*(select|with)/i.test(text) || /returning/i.test(text)) return statement.all(...params);
  statement.run(...params);
  return [];
}
const pgOptions = { driver: "postgres", exec: shim, strict: true, sqliteHandle: db };

const CAT = "scraping_api";
const NOW = new Date("2026-09-23T04:00:00.000Z");
const DAY = "2026-09-23";
const MONTH = "2026-09";

function resetBudgetFixture() {
  db.prepare("DELETE FROM call_reservations").run();
  db.prepare("DELETE FROM provider_usage_logs").run();
  db.prepare("DELETE FROM budget_limits").run();
  db.prepare("DELETE FROM settings WHERE key LIKE 'budget_site%'").run();
}

function bucketNumbers(scopeKind = "category", scopeKey = CAT, periodKey = DAY) {
  const row = db.prepare(`SELECT limit_minor, reserved_minor, settled_minor FROM budget_limits
    WHERE scope_kind = ? AND scope_key = ? AND period_key = ?`).get(scopeKind, scopeKey, periodKey);
  return row ? `${Number(row.limit_minor)}/${Number(row.reserved_minor)}/${Number(row.settled_minor)}` : "none";
}

function usageLogCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM provider_usage_logs").get().n;
}

// 同一串步驟餵給「sqlite store」或「PG store（離線替身）」。
async function drive(store) {
  resetBudgetFixture();
  const steps = [];
  const saved = await store.saveConfig(
    { category: CAT, provider_code: "stub_paid", is_enabled: true, daily_budget_twd: 20, monthly_budget_twd: 100, ceiling_twd: 1 },
    { now: NOW },
  );
  steps.push(`save:${saved.provider_code}/${saved.is_enabled}/${saved.daily_budget_twd}/${saved.ceiling_twd}`);

  const first = await store.reserve({ category: CAT, ceilingMinor: budget.TWD_MINOR, requestId: "p1", attemptId: "a1", now: NOW });
  steps.push(`reserve1:${first.ok}/${first.reserved_minor}/day=${bucketNumbers()}/month=${bucketNumbers("category", CAT, MONTH)}`);

  // 同一個 (request_id, attempt_id) 重播：要沿用原本那筆，不可再扣一次額度。
  const replay = await store.reserve({ category: CAT, ceilingMinor: budget.TWD_MINOR, requestId: "p1", attemptId: "a1", now: NOW });
  steps.push(`replay:${replay.ok}/${replay.reused}/${replay.reservation.job_state}/day=${bucketNumbers()}`);

  const settled = await store.settle(first.reservation, 500_000, { category: CAT, now: NOW });
  steps.push(`settle:${settled.ok}/${settled.settled_minor}/${settled.reservation.job_state}/day=${bucketNumbers()}`);

  const second = await store.reserve({ category: CAT, ceilingMinor: budget.TWD_MINOR, requestId: "p2", attemptId: "a1", now: NOW });
  steps.push(`reserve2:${second.ok}/day=${bucketNumbers()}`);
  const released = await store.release(second.reservation, { category: CAT, now: NOW });
  steps.push(`release:${released.ok}/${released.reservation.job_state}/day=${bucketNumbers()}`);

  const third = await store.reserve({ category: CAT, ceilingMinor: budget.TWD_MINOR, requestId: "p3", attemptId: "a1", now: NOW });
  const held = await store.hold(third.reservation, { category: CAT, now: NOW, note: "timeout" });
  steps.push(`hold:${held.ok}/${held.reservation.job_state}/day=${bucketNumbers()}`);
  const releaseHeld = await store.release(third.reservation, { category: CAT, now: NOW });
  steps.push(`releaseHeld:${releaseHeld.ok}/${releaseHeld.reason}`);

  // 日預算 20 TWD、已結算 0.5 TWD → 再預約 20 TWD 一定超額（且桶子不該被動到）。
  const overflow = await store.reserve({ category: CAT, ceilingMinor: budget.twdToMinor(20), requestId: "p4", attemptId: "a1", now: NOW });
  steps.push(`overflow:${overflow.ok}/${overflow.reason}/${overflow.limit_minor}/${overflow.settled_minor}/${overflow.held_minor}/day=${bucketNumbers()}`);

  // 日預算 0 → 直接 budget_zero（先把設定改成 0）。
  await store.saveConfig({ category: CAT, provider_code: "stub_paid", is_enabled: true, daily_budget_twd: 0, monthly_budget_twd: 0, ceiling_twd: 1 }, { now: NOW });
  const zero = await store.reserve({ category: CAT, ceilingMinor: budget.TWD_MINOR, requestId: "p5", attemptId: "a1", now: NOW });
  steps.push(`zero:${zero.ok}/${zero.reason}`);

  steps.push(`logs:${usageLogCount()}`);
  const named = await store.loadEnabled(CAT);
  steps.push(`loadEnabled:${named?.provider_code}/${named?.is_enabled}`);
  const cred = await store.readCredential(named);
  steps.push(`credential:${cred === "" ? "empty" : "present"}`);
  const admin = await store.listAdmin({ now: NOW });
  steps.push(`admin:${admin.items.map((item) => `${item.category}:${item.fuse}:${item.today_settled_twd}:${item.today_limit_twd}`).join("|")}`);
  steps.push(`adminLogs:${admin.logs.length}`);
  return steps;
}

test("sqlite 模式：budgetStore 與同步函式走出同一串結果", async () => {
  const viaStore = await drive(budgetStoreModule.budgetStore({ sqliteDb: db }));
  const viaSync = await drive({
    saveConfig: async (input, args) => budget.saveProviderConfig(db, input, args),
    reserve: async (args) => budget.reserveBudget(db, args),
    settle: async (reservation, usageMinor, args) => budget.settleBudget(db, reservation, usageMinor, args),
    release: async (reservation, args) => budget.releaseBudget(db, reservation, args),
    hold: async (reservation, args) => budget.holdBudget(db, reservation, args),
    listAdmin: async (args) => budget.listProviderAdmin(db, args),
    loadEnabled: async (category) => budget.loadEnabledProvider(db, category),
    readCredential: async (cfg) => budget.readCredential(db, cfg),
  });
  assert.deepEqual(viaStore, viaSync);
  assert.equal(viaStore[0], "save:stub_paid/true/20/1");
  assert.equal(viaStore[1], "reserve1:true/1000000/day=20000000/1000000/0/month=100000000/1000000/0");
});

test("postgres 路徑（離線 exec）與 sqlite 路徑的步驟紀錄完全相同", async () => {
  const viaPg = await drive(budgetStoreModule.budgetStore({ sqliteDb: db, options: pgOptions }));
  const viaSqlite = await drive(budgetStoreModule.budgetStore({ sqliteDb: db }));
  assert.deepEqual(viaPg, viaSqlite);
  assert.equal(viaPg[2], "replay:true/true/reserved/day=20000000/1000000/0");
  assert.equal(viaPg[3], "settle:true/500000/settled/day=20000000/0/500000");
  assert.equal(viaPg[5], "release:true/released/day=20000000/0/500000");
  assert.equal(viaPg[6], "hold:true/unknown/day=20000000/1000000/500000");
  assert.equal(viaPg[7], "releaseHeld:false/uncertain_charge");
  assert.match(viaPg[8], /^overflow:false\/budget_exceeded\/20000000\/500000\/1000000\/day=/);
  assert.equal(viaPg[9], "zero:false/budget_zero");
});

// ---------------------------------------------------------------------------
// live：影子站上真的跑一輪（會寫入真的 PG，跑完把自己建立的列刪乾淨）
// ---------------------------------------------------------------------------

test("live：預算 store 在 PostgreSQL 上真的保留、結算、釋放", async (t) => {
  const url = process.env.PG_TEST_URL;
  if (!url) {
    t.skip("PG_TEST_URL is not set (live budget store)");
    return;
  }
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const driver = await createPostgresDriver({ connectionString: url });
  const options = { driver: "postgres", pgDriver: driver, strict: true, sqliteHandle: db };
  const pgStore = budgetStoreModule.budgetStore({ sqliteDb: db, options });
  const startedAt = new Date().toISOString();
  const runId = `live-budget-${Date.now()}`;
  const now = new Date();
  try {
    const schema = await budgetAsync.ensureBudgetSchemaAsync(db, options);
    assert.equal(schema.driver, "postgres");

    // ON CONFLICT 需要的唯一索引（SQLite 的 UNIQUE 表約束不會被 pgSchema 鏡射）。
    const indexes = await driver.query(
      "SELECT indexname FROM pg_indexes WHERE indexname = ANY($1::text[])",
      [["budget_limits_scope_uniq", "call_reservations_request_uniq", "system_provider_configs_provider_uniq"]],
    );
    assert.equal(indexes.rows.length, 3, "PG 端要有三個 ON CONFLICT 用的唯一索引");

    const cfg = await pgStore.config("distance_matrix");
    assert.ok(cfg, "影子站應該有 distance_matrix 的設定列（匯入自正式站）");

    // 日／月限額用參數帶，不依賴影子站上的設定值（正式站的預設是 0＝不准花錢）。
    const reserved = await pgStore.reserve({
      category: "distance_matrix",
      ceilingMinor: 1,
      requestId: runId,
      attemptId: "a1",
      configId: cfg.id,
      dailyLimitMinor: budget.twdToMinor(20),
      monthlyLimitMinor: 0,
      now,
    });
    assert.equal(reserved.ok, true, "小額預約要成功（seq 未對齊時這裡會撞 pkey）");
    assert.ok(Number(reserved.reservation?.id) > 0);

    const settled = await pgStore.settle(reserved.reservation, 1, { category: "distance_matrix", now });
    assert.equal(settled.reservation.job_state, "settled");
    assert.equal(settled.settled_minor, 1);

    // 重播同一個 (request_id, attempt_id)：沿用原本那筆，不可再扣額度。
    const replay = await pgStore.reserve({
      category: "distance_matrix",
      ceilingMinor: 1,
      requestId: runId,
      attemptId: "a1",
      dailyLimitMinor: budget.twdToMinor(20),
      now,
    });
    assert.equal(replay.reused, true);

    const second = await pgStore.reserve({
      category: "distance_matrix",
      ceilingMinor: 1,
      requestId: `${runId}-2`,
      attemptId: "a1",
      configId: cfg.id,
      dailyLimitMinor: budget.twdToMinor(20),
      now,
    });
    assert.equal(second.ok, true);
    const released = await pgStore.release(second.reservation, { category: "distance_matrix", now });
    assert.equal(released.reservation.job_state, "released");

    const rows = await driver.query(
      "SELECT request_id, job_state FROM call_reservations WHERE request_id = ANY($1::text[]) ORDER BY request_id",
      [[runId, `${runId}-2`]],
    );
    assert.equal(rows.rows.length, 2, "兩筆預約都要真的寫進 PG");
    assert.deepEqual(rows.rows.map((row) => row.job_state), ["settled", "released"]);
  } finally {
    try {
      await driver.query("DELETE FROM call_reservations WHERE request_id = ANY($1::text[])", [[runId, `${runId}-2`]]);
      await driver.query("DELETE FROM provider_usage_logs WHERE category = 'distance_matrix' AND created_at >= $1", [startedAt]);
      // 影子站的 budget_limits 原本是空的（匯入後沒有任何桶子），所以把 distance_matrix 的桶子清掉
      // 就是回到原狀。若未來影子站開始有真實桶子，這段要改成只刪本次建立的 id。
      await driver.query("DELETE FROM budget_limits WHERE scope_key = 'distance_matrix'");
    } catch {
      /* 清不掉不影響上面的斷言 */
    }
    await driver.close();
  }
});