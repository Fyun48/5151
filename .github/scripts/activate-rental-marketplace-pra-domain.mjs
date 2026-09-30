// Single-process PR A inspect / activation / compensating rollback.
// Uses exported domain functions only. Do not UPDATE/INSERT settings here.
import { writeFileSync } from "node:fs";
import {
  db,
  getRentalMarketplaceFlags,
  saveRentalMarketplaceFlags,
} from "/app/src/db.js";

// 第八十八批安全閥（判定與 `v3/src/domainToolGuards.js` 相同）：本腳本只吃**同步 SQLite handle**，
// PG 模式下它會動到容器本機 v3.db（站上讀 PG ⇒ 等於沒生效），但流程會回報成功。
// ⚠️ 這裡是**刻意內嵌**的複本：本檔是 `docker cp` 進「目前已部署」的容器執行，
//    不能依賴 /app/src 底下要等下次部署才會出現的新模組。
function assertSqliteMode(tool) {
  const raw = String(process.env.DB_DRIVER || "sqlite").trim().toLowerCase();
  if (!["postgres", "postgresql", "pg"].includes(raw)) return;
  throw new Error(
    `${tool}：只支援 SQLite 模式（目前 DB_DRIVER=${raw}）。這個腳本用同步 SQLite handle 讀寫，`
    + "PG 模式下只會動到容器本機 v3.db（站上讀 PG ⇒ 等於沒生效）。"
    + "PG 模式請改用產品端 PG-aware 入口（例：PUT /api/admin/rental-marketplace-flags）。",
  );
}
assertSqliteMode("activate-rental-marketplace-pra-domain");

const RESERVED = [
  "owner_matching_enabled",
  "offer_enabled",
  "public_share_v2_enabled",
  "owner_notifications_enabled",
  "notifications_enabled",
  "digest_enabled",
  "outbound_mail_enabled",
  "outbound_push_enabled",
];

function countDemandPosts() {
  const total = db.prepare("SELECT COUNT(*) AS n FROM demand_posts").get().n;
  const open = db.prepare(
    "SELECT COUNT(*) AS n FROM demand_posts WHERE status = ?",
  ).get("open").n;
  return { total_posts: Number(total), total_open: Number(open) };
}

function requireZero(counts, label) {
  if (counts.total_posts !== 0 || counts.total_open !== 0) {
    throw new Error(
      `${label} demand_posts total/open must be exact 0/0; stop and redo backup/review`,
    );
  }
}

function assertReservedOff(flags, label) {
  for (const key of RESERVED) {
    if (flags?.wish?.[key] !== false) {
      throw new Error(`${label} wish.${key} must be false`);
    }
  }
}

function assertAllOff(flags, label) {
  if (flags?.rental_catalog_v2?.enabled !== false) {
    throw new Error(`${label} rental_catalog_v2.enabled must be false`);
  }
  if (flags?.wish?.lifecycle_enabled !== false) {
    throw new Error(`${label} wish.lifecycle_enabled must be false`);
  }
  assertReservedOff(flags, label);
}

function assertPraOnReservedOff(flags, label) {
  if (flags?.rental_catalog_v2?.enabled !== true) {
    throw new Error(`${label} rental_catalog_v2.enabled must be true`);
  }
  if (flags?.wish?.lifecycle_enabled !== true) {
    throw new Error(`${label} wish.lifecycle_enabled must be true`);
  }
  assertReservedOff(flags, label);
}

function writeStatus(doc) {
  writeFileSync("/tmp/pra-domain-status.json", JSON.stringify(doc));
}

function writeResult(result) {
  writeFileSync("/tmp/pra-domain-result.json", JSON.stringify(result));
  console.log(JSON.stringify(result));
}

function compensateOff(label) {
  saveRentalMarketplaceFlags({
    rental_catalog_v2: { enabled: false },
    wish: { lifecycle_enabled: false },
  });
  const after_raw_flags = getRentalMarketplaceFlags();
  assertAllOff(after_raw_flags, label);
  const after_counts = countDemandPosts();
  requireZero(after_counts, label);
  return { after_raw_flags, after_counts };
}

const mode = String(process.env.PRA_DOMAIN_MODE || "activate");

if (mode === "inspect") {
  const raw_flags = getRentalMarketplaceFlags();
  const counts = countDemandPosts();
  writeStatus({
    phase: "inspect",
    mutated: raw_flags?.rental_catalog_v2?.enabled === true
      || raw_flags?.wish?.lifecycle_enabled === true,
  });
  writeResult({ mode: "inspect", raw_flags, counts });
  process.exit(0);
}

if (mode === "rollback") {
  const before_raw_flags = getRentalMarketplaceFlags();
  assertReservedOff(before_raw_flags, "rollback-before");
  const before_counts = countDemandPosts();
  requireZero(before_counts, "rollback-before");
  const rolled = compensateOff("rollback-after");
  writeStatus({ phase: "rolled-back", mutated: false });
  writeResult({
    mode: "rollback",
    before_raw_flags,
    after_raw_flags: rolled.after_raw_flags,
    before_counts,
    after_counts: rolled.after_counts,
  });
  process.exit(0);
}

if (mode !== "activate") {
  throw new Error(`unsupported PRA_DOMAIN_MODE ${mode}`);
}

writeStatus({ phase: "before-save", mutated: false });
const before_raw_flags = getRentalMarketplaceFlags();
assertAllOff(before_raw_flags, "before");
const before_counts = countDemandPosts();
requireZero(before_counts, "before");

saveRentalMarketplaceFlags({
  rental_catalog_v2: { enabled: true },
  wish: { lifecycle_enabled: true },
});
writeStatus({ phase: "after-save", mutated: true });

try {
  const after_raw_flags = getRentalMarketplaceFlags();
  assertPraOnReservedOff(after_raw_flags, "after");
  const after_counts = countDemandPosts();
  requireZero(after_counts, "after");
  if (
    before_counts.total_posts !== after_counts.total_posts
    || before_counts.total_open !== after_counts.total_open
  ) {
    throw new Error("demand_posts total/open changed during activation");
  }
  writeStatus({ phase: "after-verify", mutated: true });
  writeResult({
    mode: "activate",
    before_raw_flags,
    after_raw_flags,
    before_counts,
    after_counts,
  });
} catch (error) {
  try {
    const rolled = compensateOff("activate-in-process-rollback");
    writeStatus({
      phase: "rolled-back-in-process",
      mutated: false,
      error: String(error?.message || error),
    });
    writeResult({
      mode: "activate-compensated",
      error: String(error?.message || error),
      before_raw_flags,
      after_raw_flags: rolled.after_raw_flags,
      before_counts,
      after_counts: rolled.after_counts,
    });
  } catch (rollbackError) {
    writeStatus({
      phase: "PRODUCTION_STATE_UNKNOWN",
      mutated: true,
      error: String(rollbackError?.message || rollbackError),
    });
    throw rollbackError;
  }
  throw error;
}
