import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { openOpsDb, defaultDataDir, defaultDbPath } from "./opsDb.js";
import { makeAuth } from "./auth.js";
import { appendAudit, listAudit, verifyAuditChain, createCheckpoint, listCheckpoints } from "./audit.js";
import { listTransitions } from "./stateMachine.js";
import { verifyIngestRequest, bodyHashHex } from "./ingestSignature.js";
import { ingestFeedback } from "./ingest.js";
import {
  acceptAttachment,
  getAttachmentRow,
  publicAttachmentMeta,
  listAttachments,
  contentDisposition,
  maxUploadBytes,
} from "./attachments.js";
import { LocalPersistentStorage, defaultAttachmentDir } from "./storage/localStorage.js";
import { makeScanner } from "./malwareScan.js";
import { listAnalyses, publicAnalysis, reprocessAnalysis, analysisStats, currentAnalysisId, getCurrentFeedbackAnalysis } from "./feedbackAnalysis.js";
import { makeProvider } from "./ai/provider.js";
import { analysisConfigFromEnv, startAnalysisLoop } from "./analysisWorker.js";
import { getIssueWithMembers, mergeIssues, splitIssue, moveFeedback } from "./clustering.js";
import { makeEmbeddingProvider } from "./ai/embeddingProvider.js";
import { clusteringConfigFromEnv, startClusteringLoop } from "./clusteringWorker.js";
import { getCurrentIssueImpact, listAssessments, isImpactStale, calculateAndStoreImpact, currentImpactId } from "./impact.js";
import { impactWorkerConfigFromEnv, startImpactLoop } from "./impactWorker.js";
import { getCurrentIssueEvaluation, getEvaluationRunDetail, listEvaluationRuns, currentEvaluationRunId, isEvaluationStale, requestEvaluationRecalc } from "./evaluation.js";
import { makeEvaluationProvider } from "./ai/evaluationProvider.js";
import { evaluationWorkerConfigFromEnv, startEvaluationLoop } from "./evaluationWorker.js";
import { evaluationRolesConfig } from "./evaluationRoles.js";
import { getCurrentIssueProposal, listProposals, listOwnerDecisions, currentOwnerDecision, getActiveAuthorization, submitOwnerDecision, requestProposalGeneration } from "./proposal.js";
import { makeProposalProvider } from "./ai/proposalProvider.js";
import { proposalWorkerConfigFromEnv, startProposalLoop } from "./proposalWorker.js";
import { getReevaluationView, ownerManualReevaluate, ownerUnblock } from "./reevaluation.js";
import { reevaluationWorkerConfigFromEnv, startReevaluationLoop } from "./reevaluationWorker.js";
import { getIssueCodingView, getCodingTask, cancelCodingTask } from "./codingTask.js";
import { codingWorkerConfigFromEnv, startCodingLoop } from "./codingWorker.js";
import { makeCodingProvider } from "./coding/provider.js";
import { makeCodingRepo } from "./coding/gitRepo.js";
import { makePrGateway } from "./coding/prGateway.js";
import { getIssueQaView, getQaRunDetail, requestQaRerun } from "./qaRun.js";
import { qaWorkerConfigFromEnv, startQaLoop } from "./qaWorker.js";
import { makeQaReviewProvider } from "./qa/reviewProvider.js";
import { getCodingStagingView, getStagingDeployment, requestStagingRedeploy, cancelStagingDeployment, cleanupStagingDeployment } from "./stagingDeploy.js";
import { stagingWorkerConfigFromEnv, startStagingLoop } from "./stagingWorker.js";
import { makeStagingProvider } from "./staging/provider.js";
import { getReleaseCandidateView, getReleaseManifest, submitOwnerReleaseDecision, retryReleaseNotification, listReleaseNotifications } from "./releaseCandidate.js";
import { releaseWorkerConfigFromEnv, startReleaseLoop } from "./releaseWorker.js";
import { getMigrationSafetyView, createMigrationSafetyAssessment, assessApprovedReleaseIfNeeded } from "./release/migrationSafety.js";
import {
  createProductionReleaseRun,
  executeProductionRelease,
  getProductionRelease,
  getProductionReleaseView,
  getProductionStable,
  reconcileProductionRelease,
  requestCodeRollback,
  retryProductionRelease,
} from "./release/productionRelease.js";
import { makeProductionReleaseProvider } from "./release/productionReleaseProvider.js";
import { getDashboard, listFeedbackInbox, listIssuesWithLifecycle, OPS_PHASE } from "./dashboard.js";
import { notifyConfig, sendOpsNotification } from "./notify/webhook.js";

// 刻意不使用 express：ops 服務維持「零外部相依」，與本 repo 的 CI（不跑 npm install）相容，
// 也縮小攻擊面。所有路由用 node:http 手刻的極小 router。

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, "..", "public");
const BODY_LIMIT = 256 * 1024;

const STATIC_FILES = {
  "/": { file: "console.html", type: "text/html; charset=utf-8" },
  "/console.html": { file: "console.html", type: "text/html; charset=utf-8" },
  "/console.css": { file: "console.css", type: "text/css; charset=utf-8" },
  "/console.js": { file: "console.js", type: "application/javascript; charset=utf-8" },
};

function securityHeaders(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  if ((req.url || "").startsWith("/ops/api/")) res.setHeader("Cache-Control", "no-store");
}

// 讓 auth 的 express-style middleware（res.status().json()）能在 node:http 上重用。
function makeReply(res) {
  return {
    _status: 200,
    setHeader: (k, v) => res.setHeader(k, v),
    status(code) { this._status = code; return this; },
    json(obj) {
      res.writeHead(this._status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(obj));
    },
  };
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// 讀取上傳 body（附件）：串流累積並在超過上限時「提早中止」，記憶體用量受 limit 約束。
function readBinaryBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error("payload too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

// 執行一個 express-style middleware；回傳 true 表示放行（next 被呼叫），false 表示已自行回應。
function runGuard(mw, req, reply) {
  let passed = false;
  mw(req, reply, () => { passed = true; });
  return passed;
}

export function createHandler({ db, auth, publicDir = PUBLIC_DIR, ingestSecret = process.env.OPS_INGEST_SECRET || "", storage = null, scanner = null, codingRepo = null, productionReleaseProvider = null }) {
  const releaseRepo = codingRepo || makeCodingRepo();
  const releaseProvider = productionReleaseProvider || makeProductionReleaseProvider();
  if (!db) throw new Error("createHandler requires db");
  if (!auth) throw new Error("createHandler requires auth");
  const store = storage || new LocalPersistentStorage(defaultAttachmentDir(process.env.OPS_DATA_DIR || process.cwd()));
  const scan = scanner || makeScanner();

  return async function handler(req, res) {
    try {
      securityHeaders(req, res);
      const url = new URL(req.url, "http://localhost");
      const pathname = url.pathname;
      const method = req.method || "GET";
      const reply = makeReply(res);

      // ── 靜態檔（登入前可讀，無需 cookie） ──
      if (method === "GET" && STATIC_FILES[pathname]) {
        const entry = STATIC_FILES[pathname];
        const full = path.join(publicDir, entry.file);
        try {
          const buf = readFileSync(full);
          res.writeHead(200, { "Content-Type": entry.type });
          res.end(buf);
        } catch {
          sendJson(res, 404, { error: "not found" });
        }
        return;
      }

      // ── 公開 API ──
      if (pathname === "/ops/api/health" && method === "GET") {
        sendJson(res, 200, { ok: true, service: "ops", phase: OPS_PHASE, configured: auth.configured, webhook: notifyConfig().configured });
        return;
      }

      // ── Ingest（HMAC 認證，非 Owner session） ──
      if (pathname === "/ops/api/ingest/feedback" && method === "POST") {
        if (!ingestSecret) {
          sendJson(res, 503, { error: "ingest not configured" });
          return;
        }
        const raw = await readRawBody(req);
        const check = verifyIngestRequest({
          method: "POST",
          path: "/ops/api/ingest/feedback",
          headers: req.headers,
          rawBody: raw,
          secret: ingestSecret,
        });
        if (!check.ok) {
          // 不外洩簽章細節；只回通用錯誤（reason 僅供內部推斷）。
          const status = check.reason === "expired_timestamp" ? 401 : 401;
          sendJson(res, status, { error: "unauthorized" });
          return;
        }
        let payload;
        try {
          payload = JSON.parse(raw || "{}");
        } catch {
          sendJson(res, 400, { error: "invalid JSON" });
          return;
        }
        // 防 payload 替換：header 的 delivery 必須與 body 一致（body-hash 已在簽章內驗過）。
        if (String(payload.delivery_id || "") !== check.deliveryId) {
          sendJson(res, 400, { error: "delivery_id mismatch" });
          return;
        }
        try {
          const result = ingestFeedback(db, { deliveryId: check.deliveryId, payload, payloadHash: check.bodyHash });
          if (result.conflict) {
            // delivery_id / idempotency_key 被重用於不同內容 → 409，不覆寫原紀錄。
            sendJson(res, 409, { error: "conflict", reason: result.reason });
            return;
          }
          sendJson(res, 200, { ok: true, id: result.id, duplicate: result.duplicate });
          if (!result.duplicate && !result.conflict && notifyConfig().onIngest) {
            sendOpsNotification({
              event: "ops.feedback.ingested",
              title: "新的使用者回饋",
              text: "正式站有一筆新回饋進入 OPS 收件匣。",
              fields: [
                { name: "id", value: result.id },
                { name: "kind", value: payload.kind || "other" },
              ],
            }).catch(() => {});
          }
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      if (pathname === "/ops/api/login" && method === "POST") {
        const body = await readBody(req).catch((e) => { throw e; });
        const email = body?.email;
        const key = auth.attemptKey(req, email);
        try {
          auth.assertNotLocked(key);
        } catch (err) {
          sendJson(res, err.status || 429, { error: err.message });
          return;
        }
        if (!auth.configured) {
          sendJson(res, 503, { error: "Owner 身分尚未設定（AUTH_EMAIL / AUTH_PASSWORD / OPS_SESSION_SECRET）" });
          return;
        }
        if (!auth.verify(email, body?.password)) {
          auth.recordFail(key);
          // 稽核只記錄「有一次失敗登入」與來源 IP，不記帳號輸入內容、不記密碼。
          appendAudit(db, { actor: `anon:${auth.clientIp(req)}`, action: "owner.login.fail" });
          sendJson(res, 401, { error: "帳號或密碼不正確" });
          return;
        }
        auth.clearFails(key);
        res.setHeader("Set-Cookie", auth.sessionCookie(req));
        appendAudit(db, { actor: `owner:${auth.ownerEmail}`, action: "owner.login.ok" });
        // 前端登入成功後會呼叫 /ops/api/me 取得 CSRF token（用新 cookie）。
        sendJson(res, 200, { ok: true, email: auth.ownerEmail, role: "owner" });
        return;
      }

      if (pathname === "/ops/api/logout" && method === "POST") {
        // logout 也是 state-changing，但即便 CSRF 失敗也允許清除自身 cookie（降風險、不擴權）。
        res.setHeader("Set-Cookie", auth.clearCookie(req));
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === "/ops/api/me" && method === "GET") {
        const session = auth.readSession(req);
        if (!session) {
          sendJson(res, 200, { ok: false, role: "guest", configured: auth.configured });
          return;
        }
        res.setHeader("Set-Cookie", auth.slideCookie(req, session));
        sendJson(res, 200, { ok: true, email: session.email, role: session.role, csrfToken: auth.csrfTokenFor(session) });
        return;
      }

      // ── Owner-only 讀取 API ──
      if (pathname === "/ops/api/audit" && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        const page = listAudit(db, { limit: url.searchParams.get("limit"), offset: url.searchParams.get("offset") });
        sendJson(res, 200, { ...page, checkpoints: listCheckpoints(db, {}) });
        return;
      }

      if (pathname === "/ops/api/audit/verify" && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        sendJson(res, 200, verifyAuditChain(db));
        return;
      }

      if (pathname === "/ops/api/state/transitions" && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        sendJson(res, 200, { items: listTransitions(db, { entityId: url.searchParams.get("entityId"), limit: url.searchParams.get("limit") }) });
        return;
      }

      // ── Owner-only mutation API（需 CSRF + 同源） ──
      if (pathname === "/ops/api/audit/checkpoint" && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        const cp = createCheckpoint(db);
        appendAudit(db, { actor: `owner:${req.owner.email}`, action: "audit.checkpoint", data: cp });
        sendJson(res, 200, { ok: true, checkpoint: cp });
        return;
      }

      // ── 附件上傳（Owner + CSRF） ──
      if (pathname === "/ops/api/attachments" && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        const limit = maxUploadBytes();
        const declaredLen = Number(req.headers["content-length"] || 0);
        if (declaredLen && declaredLen > limit) {
          sendJson(res, 413, { error: "payload too large" });
          return;
        }
        let buffer;
        try {
          buffer = await readBinaryBody(req, limit);
        } catch (e) {
          sendJson(res, e.status || 400, { error: e.status === 413 ? "payload too large" : "read error" });
          return;
        }
        const feedbackId = req.headers["x-feedback-id"];
        const declaredMime = req.headers["content-type"] || "";
        const filename = req.headers["x-filename"] || "attachment";
        const piiFlag = String(req.headers["x-pii-flag"] || "") === "1";
        try {
          const result = await acceptAttachment(db, { storage: store, scanner: scan }, {
            feedbackId, declaredMime, filename, buffer, piiFlag,
          });
          sendJson(res, 201, { ok: true, ...result });
        } catch (err) {
          // 稽核拒絕（只記 metadata，不記內容）
          appendAudit(db, {
            actor: `owner:${req.owner?.email || "?"}`,
            action: "attachment.rejected",
            data: { reason: err.message?.slice(0, 120), mime: String(declaredMime).slice(0, 64), bytes: buffer?.length || 0 },
          });
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      // ── 附件 metadata（Owner） ──
      const metaMatch = pathname.match(/^\/ops\/api\/attachments\/(\d+)\/meta$/);
      if (metaMatch && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        const row = getAttachmentRow(db, metaMatch[1]);
        if (!row) { sendJson(res, 404, { error: "not found" }); return; }
        sendJson(res, 200, publicAttachmentMeta(row));
        return;
      }

      // ── 附件內容下載（Owner，強制下載、安全標頭） ──
      const dlMatch = pathname.match(/^\/ops\/api\/attachments\/(\d+)$/);
      if (dlMatch && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        const row = getAttachmentRow(db, dlMatch[1]);
        if (!row) { sendJson(res, 404, { error: "not found" }); return; }
        let bytes;
        try {
          bytes = await store.get(row.object_key);
        } catch {
          sendJson(res, 410, { error: "object missing" });
          return;
        }
        appendAudit(db, {
          actor: `owner:${req.owner?.email || "?"}`,
          action: "attachment.downloaded",
          entityType: "feedback_attachment",
          entityId: String(row.id),
          data: { feedback_id: row.feedback_id, mime: row.mime, bytes: row.bytes },
        });
        // MVP：所有型別一律強制下載，Ops Console origin 內絕不 inline 執行（HTML/SVG/未知）。
        res.setHeader("Content-Type", row.mime);
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Disposition", contentDisposition(row.original_filename, "attachment"));
        res.setHeader("Cache-Control", "no-store");
        res.writeHead(200);
        res.end(bytes);
        return;
      }

      // ── 列出某 feedback 的附件 metadata（Owner） ──
      if (pathname === "/ops/api/attachments" && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        const items = listAttachments(db, { feedbackId: url.searchParams.get("feedbackId"), limit: url.searchParams.get("limit") });
        sendJson(res, 200, { items: items.map(publicAttachmentMeta) });
        return;
      }

      // ── Phase 4：Owner 檢視某 feedback 的分析結果 ──
      const analysisListMatch = pathname.match(/^\/ops\/api\/feedback\/(\d+)\/analysis$/);
      if (analysisListMatch && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        const fid = Number(analysisListMatch[1]);
        const fb = db.prepare("SELECT id, source, kind, content, app_version, submitted_at, received_at, trust_level FROM ingested_feedback WHERE id = ?").get(fid);
        if (!fb) { sendJson(res, 404, { error: "not found" }); return; }
        const currentId = currentAnalysisId(db, fid);
        sendJson(res, 200, {
          feedback: fb,
          current_analysis_id: currentId,
          current: getCurrentFeedbackAnalysis(db, fid),
          analyses: listAnalyses(db, { feedbackId: fid }).map((row) => ({ ...publicAnalysis(row), is_current: Number(row.id) === currentId })),
        });
        return;
      }

      // ── Phase 4：Owner 手動重新分析（建立新 attempt，不覆寫歷史；需 CSRF） ──
      const reanalyzeMatch = pathname.match(/^\/ops\/api\/feedback\/(\d+)\/reanalyze$/);
      if (reanalyzeMatch && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        try {
          let body = {};
          try { body = JSON.parse(await readRawBody(req) || "{}"); } catch { body = {}; }
          const row = reprocessAnalysis(db, Number(reanalyzeMatch[1]), {
            promptVersion: body.prompt_version || undefined,
            actor: `owner:${req.owner.email}`,
          });
          sendJson(res, 201, { ok: true, analysis_id: row.id, revision: row.revision });
        } catch (err) {
          sendJson(res, err.status || 400, { error: err.message });
        }
        return;
      }

      // ── Phase 4：Owner 分析佇列統計 ──
      if (pathname === "/ops/api/analysis/stats" && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        sendJson(res, 200, analysisStats(db));
        return;
      }

      // ── Phase 5：Issue Candidate 檢視（Owner） ──
      if (pathname === "/ops/api/issues" && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        sendJson(res, 200, { items: listIssuesWithLifecycle(db, { limit: url.searchParams.get("limit") }) });
        return;
      }
      if (pathname === "/ops/api/feedback" && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        sendJson(res, 200, listFeedbackInbox(db, {
          limit: url.searchParams.get("limit"),
          offset: url.searchParams.get("offset"),
          includeContact: url.searchParams.get("includeContact") === "1",
        }));
        return;
      }
      if (pathname === "/ops/api/dashboard" && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        sendJson(res, 200, getDashboard(db));
        return;
      }
      if (pathname === "/ops/api/notify/test" && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        const sent = await sendOpsNotification({
          event: "ops.notify.test",
          title: "OPS webhook 測試",
          text: "這是 Owner 從 Console 送出的測試通知。",
          fields: [{ name: "actor", value: req.owner.email }],
        });
        sendJson(res, sent.ok ? 200 : 503, { ok: sent.ok, ...sent });
        return;
      }
      const issueGet = pathname.match(/^\/ops\/api\/issues\/(\d+)$/);
      if (issueGet && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        const data = getIssueWithMembers(db, issueGet[1]);
        if (!data) { sendJson(res, 404, { error: "not found" }); return; }
        sendJson(res, 200, data);
        return;
      }

      // ── Phase 5：Owner 可逆修正（需 CSRF） ──
      async function body() { try { return JSON.parse(await readRawBody(req) || "{}"); } catch { return {}; } }
      if (pathname === "/ops/api/issues/merge" && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        try {
          const b = await body();
          const r = mergeIssues(db, { sourceIssueId: Number(b.source_issue_id), targetIssueId: Number(b.target_issue_id), actor: `owner:${req.owner.email}`, reason: b.reason });
          sendJson(res, 200, { ok: true, ...r });
        } catch (err) { sendJson(res, err.status || 400, { error: err.message }); }
        return;
      }
      const issueSplit = pathname.match(/^\/ops\/api\/issues\/(\d+)\/split$/);
      if (issueSplit && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        try {
          const b = await body();
          const r = splitIssue(db, { issueId: Number(issueSplit[1]), feedbackIds: b.feedback_ids, actor: `owner:${req.owner.email}`, reason: b.reason });
          sendJson(res, 201, { ok: true, ...r });
        } catch (err) { sendJson(res, err.status || 400, { error: err.message }); }
        return;
      }
      if (pathname === "/ops/api/issues/move" && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        try {
          const b = await body();
          const r = moveFeedback(db, { feedbackId: Number(b.feedback_id), toIssueId: Number(b.to_issue_id), actor: `owner:${req.owner.email}`, reason: b.reason });
          sendJson(res, 200, { ok: true, ...r });
        } catch (err) { sendJson(res, err.status || 400, { error: err.message }); }
        return;
      }

      // ── Phase 6：Issue 影響力（Owner） ──
      const impactGet = pathname.match(/^\/ops\/api\/issues\/(\d+)\/impact$/);
      if (impactGet && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        const iid = Number(impactGet[1]);
        if (!db.prepare("SELECT id FROM issue_candidate WHERE id=?").get(iid)) { sendJson(res, 404, { error: "not found" }); return; }
        const current = getCurrentIssueImpact(db, iid);
        sendJson(res, 200, {
          issue_id: iid,
          current,
          current_assessment_id: currentImpactId(db, iid),
          stale: isImpactStale(db, iid),
          history: listAssessments(db, { issueId: iid }),
        });
        return;
      }
      const impactRecalc = pathname.match(/^\/ops\/api\/issues\/(\d+)\/impact\/recalculate$/);
      if (impactRecalc && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        const iid = Number(impactRecalc[1]);
        // 先記錄「Owner 要求重算」事件（與 calculated / current_changed 分開；metadata only）。
        appendAudit(db, { actor: `owner:${req.owner.email}`, action: "issue.impact.recalculation_requested", entityType: "issue_candidate", entityId: String(iid), data: { issue_id: iid } });
        try {
          const r = calculateAndStoreImpact(db, iid, { actor: `owner:${req.owner.email}` });
          sendJson(res, 201, { ok: true, ...r });
        } catch (err) { sendJson(res, err.status || 400, { error: err.message }); }
        return;
      }

      // ── Phase 7：Issue 角色制評估（Owner 檢視 current + 歷史 + 逐角色/逐輪票；不建 proposal） ──
      const evalGet = pathname.match(/^\/ops\/api\/issues\/(\d+)\/evaluation$/);
      if (evalGet && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        const iid = Number(evalGet[1]);
        if (!db.prepare("SELECT id FROM issue_candidate WHERE id=?").get(iid)) { sendJson(res, 404, { error: "not found" }); return; }
        const currentRunId = currentEvaluationRunId(db, iid);
        sendJson(res, 200, {
          issue_id: iid,
          roles: evaluationRolesConfig().roles,
          current: getCurrentIssueEvaluation(db, iid),
          current_run_id: currentRunId,
          current_run: currentRunId ? getEvaluationRunDetail(db, currentRunId) : null,
          stale: isEvaluationStale(db, iid),
          history: listEvaluationRuns(db, { issueId: iid }),
        });
        return;
      }
      const evalRunGet = pathname.match(/^\/ops\/api\/issues\/(\d+)\/evaluation\/runs\/(\d+)$/);
      if (evalRunGet && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        const detail = getEvaluationRunDetail(db, evalRunGet[2]);
        if (!detail || Number(detail.run.issue_id) !== Number(evalRunGet[1])) { sendJson(res, 404, { error: "not found" }); return; }
        sendJson(res, 200, detail);
        return;
      }
      const evalRecalc = pathname.match(/^\/ops\/api\/issues\/(\d+)\/evaluation\/recalculate$/);
      if (evalRecalc && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        try {
          const r = requestEvaluationRecalc(db, Number(evalRecalc[1]), { actor: `owner:${req.owner.email}` });
          sendJson(res, 202, { ok: true, ...r });
        } catch (err) { sendJson(res, err.status || 400, { error: err.message }); }
        return;
      }

      // ── Phase 8：開發提案 + Owner Approval Gate #1（Owner 檢視 + 決策；不寫程式、不部署） ──
      const proposalGet = pathname.match(/^\/ops\/api\/issues\/(\d+)\/proposal$/);
      if (proposalGet && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        const iid = Number(proposalGet[1]);
        if (!db.prepare("SELECT id FROM issue_candidate WHERE id=?").get(iid)) { sendJson(res, 404, { error: "not found" }); return; }
        const current = getCurrentIssueProposal(db, iid);
        sendJson(res, 200, {
          issue_id: iid,
          current,
          stale: current ? current.stale : null,
          current_decision: currentOwnerDecision(db, iid),
          development_authorization: getActiveAuthorization(db, iid),
          history: listProposals(db, { issueId: iid }),
          decisions: listOwnerDecisions(db, { issueId: iid }),
        });
        return;
      }
      const proposalGen = pathname.match(/^\/ops\/api\/issues\/(\d+)\/proposal\/generate$/);
      if (proposalGen && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        try {
          const r = requestProposalGeneration(db, Number(proposalGen[1]), { actor: `owner:${req.owner.email}` });
          sendJson(res, 202, { ok: true, ...r });
        } catch (err) { sendJson(res, err.status || 400, { error: err.message }); }
        return;
      }
      const proposalDecide = pathname.match(/^\/ops\/api\/issues\/(\d+)\/proposal\/decision$/);
      if (proposalDecide && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        let b = {};
        try { b = JSON.parse(await readRawBody(req) || "{}"); } catch { b = {}; }
        try {
          const r = submitOwnerDecision(db, Number(proposalDecide[1]), {
            action: b.action,
            proposalId: Number(b.proposal_id),
            proposalVersion: Number(b.proposal_version),
            proposalHash: String(b.proposal_hash || ""),
            reason: b.reason,
            actor: `owner:${req.owner.email}`,
          });
          sendJson(res, 200, { ok: true, ...r });
        } catch (err) { sendJson(res, err.status || 400, { error: err.message }); }
        return;
      }

      // ── Phase 9：重評/重啟（Owner 檢視 + 手動重評 + 解除 BLOCK；不寫程式、不部署） ──
      const reevalGet = pathname.match(/^\/ops\/api\/issues\/(\d+)\/reevaluation$/);
      if (reevalGet && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        const iid = Number(reevalGet[1]);
        if (!db.prepare("SELECT id FROM issue_candidate WHERE id=?").get(iid)) { sendJson(res, 404, { error: "not found" }); return; }
        sendJson(res, 200, getReevaluationView(db, iid));
        return;
      }
      const reevalReopen = pathname.match(/^\/ops\/api\/issues\/(\d+)\/reevaluation\/reopen$/);
      if (reevalReopen && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        let b = {};
        try { b = JSON.parse(await readRawBody(req) || "{}"); } catch { b = {}; }
        try {
          const r = ownerManualReevaluate(db, Number(reevalReopen[1]), { actor: `owner:${req.owner.email}`, reason: b.reason });
          sendJson(res, 200, { ok: true, ...r });
        } catch (err) { sendJson(res, err.status || 400, { error: err.message }); }
        return;
      }
      const reevalUnblock = pathname.match(/^\/ops\/api\/issues\/(\d+)\/unblock$/);
      if (reevalUnblock && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        let b = {};
        try { b = JSON.parse(await readRawBody(req) || "{}"); } catch { b = {}; }
        try {
          const r = ownerUnblock(db, Number(reevalUnblock[1]), { actor: `owner:${req.owner.email}`, reason: b.reason });
          sendJson(res, 200, { ok: true, ...r });
        } catch (err) { sendJson(res, err.status || 400, { error: err.message }); }
        return;
      }

      // ── Phase 10：授權後的 Coding Task（Owner 檢視 + 取消；不 auto-merge、不部署） ──
      const codingGet = pathname.match(/^\/ops\/api\/issues\/(\d+)\/coding$/);
      if (codingGet && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        const iid = Number(codingGet[1]);
        if (!db.prepare("SELECT id FROM issue_candidate WHERE id=?").get(iid)) { sendJson(res, 404, { error: "not found" }); return; }
        sendJson(res, 200, getIssueCodingView(db, iid));
        return;
      }
      const codingTaskGet = pathname.match(/^\/ops\/api\/coding-tasks\/(\d+)$/);
      if (codingTaskGet && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        const t = getCodingTask(db, Number(codingTaskGet[1]));
        if (!t) { sendJson(res, 404, { error: "not found" }); return; }
        sendJson(res, 200, t);
        return;
      }
      const codingCancel = pathname.match(/^\/ops\/api\/coding-tasks\/(\d+)\/cancel$/);
      if (codingCancel && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        let b = {};
        try { b = JSON.parse(await readRawBody(req) || "{}"); } catch { b = {}; }
        try {
          const r = cancelCodingTask(db, Number(codingCancel[1]), { actor: `owner:${req.owner.email}`, reason: b.reason });
          sendJson(res, 200, { ok: true, ...r });
        } catch (err) { sendJson(res, err.status || 400, { error: err.message }); }
        return;
      }

      // ── Phase 11：獨立自動化 QA（Owner 檢視 + 重跑；不 merge、不部署） ──
      const qaGet = pathname.match(/^\/ops\/api\/coding-tasks\/(\d+)\/qa$/);
      if (qaGet && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        try { sendJson(res, 200, getIssueQaView(db, Number(qaGet[1]))); }
        catch (err) { sendJson(res, err.status || 404, { error: err.message }); }
        return;
      }
      const qaRunGet = pathname.match(/^\/ops\/api\/qa-runs\/(\d+)$/);
      if (qaRunGet && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        const r = getQaRunDetail(db, Number(qaRunGet[1]));
        if (!r) { sendJson(res, 404, { error: "not found" }); return; }
        sendJson(res, 200, r);
        return;
      }
      const qaRerun = pathname.match(/^\/ops\/api\/coding-tasks\/(\d+)\/qa\/rerun$/);
      if (qaRerun && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        try {
          const r = requestQaRerun(db, Number(qaRerun[1]), { actor: `owner:${req.owner.email}` });
          sendJson(res, 200, { ok: true, ...r });
        } catch (err) { sendJson(res, err.status || 400, { error: err.message }); }
        return;
      }

      // ── Phase 12：隔離 Staging（Owner 檢視 + redeploy/cancel/cleanup；不 merge、不部署 Production） ──
      const stgGet = pathname.match(/^\/ops\/api\/coding-tasks\/(\d+)\/staging$/);
      if (stgGet && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        try { sendJson(res, 200, getCodingStagingView(db, Number(stgGet[1]))); }
        catch (err) { sendJson(res, err.status || 404, { error: err.message }); }
        return;
      }
      const stgDepGet = pathname.match(/^\/ops\/api\/staging-deployments\/(\d+)$/);
      if (stgDepGet && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        const d = getStagingDeployment(db, Number(stgDepGet[1]));
        if (!d) { sendJson(res, 404, { error: "not found" }); return; }
        sendJson(res, 200, d);
        return;
      }
      const stgRedeploy = pathname.match(/^\/ops\/api\/coding-tasks\/(\d+)\/staging\/redeploy$/);
      if (stgRedeploy && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        try { sendJson(res, 200, { ok: true, ...requestStagingRedeploy(db, Number(stgRedeploy[1]), { actor: `owner:${req.owner.email}` }) }); }
        catch (err) { sendJson(res, err.status || 400, { error: err.message }); }
        return;
      }
      const stgCancel = pathname.match(/^\/ops\/api\/staging-deployments\/(\d+)\/cancel$/);
      if (stgCancel && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        let b = {}; try { b = JSON.parse(await readRawBody(req) || "{}"); } catch { b = {}; }
        try { sendJson(res, 200, { ok: true, ...cancelStagingDeployment(db, Number(stgCancel[1]), { actor: `owner:${req.owner.email}`, reason: b.reason }) }); }
        catch (err) { sendJson(res, err.status || 400, { error: err.message }); }
        return;
      }
      const stgCleanup = pathname.match(/^\/ops\/api\/staging-deployments\/(\d+)\/cleanup$/);
      if (stgCleanup && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        try { sendJson(res, 200, { ok: true, ...cleanupStagingDeployment(db, Number(stgCleanup[1]), { actor: `owner:${req.owner.email}` }) }); }
        catch (err) { sendJson(res, err.status || 400, { error: err.message }); }
        return;
      }

      // ── Phase 13：Release Candidate + Owner Gate #2（Owner 檢視 + 決策 + 通知重試；不部署、不 merge） ──
      const rcGet = pathname.match(/^\/ops\/api\/coding-tasks\/(\d+)\/release$/);
      if (rcGet && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        try {
          const view = getReleaseCandidateView(db, Number(rcGet[1]), { repo: releaseRepo });
          try { view.migration_safety = getMigrationSafetyView(db, Number(rcGet[1]), { repo: releaseRepo }); }
          catch { view.migration_safety = null; }
          sendJson(res, 200, view);
        } catch (err) { sendJson(res, err.status || 404, { error: err.message }); }
        return;
      }
      const rmGet = pathname.match(/^\/ops\/api\/release-manifests\/(\d+)$/);
      if (rmGet && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        const m = getReleaseManifest(db, Number(rmGet[1]));
        if (!m) { sendJson(res, 404, { error: "not found" }); return; }
        sendJson(res, 200, m);
        return;
      }
      const rcDecision = pathname.match(/^\/ops\/api\/coding-tasks\/(\d+)\/release\/decision$/);
      if (rcDecision && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        let b = {}; try { b = JSON.parse(await readRawBody(req) || "{}"); } catch { b = {}; }
        try {
          const r = submitOwnerReleaseDecision(db, { codingTaskId: Number(rcDecision[1]), action: b.action, manifestId: b.manifest_id, manifestVersion: b.manifest_version, manifestHash: b.manifest_hash, artifactDigest: b.artifact_digest, headSha: b.head_sha, actor: `owner:${req.owner.email}`, reason: b.reason, repo: releaseRepo });
          if (r.authorization) {
            try { r.migration_safety = assessApprovedReleaseIfNeeded(db, { codingTaskId: Number(rcDecision[1]), authorization: r.authorization, repo: releaseRepo, actor: `owner:${req.owner.email}` }); }
            catch (assessErr) { r.migration_safety_error = assessErr.message; }
          }
          sendJson(res, 200, { ok: true, ...r });
        } catch (err) { sendJson(res, err.status || 400, { error: err.message }); }
        return;
      }
      const migSafetyGet = pathname.match(/^\/ops\/api\/coding-tasks\/(\d+)\/migration-safety$/);
      if (migSafetyGet && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        try { sendJson(res, 200, getMigrationSafetyView(db, Number(migSafetyGet[1]), { repo: releaseRepo })); }
        catch (err) { sendJson(res, err.status || 404, { error: err.message }); }
        return;
      }
      const migSafetyPost = pathname.match(/^\/ops\/api\/coding-tasks\/(\d+)\/migration-safety$/);
      if (migSafetyPost && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        let b = {}; try { b = JSON.parse(await readRawBody(req) || "{}"); } catch { b = {}; }
        try {
          const r = createMigrationSafetyAssessment(db, {
            codingTaskId: Number(migSafetyPost[1]),
            releaseAuthorizationId: b.release_authorization_id,
            manifestId: b.manifest_id,
            manifestVersion: b.manifest_version,
            manifestHash: b.manifest_hash,
            headSha: b.head_sha,
            artifactDigest: b.artifact_digest,
            repo: releaseRepo,
            actor: `owner:${req.owner.email}`,
          });
          sendJson(res, 200, { ok: true, ...r });
        } catch (err) { sendJson(res, err.status || 400, { error: err.message }); }
        return;
      }
      // ── Phase 15：Production release execution + code rollback（Owner exact IDs；不猜 latest；不持 secrets） ──
      if (pathname === "/ops/api/production-stable" && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        sendJson(res, 200, { current_stable: getProductionStable(db) });
        return;
      }
      const prodRelView = pathname.match(/^\/ops\/api\/coding-tasks\/(\d+)\/production-release$/);
      if (prodRelView && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        try { sendJson(res, 200, getProductionReleaseView(db, Number(prodRelView[1]), { repo: releaseRepo })); }
        catch (err) { sendJson(res, err.status || 404, { error: err.message }); }
        return;
      }
      const prodRelGet = pathname.match(/^\/ops\/api\/production-releases\/(\d+)$/);
      if (prodRelGet && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        const d = getProductionRelease(db, Number(prodRelGet[1]));
        if (!d) { sendJson(res, 404, { error: "not found" }); return; }
        sendJson(res, 200, d);
        return;
      }
      const prodRelEvidence = pathname.match(/^\/ops\/api\/production-releases\/(\d+)\/evidence$/);
      if (prodRelEvidence && method === "GET") {
        if (!runGuard(auth.requireOwner, req, reply)) return;
        const d = getProductionRelease(db, Number(prodRelEvidence[1]));
        if (!d) { sendJson(res, 404, { error: "not found" }); return; }
        sendJson(res, 200, { run: d.run, evidence: d.evidence, events: d.events });
        return;
      }
      const prodRelExec = pathname.match(/^\/ops\/api\/coding-tasks\/(\d+)\/production-release\/execute$/);
      if (prodRelExec && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        let b = {}; try { b = JSON.parse(await readRawBody(req) || "{}"); } catch { b = {}; }
        try {
          const created = createProductionReleaseRun(db, {
            codingTaskId: Number(prodRelExec[1]),
            releaseAuthorizationId: b.release_authorization_id,
            releaseAuthorizationHash: b.release_authorization_hash,
            manifestId: b.manifest_id,
            manifestVersion: b.manifest_version,
            manifestHash: b.manifest_hash,
            migrationSafetyAssessmentId: b.migration_safety_assessment_id,
            migrationSafetyPolicyFingerprint: b.migration_safety_policy_fingerprint,
            migrationSafetyInputFingerprint: b.migration_safety_input_fingerprint,
            clearanceResult: b.clearance_result,
            qaRunId: b.qa_run_id,
            stagingDeploymentId: b.staging_deployment_id,
            headSha: b.head_sha,
            artifactDigest: b.artifact_digest,
            targetEnvironment: b.target_environment,
            workflowRef: b.workflow_ref,
            expectedMasterHead: b.expected_master_head,
            githubActor: "Fyun48",
          }, { repo: releaseRepo, actor: `owner:${req.owner.email}` });
          const executed = await executeProductionRelease(db, created.run.id, { provider: releaseProvider, repo: releaseRepo, actor: `owner:${req.owner.email}` });
          sendJson(res, 200, { ok: true, idempotent: created.idempotent === true, ...executed });
        } catch (err) { sendJson(res, err.status || 400, { error: err.message }); }
        return;
      }
      const prodRelReconcile = pathname.match(/^\/ops\/api\/production-releases\/(\d+)\/reconcile$/);
      if (prodRelReconcile && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        try {
          sendJson(res, 200, { ok: true, ...await reconcileProductionRelease(db, Number(prodRelReconcile[1]), { provider: releaseProvider, repo: releaseRepo, actor: `owner:${req.owner.email}` }) });
        } catch (err) { sendJson(res, err.status || 400, { error: err.message }); }
        return;
      }
      const prodRelRetry = pathname.match(/^\/ops\/api\/production-releases\/(\d+)\/retry$/);
      if (prodRelRetry && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        try {
          sendJson(res, 200, { ok: true, ...await retryProductionRelease(db, Number(prodRelRetry[1]), { provider: releaseProvider, repo: releaseRepo, actor: `owner:${req.owner.email}` }) });
        } catch (err) { sendJson(res, err.status || 400, { error: err.message }); }
        return;
      }
      const prodRelRollback = pathname.match(/^\/ops\/api\/production-releases\/(\d+)\/rollback$/);
      if (prodRelRollback && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        let b = {}; try { b = JSON.parse(await readRawBody(req) || "{}"); } catch { b = {}; }
        try {
          sendJson(res, 200, { ok: true, ...await requestCodeRollback(db, {
            releaseRunId: Number(prodRelRollback[1]),
            previousStableSha: b.previous_stable_sha,
            previousStableDigest: b.previous_stable_digest,
            previousStableWorkflowRunId: b.previous_stable_workflow_run_id,
            provider: releaseProvider,
            repo: releaseRepo,
            actor: `owner:${req.owner.email}`,
          }) });
        } catch (err) { sendJson(res, err.status || 400, { error: err.message }); }
        return;
      }

      const rcNotifRetry = pathname.match(/^\/ops\/api\/release-notifications\/(\d+)\/retry$/);
      if (rcNotifRetry && method === "POST") {
        if (!runGuard(auth.requireOwnerMutation, req, reply)) return;
        try { sendJson(res, 200, { ok: true, ...await retryReleaseNotification(db, Number(rcNotifRetry[1]), { actor: `owner:${req.owner.email}` }) }); }
        catch (err) { sendJson(res, err.status || 400, { error: err.message }); }
        return;
      }

      if (pathname.startsWith("/ops/api/")) {
        sendJson(res, 404, { error: "not found" });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      const status = err?.status || 500;
      sendJson(res, status, { error: status === 500 ? "internal error" : err.message });
    }
  };
}

// 相容舊測試/呼叫：createApp 回傳一個 { listen } 介面（用 node:http 包裝 handler）。
export function createApp({ db, auth, publicDir = PUBLIC_DIR, ingestSecret = process.env.OPS_INGEST_SECRET || "", storage = null, scanner = null, codingRepo = null, productionReleaseProvider = null }) {
  const handler = createHandler({ db, auth, publicDir, ingestSecret, storage, scanner, codingRepo, productionReleaseProvider });
  return {
    handler,
    listen(...args) {
      return http.createServer(handler).listen(...args);
    },
  };
}

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const key = t.slice(0, i).trim();
    let value = t.slice(i + 1);
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === "") process.env[key] = value;
  }
}

function resolveSessionSecret(dataDir) {
  // 必須與 v3 的 SESSION_SECRET 分離：只吃 OPS_SESSION_SECRET，否則自行產生並持久化。
  if (process.env.OPS_SESSION_SECRET) return process.env.OPS_SESSION_SECRET;
  const file = path.join(dataDir, "ops.session.secret");
  try {
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
    const secret = randomBytes(32).toString("hex");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  } catch {
    return randomBytes(32).toString("hex");
  }
}

export function startServer() {
  const dataDir = defaultDataDir();
  loadEnvFile(path.join(dataDir, "auth.env"));
  const db = openOpsDb(defaultDbPath());
  const auth = makeAuth({
    ownerEmail: process.env.OPS_OWNER_EMAIL || process.env.AUTH_EMAIL,
    ownerPassword: process.env.OPS_OWNER_PASSWORD || process.env.AUTH_PASSWORD,
    sessionSecret: resolveSessionSecret(dataDir),
    cookieSecure: process.env.COOKIE_SECURE === "1" ? true : undefined,
  });
  const handler = createHandler({ db, auth });
  const host = process.env.OPS_HOST || "127.0.0.1";
  const port = Number(process.env.OPS_PORT || 5154);
  // Phase 4：AI 分析背景 worker。provider 未設定（AI_PROVIDER 未設）→ 不啟動、feedback 仍正常入庫。
  const aiProvider = makeProvider();
  const aiConfig = analysisConfigFromEnv();
  if (aiProvider.available && aiConfig.enabled) {
    startAnalysisLoop(db, { provider: aiProvider, config: aiConfig, log: (tag, info) => console.log(tag, JSON.stringify(info)) });
  }
  // Phase 5：embedding + 分群 worker。EMBEDDING_PROVIDER 未設定 → 不啟動、feedback 照常入庫。
  const embProvider = makeEmbeddingProvider();
  const clusterCfg = clusteringConfigFromEnv();
  if (embProvider.available && clusterCfg.enabled) {
    startClusteringLoop(db, { provider: embProvider, config: clusterCfg, log: (tag, info) => console.log(tag, JSON.stringify(info)) });
  }
  // Phase 6：影響力評估 worker（純本地決定性計算，預設開；無外部依賴）。
  const impactCfg = impactWorkerConfigFromEnv();
  if (impactCfg.enabled) {
    startImpactLoop(db, { config: impactCfg, log: (tag, info) => console.log(tag, JSON.stringify(info)) });
  }
  // Phase 7：角色制評估 worker。EVALUATION_PROVIDER 未設定 → 不啟動；feedback/clustering/impact 照常。
  const evalProvider = makeEvaluationProvider();
  const evalCfg = evaluationWorkerConfigFromEnv();
  if (evalProvider.available && evalCfg.enabled) {
    startEvaluationLoop(db, { provider: evalProvider, config: evalCfg, log: (tag, info) => console.log(tag, JSON.stringify(info)) });
  }
  // Phase 8：提案生成 worker。PROPOSAL_PROVIDER 未設定 → 不啟動；前面各階段照常。生成提案不寫程式、不部署。
  const proposalProvider = makeProposalProvider();
  const proposalCfg = proposalWorkerConfigFromEnv();
  if (proposalProvider.available && proposalCfg.enabled) {
    startProposalLoop(db, { provider: proposalProvider, config: proposalCfg, log: (tag, info) => console.log(tag, JSON.stringify(info)) });
  }
  // Phase 9：重評 worker（純本地決定性，預設開；無外部依賴）。只自動重啟 DEFERRED/REJECTED；BLOCKED 永不自動。
  const reevalCfg = reevaluationWorkerConfigFromEnv();
  if (reevalCfg.enabled) {
    startReevaluationLoop(db, { config: reevalCfg, log: (tag, info) => console.log(tag, JSON.stringify(info)) });
  }
  // Phase 10：Coding worker。唯一會呼叫 coding provider 的階段，且僅在 ACTIVE 授權存在時。
  // 成本控制 + 安全預設：CODING_PROVIDER 未設 → provider 不可用；OPS_CODING_REPO_PATH 未設 → repo 不可用 → 不建/不跑。
  const codingProvider = makeCodingProvider();
  const codingRepo = makeCodingRepo();
  const codingPr = makePrGateway();
  const codingCfg = codingWorkerConfigFromEnv();
  if (codingCfg.enabled && codingProvider.available && codingRepo.available) {
    startCodingLoop(db, { provider: codingProvider, repo: codingRepo, pr: codingPr, config: codingCfg, log: (tag, info) => console.log(tag, JSON.stringify(info)) });
  }
  // Phase 11：獨立 QA worker（決定性檢核為主；optional AI reviewer 預設關）。
  // 安全預設：repo 不可用（OPS_CODING_REPO_PATH 未設）→ 不建/不跑；QA 絕不 merge/部署。
  const qaRepo = makeCodingRepo();
  const qaReviewer = makeQaReviewProvider();
  const qaCfg = qaWorkerConfigFromEnv();
  if (qaCfg.enabled && qaRepo.available) {
    startQaLoop(db, { repo: qaRepo, reviewProvider: qaReviewer, config: qaCfg, log: (tag, info) => console.log(tag, JSON.stringify(info)) });
  }
  // Phase 12：隔離 Staging worker。安全預設：STAGING_PROVIDER 未設 → provider 不可用；repo 不可用 → 不建/不跑。
  // 絕不部署 Production；Staging 憑證必須與 Production 分離。
  const stagingRepo = makeCodingRepo();
  const stagingProvider = makeStagingProvider();
  const stagingCfg = stagingWorkerConfigFromEnv();
  if (stagingCfg.enabled && stagingProvider.available && stagingRepo.available) {
    startStagingLoop(db, { repo: stagingRepo, provider: stagingProvider, config: stagingCfg, log: (tag, info) => console.log(tag, JSON.stringify(info)) });
  }
  // Phase 13：Release Candidate worker（決定性組裝；不用 LLM）。安全預設：repo 不可用 → 不建。絕不部署/合併。
  const releaseRepo = makeCodingRepo();
  const releaseCfg = releaseWorkerConfigFromEnv();
  if (releaseCfg.enabled && releaseRepo.available) {
    startReleaseLoop(db, { repo: releaseRepo, config: releaseCfg, log: (tag, info) => console.log(tag, JSON.stringify(info)) });
  }
  http.createServer(handler).listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`Ops console (Phase ${OPS_PHASE})：http://${host}:${port}  owner=${auth.configured ? auth.ownerEmail : "(未設定)"}  ingest=${process.env.OPS_INGEST_SECRET ? "on" : "off"}  webhook=${notifyConfig().configured ? notifyConfig().channel : "off"}  ai=${aiProvider.available ? aiProvider.name : "off"}  embed=${embProvider.available ? embProvider.name : "off"}  impact=${impactCfg.enabled ? "on" : "off"}  eval=${evalProvider.available ? evalProvider.name : "off"}  proposal=${proposalProvider.available ? proposalProvider.name : "off"}  reeval=${reevalCfg.enabled ? "on" : "off"}  coding=${codingProvider.available && codingRepo.available ? codingProvider.name : "off"}  qa=${qaCfg.enabled && qaRepo.available ? "on" : "off"}  staging=${stagingCfg.enabled && stagingProvider.available && stagingRepo.available ? stagingProvider.name : "off"}  release=${releaseCfg.enabled && releaseRepo.available ? "on" : "off"}`);
  });
  return { db, auth };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  startServer();
}
