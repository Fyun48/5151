// live PG 測試的「目標庫守衛」共用包（2026-10-11）。
//
// 背景（正式庫已發生的髒資料）：`PG_TEST_URL` 在本機／開發機上指向**正式庫 `5151_shadow`**
// （憑證索引裡有明確警告；`PG_URL` 與它其實是同一顆實例、同一個庫）。2026-09-18 與 09-24
// 就是 live 測試直接拿它當連線去寫，在正式庫留下 25 個 `*@jibby.test` 測試夾具帳號與
// 444 筆關聯列。
//
// repo 其實已經有防呆 `assertPgTargetAllowed()`（`v3/src/domainToolGuards.js`）——目標庫必須在
// `ALLOWED_PG_TARGET_DBS`（repro／tracker_test／repro2／crawl_sandbox）內，否則丟錯；要對清單外的
// 庫動手必須明確設 `ALLOW_PRODUCTION_PG_TARGET=1`。問題是**只有部分腳本接上它，live 測試沒接**。
//
// 這一支把它包成 node:test 的 `{ skip }` 形狀（沿用 repo 既有寫法，不新增機制）：
//
//   import { livePgTargetSkip } from "./helpers/livePgTarget.js";
//   const PG_TEST_URL = (process.env.PG_TEST_URL || "").trim();
//   const skip = (await livePgTargetSkip("settings-driver-parity"))
//     || (PG_TEST_URL ? false : "PG_TEST_URL is not set");
//   test("live：…", { skip }, async () => { /* 這裡才建立連線 */ });
//
//   • 回傳 `false`          ⇒ 目標庫在允許清單內（或明確設了 ALLOW_PRODUCTION_PG_TARGET=1），照常執行。
//   • 回傳非空字串（理由）  ⇒ 呼叫端把它當 `{ skip }` 的值：整支測試略過，並在輸出印出被擋的原因。
//
// ⚠️ 一定要在**建立連線之前**呼叫（見每個呼叫点上方那一行註解）。
//    CI 的 PG job 餵的是拋棄式 `tracker_test`（在清單內）⇒ 正常情況不會被擋；
//    被擋下來只代表有人在本機把 `PG_TEST_URL` 指到白名單以外的庫——那正是我們要擋的形狀。
export async function livePgTargetSkip(tool, url = process.env.PG_TEST_URL) {
  const raw = String(url == null ? "" : url).trim();
  if (!raw) return "PG_TEST_URL 未設定";
  const { assertPgTargetAllowed } = await import("../../src/domainToolGuards.js");
  try {
    assertPgTargetAllowed(tool, raw, { env: process.env });
    return false;
  } catch (err) {
    return `拒絕執行（live PG 目標庫守衛）：${err && err.message ? err.message : String(err)}`;
  }
}
