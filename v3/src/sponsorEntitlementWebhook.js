// 贊助連動 webhook 對帳（Phase 3）。flags.webhook 關時完全不介入（回 handled:false 走既有 501 stub）。
// 金鑰只從環境變數讀（BMC_WEBHOOK_SECRET／KO_FI_VERIFICATION_TOKEN）；沒有金鑰＝501「尚未設定」，fail-soft。
import {
  extractSupportCode,
  evaluateSupportMatch,
  verifyBmcWebhookSignature,
  verifyKofiVerificationToken,
} from "./sponsorEntitlement.js";
import {
  getSponsorEntitlementFlagsAsync,
  getSponsorEntitlementRulesAsync,
  resolveMemberSupportCodeAsync,
  recordSponsorWebhookTransactionAsync,
  recentSupportSumAsync,
  applySponsorEntitlementAsync,
} from "./sponsorEntitlementAsync.js";

const PAYMENT_EVENT = /payment|donation|purchase|subscription/i;
const REFUND_EVENT = /refund|reversed|canceled|cancelled/i;

function pick(body, data, keys) {
  for (const key of keys) {
    const value = data?.[key] ?? body?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

export async function handleSponsorEntitlementWebhookAsync({ provider, body, rawBody, headers } = {}, options = {}) {
  const flags = await getSponsorEntitlementFlagsAsync(options);
  if (!flags.webhook) return { handled: false };
  const raw = String(provider || "").toLowerCase();
  const providerNorm = raw === "buy_me_a_coffee" ? "bmc" : raw;
  if (providerNorm !== "bmc" && providerNorm !== "kofi") return { handled: false };

  if (providerNorm === "bmc") {
    const secret = process.env.BMC_WEBHOOK_SECRET || "";
    if (!secret) return { handled: true, status: 501, json: { ok: false, error: "尚未設定 BMC_WEBHOOK_SECRET" } };
    if (!verifyBmcWebhookSignature(rawBody || JSON.stringify(body || {}), secret, headers?.["x-signature-sha256"])) {
      return { handled: true, status: 401, json: { ok: false, error: "簽章驗證失敗" } };
    }
  } else {
    const secret = process.env.KO_FI_VERIFICATION_TOKEN || "";
    if (!secret) return { handled: true, status: 501, json: { ok: false, error: "尚未設定 KO_FI_VERIFICATION_TOKEN" } };
    if (!verifyKofiVerificationToken(body, secret)) {
      return { handled: true, status: 401, json: { ok: false, error: "verification_token 驗證失敗" } };
    }
  }

  const event = String(body?.event || body?.type || "");
  if (event && REFUND_EVENT.test(event)) {
    // D8 預設不自動撤銷：退款只記錄、不動會員方案。
    return { handled: true, status: 200, json: { ok: true, ignored: "refund" } };
  }
  if (event && !PAYMENT_EVENT.test(event)) {
    return { handled: true, status: 200, json: { ok: true, ignored: event } };
  }

  const data = body?.data && typeof body.data === "object" ? body.data : {};
  const amount = Number(pick(body, data, ["total_amount", "amount", "amount_usd"])) || 0;
  const note = String(pick(body, data, ["support_note", "message", "content"]) || "");
  const providerTxId = String(pick(body, data, ["id", "transaction_id", "payment_id"]) || "");
  if (!providerTxId) return { handled: true, status: 400, json: { ok: false, error: "缺少交易 id" } };

  const code = extractSupportCode(note);
  const matched = code ? await resolveMemberSupportCodeAsync({ code }, options) : null;
  const record = await recordSponsorWebhookTransactionAsync({
    provider: providerNorm,
    providerTransactionId: providerTxId,
    userId: matched?.userId || null,
    supporterName: String(pick(body, data, ["supporter_name", "from_name", "payer_name"]) || "").slice(0, 120),
    amount,
    message: note,
    receivedAt: new Date(pick(body, data, ["created_at", "paid_at", "timestamp"]) || Date.now()),
    rawReference: JSON.stringify(body).slice(0, 300),
  }, options);
  if (record.duplicate) return { handled: true, status: 200, json: { ok: true, duplicate: true } };

  let entitled = false;
  if (matched?.userId) {
    const rules = await getSponsorEntitlementRulesAsync(options);
    const windowMs = rules.windowDays * 86400000;
    const sumIncluding = await recentSupportSumAsync({ userId: matched.userId, sinceMs: windowMs }, options);
    const prior = Math.max(0, sumIncluding - amount);
    const verdict = evaluateSupportMatch({ amount, rules, recentSumTWD: prior });
    if (flags.autoEntitlement && verdict.eligible) {
      const grant = await applySponsorEntitlementAsync({
        userId: matched.userId,
        transactionId: `${providerNorm}:${providerTxId}`,
        provider: providerNorm,
        amount,
        reason: `webhook:${verdict.reason}`,
        durationDays: rules.durationDays,
      }, options);
      entitled = Boolean(grant.ok);
    }
  }
  return { handled: true, status: 200, json: { ok: true, matched: Boolean(matched?.userId), entitled } };
}
