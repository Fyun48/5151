import { DEFAULT_CAPABILITIES } from "./products.js";

function parseCaps(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function capsOf(product) {
  const raw = product?.subscription?.capabilities ?? product?.capabilities;
  return { ...DEFAULT_CAPABILITIES, ...(typeof raw === "string" ? parseCaps(raw) : (raw || {})) };
}

function isConnected(product) {
  const pStatus = product?.status;
  const sStatus = product?.subscription_status || product?.subscription?.status;
  return pStatus === "active" && (sStatus === "connected" || sStatus === "connecting");
}

export function productAllowsStats(product) {
  if (!product) return false;
  return Boolean(capsOf(product).stats) && isConnected(product);
}

export function productAllowsFollowup(product) {
  if (!product) return false;
  return Boolean(capsOf(product).followup_service) && isConnected(product);
}

export function listProductConsentRows(db) {
  if (!db) return [];
  return db.prepare(`
    SELECT p.id, p.status, s.status AS subscription_status, s.capabilities
      FROM ops_product p
      LEFT JOIN product_subscription s ON s.product_id = p.id
     ORDER BY p.id ASC
  `).all();
}

export function productIdsAllowingStats(db) {
  return listProductConsentRows(db).filter((row) => productAllowsStats(row)).map((row) => row.id);
}

export function productIdsWithheldFromStats(db) {
  return listProductConsentRows(db).filter((row) => !productAllowsStats(row)).map((row) => row.id);
}

export function countIngestedForStats(db, { productId = null } = {}) {
  if (productId) {
    const row = listProductConsentRows(db).find((item) => item.id === productId);
    if (!productAllowsStats(row)) return 0;
    return Number(db.prepare("SELECT COUNT(*) AS n FROM ingested_feedback WHERE product_id=?").get(productId)?.n) || 0;
  }
  const allowed = productIdsAllowingStats(db);
  if (!allowed.length) return 0;
  const marks = allowed.map(() => "?").join(",");
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ingested_feedback WHERE product_id IN (${marks})`).get(...allowed)?.n) || 0;
}

export function analysisStatsForConsent(db, rawStats) {
  const allowed = productIdsAllowingStats(db);
  const consented = { pending: 0, processing: 0, failed_retry: 0, completed: 0, failed: 0, total: 0 };
  if (allowed.length) {
    const marks = allowed.map(() => "?").join(",");
    for (const r of db.prepare(`
      SELECT a.status, COUNT(*) n
        FROM feedback_analysis a
        JOIN ingested_feedback f ON f.id = a.feedback_id
       WHERE f.product_id IN (${marks})
       GROUP BY a.status
    `).all(...allowed)) {
      consented[r.status] = Number(r.n) || 0;
      consented.total += Number(r.n) || 0;
    }
  }
  return {
    ...rawStats,
    stats_consented: consented,
    stats_withheld_product_ids: productIdsWithheldFromStats(db),
  };
}
