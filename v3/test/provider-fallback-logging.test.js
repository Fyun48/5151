// executeWithProvider 的診斷寫入不得影響呼叫（2026-09-24）。
//
// 背景：`fallback: disabled_or_no_credential` 原本**每次呼叫都寫一列**（實測 3 天 6 萬列，
// 來源包含爬蟲每一個抓取）。在 DB_DRIVER=postgres + 寫入 fail-closed 之下，那一列寫失敗會讓
// 整個 provider 呼叫（含直連 fallback）一起失敗 —— 這一支就是釘住「診斷不得影響呼叫」。
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeWithProvider } from "../src/providers/executeWithProvider.js";

function fakeStore({ usageLog }) {
  return {
    loadEnabled: async () => null, // 沒有啟用的付費 provider → 走 fallback
    hasCredentials: async () => false,
    usageLog,
    reserve: async () => ({ ok: true, reservation: { id: "r1" } }),
    settle: async () => {},
    hold: async () => {},
    release: async () => {},
  };
}

test("usageLog 失敗不會讓 provider 呼叫失敗（仍走 fallback）", async () => {
  let logged = 0;
  const out = await executeWithProvider({
    db: {},
    category: "scraping_api",
    store: fakeStore({
      usageLog: async () => {
        logged += 1;
        throw new Error("pg is down");
      },
    }),
    actionWithProvider: async () => ({ value: "paid-result" }),
    fallbackAction: async () => "direct-result",
  });
  assert.equal(out, "direct-result");
  assert.equal(logged, 1, "診斷有嘗試寫入，但失敗被吞掉");
});

test("同一個 (category, note) 每個行程只記一次（去掉每個抓取一列的噪音）", async () => {
  let logged = 0;
  const store = fakeStore({ usageLog: async () => { logged += 1; } });
  for (let i = 0; i < 5; i += 1) {
    const out = await executeWithProvider({
      db: {},
      category: "llm_dedupe_probe",
      store,
      actionWithProvider: async () => ({ value: "paid-result" }),
      fallbackAction: async () => "direct-result",
    });
    assert.equal(out, "direct-result");
  }
  assert.equal(logged, 1, "重複的 fallback 狀態只記一次");
});
