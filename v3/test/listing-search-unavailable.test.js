// F2（PR-B）：PostgreSQL 失效時的可用性行為。
//
// 決策（依指令文件）：PG 掛掉時回 503 + 穩定錯誤碼，**不回退 SQLite** —— 回退會讓清單與 PG 的
// 真相無聲分裂，也讓故障無法被看見。options.sqliteFallback 只供測試明確開啟（無環境變數開關）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEARCH_UNAVAILABLE_CODE,
  isListingSearchUnavailable,
  searchListingsAsync,
} from "../src/listingSearchAsync.js";

function failingDriver() {
  return {
    async query() {
      throw new Error("connection terminated unexpectedly");
    },
    async poolEnd() {},
  };
}

// 注意：參數必須落在 SQL 外框**內**（帶 districts/allowAllDistricts），否則 searchPage 會回 null
// 走「外框外」的既有回退，而不是走到 PG 錯誤路徑——那測不到這裡要驗的行為。
const IN_ENVELOPE = { filter: "all", districts: ["中正區"], allowAllDistricts: true, limit: 1 };

test("PG 失敗時拋出穩定錯誤碼（不回退 SQLite）", async () => {
  await assert.rejects(
    () => searchListingsAsync(IN_ENVELOPE, { driver: "postgres", pgDriver: failingDriver() }),
    (error) => {
      assert.equal(isListingSearchUnavailable(error), true, `錯誤碼不對：${error?.code}`);
      assert.equal(error.code, SEARCH_UNAVAILABLE_CODE);
      assert.match(String(error.message), /unavailable/i);
      return true;
    },
  );
});

test("PG 失敗時，正是因為不回退，才會拋錯（原始原因被保留）", async () => {
  await assert.rejects(
    () => searchListingsAsync(IN_ENVELOPE, { driver: "postgres", pgDriver: failingDriver() }),
    (error) => {
      assert.match(String(error.cause?.message || ""), /connection terminated/);
      return true;
    },
  );
});

test("測試用 sqliteFallback 明確開啟時才回退（正式路徑沒有這個開關）", async () => {
  const listed = await searchListingsAsync(
    IN_ENVELOPE,
    { driver: "postgres", pgDriver: failingDriver(), sqliteFallback: true },
  );
  assert.ok(listed && typeof listed === "object", "應回傳 SQLite 鏈的結果");
  assert.ok(Array.isArray(listed.listings));
});

test("sqlite driver 不受影響（不經過 PG 錯誤路徑）", async () => {
  const listed = await searchListingsAsync({ filter: "all", limit: 1 }, { driver: "sqlite" });
  assert.ok(Array.isArray(listed.listings));
});
