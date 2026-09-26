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

test("PG provider 介面不完整時明確失敗，完整的空 provider 可以回空頁", async () => {
  const { preloadedDecorationProvider } = await import("../src/db.js");
  assert.throws(() => decorateListListingsPage([], [], {
    settings: {}, uid: 0, provider: {}, requireProvider: true,
  }), /provider requires prep/);
  assert.deepEqual(decorateListListingsPage([], [], {
    settings: {}, uid: 0, provider: preloadedDecorationProvider(), requireProvider: true,
  }), []);
});
