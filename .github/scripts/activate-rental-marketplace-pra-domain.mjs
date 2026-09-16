// Single-process PR A activation. Uses exported domain functions only.
// Do not UPDATE/INSERT settings or rentalMarketplaceFlags here.
import { writeFileSync } from "node:fs";
import {
  db,
  getRentalMarketplaceFlags,
  saveRentalMarketplaceFlags,
} from "/app/src/db.js";

function countDemandPosts() {
  const total = db.prepare("SELECT COUNT(*) AS n FROM demand_posts").get().n;
  const open = db.prepare(
    "SELECT COUNT(*) AS n FROM demand_posts WHERE status = ?",
  ).get("open").n;
  return { total_posts: Number(total), total_open: Number(open) };
}

function assertAllOff(flags, label) {
  const reserved = [
    "owner_matching_enabled",
    "offer_enabled",
    "public_share_v2_enabled",
    "owner_notifications_enabled",
  ];
  if (flags?.rental_catalog_v2?.enabled !== false) {
    throw new Error(`${label} rental_catalog_v2.enabled must be false`);
  }
  if (flags?.wish?.lifecycle_enabled !== false) {
    throw new Error(`${label} wish.lifecycle_enabled must be false`);
  }
  for (const key of reserved) {
    if (flags?.wish?.[key] !== false) {
      throw new Error(`${label} wish.${key} must be false`);
    }
  }
}

function assertPraOnReservedOff(flags, label) {
  const reserved = [
    "owner_matching_enabled",
    "offer_enabled",
    "public_share_v2_enabled",
    "owner_notifications_enabled",
  ];
  if (flags?.rental_catalog_v2?.enabled !== true) {
    throw new Error(`${label} rental_catalog_v2.enabled must be true`);
  }
  if (flags?.wish?.lifecycle_enabled !== true) {
    throw new Error(`${label} wish.lifecycle_enabled must be true`);
  }
  for (const key of reserved) {
    if (flags?.wish?.[key] !== false) {
      throw new Error(`${label} wish.${key} must stay false`);
    }
  }
}

const before_raw_flags = getRentalMarketplaceFlags();
assertAllOff(before_raw_flags, "before");
const before_counts = countDemandPosts();

saveRentalMarketplaceFlags({
  rental_catalog_v2: { enabled: true },
  wish: { lifecycle_enabled: true },
});

const after_raw_flags = getRentalMarketplaceFlags();
assertPraOnReservedOff(after_raw_flags, "after");
const after_counts = countDemandPosts();
if (
  before_counts.total_posts !== after_counts.total_posts
  || before_counts.total_open !== after_counts.total_open
) {
  throw new Error("demand_posts total/open changed during activation");
}

const result = {
  before_raw_flags,
  after_raw_flags,
  before_counts,
  after_counts,
};
writeFileSync("/tmp/pra-domain-result.json", JSON.stringify(result));
console.log(JSON.stringify(result));
