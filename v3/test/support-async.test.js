// Support 後台列表 PG 分支的 parity（2026-09-27）。
//
// 這一批是「卡點全部在 handler 內」那一群裡最大的——`support.js` 的六個列表函式，
// 形狀都是「一句 SELECT ＋ 一個純的列對應」。port 很短，所以測試要釘住容易漏的地方：
//
//   1. `listSupportTransactions` 的 `from`／`to` 是**選擇性**條件，參數順序與同步版必須一致；
//      順序寫錯會讓篩選悄悄失效（回傳全部，而且不會報錯）。
//   2. `listSupportSponsors` 的列對應吃 `now`（`sponsorRow(row, now)`）——時間沒固定就無法比對，
//      所以兩邊都注入同一個 `now`。
//   3. `listSupportTiers` 的 `activeOnly` 過濾 ＋ `sortSupportTiers` 排序。
//
// 純的列對應（`costRow` 等）留在 `support.js` 由兩邊共用，所以這裡比的是**整條路徑**
// （SQL → 對應 → 排序），不是只比 SQL。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-support-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const db = await import("../src/db.js");
const support = await import("../src/support.js");
const asyncMod = await import("../src/supportAsync.js");

const PG = { driver: "postgres" };
// 刻意選一個**與系統時鐘判定結果不同**的時間點：贊助商檔期是 2026-09-01～2026-12-31，
// 注入 2027-06-01 ⇒ 應該算「已過期」；若實作忘了把 now 傳進 sponsorRow，
// 它會用 `new Date()`（現在的系統時間，2026-09-27）算出「進行中」而被這條測試抓到。
const NOW = new Date("2027-06-01T00:00:00.000Z");
const diskPath = () => path.join(dataDir, "v3.db");
const TABLES = [
  "support_operating_cost", "support_tier", "support_provider",
  "support_transaction", "support_sponsor", "support_cta_rule",
];

const PG_ILLEGAL = [
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
  [/\bIFNULL\s*\(/i, "function ifnull(text, unknown) does not exist"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  [/\binstr\s*\(/i, "function instr(text, text) does not exist"],
];

// DDL 從真實 sqlite_master 複製。
function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  const rows = disk.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name IN (${TABLES.map(() => "?").join(",")})`,
  ).all(...TABLES);
  disk.close();
  for (const row of rows) if (row.sql) mem.exec(row.sql);
  assert.equal(rows.length, TABLES.length, `必須抓到全部 ${TABLES.length} 張表的 DDL（否則測試是空的）`);
  const exec = async (sql, params = []) => {
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    return mem.prepare(sql).all(...params);
  };
  exec.raw = mem;
  return exec;
}

// 用**真實欄位**種資料。欄位清單從 PRAGMA 推導，避免手寫漏欄位（本系列踩過）。
function seed(handle, table, values) {
  const info = handle.prepare(`PRAGMA table_info(${table})`).all();
  const names = Object.keys(values);
  for (const n of names) assert.ok(info.some((c) => c.name === n), `${table} 沒有欄位 ${n}`);
  const nullable = new Set(info.filter((c) => c.notnull === 0 || c.dflt_value !== null).map((c) => c.name));
  const missing = info.filter((c) => !names.includes(c.name) && c.notnull === 1 && c.dflt_value === null && c.pk === 0);
  for (const c of missing) {
    if (!nullable.has(c.name)) values[c.name] = /INT|REAL|NUM/i.test(c.type) ? 0 : "";
  }
  const cols = Object.keys(values);
  handle.prepare(`INSERT INTO ${table}(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(...cols.map((c) => values[c]));
}

function resetBoth() {
  const disk = new DatabaseSync(diskPath());
  const exec = pgFixture();
  for (const h of [disk, exec.raw]) {
    for (const t of [...TABLES].reverse()) h.prepare(`DELETE FROM ${t}`).run();
    // 磁碟 DB 在同檔的多個 test 之間共用，`DELETE` **不會**重置 AUTOINCREMENT 計數器，
    // 記憶體夾具卻是全新的 ⇒ 不歸零的話第二個 test 起 id 就兩邊不同（污染型假失敗）。
    // 這個坑本系列已經踩過一次（reject-match 那批），這裡照同一套處理。
    try {
      h.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${TABLES.map(() => "?").join(",")})`).run(...TABLES);
    } catch { /* 沒有 AUTOINCREMENT 表時 sqlite_sequence 不存在 */ }
  }
  return [disk, exec];
}

function seedAll(h) {
  seed(h, "support_operating_cost", { category: "hosting", name: "主機", amount: 1200, billing_cycle: "monthly", created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" });
  seed(h, "support_operating_cost", { category: "domain", name: "網域", amount: 400, billing_cycle: "yearly", created_at: "2026-09-02T00:00:00.000Z", updated_at: "2026-09-02T00:00:00.000Z" });
  seed(h, "support_tier", { title: "小額", amount: 100, sort_order: 2, is_active: 1, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" });
  seed(h, "support_tier", { title: "停用中", amount: 200, sort_order: 1, is_active: 0, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" });
  seed(h, "support_provider", { kind: "buy_me_a_coffee", display_name: "咖啡", is_default: 1, is_active: 1, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" });
  seed(h, "support_transaction", { provider: "buy_me_a_coffee", amount: 300, fee: 15, net_amount: 285, currency: "TWD", status: "succeeded", anonymous: 0, channel: "web", received_at: "2026-09-10T00:00:00.000Z", created_at: "2026-09-10T00:00:00.000Z", updated_at: "2026-09-10T00:00:00.000Z" });
  seed(h, "support_transaction", { provider: "buy_me_a_coffee", amount: 500, fee: 25, net_amount: 475, currency: "TWD", status: "succeeded", anonymous: 0, channel: "web", received_at: "2026-09-20T00:00:00.000Z", created_at: "2026-09-20T00:00:00.000Z", updated_at: "2026-09-20T00:00:00.000Z" });
  seed(h, "support_sponsor", { name: "贊助商甲", status: "active", sort_order: 1, start_at: "2026-09-01T00:00:00.000Z", end_at: "2026-12-31T00:00:00.000Z", created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" });
  seed(h, "support_cta_rule", { rule_type: "always", threshold: 0, priority: 1, enabled: 1, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" });
}

// ---------------------------------------------------------------------------

test("listSupportCostsAsync：逐列相同，且真的讀到資料", async () => {
  const [disk, exec] = resetBoth();
  seedAll(disk); seedAll(exec.raw);
  const a = await asyncMod.listSupportCostsAsync({ ...PG, exec });
  assert.deepEqual(a, support.listSupportCosts(disk));
  assert.equal(a.length, 2, "必須真的讀到 2 列（否則這條測試沒鑑別力）");
  disk.close();
});

test("listSupportTiersAsync：activeOnly 兩種情形都要與同步版相同", async () => {
  const [disk, exec] = resetBoth();
  seedAll(disk); seedAll(exec.raw);
  const all = await asyncMod.listSupportTiersAsync({}, { ...PG, exec });
  assert.deepEqual(all, support.listSupportTiers(disk));
  assert.equal(all.length, 2);
  const active = await asyncMod.listSupportTiersAsync({ activeOnly: true }, { ...PG, exec });
  assert.deepEqual(active, support.listSupportTiers(disk, { activeOnly: true }));
  assert.equal(active.length, 1, "activeOnly 必須真的過濾掉停用的那一筆");
  assert.equal(active[0].title, "小額");
  disk.close();
});

test("listSupportProvidersAsync：逐列相同", async () => {
  const [disk, exec] = resetBoth();
  seedAll(disk); seedAll(exec.raw);
  const a = await asyncMod.listSupportProvidersAsync({ ...PG, exec });
  assert.deepEqual(a, support.listSupportProviders(disk));
  assert.equal(a.length, 1);
  disk.close();
});

test("listSupportSponsorsAsync：注入同一個 now，逐列相同", async () => {
  const [disk, exec] = resetBoth();
  seedAll(disk); seedAll(exec.raw);
  const a = await asyncMod.listSupportSponsorsAsync({ now: NOW }, { ...PG, exec });
  assert.deepEqual(a, support.listSupportSponsors(disk, NOW));
  assert.equal(a.length, 1);
  // 證明 now 真的有被用上：sponsorRow 把解析結果放在 **`resolved_status`**（`status` 是原儲存值）。
  // 注入的時間已過檔期 ⇒ resolved_status 必須是 expired；忘了傳 now 就會用系統時鐘算出 active。
  assert.equal(a[0].resolved_status, "expired",
    "now 必須傳進 sponsorRow，否則 resolved_status 會用到系統時鐘");
  assert.equal(a[0].status, "active", "原儲存值不變（用來確認兩者是不同欄位）");
  disk.close();
});

test("listCtaRulesAsync：逐列相同", async () => {
  const [disk, exec] = resetBoth();
  seedAll(disk); seedAll(exec.raw);
  const a = await asyncMod.listCtaRulesAsync({ ...PG, exec });
  assert.deepEqual(a, support.listCtaRules(disk));
  assert.equal(a.length, 1);
  disk.close();
});

test("listSupportTransactionsAsync：from／to 篩選必須真的生效且與同步版相同", async () => {
  const [disk, exec] = resetBoth();
  seedAll(disk); seedAll(exec.raw);
  const cases = [
    {},
    { from: "2026-09-15T00:00:00.000Z" },
    { to: "2026-09-15T00:00:00.000Z" },
    { from: "2026-09-01T00:00:00.000Z", to: "2026-09-15T00:00:00.000Z" },
  ];
  for (const q of cases) {
    const a = await asyncMod.listSupportTransactionsAsync(q, { ...PG, exec });
    assert.deepEqual(a, support.listSupportTransactions(disk, q), `query=${JSON.stringify(q)}`);
  }
  // 篩選必須真的有作用——若參數順序寫錯，這裡會回傳全部而「兩邊一樣」照樣過關。
  const all = await asyncMod.listSupportTransactionsAsync({}, { ...PG, exec });
  const onlyFirst = await asyncMod.listSupportTransactionsAsync({ to: "2026-09-15T00:00:00.000Z" }, { ...PG, exec });
  assert.equal(all.length, 2);
  assert.equal(onlyFirst.length, 1, "to 篩選必須把 09-20 那筆排除掉");
  assert.equal(onlyFirst[0].received_at, "2026-09-10T00:00:00.000Z");
  disk.close();
});

test("非 postgres 必須回退同步路徑（讀磁碟，不是讀傳入的 exec）", async () => {
  const disk = new DatabaseSync(diskPath());
  for (const t of [...TABLES].reverse()) disk.prepare(`DELETE FROM ${t}`).run();
  seed(disk, "support_cta_rule", { rule_type: "always", threshold: 0, priority: 1, enabled: 1, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" });
  const exec = pgFixture();
  for (const t of [...TABLES].reverse()) exec.raw.prepare(`DELETE FROM ${t}`).run();
  seed(exec.raw, "support_cta_rule", { rule_type: "never", priority: 9, enabled: 0, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" });

  const a = await asyncMod.listCtaRulesAsync({ driver: "sqlite", exec });
  assert.equal(a.length, 1);
  assert.equal(a[0].rule_type, "always", "sqlite 模式必須讀磁碟，不可以讀傳入的 exec");
  assert.equal(exec.raw.prepare("SELECT rule_type FROM support_cta_rule").get().rule_type, "never",
    "sqlite 模式不得改動 PG 夾具");
  disk.close();
});

test("夾具本身要真的拒絕 SQLite 專屬語法", async () => {
  const exec = pgFixture();
  await assert.rejects(() => exec("SELECT 1 LIMIT -1 OFFSET 0"), /LIMIT must not be negative/);
  await assert.rejects(() => exec("SELECT IFNULL(rule_type,'') FROM support_cta_rule"), /function ifnull/);
});
