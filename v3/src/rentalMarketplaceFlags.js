/** Rental Marketplace v2 feature flags。全部預設關閉；部署 code ≠ 啟用。 */

export const DEFAULT_RENTAL_MARKETPLACE_FLAGS = Object.freeze({
  rental_catalog_v2: Object.freeze({ enabled: false }),
  wish: Object.freeze({
    lifecycle_enabled: false,
    owner_matching_enabled: false,
    offer_enabled: false,
    public_share_v2_enabled: false,
    owner_notifications_enabled: false,
  }),
});

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function boolFlag(value) {
  return value === true;
}

export function normalizeRentalMarketplaceFlags(input = {}) {
  const src = asObject(input);
  const catalog = asObject(src.rental_catalog_v2);
  const wish = asObject(src.wish);
  return {
    rental_catalog_v2: { enabled: boolFlag(catalog.enabled) },
    wish: {
      lifecycle_enabled: boolFlag(wish.lifecycle_enabled),
      owner_matching_enabled: boolFlag(wish.owner_matching_enabled),
      offer_enabled: boolFlag(wish.offer_enabled),
      public_share_v2_enabled: boolFlag(wish.public_share_v2_enabled),
      owner_notifications_enabled: boolFlag(wish.owner_notifications_enabled),
    },
  };
}

export function isRentalCatalogV2Enabled(flags = {}) {
  return normalizeRentalMarketplaceFlags(flags).rental_catalog_v2.enabled === true;
}

export function isWishLifecycleEnabled(flags = {}) {
  return normalizeRentalMarketplaceFlags(flags).wish.lifecycle_enabled === true;
}

export function publicRentalMarketplaceFlags(flags = {}) {
  const row = normalizeRentalMarketplaceFlags(flags);
  return {
    rental_catalog_v2: { enabled: row.rental_catalog_v2.enabled },
    wish: {
      lifecycle_enabled: row.wish.lifecycle_enabled,
      owner_matching_enabled: false,
      offer_enabled: false,
      public_share_v2_enabled: false,
      owner_notifications_enabled: false,
    },
  };
}
