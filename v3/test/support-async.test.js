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
  "support_page_config", "support_event",
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
  // end_date 刻意**有值**：這樣「把 end_date 設成 null 是否真的清掉」才測得出來
  // （第一版留空 ⇒ 正確版與變異版都會得到 NULL，變異就活了下來）。
  seed(h, "support_operating_cost", { category: "hosting", name: "主機", amount: 1200, billing_cycle: "monthly", end_date: "2026-12-31", created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" });
  seed(h, "support_operating_cost", { category: "domain", name: "網域", amount: 400, billing_cycle: "yearly", created_at: "2026-09-02T00:00:00.000Z", updated_at: "2026-09-02T00:00:00.000Z" });
  // is_default 刻意設 1：這樣「建立新預設時有沒有把舊的歸零」才測得出來
  // （第一版全部是 0 ⇒ 不歸零也只會有一個預設，變異就活了下來）。
  seed(h, "support_tier", { title: "小額", amount: 100, sort_order: 2, is_active: 1, is_default: 1, created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z" });
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

// ---------------------------------------------------------------------------
// 寫入：比對**實際落地的資料列**
//
// 這幾條的重點在「順序」與「只改有給的欄位」：
//   - `is_default` 會先把同表其他列的 is_default 歸零，**再**寫入。順序顛倒會把剛設好的預設值清掉。
//   - `updateSupportCost` 的 `end_date !== undefined`：傳 `null` 是「清掉」，不傳是「保留」。
// 這些用回傳值比對不一定看得出來，所以一律比對落地列。

const tableOf = (h, t) => h.prepare(`SELECT * FROM ${t} ORDER BY id`).all();

test("createSupportCostAsync：落地的資料列必須與同步版相同（含日期預設）", async () => {
  const [disk, exec] = resetBoth();
  const body = { category: "hosting", name: "新主機", amount: 1500, billing_cycle: "monthly", is_public: 1, note: "備註" };
  const s = support.createSupportCost(disk, body, NOW);
  const a = await asyncMod.createSupportCostAsync(body, { ...PG, exec, now: NOW });
  assert.deepEqual(a, s, "回傳值必須相同");
  assert.deepEqual(tableOf(exec.raw, "support_operating_cost"), tableOf(disk, "support_operating_cost"),
    "落地的資料列必須逐欄相同");
  assert.equal(tableOf(disk, "support_operating_cost").length, 1, "必須真的寫入一列");
  disk.close();
});

test("updateSupportCostAsync：只改有給的欄位；end_date 傳 null 是清掉、不傳是保留", async () => {
  const [disk, exec] = resetBoth();
  seedAll(disk); seedAll(exec.raw);
  const first = tableOf(disk, "support_operating_cost")[0];

  // (a) 只改名稱
  const s1 = support.updateSupportCost(disk, first.id, { name: "改過的名字" }, NOW);
  const a1 = await asyncMod.updateSupportCostAsync(first.id, { name: "改過的名字" }, { ...PG, exec, now: NOW });
  assert.deepEqual(a1, s1);
  assert.deepEqual(tableOf(exec.raw, "support_operating_cost"), tableOf(disk, "support_operating_cost"));
  assert.equal(a1.amount, s1.amount, "沒給的欄位要沿用現值");

  // (b) end_date 明確傳 null ⇒ 清掉
  const s2 = support.updateSupportCost(disk, first.id, { end_date: null }, NOW);
  const a2 = await asyncMod.updateSupportCostAsync(first.id, { end_date: null }, { ...PG, exec, now: NOW });
  assert.deepEqual(a2, s2);
  // `costRow` 會把 null 映射成空字串（見 support.js:291），所以回傳值的 end_date 是 `""`；
  // 真正該斷言的是**底層欄位**被清成 NULL——那才是「清掉」的意思。
  assert.equal(a2.end_date, "", "costRow 會把 null 映射成空字串");
  assert.equal(tableOf(disk, "support_operating_cost").find((r) => r.id === first.id).end_date, null,
    "同步版：底層欄位必須是 NULL");
  assert.equal(tableOf(exec.raw, "support_operating_cost").find((r) => r.id === first.id).end_date, null,
    "PG 分支：底層欄位必須是 NULL");
  assert.deepEqual(tableOf(exec.raw, "support_operating_cost"), tableOf(disk, "support_operating_cost"));

  // (c) 找不到 ⇒ 404
  let syncErr = null, asyncErr = null;
  try { support.updateSupportCost(disk, 99999, {}, NOW); } catch (e) { syncErr = e; }
  try { await asyncMod.updateSupportCostAsync(99999, {}, { ...PG, exec, now: NOW }); } catch (e) { asyncErr = e; }
  assert.equal(asyncErr?.status, syncErr?.status, "404 的 status 必須相同");
  disk.close();
});

test("🚨 createSupportTierAsync：is_default 的『先歸零再寫入』順序必須正確", async () => {
  // 順序顛倒（先 INSERT 再歸零）會把剛設好的預設值清掉，而且**回傳值看起來還是對的**，
  // 所以一定要比對落地列。
  const [disk, exec] = resetBoth();
  seedAll(disk); seedAll(exec.raw);
  const body = { title: "新的預設方案", amount: 300, is_default: 1, is_active: 1 };
  const s = support.createSupportTier(disk, body, NOW);
  const a = await asyncMod.createSupportTierAsync(body, { ...PG, exec, now: NOW });
  assert.deepEqual(a, s);
  assert.deepEqual(tableOf(exec.raw, "support_tier"), tableOf(disk, "support_tier"), "落地列必須完全相同");
  const defaults = tableOf(disk, "support_tier").filter((r) => Number(r.is_default) === 1);
  assert.equal(defaults.length, 1, "全表只能有一個預設方案");
  assert.equal(defaults[0].title, "新的預設方案", "預設必須是剛建立的那一個（順序錯的話會變成沒有預設）");
  disk.close();
});

test("updateSupportTierAsync：設為預設時要把其他列歸零，落地列必須相同", async () => {
  const [disk, exec] = resetBoth();
  seedAll(disk); seedAll(exec.raw);
  const tiers = tableOf(disk, "support_tier");
  const target = tiers.find((r) => r.title === "停用中");
  const s = support.updateSupportTier(disk, target.id, { is_default: true, is_active: 1 }, NOW);
  const a = await asyncMod.updateSupportTierAsync(target.id, { is_default: true, is_active: 1 }, { ...PG, exec, now: NOW });
  assert.deepEqual(a, s);
  assert.deepEqual(tableOf(exec.raw, "support_tier"), tableOf(disk, "support_tier"));
  assert.equal(tableOf(disk, "support_tier").filter((r) => Number(r.is_default) === 1).length, 1);
  disk.close();
});

test("updateSupportProviderAsync：落地列相同，且只有一個預設收款方式", async () => {
  const [disk, exec] = resetBoth();
  seedAll(disk); seedAll(exec.raw);
  const prov = tableOf(disk, "support_provider")[0];
  // page_url 刻意給一個**不合法**的值：`sanitizeHttpUrl` 會把它變成空字串，
  // 沒做 sanitize 的版本會原樣寫進去（第一版沒給 page_url，兩邊都沿用現值 ⇒ 變異活了下來）。
  const body = { display_name: "改過的收款", is_default: 1, page_url: "not-a-url" };
  const s = support.updateSupportProvider(disk, prov.id, body, NOW);
  const a = await asyncMod.updateSupportProviderAsync(prov.id, body, { ...PG, exec, now: NOW });
  assert.deepEqual(a, s);
  assert.deepEqual(tableOf(exec.raw, "support_provider"), tableOf(disk, "support_provider"));
  assert.equal(tableOf(disk, "support_provider").filter((r) => Number(r.is_default) === 1).length, 1);
  assert.equal(tableOf(disk, "support_provider")[0].page_url, "", "不合法的 URL 必須被 sanitize 成空字串");
  assert.equal(a.page_url, "", "回傳值也必須是 sanitize 過的");
  disk.close();
});

// ---------------------------------------------------------------------------
// 第二群寫入：贊助商／支持紀錄／CTA 規則

test("createSupportSponsorAsync：落地列相同，且 amount 的空字串要寫 null（不是 0）", async () => {
  const [disk, exec] = resetBoth();
  const body = { name: "新贊助商", logo: "https://cdn.example/x.png", amount: "", status: "active", sort_order: 3 };
  const s = support.createSupportSponsor(disk, body, NOW);
  const a = await asyncMod.createSupportSponsorAsync(body, { ...PG, exec, now: NOW });
  assert.deepEqual(a, s);
  const rows = tableOf(exec.raw, "support_sponsor");
  assert.deepEqual(rows, tableOf(disk, "support_sponsor"), "落地列必須逐欄相同");
  assert.equal(rows.length, 1, "必須真的寫入一列");
  assert.equal(rows[0].amount, null, "空字串的金額必須寫 null，不是 0");
  disk.close();
});

test("updateSupportSponsorAsync：沒給的欄位沿用現值；給 undefined vs 給空字串的差別", async () => {
  const [disk, exec] = resetBoth();
  seedAll(disk); seedAll(exec.raw);
  const sp = tableOf(disk, "support_sponsor")[0];

  // (a) 只改名稱
  const s1 = support.updateSupportSponsor(disk, sp.id, { name: "改名" }, NOW);
  const a1 = await asyncMod.updateSupportSponsorAsync(sp.id, { name: "改名" }, { ...PG, exec, now: NOW });
  assert.deepEqual(a1, s1);
  assert.deepEqual(tableOf(exec.raw, "support_sponsor"), tableOf(disk, "support_sponsor"));
  assert.equal(a1.website_url, s1.website_url, "沒給的欄位要沿用現值");

  // (b) logo 給空字串 ⇒ sanitize("") = ""（清掉），與 undefined（沿用）不同
  const s2 = support.updateSupportSponsor(disk, sp.id, { logo: "" }, NOW);
  const a2 = await asyncMod.updateSupportSponsorAsync(sp.id, { logo: "" }, { ...PG, exec, now: NOW });
  assert.deepEqual(a2, s2);
  assert.deepEqual(tableOf(exec.raw, "support_sponsor"), tableOf(disk, "support_sponsor"));
  assert.equal(a2.logo, "", "給空字串要把 logo 清掉");

  // (c) 不合法網址必須被 sanitize 成空字串（沒有 sanitize 的版本會原樣寫進去）
  const s3 = support.updateSupportSponsor(disk, sp.id, { website_url: "not-a-url" }, NOW);
  const a3 = await asyncMod.updateSupportSponsorAsync(sp.id, { website_url: "not-a-url" }, { ...PG, exec, now: NOW });
  assert.deepEqual(a3, s3);
  assert.deepEqual(tableOf(exec.raw, "support_sponsor"), tableOf(disk, "support_sponsor"));
  assert.equal(a3.website_url, "", "不合法的網址必須被 sanitize 成空字串");
  disk.close();
});

test("🚨 createManualTransactionAsync：去重要生效（同一組 provider+交易號第二次要 409）", async () => {
  const [disk, exec] = resetBoth();
  const body = { amount: 500, fee: 25, provider_transaction_id: "TX-1", anonymous: false, supporter_name: "小明" };
  const s = support.createManualTransaction(disk, body, NOW);
  const a = await asyncMod.createManualTransactionAsync(body, { ...PG, exec, now: NOW });
  assert.deepEqual(a, s);
  assert.deepEqual(tableOf(exec.raw, "support_transaction"), tableOf(disk, "support_transaction"));
  assert.equal(a.net_amount, 475, "net = amount - fee 必須算對");

  // 第二次：兩邊都要丟 409 DUPLICATE_TRANSACTION（去重是**先查再寫**，少了查詢就會寫進第二筆）
  let syncErr = null, asyncErr = null;
  try { support.createManualTransaction(disk, body, NOW); } catch (e) { syncErr = e; }
  try { await asyncMod.createManualTransactionAsync(body, { ...PG, exec, now: NOW }); } catch (e) { asyncErr = e; }
  assert.ok(syncErr, "同步版應該擋下重複");
  assert.equal(asyncErr?.status, syncErr?.status, "status 必須相同");
  assert.equal(asyncErr?.code, syncErr?.code, "code 必須相同（DUPLICATE_TRANSACTION）");
  assert.equal(tableOf(exec.raw, "support_transaction").length, 1, "重複的那筆不得寫入");
  disk.close();
});

test("createManualTransactionAsync：金額 <= 0 要擋下來（兩邊形狀相同）", async () => {
  const [disk, exec] = resetBoth();
  let syncErr = null, asyncErr = null;
  try { support.createManualTransaction(disk, { amount: 0 }, NOW); } catch (e) { syncErr = e; }
  try { await asyncMod.createManualTransactionAsync({ amount: 0 }, { ...PG, exec, now: NOW }); } catch (e) { asyncErr = e; }
  assert.ok(syncErr && asyncErr);
  assert.equal(asyncErr.message, syncErr.message);
  assert.equal(tableOf(exec.raw, "support_transaction").length, 0, "被擋下時不得寫入");
  disk.close();
});

test("updateSupportTransactionAsync：net_amount 要跟著 amount／fee 重算", async () => {
  const [disk, exec] = resetBoth();
  seedAll(disk); seedAll(exec.raw);
  const tx = tableOf(disk, "support_transaction")[0];
  const s = support.updateSupportTransaction(disk, tx.id, { amount: 1000, fee: 40, status: "refunded" }, NOW);
  const a = await asyncMod.updateSupportTransactionAsync(tx.id, { amount: 1000, fee: 40, status: "refunded" }, { ...PG, exec, now: NOW });
  assert.deepEqual(a, s);
  assert.deepEqual(tableOf(exec.raw, "support_transaction"), tableOf(disk, "support_transaction"));
  assert.equal(a.net_amount, 960, "net 必須重算");
  assert.equal(a.status, "refunded");
  disk.close();
});

test("updateCtaRuleAsync：threshold／cooldown_days 的下限（Math.max(1,…)）必須一致", async () => {
  const [disk, exec] = resetBoth();
  seedAll(disk); seedAll(exec.raw);
  const rule = tableOf(disk, "support_cta_rule")[0];
  // 故意給**負數**：`Math.max(1, X || 預設)` 在 X=0 時與「少了 Math.max」的版本結果相同
  // （`0 || 1` 就是 1），所以 0 測不出來；-5 才驗得到那個下限。
  const s = support.updateCtaRule(disk, rule.id, { threshold: -5, cooldown_days: -5, priority: 0 }, NOW);
  const a = await asyncMod.updateCtaRuleAsync(rule.id, { threshold: -5, cooldown_days: -5, priority: 0 }, { ...PG, exec, now: NOW });
  assert.deepEqual(a, s);
  assert.deepEqual(tableOf(exec.raw, "support_cta_rule"), tableOf(disk, "support_cta_rule"));
  assert.equal(a.threshold, s.threshold);
  assert.ok(Number(a.threshold) >= 1, "threshold 不得被寫成 0");
  assert.ok(Number(a.cooldown_days) >= 1, "cooldown_days 不得被寫成 0");
  disk.close();
});

// ---------------------------------------------------------------------------
// 後台設定（support_page_config）與事件記錄

// 設定列固定是 id=1；同步版的 readFlags／readDraft／readPublished 都靠這一列。
const seedConfig = (h, values = {}) => {
  h.prepare("DELETE FROM support_page_config").run();
  seed(h, "support_page_config", { id: 1, updated_at: "2026-09-01T00:00:00.000Z", ...values });
};

test("adminSupportConfigAsync：預設狀態（沒有任何設定列）必須與同步版相同", async () => {
  const [disk, exec] = resetBoth();
  const a = await asyncMod.adminSupportConfigAsync({ ...PG, exec });
  assert.deepEqual(a, support.adminSupportConfig(disk));
  assert.equal(a.flags.enabled, false, "預設必須是未開啟");
  disk.close();
});

test("adminSupportConfigAsync：有設定值時逐欄相同（flags／draft／goal／wall）", async () => {
  const [disk, exec] = resetBoth();
  const stored = {
    flags_json: JSON.stringify({ enabled: true, cta_enabled: true }),
    draft_json: JSON.stringify({ intro: "草稿說明", show_goal: false }),
    published_json: JSON.stringify({ intro: "已發佈說明" }),
    published_at: "2026-09-02T00:00:00.000Z",
    goal_amount: 5000,
    goal_label: "這個月的目標",
    goal_display: "amount",
    wall_enabled: 1,
  };
  seedConfig(disk, stored); seedConfig(exec.raw, stored);

  const a = await asyncMod.adminSupportConfigAsync({ ...PG, exec });
  assert.deepEqual(a, support.adminSupportConfig(disk));
  assert.equal(a.flags.enabled, true, "必須真的讀到存的 flags");
  assert.equal(a.goal_amount, 5000);
  assert.equal(a.draft.intro, "草稿說明");
  assert.equal(a.draft.show_goal, false, "draft 的 show_goal=false 必須保留（不是被預設值蓋掉）");
  assert.equal(a.wall_enabled, true);
  disk.close();
});

test("getSupportFlagsAsync：與同步版相同", async () => {
  const [disk, exec] = resetBoth();
  seedConfig(disk, { flags_json: JSON.stringify({ enabled: true }) });
  seedConfig(exec.raw, { flags_json: JSON.stringify({ enabled: true }) });
  const a = await asyncMod.getSupportFlagsAsync({ ...PG, exec });
  assert.deepEqual(a, support.getSupportFlags(disk));
  assert.equal(a.enabled, true);
  disk.close();
});

test("saveSupportConfigAsync：落地的 config 列必須逐欄相同（含 draft 合併語意）", async () => {
  const [disk, exec] = resetBoth();
  seedConfig(disk, { draft_json: JSON.stringify({ intro: "舊說明", show_cost: false }) });
  seedConfig(exec.raw, { draft_json: JSON.stringify({ intro: "舊說明", show_cost: false }) });
  // ⚠️ copy 的鍵必須在 `DEFAULT_PAGE_COPY` 白名單內（normalizePageCopy 只留那些鍵）——
  // 第一版我用 `title`，它不在白名單裡，於是被丟掉、斷言失敗。用真實的鍵才有鑑別力。
  const partial = { flags: { enabled: true }, copy: { cta_label: "新標籤" }, goal_amount: 8000, wall_enabled: 1 };

  const s = support.saveSupportConfig(disk, partial, NOW);
  const a = await asyncMod.saveSupportConfigAsync(partial, { ...PG, exec, now: NOW });
  assert.deepEqual(a, s, "回傳值必須相同");
  assert.deepEqual(tableOf(exec.raw, "support_page_config"), tableOf(disk, "support_page_config"),
    "落地的 config 列必須逐欄相同");
  const landed = tableOf(disk, "support_page_config")[0];
  assert.match(landed.draft_json, /舊說明/, "沒給的 draft 欄位要沿用現值");
  assert.match(landed.draft_json, /新標籤/, "給的 copy 要合併進去");
  disk.close();
});

test("publishSupportConfigAsync：published_json 要等於 draft，且落地的 published_at 相同", async () => {
  const [disk, exec] = resetBoth();
  seedConfig(disk, { draft_json: JSON.stringify({ intro: "要發佈的" }) });
  seedConfig(exec.raw, { draft_json: JSON.stringify({ intro: "要發佈的" }) });

  const s = support.publishSupportConfig(disk, NOW);
  const a = await asyncMod.publishSupportConfigAsync({ ...PG, exec, now: NOW });
  assert.deepEqual(a, s);
  assert.deepEqual(tableOf(exec.raw, "support_page_config"), tableOf(disk, "support_page_config"));
  const landed = tableOf(disk, "support_page_config")[0];
  assert.equal(landed.published_at, NOW.toISOString(), "published_at 要用傳入的 now");
  // 注意：`published_json` 存的是「正規化後的 draft 檢視」（adminSupportConfig 的 draft），
  // 不是 DB 裡那個原始的 draft_json——原始的可能缺欄位。第一版我拿兩者直接比，當然不同。
  assert.deepEqual(JSON.parse(landed.published_json), support.adminSupportConfig(disk).draft,
    "發佈的內容必須等於當下的 draft 檢視");
  disk.close();
});

test("recordSupportEventAsync：合法 kind 要寫入、meta 只留白名單欄位", async () => {
  const [disk, exec] = resetBoth();
  const meta = { ruleId: 7, tierId: 3, sponsorId: 0, days: 5, 不該留下的欄位: "x", userId: 999 };
  const s = support.recordSupportEvent(disk, "support_cta_shown", { userId: 42, guestKey: "g1", meta, now: NOW });
  const a = await asyncMod.recordSupportEventAsync("support_cta_shown", { userId: 42, guestKey: "g1", meta, now: NOW, ...PG, exec });
  assert.deepEqual(a, s);
  assert.deepEqual(a, { ok: true });
  const rows = tableOf(exec.raw, "support_event");
  assert.deepEqual(rows, tableOf(disk, "support_event"), "落地的事件列必須逐欄相同");
  assert.equal(rows.length, 1, "必須真的寫入一筆");
  assert.deepEqual(JSON.parse(rows[0].meta_json), { ruleId: 7, tierId: 3, days: 5 },
    "meta 只留白名單欄位（0 的不寫、其他欄位不得外洩）");
  disk.close();
});

test("recordSupportEventAsync：不合法的 kind 回 {ok:false} 且不寫入", async () => {
  const [disk, exec] = resetBoth();
  const s = support.recordSupportEvent(disk, "not_a_kind", { now: NOW });
  const a = await asyncMod.recordSupportEventAsync("not_a_kind", { now: NOW, ...PG, exec });
  assert.deepEqual(a, s);
  assert.deepEqual(a, { ok: false });
  assert.equal(tableOf(exec.raw, "support_event").length, 0, "不合法時不得寫入");
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
