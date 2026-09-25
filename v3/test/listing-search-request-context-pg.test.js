import { test } from "node:test";
import assert from "node:assert/strict";
import { buildListRequestContextFromPg, buildListListingsClauses } from "../src/db.js";

const silentExec = async () => [];

test("context：由 PG settings 取得 crawlSources（同名 key），並可套進子句", async () => {
  const exec = async (sql) => {
    // astra §4.3：crawlSources 現在與全域 settings 共用**同一筆**查詢（原本另發一筆 WHERE key=? ✗）。
    if (!/FROM settings/.test(String(sql))) return [];
    return [{
      key: "crawlSources",
      value: JSON.stringify({ items: [{ id: "591", enabled: true }, { id: "sinyi", enabled: false }] }),
    }];
  };
  const context = await buildListRequestContextFromPg(exec);
  const built = buildListListingsClauses(
    { filter: "all", districts: ["士林區"], settings: {}, uid: 0, voteUid: 0, context },
  );
  assert.ok(built.params.includes("sinyi"), "停用來源應進入條件");
  assert.ok(!built.params.includes("591"), "啟用來源不應被排除");
});

test("context：settings 查無列時落回純函式預設（不讀 SQLite）", async () => {
  const context = await buildListRequestContextFromPg(silentExec);
  assert.ok(context.crawlSources && Array.isArray(context.crawlSources.items));
  assert.ok(context.crawlSources.items.length > 0);
});

test("context：isolation 預設排除 fixture 列；給 namespace 時只保留該 namespace", async () => {
  const base = await buildListRequestContextFromPg(silentExec);
  assert.match(base.isolation.sql, /fixture_namespace IS NULL/);
  const scoped = await buildListRequestContextFromPg(silentExec, { namespace: "ns1" });
  assert.match(scoped.isolation.sql, /fixture_namespace = \?/);
  assert.deepEqual(scoped.isolation.params, ["ns1"]);
});

test("context：searchKeys 由 PG 建立（settings／user_settings／users／crawl_covers／distinct search_key）", async () => {
  const seen = [];
  const exec = async (sql) => {
    const text = String(sql);
    seen.push(text);
    if (/FROM settings WHERE key/.test(text)) return [];
    if (/DISTINCT search_key/.test(text)) return [{ search_key: "https://covers.test/c1" }];
    if (/FROM crawl_covers/.test(text)) {
      return [{ id: 1, region_id: 1, section_ids: "[1,2]", price_min: 0, price_max: 0, last_run_at: null, created_at: "" }];
    }
    if (/FROM user_settings/.test(text)) {
      return [{ user_id: 7, key: "searchUrls", value: JSON.stringify(["https://user.test/u7"]) }];
    }
    if (/FROM users/.test(text)) return [{ id: 7, role: "member", plan: "free" }];
    if (/FROM settings/.test(text)) {
      return [{ key: "searchUrls", value: JSON.stringify(["https://global.test/g"]) }];
    }
    return [];
  };
  const context = await buildListRequestContextFromPg(exec);
  assert.ok(Array.isArray(context.searchKeys), "searchKeys 應由 PG 建立");
  // 走的是 PG 路徑：covers 與展開都使用 PG 查詢（不再掃 SQLite）。
  assert.ok(seen.some((sql) => /FROM crawl_covers/.test(sql)));
  assert.ok(seen.some((sql) => /DISTINCT search_key/.test(sql)));
  assert.ok(context.searchKeys.includes("https://global.test/g"), "全域 searchUrls 應納入");
  assert.ok(context.searchKeys.length >= 1);
});
