import { appendAuditRow } from "./audit.js";
import { httpError } from "./errors.js";
import { getProduct, publicProduct } from "./products.js";
import { withImmediateTx } from "./tx.js";
import { rejectSpoofedOwnerDirect } from "./instructionSource.js";

function iso(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function subscriptionRevoked(product) {
  if (!product) return false;
  const productStatus = String(product.status || "");
  const subStatus = String(product.subscription_status || product.subscription?.status || "");
  return ["exited", "exiting"].includes(productStatus) || ["exited", "exiting"].includes(subStatus);
}

function snapshotPending(pending) {
  const items = (pending?.items || []).filter((it) => it.kind !== "exit_record");
  const blocking = (pending?.blocking || items.filter((it) => it.blocking)).filter((it) => it.kind !== "exit_record");
  return {
    items,
    blocking,
    site_delivery_unconfirmed: pending?.site_delivery_unconfirmed === true,
  };
}

export function latestBlockedUnsubscribe(db, productId) {
  const id = String(productId || "");
  if (!id) return null;
  return db.prepare(`
    SELECT * FROM product_exit_record
     WHERE product_id=? AND action='unsubscribe' AND exit_status='blocked'
     ORDER BY id DESC LIMIT 1
  `).get(id) || null;
}

export function describeExitRetryOffer(db, productId) {
  const product = getProduct(db, productId);
  if (!product) return { offered: false, reason: "not_found" };
  const generation = Number(product.subscription_generation || 1);
  if (!subscriptionRevoked(product)) {
    return { offered: false, reason: "subscription_active", confirmed: false, product_id: product.id, generation };
  }
  const record = latestBlockedUnsubscribe(db, product.id);
  if (!record) {
    return { offered: false, reason: "no_blocked_exit", confirmed: true, product_id: product.id, generation };
  }
  if (Number(record.generation || 1) !== generation) {
    return {
      offered: false,
      reason: "stale_generation",
      confirmed: false,
      product_id: product.id,
      generation,
      exit_record_id: Number(record.id),
    };
  }
  return {
    offered: true,
    confirmed: false,
    product_id: product.id,
    generation,
    exit_record_id: Number(record.id),
    rewrite_subscription: false,
    pending_not_claimed: true,
  };
}

export function retryBlockedExit(db, productId, opts = {}) {
  rejectSpoofedOwnerDirect(opts);
  const {
    actor = "owner",
    reason = null,
    now = new Date(),
    listPendingWork,
  } = opts;
  const note = String(reason || "").trim();
  if (!note) throw httpError("重試必須寫明目前看到的未決情況", 400);
  if (typeof listPendingWork !== "function") {
    throw httpError("重試退出紀錄缺少未決快照來源", 500);
  }
  const product = getProduct(db, productId);
  if (!product) throw httpError("找不到產品", 404);
  if (!subscriptionRevoked(product)) {
    throw httpError("只有已解除訂閱或退出中的站才可重試退出紀錄。訂閱仍接通時不必重試。", 409);
  }
  const generation = Number(product.subscription_generation || 1);
  const record = latestBlockedUnsubscribe(db, product.id);
  if (!record) {
    return {
      idempotent: true,
      retried: false,
      completed: true,
      still_blocked: false,
      rewrite_subscription: false,
      pending_not_claimed: true,
      blocking_count: 0,
      generation,
      product: publicProduct(product),
    };
  }
  if (Number(record.generation || 1) !== generation) {
    throw httpError("退出紀錄世代已過期。重新連接後的舊紀錄不能重試。", 409);
  }
  const pending = snapshotPending(listPendingWork(db, product.id));
  const completed = pending.blocking.length === 0;
  withImmediateTx(db, () => {
    db.prepare(`
      UPDATE product_exit_record
         SET exit_status=?, pending_json=?, notes=?, updated_at=?, completed_at=?
       WHERE id=?
    `).run(
      completed ? "completed" : "blocked",
      JSON.stringify(pending),
      completed
        ? `已重試退出紀錄：未決阻擋已解除。${note.slice(0, 800)}`
        : `已重試退出紀錄：仍有 ${pending.blocking.length} 項阻擋。${note.slice(0, 800)}`,
      iso(now),
      completed ? iso(now) : null,
      Number(record.id),
    );
    appendAuditRow(db, {
      actor,
      action: "product.exit.retry",
      entityType: "ops_product",
      entityId: String(product.id),
      data: {
        product_id: product.id,
        generation,
        exit_record_id: Number(record.id),
        completed,
        still_blocked: !completed,
        blocking_count: pending.blocking.length,
        reason: note.slice(0, 1000),
        rewrite_subscription: false,
        pending_not_claimed: true,
        prev_product_status: product.status,
        prev_subscription_status: product.subscription_status || null,
        prev_exit_status: record.exit_status,
      },
      now,
    });
  });
  const fresh = getProduct(db, product.id);
  const updated = db.prepare("SELECT * FROM product_exit_record WHERE id=?").get(Number(record.id));
  let pendingOut = pending;
  try { pendingOut = updated?.pending_json ? JSON.parse(updated.pending_json) : pending; } catch { /* keep */ }
  return {
    retried: true,
    completed,
    still_blocked: !completed,
    rewrite_subscription: false,
    pending_not_claimed: true,
    blocking_count: pending.blocking.length,
    generation,
    exit: {
      id: Number(updated.id),
      product_id: updated.product_id,
      generation: Number(updated.generation || 1),
      action: updated.action,
      exit_status: updated.exit_status,
      pending: pendingOut,
      notes: updated.notes || "",
      created_at: updated.created_at,
      updated_at: updated.updated_at,
      completed_at: updated.completed_at || null,
    },
    product: publicProduct(fresh),
  };
}
