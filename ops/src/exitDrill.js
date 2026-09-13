import { createHash } from "node:crypto";
import { withImmediateTx } from "./tx.js";
import { appendAuditRow } from "./audit.js";
import { httpError } from "./errors.js";
import {
  getProduct,
  publicProduct,
  unsubscribeProduct,
  normalizeProductId,
} from "./products.js";
import { redactCrmReplicas, listCrmHandoff } from "./crmReplica.js";
import { inferIssueProductId, issueWriteDecision, redactInsightDerivatives } from "./insightConsent.js";
import { recordPurgeEvent, redactExclusiveIssues } from "./purgeLedger.js";
import { describeCodeRollbackOffer, describeDbRestoreOffer } from "./release/productionRelease.js";

export const EXIT_ACTIONS = Object.freeze(["pause", "unsubscribe", "handoff", "purge_replica"]);
export const HANDOFF_SCHEMA = 1;

function iso(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function sha256Json(value) {
  return createHash("sha256").update(Buffer.from(JSON.stringify(value), "utf8")).digest("hex");
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function safeAll(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

const TERMINAL_PRODUCTION_STATUSES = new Set(["SUCCEEDED", "ROLLED_BACK", "BLOCKED"]);
export const UNKNOWN_PRODUCTION_STATUS = "PRODUCTION_STATE_UNKNOWN";
const RUNNER_IN_FLIGHT_STATUSES = new Set([
  "BUILD_DISPATCHED",
  "PREDEPLOY_DISPATCHED",
  "DEPLOY_DISPATCHED",
  "CODE_ROLLBACK_DISPATCHED",
]);

function productionReleaseObservation(db, runId, status) {
  const bindings = tableExists(db, "production_release_workflow_binding")
    ? safeAll(db, `
      SELECT workflow_kind, workflow_run_id, dispatch_submitted_at, binding_status
        FROM production_release_workflow_binding WHERE release_run_id=? ORDER BY id
    `, [runId])
    : [];
  const accepted = bindings.filter((row) => row.workflow_run_id || (row.dispatch_submitted_at && row.binding_status !== "rejected"));
  const latest = accepted[accepted.length - 1] || null;
  const evidence = tableExists(db, "production_release_evidence")
    ? safeAll(db, `
      SELECT evidence_kind, workflow_run_id, workflow_conclusion
        FROM production_release_evidence WHERE release_run_id=? ORDER BY id DESC LIMIT 1
    `, [runId])[0]
    : null;
  const cancelN = tableExists(db, "production_release_evidence")
    ? Number(db.prepare(
      "SELECT COUNT(*) n FROM production_release_evidence WHERE release_run_id=? AND evidence_kind='runner_cancel'",
    ).get(runId)?.n || 0)
    : 0;
  return {
    accepted: accepted.length > 0,
    in_flight: RUNNER_IN_FLIGHT_STATUSES.has(status),
    runner_cancel_requested: cancelN > 0,
    workflow_kind: latest?.workflow_kind || null,
    workflow_run_id: latest?.workflow_run_id || evidence?.workflow_run_id || null,
    workflow_conclusion: evidence?.workflow_conclusion || null,
  };
}

function knownResultPendingNote({ scoped, status, codeOffer, dbOffer }) {
  if (!scoped) {
    return "正式發布尚未綁 product_id；列出已知結果但不能宣稱可退回或還原資料庫";
  }
  const dbBit = dbOffer?.requested
    ? "已記錄 DB 還原要求；自動還原不會執行。"
    : "可另送 DB 還原要求；自動還原不會執行。";
  if (status === "ROLLED_BACK") {
    return `已知結果：程式已退回。${dbBit}這不是再退回程式，也不是取消 runner。`;
  }
  if (codeOffer?.rollback?.contract_complete) {
    return `已知結果：正式發布已成功，此為目前正式版。可程式退回上一版。${dbBit}程式退回與 DB 還原是不同操作。`;
  }
  return `已知結果：正式發布已成功，此為目前正式版。上一版身分不完整，不能宣稱可退回。${dbBit}`;
}

function productionReleasePendingNote({ scoped, unknown, observation }) {
  if (unknown) {
    return scoped
      ? "正式部署狀態不明；先確認該環境實際結果，再完成移交。已送出的部署不宣稱撤回。"
      : "正式發布尚未綁 product_id，且狀態不明；不能用這筆擋別站移交";
  }
  if (!scoped) {
    return "正式發布尚未綁 product_id；退出時列出但不能宣稱已取消外部呼叫";
  }
  if (observation.accepted && observation.in_flight) {
    return observation.runner_cancel_requested
      ? "執行中：已要求取消 GitHub runner。不宣稱撤回部署。程式退回與 DB 還原是不同操作。"
      : "執行中：GitHub runner 尚未結束。可取消 runner，不宣稱撤回部署。程式退回與 DB 還原是不同操作。";
  }
  if (observation.accepted) {
    const result = observation.workflow_conclusion ? `（${observation.workflow_conclusion}）` : "";
    return `已知結果：已受理的 workflow 有觀察紀錄${result}。取消 runner 只適用尚未結束的檢查。不宣稱撤回部署。`;
  }
  return "未送出的正式發布可取消；已受理的部署不宣稱撤回。訂閱世代已換或已退出的晚到發布不開新 workflow。";
}

function latestProductionStatus(db, runId) {
  const row = safeAll(db, "SELECT to_status FROM production_release_run_event WHERE release_run_id=? ORDER BY id DESC LIMIT 1", [Number(runId)])[0];
  return row?.to_status || "CREATED";
}

function scopedProductionProductId(db, row) {
  return row.product_id || inferIssueProductId(db, row.issue_id) || null;
}

export function listUnknownProductionRuns(db, productId) {
  const id = normalizeProductId(productId);
  if (!id || !tableExists(db, "production_release_run")) return [];
  return safeAll(db, "SELECT id, issue_id, product_id FROM production_release_run")
    .filter((row) => scopedProductionProductId(db, row) === id)
    .filter((row) => latestProductionStatus(db, row.id) === UNKNOWN_PRODUCTION_STATUS)
    .map((row) => ({ id: Number(row.id), issue_id: Number(row.issue_id), product_id: id, status: UNKNOWN_PRODUCTION_STATUS }));
}

export function ensureExitDrillSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_exit_record (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      generation INTEGER NOT NULL DEFAULT 1,
      action TEXT NOT NULL,
      exit_status TEXT NOT NULL,
      pending_json TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (product_id) REFERENCES ops_product(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_exit_record_product ON product_exit_record(product_id, id);
    CREATE TABLE IF NOT EXISTS product_handoff_export (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL,
      exit_record_id INTEGER,
      manifest_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES ops_product(id) ON DELETE RESTRICT
    );
  `);
}

export function listPendingWork(db, productId) {
  const id = normalizeProductId(productId);
  const items = [];
  const creds = safeAll(db, "SELECT id, label, status FROM product_ingest_credential WHERE product_id=? AND status='active'", [id]);
  for (const row of creds) {
    items.push({
      kind: "credential",
      id: row.id,
      label: row.label || "ingest",
      state: row.status,
      blocking: false,
      note: "解除訂閱後會撤銷",
    });
  }
  const analysis = safeAll(db, `
    SELECT a.id, a.status FROM feedback_analysis a
     JOIN ingested_feedback f ON f.id = a.feedback_id
    WHERE f.product_id=? AND a.status IN ('pending','failed_retry','processing')
  `, [id]);
  for (const row of analysis) {
    items.push({
      kind: "analysis",
      id: row.id,
      state: row.status,
      blocking: row.status === "processing",
      note: "未送出的分析可取消；已在跑的不宣稱撤回。訂閱世代已換或已退出的晚到結果不會開新議題。",
    });
  }
  if (tableExists(db, "issue_evaluation_run")) {
    const evals = safeAll(db, `
      SELECT r.id, r.status FROM issue_evaluation_run r
       JOIN issue_candidate i ON i.id = r.issue_id
      WHERE r.status IN ('pending','failed_retry','processing')
        AND (
          i.product_id=?
          OR EXISTS (
            SELECT 1 FROM issue_feedback_link l
             JOIN ingested_feedback f ON f.id = l.feedback_id
            WHERE l.issue_id = i.id AND l.active = 1 AND f.product_id = ?
          )
        )
    `, [id, id]);
    for (const row of evals) {
      items.push({
        kind: "evaluation",
        id: row.id,
        state: row.status,
        blocking: row.status === "processing",
        note: "未送出的評估可取消；已在跑的不宣稱撤回。訂閱世代已換或已退出的晚到評估不會寫入新結果。",
      });
    }
  }
  if (tableExists(db, "issue_proposal")) {
    const props = safeAll(db, `
      SELECT p.id, p.status FROM issue_proposal p
       JOIN issue_candidate i ON i.id = p.issue_id
      WHERE p.status IN ('pending','failed_retry','processing')
        AND (
          i.product_id=?
          OR EXISTS (
            SELECT 1 FROM issue_feedback_link l
             JOIN ingested_feedback f ON f.id = l.feedback_id
            WHERE l.issue_id = i.id AND l.active = 1 AND f.product_id = ?
          )
        )
    `, [id, id]);
    for (const row of props) {
      items.push({
        kind: "proposal",
        id: row.id,
        state: row.status,
        blocking: row.status === "processing",
        note: "未送出的提案可取消；已在跑的不宣稱撤回。訂閱世代已換或已退出的晚到提案不會寫入或送 webhook。",
      });
    }
  }
  if (tableExists(db, "development_coding_task")) {
    const tasks = safeAll(db, `
      SELECT id, issue_id, status FROM development_coding_task
       WHERE status IN ('pending','claimed','running','changes_ready','failed_retry')
    `);
    for (const row of tasks) {
      const scoped = inferIssueProductId(db, row.issue_id);
      if (scoped && scoped !== id) continue;
      items.push({
        kind: "coding",
        id: row.id,
        state: row.status,
        blocking: row.status === "running" || row.status === "claimed",
        unscoped: !scoped,
        note: scoped
          ? "未送出的製作可取消；已在跑的不宣稱撤回外部呼叫。訂閱世代已換或已退出的晚到結果不會開 PR 或寫入。"
          : "製作任務尚未綁 product_id；退出時列出但不能宣稱已取消外部呼叫",
      });
    }
  }
  if (tableExists(db, "development_qa_run")) {
    const runs = safeAll(db, `
      SELECT id, issue_id, status FROM development_qa_run
       WHERE status IN ('pending','claimed','running','failed_retry')
    `);
    for (const row of runs) {
      const scoped = inferIssueProductId(db, row.issue_id);
      if (scoped && scoped !== id) continue;
      items.push({
        kind: "qa",
        id: row.id,
        state: row.status,
        blocking: row.status === "running" || row.status === "claimed",
        unscoped: !scoped,
        note: scoped
          ? "未送出的 QA 可取消；已在跑的取消不宣稱撤回 worktree。已完成的結果不改寫。訂閱世代已換或已退出的晚到 QA 不會寫入結果。"
          : "QA 尚未綁 product_id；退出時列出但不能宣稱已取消外部呼叫",
      });
    }
  }
  if (tableExists(db, "development_staging_deployment")) {
    const deps = safeAll(db, `
      SELECT id, issue_id, status FROM development_staging_deployment
       WHERE status IN ('pending','claimed','building','deploying','validating','failed_retry')
    `);
    for (const row of deps) {
      const scoped = inferIssueProductId(db, row.issue_id);
      if (scoped && scoped !== id) continue;
      items.push({
        kind: "staging",
        id: row.id,
        state: row.status,
        blocking: ["claimed", "building", "deploying", "validating"].includes(row.status),
        unscoped: !scoped,
        note: scoped
          ? "未送出的隔離 staging 可取消；已在跑的不宣稱撤回。訂閱世代已換或已退出的晚到部署不會寫入 current。"
          : "隔離 staging 尚未綁 product_id；退出時列出但不能宣稱已取消外部呼叫",
      });
    }
  }
  if (tableExists(db, "production_release_run")) {
    const runs = safeAll(db, "SELECT id, issue_id, product_id FROM production_release_run");
    for (const row of runs) {
      const scoped = scopedProductionProductId(db, row);
      if (scoped && scoped !== id) continue;
      const status = latestProductionStatus(db, row.id);
      if (TERMINAL_PRODUCTION_STATUSES.has(status)) {
        const codeOffer = status === "SUCCEEDED" ? describeCodeRollbackOffer(db, row.id) : { offered: false };
        const dbOffer = describeDbRestoreOffer(db, row.id);
        if (codeOffer.offered || dbOffer.offered) {
          items.push({
            kind: "production_release",
            id: row.id,
            state: status,
            blocking: false,
            unscoped: !scoped,
            observation: {
              accepted: true,
              in_flight: false,
              known_result: status === "ROLLED_BACK" ? "rolled_back" : "success",
              runner_cancel_requested: false,
              db_restore_requested: !!dbOffer.requested,
            },
            rollback: codeOffer.rollback || null,
            db_restore: dbOffer.offered ? dbOffer : null,
            note: knownResultPendingNote({ scoped, status, codeOffer, dbOffer }),
          });
        }
        continue;
      }
      const unknown = status === UNKNOWN_PRODUCTION_STATUS;
      const observation = productionReleaseObservation(db, row.id, status);
      items.push({
        kind: "production_release",
        id: row.id,
        state: unknown ? "unknown" : (status || "pending"),
        blocking: true,
        unscoped: !scoped,
        observation,
        note: productionReleasePendingNote({ scoped, unknown, observation }),
      });
    }
  }
  if (tableExists(db, "embedding")) {
    const embN = Number(db.prepare(`
      SELECT COUNT(*) n FROM embedding e
       JOIN ingested_feedback f ON f.id = e.feedback_id
      WHERE f.product_id=? AND e.status='active'
    `).get(id)?.n || 0);
    if (embN) {
      items.push({
        kind: "insight_embedding",
        id,
        state: "replica",
        blocking: false,
        note: `OPS 有 ${embN} 筆向量；刪複本才清除。去掉 email 不是匿名化。撤回跨站分析只停新洞察。`,
      });
    }
  }
  if (tableExists(db, "ingested_crm_contact")) {
    const crmN = Number(db.prepare("SELECT COUNT(*) n FROM ingested_crm_contact WHERE product_id=?").get(id)?.n || 0);
    if (crmN) {
      items.push({
        kind: "crm_replica",
        id: id,
        state: "replica",
        blocking: false,
        note: `OPS 有 ${crmN} 筆站方 CRM 複本；刪複本才清除，關模組不會 DROP`,
      });
    }
  }
  if (tableExists(db, "site_command_job")) {
    const cmds = safeAll(db, `
      SELECT id, job_state, apply_state FROM site_command_job
       WHERE product_id=? AND job_state IN ('pending','sending','sent')
    `, [id]);
    for (const row of cmds) {
      if (row.job_state === "sent" && row.apply_state === "applied") continue;
      const inFlight = row.job_state === "sending";
      items.push({
        kind: "site_command",
        id: row.id,
        state: row.job_state,
        blocking: inFlight,
        note: inFlight
          ? "已送出的遠端客服不宣稱撤回。訂閱世代已換或已退出的晚到命令不再重試外送。"
          : "未送出的遠端客服可取消。已在跑的外送不宣稱撤回。訂閱世代已換或已退出的晚到命令不會外送。",
      });
    }
  }
  if (tableExists(db, "state_entity") && tableExists(db, "issue_candidate")) {
    const deferred = safeAll(db, `
      SELECT i.id AS issue_id, e.state FROM state_entity e
       JOIN issue_candidate i ON e.id = 'issue:' || i.id
      WHERE e.entity_type='issue' AND e.state IN ('DEFERRED','REJECTED') AND i.status='open'
    `);
    for (const row of deferred) {
      const scoped = inferIssueProductId(db, row.issue_id);
      if (scoped && scoped !== id) continue;
      if (!scoped) continue;
      const decision = safeAll(db, `
        SELECT subscription_generation FROM proposal_owner_decision
         WHERE issue_id=? AND action IN ('DEFER','REJECT')
         ORDER BY id DESC LIMIT 1
      `, [row.issue_id])[0];
      const expected = decision?.subscription_generation == null ? null : Number(decision.subscription_generation);
      const gate = issueWriteDecision(db, row.issue_id, { expectedGeneration: expected });
      if (gate.ok) continue;
      items.push({
        kind: "reevaluation",
        id: row.issue_id,
        state: gate.reason === "stale_generation" ? "stale_generation" : "subscription_revoked",
        blocking: false,
        note: "自動重評已停：訂閱已退出或世代已換，不會把舊議題重開成評估中。已送出的外部呼叫不宣稱撤回。Owner 手動重評不在此限。",
      });
    }
  }
  if (tableExists(db, "release_notification")) {
    const notes = safeAll(db, "SELECT id, issue_id, status FROM release_notification WHERE status='pending'");
    for (const row of notes) {
      const scoped = inferIssueProductId(db, row.issue_id);
      if (scoped && scoped !== id) continue;
      items.push({
        kind: "release_notification",
        id: row.id,
        state: row.status,
        blocking: false,
        unscoped: !scoped,
        note: scoped
          ? "未送出的發布通知可取消。訂閱世代已換或已退出的晚到通知不會外送。"
          : "發布通知佇列尚未分站",
      });
    }
  }
  const blocking = items.filter((it) => it.blocking);
  return { items, blocking, site_delivery_unconfirmed: true };
}

function insertExitRecord(db, { productId, generation, action, exitStatus, pending, notes, actor, now }) {
  const ts = iso(now);
  const res = db.prepare(`
    INSERT INTO product_exit_record(product_id, generation, action, exit_status, pending_json, notes, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    productId,
    Number(generation || 1),
    action,
    exitStatus,
    JSON.stringify(pending || { items: [], blocking: [] }),
    notes || "",
    ts,
    ts,
    exitStatus === "completed" ? ts : null,
  );
  appendAuditRow(db, {
    actor,
    action: `product.exit.${action}`,
    entityType: "ops_product",
    entityId: productId,
    data: { exit_record_id: Number(res.lastInsertRowid), exit_status: exitStatus },
    now,
  });
  return getExitRecord(db, Number(res.lastInsertRowid));
}

export function getExitRecord(db, id) {
  const row = db.prepare("SELECT * FROM product_exit_record WHERE id=?").get(id);
  return row ? publicExit(row) : null;
}

export function listExits(db, productId) {
  const id = normalizeProductId(productId);
  if (!id) return [];
  return db.prepare("SELECT * FROM product_exit_record WHERE product_id=? ORDER BY id DESC LIMIT 20").all(id).map(publicExit);
}

export function latestExit(db, productId) {
  const id = normalizeProductId(productId);
  if (!id) return null;
  const row = db.prepare("SELECT * FROM product_exit_record WHERE product_id=? ORDER BY id DESC LIMIT 1").get(id);
  return row ? publicExit(row) : null;
}

export function publicExit(row) {
  if (!row) return null;
  let pending = { items: [], blocking: [] };
  try { pending = row.pending_json ? JSON.parse(row.pending_json) : pending; } catch { /* keep empty */ }
  return {
    id: Number(row.id),
    product_id: row.product_id,
    generation: Number(row.generation || 1),
    action: row.action,
    exit_status: row.exit_status,
    pending,
    notes: row.notes || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at || null,
  };
}

export function beginUnsubscribeExit(db, productId, { actor = "owner", now = new Date() } = {}) {
  const before = getProduct(db, productId);
  if (!before) throw httpError("not found", 404);
  const pending = listPendingWork(db, before.id);
  const product = unsubscribeProduct(db, before.id, { actor, now });
  const blocked = pending.blocking.length > 0;
  const record = withImmediateTx(db, () => insertExitRecord(db, {
    productId: before.id,
    generation: before.subscription_generation,
    action: "unsubscribe",
    exitStatus: blocked ? "blocked" : "completed",
    pending,
    notes: blocked
      ? "憑證已撤銷。未決外部工作不能宣稱已取消。"
      : "已解除訂閱並撤銷密鑰。本機主本不在 OPS。",
    actor,
    now,
  }));
  return {
    product,
    exit: record,
    pending,
    site_delivery_unconfirmed: true,
  };
}

export function pendingForHandoff(pendingAll) {
  const items = (pendingAll?.items || []).filter((it) => !it.unscoped);
  const blocking = (pendingAll?.blocking || []).filter((it) => !it.unscoped);
  return {
    items,
    blocking,
    site_delivery_unconfirmed: true,
    omitted_unscoped: (pendingAll?.items || []).filter((it) => it.unscoped).length,
  };
}

export function exportHandoff(db, productId, { actor = "owner", now = new Date() } = {}) {
  const product = getProduct(db, productId);
  if (!product) throw httpError("not found", 404);
  const unknown = listUnknownProductionRuns(db, product.id);
  if (unknown.length) {
    throw httpError("正式部署狀態不明，先確認該環境實際結果再移交。已送出的部署不宣稱撤回。", 409);
  }
  const pending = pendingForHandoff(listPendingWork(db, product.id));
  const crmContacts = tableExists(db, "ingested_crm_contact") ? listCrmHandoff(db, product.id) : [];
  const feedback = db.prepare(`
    SELECT id, product_id, kind, content, app_version, received_at, submitted_at, source
      FROM ingested_feedback WHERE product_id=? ORDER BY id ASC
  `).all(product.id).map((row) => ({
    id: Number(row.id),
    product_id: row.product_id,
    kind: row.kind || "other",
    content: row.content || "",
    app_version: row.app_version || null,
    received_at: row.received_at,
    submitted_at: row.submitted_at,
    source: row.source || "unknown",
    content_sha256: createHash("sha256").update(String(row.content || ""), "utf8").digest("hex"),
  }));
  const payload = {
    schema_version: HANDOFF_SCHEMA,
    product: publicProduct(product),
    exported_at: iso(now),
    feedback,
    crm_contacts: crmContacts,
    pending,
    checklist: {
      code: { included: false, note: "同一 repo；分家時另交該站程式與 lockfile，不在本包" },
      operations_data: { included: true, count: feedback.length, note: "OPS 複本回饋（不含聯絡方式）" },
      crm: { included: true, count: crmContacts.length, note: "站方 CRM 複本摘要；Owner 商務備註不當作站方資料匯出" },
      accounts: { included: false, note: "本機管理員帳號在站方庫，不在 OPS" },
      infrastructure: { included: false, note: "網域／Tunnel／CI 另列經營者" },
      external_services: { included: false, note: "金鑰不匯出；對方自備憑證" },
      permission_revoke: { included: true, note: "訂閱憑證由解除訂閱撤銷；其它部署鑰匙第 8 包" },
    },
  };
  const digest = sha256Json(payload);
  const manifest = {
    schema_version: HANDOFF_SCHEMA,
    product_id: product.id,
    sha256: digest,
    feedback_count: feedback.length,
    exported_at: payload.exported_at,
    files: [
      { name: "handoff.json", sha256: digest },
    ],
  };
  return withImmediateTx(db, () => {
    const exit = insertExitRecord(db, {
      productId: product.id,
      generation: product.subscription_generation,
      action: "handoff",
      exitStatus: "completed",
      pending,
      notes: `交接包 ${digest.slice(0, 12)}`,
      actor,
      now,
    });
    db.prepare(`
      INSERT INTO product_handoff_export(product_id, exit_record_id, manifest_json, payload_json, sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(product.id, exit.id, JSON.stringify(manifest), JSON.stringify(payload), digest, iso(now));
    return { manifest, payload, sha256: digest, exit };
  });
}

export function latestHandoff(db, productId) {
  const id = normalizeProductId(productId);
  if (!id) return null;
  const row = db.prepare("SELECT * FROM product_handoff_export WHERE product_id=? ORDER BY id DESC LIMIT 1").get(id);
  if (!row) return null;
  return {
    id: Number(row.id),
    product_id: row.product_id,
    sha256: row.sha256,
    manifest: JSON.parse(row.manifest_json),
    payload: JSON.parse(row.payload_json),
    created_at: row.created_at,
  };
}

export function purgeReplica(db, productId, { actor = "owner", now = new Date(), confirm = "" } = {}) {
  const product = getProduct(db, productId);
  if (!product) throw httpError("not found", 404);
  const expected = `PURGE-${product.id}`;
  if (String(confirm || "") !== expected) throw httpError(`confirmation must be ${expected}`, 400);
  const pending = listPendingWork(db, product.id);
  return withImmediateTx(db, () => {
    const before = Number(db.prepare("SELECT COUNT(*) n FROM ingested_feedback WHERE product_id=?").get(product.id).n) || 0;
    db.prepare(`
      UPDATE ingested_feedback
         SET content='[purged]', contact=NULL, context=NULL, user_ref=NULL
       WHERE product_id=?
    `).run(product.id);
    const crmPurged = tableExists(db, "ingested_crm_contact") ? redactCrmReplicas(db, product.id) : 0;
    const insight = redactInsightDerivatives(db, product.id);
    const issues = redactExclusiveIssues(db, product.id);
    recordPurgeEvent(db, {
      productId: product.id,
      actor,
      counts: { feedback: before, crm: crmPurged, ...insight, issues },
      now,
    });
    const record = insertExitRecord(db, {
      productId: product.id,
      generation: product.subscription_generation,
      action: "purge_replica",
      exitStatus: "completed",
      pending,
      notes: `已清除 ${before} 筆回饋複本、${crmPurged} 筆 CRM 複本、分析 ${insight.analysis}、向量 ${insight.embeddings}、附件 ${insight.attachments}、匯出 ${insight.exports}、專屬議題 ${issues}。去掉聯絡方式不是匿名化。產品卡、稽核與清除帳本保留，還原後會再套用。本機主本不在此庫。`,
      actor,
      now,
    });
    return { product: publicProduct(getProduct(db, product.id)), purged: before, insight, issues, exit: record };
  });
}
