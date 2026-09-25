import { test } from "node:test";
import assert from "node:assert/strict";
import { buildListRequestContextFromPg, buildListListingsClauses } from "../src/db.js";

const silentExec = async () => [];

test("context：由 PG settings 取得 crawlSources（同名 key），並可套進子句", async () => {
  const exec = async (sql, params) => {
    assert.match(String(sql), /FROM settings WHERE key = \?/);
    assert.deepEqual(params, ["crawlSources"]);
    return [{ value: JSON.stringify({ items: [{ id: "591", enabled: true }, { id: "sinyi", enabled: false }] }) }];
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

test("context：不會提供 searchKeys（在補上 PG 來源前維持現況）", async () => {
  const context = await buildListRequestContextFromPg(silentExec);
  assert.equal(context.searchKeys, undefined);
});
