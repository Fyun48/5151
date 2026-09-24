// admin-providers.js 的行為測試（不引入 DOM 套件：用 node:vm ＋ 極簡假 document/fetch）。
//
// 釘住的重點：
//  1. 五個類別都會渲染，且每列帶正確的 data-provider-row 與 code 選項。
//  2. 「有金鑰」與「沒有金鑰」的提示文字不同（避免管理員誤以為要重填）。
//  3. 今日額度用盡（fuse=tripped）與 8 成（warn）會顯示警示。
//  4. 儲存時的 payload 是 TWD 數字（後端會自己轉 minor），刪除金鑰帶 clear_credential。
//  5. 全站預算表單會把值寫進兩個輸入框。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";

const src = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/admin-providers.js"),
  "utf8",
);

function fakeDocument() {
  const nodes = new Map();
  const makeNode = (id) => ({
    id, value: "", innerHTML: "", textContent: "", hidden: false,
    style: {}, dataset: {}, scrollTop: 0,
    addEventListener() {}, setAttribute() {}, toggleAttribute() {}, closest: () => null, querySelector: () => null,
  });
  return {
    readyState: "complete",
    getElementById: (id) => {
      if (!nodes.has(id)) nodes.set(id, makeNode(id));
      return nodes.get(id);
    },
    addEventListener() {},
    querySelectorAll: () => [],
    _nodes: nodes,
  };
}

const payload = {
  baseline: "pack6",
  legal: "金鑰與每日預算只存在本站資料庫。",
  site_daily_budget_twd: 100,
  site_monthly_budget_twd: 1000,
  items: [
    { category: "scraping_api", label: "網頁代爬", provider_code: "none", is_enabled: false, has_credential: false,
      daily_budget_twd: 0, monthly_budget_twd: 0, ceiling_twd: 1, suggested_daily_twd: 20,
      codes: ["none", "stub_paid", "zenrows", "scrape_do"],
      today_settled_twd: 0, today_reserved_twd: 0, today_limit_twd: 0, month_settled_twd: 0, fuse: "ok" },
    { category: "residential_proxy", label: "住宅代理", provider_code: "brightdata", is_enabled: true, has_credential: true,
      daily_budget_twd: 20, monthly_budget_twd: 200, ceiling_twd: 1.5, suggested_daily_twd: 20,
      codes: ["none", "stub_paid", "brightdata", "smartproxy"],
      today_settled_twd: 18, today_reserved_twd: 4, today_limit_twd: 20, month_settled_twd: 55, fuse: "tripped" },
    { category: "distance_matrix", label: "地圖距離", provider_code: "google_routes", is_enabled: false, has_credential: true,
      daily_budget_twd: 0, monthly_budget_twd: 0, ceiling_twd: 0.2, suggested_daily_twd: 50,
      codes: ["none", "google_routes"],
      today_settled_twd: 0, today_reserved_twd: 0, today_limit_twd: 0, month_settled_twd: 0, fuse: "warn" },
  ],
  logs: [{ id: 1, created_at: "2026-09-24T00:00:00.000Z", category: "llm", category_label: "LLM 同源",
    event_kind: "settled", event_label: "已結算", job_state: "settled", state_label: "完成", amount_twd: 3 }],
};

function load({ fetchImpl } = {}) {
  const doc = fakeDocument();
  const calls = [];
  const ctx = createContext({ window: {}, globalThis: {}, document: doc, confirm: () => true });
  ctx.window = ctx;
  ctx.globalThis = ctx;
  ctx.document = doc;
  ctx.confirm = () => true;
  ctx.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || "GET", body: init.body });
    const payloadOut = fetchImpl ? fetchImpl(String(url), init) : payload;
    return new Response(JSON.stringify(payloadOut), { status: 200, headers: { "content-type": "application/json" } });
  };
  runInContext(src, ctx);
  return { mod: ctx.AdminProviders, doc, calls };
}

test("load 會渲染每個類別，並帶正確的 data-provider-row 與代碼選項", async () => {
  const { mod, doc } = load();
  const out = await mod.load();
  assert.equal(out.items.length, 3);
  const html = doc.getElementById("providersGrid").innerHTML;
  assert.match(html, /data-provider-row="scraping_api"/);
  assert.match(html, /data-provider-row="residential_proxy"/);
  assert.match(html, /data-provider-row="distance_matrix"/);
  assert.match(html, /<option value="zenrows">/);
  assert.match(html, /<option value="brightdata" selected>/);
  // 額度警示渲染在頁面層級的說明列（#providersMsg），不是清單列裡。
  const note = doc.getElementById("providersMsg").innerHTML;
  assert.match(note, /今日額度已滿/);
  assert.match(note, /今日用量已達 8 成/);
});

test("金鑰狀態提示：有金鑰 vs 沒有金鑰", async () => {
  const { mod, doc } = load();
  await mod.load();
  const html = doc.getElementById("providersGrid").innerHTML;
  assert.match(html, /已設定，留白＝不變更/);
  assert.match(html, /尚未設定/);
  assert.match(html, /金鑰：已設定/);
  assert.match(html, /金鑰：未設定/);
});

test("全站預算與用量會寫進對應區塊", async () => {
  const { mod, doc } = load();
  await mod.load();
  assert.equal(doc.getElementById("siteDailyTwd").value, "100");
  assert.equal(doc.getElementById("siteMonthlyTwd").value, "1000");
  const logs = doc.getElementById("providersLogs").innerHTML;
  assert.match(logs, /LLM 同源/);
  assert.match(logs, /已結算/);
  assert.match(logs, /NT\$ 3/);
});

test("沒有用量紀錄時顯示提示，而不是空表格", async () => {
  const { mod, doc } = load({ fetchImpl: () => ({ ...payload, logs: [] }) });
  await mod.load();
  assert.match(doc.getElementById("providersLogs").innerHTML, /目前沒有任何付費呼叫紀錄/);
});

test("saveRow 的 payload 用 TWD 數字，刪除金鑰帶 clear_credential", async () => {
  const { mod, calls } = load();
  const fields = {
    provider_code: { value: "zenrows" },
    is_enabled: { checked: true },
    ceiling_twd: { value: "1" },
    daily_budget_twd: { value: "20" },
    monthly_budget_twd: { value: "200" },
    credential: { value: "  secret-key  " },
  };
  const row = { dataset: { providerRow: "scraping_api" }, querySelector: (sel) => fields[String(sel).match(/"([^"]+)"/)[1]] || null };
  await mod.saveRow(row);
  const put = calls.find((c) => c.method === "PUT");
  assert.ok(put, "應該送出 PUT");
  assert.deepEqual(JSON.parse(put.body), {
    category: "scraping_api",
    provider_code: "zenrows",
    is_enabled: true,
    ceiling_twd: 1,
    daily_budget_twd: 20,
    monthly_budget_twd: 200,
    credential: "secret-key",
  });

  calls.length = 0;
  await mod.saveRow(row, { clearCredential: true });
  assert.equal(JSON.parse(calls.find((c) => c.method === "PUT").body).clear_credential, true);
});

test("單筆上限的小數不會被吃掉（0.2 不能變成 0）", async () => {
  const { mod, doc } = load();
  await mod.load();
  const html = doc.getElementById("providersGrid").innerHTML;
  const distanceRow = html.slice(html.indexOf('data-provider-row="distance_matrix"'));
  assert.match(distanceRow, /data-field="ceiling_twd" value="0\.2"/);
  assert.doesNotMatch(distanceRow, /data-field="ceiling_twd" value="0"/);
});

test("未啟用的類別仍顯示「走免費路徑」的說明，避免誤解為已在花錢", async () => {
  const { mod, doc } = load();
  await mod.load();
  const html = doc.getElementById("providersGrid").innerHTML;
  assert.match(html, /未啟用時走免費路徑，不會花費/);
  assert.match(html, /0＝不花錢/);
});
