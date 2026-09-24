// 2.4：provider 呼叫的額度保留／結算全部走 budgetStore（driver-aware）。
// 讀與寫必須同一個 store——只換一半會變成「管理介面寫 SQLite、判斷讀 PG」。
import { getBoundBudgetDb } from "../budgetGuard.js";
import { budgetStore } from "../budgetStore.js";

function isUncertainCharge(error) {
  if (!error) return false;
  if (error.uncertainCharge === true) return true;
  const name = String(error.name || "");
  const message = String(error.message || "").toLowerCase();
  return name === "AbortError" || name === "TimeoutError" || message.includes("timeout") || message.includes("aborted");
}

// 診斷用的用量紀錄（2026-09-24）。
//
// 為什麼要特別處理：`fallback: disabled_or_no_credential` 是「這條 category 沒有設定付費 provider」
// 的狀態，不是單次呼叫的結果——但原寫法**每次呼叫都寫一列**（實測 3 天 6 萬列，來源包含爬蟲的
// 每一個抓取）。在 DB_DRIVER=postgres 之下那是每個抓取一次 PG 寫入，而寫入自 2026-09-23 起是
// fail-closed：紀錄寫失敗會讓整個 provider 呼叫（含直連 fallback）一起失敗。
//
// 所以這裡：①同一個 (category, note) 每個行程只記一次（去噪）②任何錯誤都吞掉（診斷不得影響呼叫）。
const loggedFallbackStates = new Set();

async function logFallbackState(budget, entry) {
  const key = `${entry.category}|${entry.note}`;
  if (loggedFallbackStates.has(key)) return;
  loggedFallbackStates.add(key);
  try {
    await budget.usageLog(entry);
  } catch {
    // 診斷紀錄失敗不影響呼叫
  }
}

async function logUsageBestEffort(budget, entry) {
  try {
    await budget.usageLog(entry);
  } catch {
    // 診斷紀錄失敗不影響呼叫
  }
}

export async function executeWithProvider({
  db,
  category,
  actionWithProvider,
  fallbackAction,
  costCeilingMinor,
  requestId,
  attemptId,
  now = new Date(),
  store = null,
  options = {},
} = {}) {
  const database = db || getBoundBudgetDb();
  const budget = store || budgetStore({ sqliteDb: database, options });
  const fallback = async () => fallbackAction();
  if (!database || typeof actionWithProvider !== "function") return fallback();
  const cfg = await budget.loadEnabled(category);
  if (!cfg || !(await budget.hasCredentials(cfg))) {
    await logFallbackState(budget, { now, category, provider_code: cfg?.provider_code, event_kind: "fallback", note: "disabled_or_no_credential" });
    return fallback();
  }
  const ceiling = Math.max(0, Math.round(Number(costCeilingMinor ?? cfg.ceiling_minor) || 0));
  const reserved = await budget.reserve({
    category,
    ceilingMinor: ceiling,
    requestId,
    attemptId,
    configId: cfg.id,
    priceVersion: cfg.price_version,
    now,
  });
  if (!reserved.ok) {
    await logUsageBestEffort(budget, { now, category, provider_code: cfg.provider_code, event_kind: "fallback", note: reserved.reason });
    return fallback();
  }
  try {
    const result = await actionWithProvider(cfg, reserved.reservation, budget);
    const usage = Math.round(Number(result?.usage?.costMinor ?? ceiling) || 0);
    await budget.settle(reserved.reservation, usage, { category, now });
    return result?.value;
  } catch (error) {
    if (isUncertainCharge(error)) {
      await budget.hold(reserved.reservation, { category, now, note: error?.message || "timeout" });
    } else {
      try { await budget.release(reserved.reservation, { category, now }); } catch { /* keep unknown if already held */ }
    }
    await logUsageBestEffort(budget, {
      now,
      category,
      provider_code: cfg.provider_code,
      reservation_id: reserved.reservation?.id,
      event_kind: "error",
      note: String(error?.message || "error").slice(0, 200),
    });
    return fallback();
  }
}
