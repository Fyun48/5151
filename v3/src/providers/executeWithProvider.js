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
    await budget.usageLog({ now, category, provider_code: cfg?.provider_code, event_kind: "fallback", note: "disabled_or_no_credential" });
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
    await budget.usageLog({ now, category, provider_code: cfg.provider_code, event_kind: "fallback", note: reserved.reason });
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
    await budget.usageLog({
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
