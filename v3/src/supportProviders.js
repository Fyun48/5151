/** Support 收款 adapter。前端不得寫死第三方 URL；秘密值只留在伺服器。 */

import { sanitizeHttpUrl } from "./sponsorLinks.js";
import { FUTURE_PAYMENT_PROVIDERS, SUPPORT_PROVIDER_KINDS, httpError } from "./supportDomain.js";

export class SupportPaymentUnavailable extends Error {
  constructor(message = "目前支持付款服務暫時無法使用，稍後再試即可。") {
    super(message);
    this.status = 503;
    this.code = "SUPPORT_PROVIDER_UNAVAILABLE";
  }
}

function cleanAmount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

export class BuyMeACoffeeProvider {
  kind = "buy_me_a_coffee";

  async getCheckoutUrl(input = {}) {
    const url = sanitizeHttpUrl(input.page_url || input.url);
    if (!url) throw new SupportPaymentUnavailable();
    return {
      provider: this.kind,
      checkoutType: "external",
      url,
    };
  }

  async getStatus() {
    return { ok: true, implemented: false, note: "external checkout only" };
  }

  async verifyWebhook() {
    return { ok: false, implemented: false, reason: "webhook_not_implemented" };
  }
}

export class ExternalUrlProvider {
  kind = "external_url";

  async getCheckoutUrl(input = {}) {
    const url = sanitizeHttpUrl(input.page_url || input.url);
    if (!url) throw new SupportPaymentUnavailable();
    return {
      provider: this.kind,
      checkoutType: "external",
      url,
    };
  }

  async getStatus() {
    return { ok: true, implemented: true };
  }

  async verifyWebhook() {
    return { ok: false, implemented: false, reason: "webhook_not_implemented" };
  }
}

export class FuturePaymentProvider {
  constructor(kind) {
    this.kind = kind;
  }

  async getCheckoutUrl() {
    throw new SupportPaymentUnavailable("此收款方式尚未開通。");
  }

  async getStatus() {
    return { ok: false, implemented: false, note: "reserved" };
  }

  async verifyWebhook() {
    return { ok: false, implemented: false, reason: "reserved_provider" };
  }
}

export function getSupportPaymentProvider(kind) {
  const id = String(kind || "").trim();
  if (id === "buy_me_a_coffee") return new BuyMeACoffeeProvider();
  if (id === "external_url") return new ExternalUrlProvider();
  if (id === "custom") return new ExternalUrlProvider();
  if (FUTURE_PAYMENT_PROVIDERS.includes(id) || id === "newebpay" || id === "ec_pay") {
    return new FuturePaymentProvider(id);
  }
  if (SUPPORT_PROVIDER_KINDS.includes(id)) return new FuturePaymentProvider(id);
  throw httpError("未知的收款方式", 400, "UNKNOWN_PROVIDER");
}

export async function resolveSupportCheckout(providerRow, { amount } = {}) {
  if (!providerRow || Number(providerRow.is_active) !== 1) {
    throw new SupportPaymentUnavailable();
  }
  const adapter = getSupportPaymentProvider(providerRow.kind);
  const result = await adapter.getCheckoutUrl({
    page_url: providerRow.page_url,
    amount: cleanAmount(amount),
    productId: providerRow.provider_product_id,
  });
  if (!result?.url) throw new SupportPaymentUnavailable();
  return result;
}

export function adminProviderView(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    display_name: row.display_name,
    page_url: row.page_url || "",
    widget_url: row.widget_url || "",
    is_active: Number(row.is_active) === 1,
    is_default: Number(row.is_default) === 1,
    has_secret: Boolean(row.secret_ref),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
