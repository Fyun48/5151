// PG 模式的「SQLite fallback」政策（2026-09-23）。
//
// 原本每個 *Async 模組在 PostgreSQL 失敗時**一律** fail-open 回本機 SQLite。對讀取那是合理的
// （寧可回舊資料也不要整個站 500），但對寫入會寫進**沒有任何人在讀**的 store＝無聲的資料分歧
// （2026-09-23 的 HA 演練就出現過寫入失敗的窗口，只是剛好沒有真的寫進 SQLite）。
//
// 這支測試釘住 sqliteFallback.js 的政策：
//   ① 寫入失敗 → 往上丟（絕不落回本機 SQLite）
//   ② 讀取失敗 → 仍 fail-open 回本機 SQLite
//   ③ PG_SQLITE_FALLBACK=open 或 options.fallback="open" → 緊急回退成舊行為
//   ④ options.strict=true → 一律往上丟
// 走的是模組的注入式 exec（options.exec），不連線、不需要 PG_TEST_URL。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureBudgetSchema, saveProviderConfig } from "../src/budgetGuard.js";
import { getProviderConfigAsync, reserveBudgetAsync } from "../src/budgetGuardAsync.js";
import { ensureListingSimilaritySchema, isPhashEnabled } from "../src/listingSimilarity.js";
import { isPhashEnabledAsync, savePhashSettingsAsync } from "../src/listingSimilarityAsync.js";
import { sqliteFallbackAllowed } from "../src/sqliteFallback.js";

const PG_DOWN = "simulated PostgreSQL outage";
const pgDown = () => {
  throw new Error(PG_DOWN);
};
const pgOptions = (extra = {}) => ({ driver: "postgres", exec: pgDown, ...extra });

function openBudget() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  ensureBudgetSchema(db);
  saveProviderConfig(db, {
    category: "scraping_api",
    provider_code: "stub_paid",
    is_enabled: true,
    daily_budget_twd: 20,
    monthly_budget_twd: 100,
    ceiling_twd: 1,
  });
  return db;
}

function openSimilarity() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  ensureListingSimilaritySchema(db);
  return db;
}

function reservationCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM call_reservations").get().n;
}

const RESERVE_ARGS = { category: "scraping_api", ceilingMinor: 100, requestId: "r-fallback", attemptId: "a-fallback" };

test("政策：讀取預設允許 fallback，寫入預設拒絕（未設 PG_SQLITE_FALLBACK）", () => {
  assert.equal(sqliteFallbackAllowed({}, { write: false, env: {} }), true);
  assert.equal(sqliteFallbackAllowed({}, { write: true, env: {} }), false);
  assert.equal(sqliteFallbackAllowed({}, { write: false, env: { PG_SQLITE_FALLBACK: "closed" } }), true);
  assert.equal(sqliteFallbackAllowed({}, { write: true, env: { PG_SQLITE_FALLBACK: "closed" } }), false);
});

test("政策：PG_SQLITE_FALLBACK=open 與 options.fallback='open' 連寫入都放行", () => {
  assert.equal(sqliteFallbackAllowed({}, { write: true, env: { PG_SQLITE_FALLBACK: "open" } }), true);
  assert.equal(sqliteFallbackAllowed({}, { write: true, env: { PG_SQLITE_FALLBACK: "OPEN " } }), true);
  assert.equal(sqliteFallbackAllowed({ fallback: "open" }, { write: true, env: {} }), true);
});

test("政策：strict=true 一律往上丟（連環境變數也壓不過）", () => {
  assert.equal(sqliteFallbackAllowed({ strict: true }, { write: false, env: {} }), false);
  assert.equal(sqliteFallbackAllowed({ strict: true }, { write: true, env: { PG_SQLITE_FALLBACK: "open" } }), false);
});

test("PG 模式寫入失敗（交易型入口）：往上丟，且不動本機 SQLite", async () => {
  const db = openBudget();
  const before = reservationCount(db);
  await assert.rejects(() => reserveBudgetAsync(db, RESERVE_ARGS, pgOptions()), new RegExp(PG_DOWN));
  assert.equal(reservationCount(db), before, "寫入失敗不得落回本機 SQLite");
});

test("PG 模式讀取失敗：仍回本機 SQLite 的答案（fail-open 保留給讀取）", async () => {
  const db = openBudget();
  const cfg = await getProviderConfigAsync(db, "scraping_api", pgOptions());
  assert.equal(cfg?.provider_code, "stub_paid");
});

test("緊急逃生門：PG_SQLITE_FALLBACK=open 時寫入回退成舊行為（真的寫進 SQLite）", async () => {
  const db = openBudget();
  process.env.PG_SQLITE_FALLBACK = "open";
  try {
    const result = await reserveBudgetAsync(db, RESERVE_ARGS, pgOptions());
    assert.equal(result?.ok, true, "回退到 SQLite 的預算保留應成功");
    assert.equal(reservationCount(db), 1);
  } finally {
    delete process.env.PG_SQLITE_FALLBACK;
  }
});

test("讀寫混合模組：寫入入口帶 write 旗標才擋住 fallback，讀取入口仍 fail-open", async () => {
  const db = openSimilarity();
  await assert.rejects(
    () => savePhashSettingsAsync({ phash_enabled: true }, pgOptions({ sqliteHandle: db })),
    new RegExp(PG_DOWN),
  );
  assert.equal(isPhashEnabled(db), false, "寫入失敗不得落回本機 SQLite");

  // 同一個呼叫加 fallback:"open" 就會落到 SQLite——證明擋住它的是 write 旗標，不是別的因素。
  const saved = await savePhashSettingsAsync({ phash_enabled: true }, pgOptions({ sqliteHandle: db, fallback: "open" }));
  assert.equal(saved?.phash_enabled, true);
  assert.equal(isPhashEnabled(db), true);

  // 讀取入口：PG 掛掉時回 SQLite 的答案。
  assert.equal(await isPhashEnabledAsync(pgOptions({ sqliteHandle: db })), true);
});
