// Single-process Stage 1 inspect / activation / compensating rollback.
// Uses exported domain functions only. Do not UPDATE/INSERT settings here.
// Mutates only wish.owner_matching_enabled. PR A flags stay ON.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STAGE2_PLUS_FLAGS = Object.freeze([
  "offer_enabled",
  "public_share_v2_enabled",
  "owner_notifications_enabled",
  "notifications_enabled",
  "digest_enabled",
  "outbound_mail_enabled",
  "outbound_push_enabled",
]);

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function countDemandPosts(db) {
  const total = db.prepare("SELECT COUNT(*) AS n FROM demand_posts").get().n;
  const open = db.prepare(
    "SELECT COUNT(*) AS n FROM demand_posts WHERE status = ?",
  ).get("open").n;
  return { total_posts: Number(total), total_open: Number(open) };
}

export function lifecycleCounts(db) {
  try {
    return db.prepare(`
      SELECT COALESCE(NULLIF(lifecycle, ''), 'active') AS lifecycle,
             status,
             COUNT(*) AS n
      FROM demand_posts
      GROUP BY 1, 2
      ORDER BY 1, 2
    `).all().map((row) => ({
      lifecycle: String(row.lifecycle || ""),
      status: String(row.status || ""),
      n: Number(row.n) || 0,
    }));
  } catch {
    return [];
  }
}

export function assertPraOnLaterOff(flags, label, ownerMatching) {
  const wish = asObject(flags?.wish);
  if (flags?.rental_catalog_v2?.enabled !== true) {
    throw new Error(`${label} rental_catalog_v2.enabled must be true`);
  }
  if (wish.lifecycle_enabled !== true) {
    throw new Error(`${label} wish.lifecycle_enabled must be true`);
  }
  if (wish.owner_matching_enabled !== ownerMatching) {
    throw new Error(`${label} wish.owner_matching_enabled must be ${ownerMatching}`);
  }
  for (const key of STAGE2_PLUS_FLAGS) {
    if (wish[key] !== false) {
      throw new Error(`${label} wish.${key} must be false`);
    }
  }
}

function sameCounts(before, after, label) {
  if (
    before.total_posts !== after.total_posts
    || before.total_open !== after.total_open
  ) {
    throw new Error(`${label} demand_posts total/open changed during Stage 1 mutation`);
  }
}

export function runStage1Domain({
  db,
  getRentalMarketplaceFlags,
  saveRentalMarketplaceFlags,
  mode = "activate",
  statusPath = process.env.STAGE1_DOMAIN_STATUS_PATH || "/tmp/stage1-domain-status.json",
  resultPath = process.env.STAGE1_DOMAIN_RESULT_PATH || "/tmp/stage1-domain-result.json",
} = {}) {
  if (!getRentalMarketplaceFlags || !saveRentalMarketplaceFlags || !db) {
    throw new Error("Stage 1 domain requires db, getRentalMarketplaceFlags, saveRentalMarketplaceFlags");
  }

  function writeStatus(doc) {
    writeFileSync(statusPath, JSON.stringify(doc));
  }

  function writeResult(result) {
    writeFileSync(resultPath, JSON.stringify(result));
    return result;
  }

  function compensateOff(label) {
    saveRentalMarketplaceFlags({
      wish: { owner_matching_enabled: false },
    });
    const after_raw_flags = getRentalMarketplaceFlags();
    assertPraOnLaterOff(after_raw_flags, label, false);
    const after_counts = countDemandPosts(db);
    return { after_raw_flags, after_counts, lifecycle_counts: lifecycleCounts(db) };
  }

  if (mode === "inspect") {
    const raw_flags = getRentalMarketplaceFlags();
    const counts = countDemandPosts(db);
    writeStatus({
      phase: "inspect",
      mutated: raw_flags?.wish?.owner_matching_enabled === true,
    });
    return writeResult({
      mode: "inspect",
      raw_flags,
      counts,
      lifecycle_counts: lifecycleCounts(db),
    });
  }

  if (mode === "rollback") {
    const before_raw_flags = getRentalMarketplaceFlags();
    assertPraOnLaterOff(before_raw_flags, "rollback-before", before_raw_flags?.wish?.owner_matching_enabled === true);
    const before_counts = countDemandPosts(db);
    const rolled = compensateOff("rollback-after");
    sameCounts(before_counts, rolled.after_counts, "rollback");
    writeStatus({ phase: "rolled-back", mutated: false });
    return writeResult({
      mode: "rollback",
      before_raw_flags,
      after_raw_flags: rolled.after_raw_flags,
      before_counts,
      after_counts: rolled.after_counts,
      lifecycle_counts: rolled.lifecycle_counts,
    });
  }

  if (mode !== "activate") {
    throw new Error(`unsupported STAGE1_DOMAIN_MODE ${mode}`);
  }

  writeStatus({ phase: "before-save", mutated: false });
  const before_raw_flags = getRentalMarketplaceFlags();
  if (before_raw_flags?.wish?.owner_matching_enabled === true) {
    assertPraOnLaterOff(before_raw_flags, "already-on", true);
    const counts = countDemandPosts(db);
    writeStatus({ phase: "already-on", mutated: false });
    return writeResult({
      mode: "activate-already-on",
      before_raw_flags,
      after_raw_flags: before_raw_flags,
      before_counts: counts,
      after_counts: counts,
      lifecycle_counts: lifecycleCounts(db),
    });
  }
  assertPraOnLaterOff(before_raw_flags, "before", false);
  const before_counts = countDemandPosts(db);

  saveRentalMarketplaceFlags({
    wish: { owner_matching_enabled: true },
  });
  writeStatus({ phase: "after-save", mutated: true });

  try {
    const after_raw_flags = getRentalMarketplaceFlags();
    assertPraOnLaterOff(after_raw_flags, "after", true);
    const after_counts = countDemandPosts(db);
    sameCounts(before_counts, after_counts, "after");
    writeStatus({ phase: "after-verify", mutated: true });
    return writeResult({
      mode: "activate",
      before_raw_flags,
      after_raw_flags,
      before_counts,
      after_counts,
      lifecycle_counts: lifecycleCounts(db),
    });
  } catch (error) {
    try {
      const rolled = compensateOff("activate-in-process-rollback");
      sameCounts(before_counts, rolled.after_counts, "activate-in-process-rollback");
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
        lifecycle_counts: rolled.lifecycle_counts,
      });
    } catch (rollbackError) {
      writeStatus({
        phase: "PRODUCTION_STATE_UNKNOWN",
        mutated: true,
        error: String(rollbackError?.message || rollbackError),
      });
      writeResult({
        mode: "PRODUCTION_STATE_UNKNOWN",
        error: String(rollbackError?.message || rollbackError),
        original_error: String(error?.message || error),
        before_raw_flags,
      });
      throw rollbackError;
    }
    throw error;
  }
}

async function main() {
  const spec = process.env.STAGE1_DOMAIN_DB_MODULE || "/app/src/db.js";
  const href = spec.startsWith("file:") ? spec : pathToFileURL(path.resolve(spec)).href;
  const mod = await import(href);
  runStage1Domain({
    db: mod.db,
    getRentalMarketplaceFlags: mod.getRentalMarketplaceFlags,
    saveRentalMarketplaceFlags: mod.saveRentalMarketplaceFlags,
    mode: process.env.STAGE1_DOMAIN_MODE || "activate",
  });
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  await main();
}
