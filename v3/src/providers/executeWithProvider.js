import {
  getBoundBudgetDb,
  loadEnabledProvider,
  hasCredentials,
  reserveBudget,
  settleBudget,
  releaseBudget,
  holdBudget,
  writeUsageLog,
} from "../budgetGuard.js";

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
} = {}) {
  const database = db || getBoundBudgetDb();
  const fallback = async () => fallbackAction();
  if (!database || typeof actionWithProvider !== "function") return fallback();
  const cfg = loadEnabledProvider(database, category);
  if (!cfg || !hasCredentials(database, cfg)) {
    writeUsageLog(database, { now, category, provider_code: cfg?.provider_code, event_kind: "fallback", note: "disabled_or_no_credential" });
    return fallback();
  }
  const ceiling = Math.max(0, Math.round(Number(costCeilingMinor ?? cfg.ceiling_minor) || 0));
  const reserved = reserveBudget(database, {
    category,
    ceilingMinor: ceiling,
    requestId,
    attemptId,
    configId: cfg.id,
    priceVersion: cfg.price_version,
    now,
  });
  if (!reserved.ok) {
    writeUsageLog(database, { now, category, provider_code: cfg.provider_code, event_kind: "fallback", note: reserved.reason });
    return fallback();
  }
  try {
    const result = await actionWithProvider(cfg, reserved.reservation);
    const usage = Math.round(Number(result?.usage?.costMinor ?? ceiling) || 0);
    settleBudget(database, reserved.reservation, usage, { category, now });
    return result?.value;
  } catch (error) {
    if (isUncertainCharge(error)) {
      holdBudget(database, reserved.reservation, { category, now, note: error?.message || "timeout" });
    } else {
      try { releaseBudget(database, reserved.reservation, { category, now }); } catch { /* keep unknown if already held */ }
    }
    writeUsageLog(database, {
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
