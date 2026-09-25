// astra6 2026-09-25 §0.2 的護欄：PG-fed Node 的頁面裝飾**不得**在缺 provider 時回退 SQLite。
//
// 背景：`decorateListingLite`／`finalizeListingDecorate` 在 provider 為空時會 fallback 到
// `sqliteDecorationProvider()`（db.js:3275 等）⇒ PG 路徑會偷偷讀 SQLite。
// 因此 `decorateListListingsPage` 增加 `requireProvider`，PG 呼叫端必須傳 true；
// 缺 provider 時**直接拋錯**（不得靜默）。
//
// 註：完整的「整個請求內 SQLite I/O = 0」驗收屬 astra6 §0.2 的正式入口測試（尚待建立 CI）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { decorateListListingsPage } from "../src/db.js";

test("PG 路徑缺 provider 時直接拋錯（不得回退 SQLite）", () => {
  assert.throws(
    () => decorateListListingsPage([{ post_id: 1 }], [{ post_id: 1 }], { settings: {}, uid: 0, requireProvider: true }),
    /必須提供 decoration provider/,
  );
});

test("提供 provider 時不會因護欄而拋錯（護欄只檢查有無）", () => {
  const provider = { personalFlags: () => new Map(), personalIndex: () => ({ peers: () => [] }), splitPairs: () => new Set(), extras: () => [] };
  assert.doesNotThrow(() => {
    try {
      decorateListListingsPage([], [], { settings: {}, uid: 0, provider, requireProvider: true });
    } catch (error) {
      // 空頁面不會進到裝飾邏輯；若有其他錯誤（例如 provider 介面不足）不屬於本護欄要測的行為。
      if (/必須提供 decoration provider/.test(String(error?.message))) throw error;
    }
  });
});
