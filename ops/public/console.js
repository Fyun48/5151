"use strict";
const $ = (id) => document.getElementById(id);
const CRM_HANDLING_LABEL = Object.freeze({
  new: "待看",
  planned: "已排入",
  doing: "處理中",
  done: "已完成",
  declined: "暫不處理",
});
function crmHandlingLabel(id) {
  const key = String(id || "").trim();
  return CRM_HANDLING_LABEL[key] || key;
}
let CSRF = "";
let selectedIssueId = null;
let selectedProductId = "";
let productsCache = [];
let productBusy = false;
let confirmAction = null;
let confirmReturnFocus = null;
let confirmNeedsReason = false;

async function api(path, opts) {
  const o = { cache: "no-store", ...(opts || {}) };
  const method = (o.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    o.headers = { ...(o.headers || {}), "X-CSRF-Token": CSRF };
  }
  const res = await fetch(path, o);
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  return { res, data };
}

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtTime(v) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? esc(v) : d.toLocaleString("zh-TW");
}

function setStatus(el, text, kind) {
  if (!el) return;
  el.textContent = text || "";
  el.className = kind === "err" ? "msg err" : kind === "ok" ? "msg ok" : "msg";
  el.setAttribute("role", kind === "err" ? "alert" : "status");
}

function productQuery(prefix = "?") {
  if (!selectedProductId) return "";
  const join = prefix.includes("?") && prefix !== "?" ? "&" : prefix === "?" ? "?" : "&";
  return `${join}productId=${encodeURIComponent(selectedProductId)}`;
}

function showLoggedOut(configured) {
  $("loginCard").hidden = false;
  $("ownerArea").hidden = true;
  $("logoutBtn").hidden = true;
  $("who").textContent = "未登入";
  hideConfirm();
  hideSecret();
  const exit = $("exitDetail");
  if (exit) {
    exit.hidden = true;
    exit.removeAttribute("aria-busy");
  }
  if ($("productMsg")) setStatus($("productMsg"), "");
  if (!configured) {
    $("loginMsg").textContent = "Owner 身分尚未設定（AUTH_EMAIL / AUTH_PASSWORD）。";
    $("loginMsg").className = "msg err";
  }
}

function showLoggedIn(email) {
  $("loginCard").hidden = true;
  $("ownerArea").hidden = false;
  $("logoutBtn").hidden = false;
  $("who").textContent = email;
}

function setTab(name) {
  document.querySelectorAll(".tab").forEach((btn) => {
    const on = btn.dataset.tab === name;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".tabpane").forEach((pane) => {
    pane.hidden = pane.id !== `tab-${name}`;
  });
}

const STATUS_LABEL = {
  active: "使用中",
  paused: "已暫停",
  exiting: "退出中",
  exited: "已退出",
  connected: "已連接（可收件）",
  connecting: "連接中",
  reconnecting: "重新連接中",
  pending: "等候中",
  sending: "外送中",
  processing: "執行中",
  claimed: "已領取",
  running: "執行中",
  changes_ready: "變更待收",
  failed_retry: "失敗可重試",
  completed: "已完成",
  PASS: "通過",
  FAIL: "未通過",
  WARN: "有警告",
  ready: "就緒",
  building: "建置中",
  deploying: "佈署中",
  validating: "驗證中",
  cancelled: "已取消",
  unknown: "狀態不明",
  PRODUCTION_STATE_UNKNOWN: "狀態不明",
  subscription_revoked: "訂閱已撤",
  stale_generation: "世代已換",
};

const EXIT_ACTION_LABEL = {
  pause: "暫停",
  unsubscribe: "解除訂閱",
  handoff: "移交整站",
  purge_replica: "刪除 OPS 複本",
};

const PENDING_KIND_LABEL = {
  credential: "憑證",
  analysis: "分析工作",
  evaluation: "評估工作",
  proposal: "提案工作",
  qa: "QA 工作",
  insight_embedding: "洞察向量",
  crm_replica: "CRM 複本",
  coding: "製作任務",
  staging: "隔離 staging",
  production_release: "正式發布",
  release_notification: "發布通知",
  reevaluation: "自動重評",
  site_command: "遠端客服",
};

const ACTION_ERROR = {
  "product exists": "這個 product_id 已存在",
  "invalid product_id": "product_id 格式不正確（小寫英文開頭）",
  "not found": "找不到這個產品",
  "reconnect required": "已退出，請先重新連接",
  "subscription_inactive": "訂閱未接通，無法輪替密鑰",
};

function humanError(err) {
  const key = String(err || "").trim();
  return ACTION_ERROR[key] || key || "操作失敗";
}

function chipClass(status) {
  if (status === "active" || status === "connected" || status === "PASS" || status === "changes_ready" || status === "completed") return "ok";
  if (status === "exited" || status === "FAIL" || status === "failed" || status === "cancelled") return "danger";
  if (status === "paused" || status === "exiting" || status === "reconnecting" || status === "connecting" || status === "failed_retry" || status === "unknown" || status === "PRODUCTION_STATE_UNKNOWN") return "warn";
  return "";
}

function statusChip(status) {
  return `<span class="chip ${chipClass(status)}">${esc(STATUS_LABEL[status] || status || "—")}</span>`;
}

function hideSecret() {
  const box = $("secretOnce");
  if (box) box.hidden = true;
  if ($("secretOnceText")) $("secretOnceText").textContent = "";
}

function showSecret(secret, context) {
  const box = $("secretOnce");
  if (!box) return;
  box.hidden = false;
  $("secretOnceText").textContent = secret;
  $("secretOnceHint").textContent = String(context || "").includes("遠端客服")
    ? `${context}：只顯示一次，請複製到該站 V3_OPS_COMMAND_SECRET。`
    : `${context}：此密鑰只顯示一次，請立刻複製到該站 OPS_INGEST_SECRET。`;
  setTab("products");
  box.scrollIntoView({ block: "nearest" });
  $("copySecretBtn")?.focus();
}

function confirmChrome() {
  return [document.querySelector(".topbar"), $("ownerArea")].filter(Boolean);
}

function hideConfirm() {
  const dlg = $("confirmDlg");
  if (!dlg || dlg.hidden) {
    confirmAction = null;
    confirmNeedsReason = false;
    return;
  }
  dlg.hidden = true;
  confirmAction = null;
  confirmNeedsReason = false;
  if ($("confirmReasonWrap")) $("confirmReasonWrap").hidden = true;
  if ($("confirmReason")) $("confirmReason").value = "";
  if ($("confirmReasonErr")) {
    $("confirmReasonErr").hidden = true;
    $("confirmReasonErr").textContent = "";
  }
  for (const el of confirmChrome()) el.inert = false;
  const back = confirmReturnFocus;
  confirmReturnFocus = null;
  if (back && typeof back.focus === "function") back.focus();
}

function showConfirm({ title, body, confirmLabel, onConfirm, danger = true, reasonRequired = false, reasonLabel = "請說明要改什麼" }) {
  confirmReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $("confirmTitle").textContent = title;
  $("confirmBody").textContent = body;
  $("confirmOk").textContent = confirmLabel || "確定";
  $("confirmOk").classList.toggle("danger", danger !== false);
  confirmAction = onConfirm;
  confirmNeedsReason = !!reasonRequired;
  if ($("confirmReasonWrap")) $("confirmReasonWrap").hidden = !reasonRequired;
  if ($("confirmReasonLabel") && reasonLabel) $("confirmReasonLabel").textContent = reasonLabel;
  if ($("confirmReason")) $("confirmReason").value = "";
  if ($("confirmReasonErr")) {
    $("confirmReasonErr").hidden = true;
    $("confirmReasonErr").textContent = "";
  }
  $("confirmDlg").hidden = false;
  for (const el of confirmChrome()) el.inert = true;
  if (reasonRequired && $("confirmReason")) $("confirmReason").focus();
  else $("confirmCancel").focus();
}

function confirmFocusables() {
  const nodes = [$("confirmReason"), $("confirmCancel"), $("confirmOk")].filter((el) => el && !el.hidden && !el.closest("[hidden]"));
  return nodes;
}

function trapConfirmTab(ev) {
  if (ev.key !== "Tab" || $("confirmDlg").hidden) return;
  const list = confirmFocusables();
  if (list.length < 2) return;
  const first = list[0];
  const last = list[list.length - 1];
  if (ev.shiftKey && document.activeElement === first) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && document.activeElement === last) {
    ev.preventDefault();
    first.focus();
  }
}

function renderProductSwitcher() {
  const box = $("productSwitch");
  if (!box) return;
  const items = [{ id: "", display_name: "全部" }, ...productsCache];
  box.innerHTML = items.map((p) => {
    const id = p.id || "";
    const on = selectedProductId === id;
    return `<button type="button" class="chip-btn${on ? " on" : ""}" data-product="${esc(id)}" aria-pressed="${on ? "true" : "false"}">${esc(p.display_name || "全部")}</button>`;
  }).join("");
}

function renderProductCards() {
  const box = $("productCards");
  if (!box) return;
  if (!productsCache.length) {
    box.innerHTML = `<p class="hint">尚無產品卡。</p>`;
    return;
  }
  box.innerHTML = productsCache.map((p) => {
    const sub = p.subscription || {};
    const exited = p.status === "exited" || sub.status === "exited";
    const paused = p.status === "paused" || sub.status === "paused";
    const name = p.display_name || p.id;
    const caps = sub.capabilities || {};
    return `<article class="product-card">
      <div class="row">
        <h3>${esc(p.display_name)}</h3>
        <span class="grow"></span>
        ${statusChip(p.status)}
      </div>
      <p class="hint"><code>${esc(p.id)}</code> · 訂閱世代 ${esc(sub.generation ?? "—")} · ${statusChip(sub.status)}</p>
      ${Array.isArray(p.environments) && p.environments.length
        ? `<p class="hint">部署目標：${p.environments.map((e) => `<code>${esc(e.environment_key)}</code>${e.container_name ? ` → ${esc(e.container_name)}` : ""}${e.workflow_file ? ` · ${esc(e.workflow_file.split("/").pop())}` : ""}`).join(" · ")}</p>`
        : `<p class="hint">部署目標：尚未登記環境。顯示名不能當安全識別。</p>`}
      <p class="hint">授權：回饋複製 ${caps.feedback_copy ? "開" : "關"} · CRM 同步 ${caps.crm_sync ? "開" : "關"} · 遠端客服 ${caps.remote_cs ? "開" : "關"} · 跨站分析 ${caps.cross_site_insight ? "開" : "關"} · 統計指標 ${caps.stats ? "開" : "關"} · 後續服務 ${caps.followup_service ? "開" : "關"} · 退出後保留 ${caps.retain_after_exit ? "開" : "關"}</p>
      ${Array.isArray(p.consent_events) && p.consent_events.length
        ? `<p class="hint">授權紀錄：${p.consent_events.slice(0, 4).map((ev) => `${esc(ev.capability_key)} ${ev.granted ? "開" : "撤回"}`).join(" · ")}</p>`
        : `<p class="hint">授權紀錄：尚無撤回或新開紀錄。</p>`}
      <p class="hint">訂閱：暫停或恢復傳送；輪替密鑰不會解除訂閱。</p>
      <div class="row actions">
        ${exited ? `<button type="button" class="primary" data-pid="${esc(p.id)}" data-pact="reconnect" aria-label="重新連接 ${esc(name)}">重新連接</button>` : ""}
        ${!exited && paused ? `<button type="button" class="primary" data-pid="${esc(p.id)}" data-pact="resume" aria-label="恢復 ${esc(name)}">恢復</button>` : ""}
        ${!exited && !paused ? `<button type="button" data-pid="${esc(p.id)}" data-pact="pause" aria-label="暫停 ${esc(name)}">暫停</button>` : ""}
        ${!exited && !caps.crm_sync ? `<button type="button" data-pid="${esc(p.id)}" data-pact="grant-crm-sync" aria-label="允許 ${esc(name)} 的 CRM 同步">允許 CRM 同步</button>` : ""}
        ${!exited && caps.crm_sync ? `<button type="button" data-pid="${esc(p.id)}" data-pact="revoke-crm-sync" aria-label="撤回 ${esc(name)} 的 CRM 同步">撤回 CRM 同步</button>` : ""}
        ${!exited && !caps.remote_cs ? `<button type="button" data-pid="${esc(p.id)}" data-pact="grant-remote-cs" aria-label="允許 ${esc(name)} 的遠端客服">允許遠端客服</button>` : ""}
        ${!exited && caps.remote_cs ? `<button type="button" data-pid="${esc(p.id)}" data-pact="revoke-remote-cs" aria-label="撤回 ${esc(name)} 的遠端客服">撤回遠端客服</button>` : ""}
        ${!exited && !caps.cross_site_insight ? `<button type="button" data-pid="${esc(p.id)}" data-pact="grant-insight" aria-label="允許 ${esc(name)} 的跨站分析">允許跨站分析</button>` : ""}
        ${!exited && caps.cross_site_insight ? `<button type="button" data-pid="${esc(p.id)}" data-pact="revoke-insight" aria-label="撤回 ${esc(name)} 的跨站分析">撤回跨站分析</button>` : ""}
        ${!exited && caps.cross_site_insight && !caps.retain_after_exit ? `<button type="button" data-pid="${esc(p.id)}" data-pact="grant-retain" aria-label="允許 ${esc(name)} 退出後保留用途">允許退出後保留</button>` : ""}
        ${!exited && caps.retain_after_exit ? `<button type="button" data-pid="${esc(p.id)}" data-pact="revoke-retain" aria-label="撤回 ${esc(name)} 的退出後保留用途">撤回退出後保留</button>` : ""}
        ${!exited && !caps.stats ? `<button type="button" data-pid="${esc(p.id)}" data-pact="grant-stats" aria-label="允許 ${esc(name)} 的統計指標">允許統計指標</button>` : ""}
        ${!exited && caps.stats ? `<button type="button" data-pid="${esc(p.id)}" data-pact="revoke-stats" aria-label="撤回 ${esc(name)} 的統計指標">撤回統計指標</button>` : ""}
        ${!exited && !caps.followup_service ? `<button type="button" data-pid="${esc(p.id)}" data-pact="grant-followup" aria-label="允許 ${esc(name)} 的後續服務使用">允許後續服務</button>` : ""}
        ${!exited && caps.followup_service ? `<button type="button" data-pid="${esc(p.id)}" data-pact="revoke-followup" aria-label="撤回 ${esc(name)} 的後續服務使用">撤回後續服務</button>` : ""}
        ${!exited ? `<button type="button" data-pid="${esc(p.id)}" data-pact="rotate-credential" aria-label="輪替 ${esc(name)} 的密鑰">輪替密鑰</button>` : ""}
        ${!exited ? `<button type="button" class="danger" data-pid="${esc(p.id)}" data-pact="unsubscribe" aria-label="解除訂閱 ${esc(name)}">解除訂閱</button>` : ""}
      </div>
      <p class="hint">${exited
        ? "已退出：可查看未決清單、移交整站或刪除 OPS 複本。要恢復傳送請重新連接。"
        : "退出四件事：暫停、解除訂閱、移交整站、刪除 OPS 複本。"}</p>
      <div class="row actions exit-actions">
        <button type="button" data-pid="${esc(p.id)}" data-pact="pending" aria-label="查看 ${esc(name)} 的未決清單">未決清單</button>
        <button type="button" data-pid="${esc(p.id)}" data-pact="handoff" aria-label="移交 ${esc(name)} 整站">移交整站</button>
        <button type="button" class="danger" data-pid="${esc(p.id)}" data-pact="purge-replica" aria-label="刪除 ${esc(name)} 的 OPS 複本">刪除 OPS 複本</button>
      </div>
    </article>`;
  }).join("");
}

function setProductBusy(on) {
  productBusy = on;
  document.querySelectorAll("#productCards button, #createProductBtn").forEach((btn) => {
    btn.disabled = on;
  });
}

async function refreshProducts() {
  const box = $("productCards");
  if (box && !box.dataset.loaded) box.innerHTML = `<p class="hint">載入中…</p>`;
  const { res, data } = await api("/ops/api/products");
  if (!res.ok) {
    setStatus($("productMsg"), data.error || "無法讀取產品", "err");
    return;
  }
  productsCache = data.items || [];
  if (box) box.dataset.loaded = "1";
  if (selectedProductId && !productsCache.some((p) => p.id === selectedProductId)) {
    selectedProductId = "";
  }
  if ($("productMsg")?.classList.contains("err")) setStatus($("productMsg"), "");
  renderProductSwitcher();
  renderProductCards();
}

function productName(id) {
  return productsCache.find((p) => p.id === id)?.display_name || id;
}

function pendingItemCancellable(it) {
  return it.kind === "site_command" && (it.state === "pending" || it.state === "sending");
}

function showExitDetail(id, data) {
  const box = $("exitDetail");
  if (!box) return;
  box.hidden = false;
  box.removeAttribute("aria-busy");
  const pending = data.pending || data.exit?.pending || { items: [] };
  const lines = [];
  const sha = data.sha256 || data.manifest?.sha256 || "";
  if (data.manifest || sha) {
    lines.push(sha ? `交接包 sha256` : "交接包");
    if (sha) lines.push(sha);
    lines.push(`回饋 ${data.manifest?.feedback_count ?? data.payload?.feedback?.length ?? 0} 筆`);
  }
  if (data.purged != null) lines.push(`已清除 OPS 複本 ${data.purged} 筆內容`);
  const notes = String(data.exit?.notes || "").trim();
  if (notes && !/^交接包 [a-f0-9]+$/i.test(notes)) lines.push(notes);
  if (data.site_delivery_unconfirmed) lines.push("OPS 權限已撤銷；本站停止遞送尚未由此畫面確認。");
  const items = pending.items || [];
  lines.push(items.length ? `未決 ${items.length} 項` : "沒有未決工作");
  const product = productsCache.find((p) => p.id === id);
  const exited = product?.status === "exited" || product?.subscription?.status === "exited";
  if (!items.length) {
    lines.push(exited
      ? "下一步：移交整站帶走複本，或重新連接恢復傳送。"
      : "下一步：解除訂閱前可先移交整站。");
  }
  $("exitDetailTitle").textContent = `${productName(id)} · 退出／移交`;
  $("exitDetailHint").textContent = data.exit?.action
    ? `最近動作：${EXIT_ACTION_LABEL[data.exit.action] || data.exit.action}（${STATUS_LABEL[data.exit.exit_status] || data.exit.exit_status}）`
    : "未決與交接摘要";
  const blocks = lines.map((line) => `<p>${esc(line)}</p>`);
  for (const it of items) {
    const label = `${PENDING_KIND_LABEL[it.kind] || it.kind} #${it.id} ${STATUS_LABEL[it.state] || it.state}${it.blocking ? "（阻擋）" : ""}${it.unscoped ? "（尚未分站）" : ""} ${it.note || ""}`;
    const btn = pendingItemCancellable(it)
      ? `<button type="button" data-cancel-cmd="${Number(it.id)}" data-pid="${esc(id)}" data-cmd-state="${esc(it.state)}">取消未送出的遠端客服</button>`
      : "";
    blocks.push(`<div class="pending-item"><p>${esc(label)}</p>${btn}</div>`);
  }
  $("exitDetailBody").innerHTML = blocks.join("");
  box.scrollIntoView({ block: "nearest" });
}

async function loadPending(id) {
  const box = $("exitDetail");
  if (box) {
    box.hidden = false;
    box.setAttribute("aria-busy", "true");
    $("exitDetailTitle").textContent = `${productName(id)} · 退出／移交`;
    $("exitDetailHint").textContent = "載入未決清單…";
    $("exitDetailBody").textContent = "";
  }
  setStatus($("productMsg"), "載入未決清單…");
  const { res, data } = await api(`/ops/api/products/${encodeURIComponent(id)}/pending`);
  if (box) box.removeAttribute("aria-busy");
  if (!res.ok) {
    setStatus($("productMsg"), humanError(data.error), "err");
    if (box) {
      $("exitDetailHint").textContent = "無法載入未決清單";
      $("exitDetailBody").textContent = humanError(data.error);
    }
    return;
  }
  showExitDetail(id, data);
  setStatus($("productMsg"), "已載入未決清單", "ok");
}

async function runProductAction(id, action) {
  if (productBusy) return;
  setProductBusy(true);
  setStatus($("productMsg"), "處理中…");
  try {
    const opts = { method: "POST" };
    if (action === "purge-replica") {
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify({ confirm: `PURGE-${id}` });
    }
    const { res, data } = await api(`/ops/api/products/${encodeURIComponent(id)}/${action}`, opts);
    if (!res.ok) {
      setStatus($("productMsg"), humanError(data.error), "err");
      return;
    }
    const labels = {
      pause: "已暫停訂閱",
      resume: "已恢復訂閱",
      unsubscribe: "已解除訂閱，密鑰已撤銷",
      reconnect: "已重新連接",
      "rotate-credential": "已輪替密鑰",
      handoff: "已匯出交接包",
      "purge-replica": "已刪除 OPS 複本內容",
    };
    setStatus($("productMsg"), labels[action] || "已完成", "ok");
    if (data.ingest_secret) {
      showSecret(data.ingest_secret, action === "reconnect" ? "重新連接" : "輪替密鑰");
    }
    if (data.pending || data.exit || data.manifest) {
      showExitDetail(id, data);
    }
    await refreshProducts();
  } finally {
    setProductBusy(false);
  }
}

async function setProductCapability(id, patch) {
  if (productBusy) return;
  setProductBusy(true);
  setStatus($("productMsg"), "處理中…");
  try {
    const { res, data } = await api(`/ops/api/products/${encodeURIComponent(id)}/capabilities`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch || {}),
    });
    if (!res.ok) {
      setStatus($("productMsg"), humanError(data.error), "err");
      return;
    }
    if (data.command_secret) showSecret(data.command_secret, "遠端客服命令密鑰");
    const msg = patch.remote_cs === true ? "已允許遠端客服"
      : patch.remote_cs === false ? "已撤回遠端客服"
        : patch.cross_site_insight === true ? "已允許跨站分析"
          : patch.cross_site_insight === false ? "已撤回跨站分析"
            : patch.retain_after_exit === true ? "已允許退出後保留用途"
              : patch.retain_after_exit === false ? "已撤回退出後保留用途"
                : patch.stats === true ? "已允許統計指標"
                  : patch.stats === false ? "已撤回統計指標"
                    : patch.followup_service === true ? "已允許後續服務使用"
                      : patch.followup_service === false ? "已撤回後續服務使用"
                        : patch.crm_sync ? "已允許 CRM 同步" : "已撤回 CRM 同步";
    setStatus($("productMsg"), msg, "ok");
    await Promise.all([refreshProducts(), refreshCrm()]);
  } finally {
    setProductBusy(false);
  }
}

async function createProduct(ev) {
  ev.preventDefault();
  if (productBusy) return;
  const id = $("newProductId").value.trim();
  const name = $("newProductName").value.trim();
  setProductBusy(true);
  setStatus($("productMsg"), "建立中…");
  try {
    const { res, data } = await api("/ops/api/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, display_name: name }),
    });
    if (!res.ok) {
      setStatus($("productMsg"), humanError(data.error), "err");
      $("newProductId").setAttribute("aria-invalid", "true");
      $("newProductId").focus();
      return;
    }
    $("newProductId").removeAttribute("aria-invalid");
    $("createProductForm").reset();
    setStatus($("productMsg"), `已建立 ${data.product?.display_name || id}`, "ok");
    if (data.ingest_secret) showSecret(data.ingest_secret, "新建產品");
    await refreshProducts();
  } finally {
    setProductBusy(false);
  }
}

function requestProductAction(id, action) {
  const product = productsCache.find((p) => p.id === id);
  const name = product?.display_name || id;
  if (action === "pause") {
    showConfirm({
      title: "確認暫停",
      body: `暫停「${name}」（${id}）後，此站停止傳送。產品卡仍在，可再恢復。這不是解除訂閱，密鑰不會撤銷。`,
      confirmLabel: "確定暫停",
      onConfirm: () => runProductAction(id, "pause"),
    });
    return;
  }
  if (action === "resume") {
    showConfirm({
      title: "確認恢復",
      body: `恢復「${name}」（${id}）的傳送？密鑰沿用，不開新的訂閱世代。`,
      confirmLabel: "確定恢復",
      onConfirm: () => runProductAction(id, "resume"),
    });
    return;
  }
  if (action === "unsubscribe") {
    showConfirm({
      title: "確認解除訂閱",
      body: `確定解除「${name}」（${id}）的訂閱？此站將停止傳送，現有密鑰立即失效。自動重評不會把舊議題重開，未送出的遠端客服也不會外送。產品卡會留下摘要，之後可重新連接。`,
      confirmLabel: "確定解除",
      onConfirm: () => runProductAction(id, "unsubscribe"),
    });
    return;
  }
  if (action === "rotate-credential") {
    showConfirm({
      title: "確認輪替密鑰",
      body: `確定輪替「${name}」（${id}）的 ingest 密鑰？舊密鑰會立刻失效，新密鑰只顯示一次。`,
      confirmLabel: "確定輪替",
      onConfirm: () => runProductAction(id, "rotate-credential"),
    });
    return;
  }
  if (action === "reconnect") {
    showConfirm({
      title: "確認重新連接",
      body: `確定重新連接「${name}」（${id}）？會開新的訂閱世代並發出新密鑰，舊密鑰失效。`,
      confirmLabel: "確定重連",
      onConfirm: () => runProductAction(id, "reconnect"),
    });
    return;
  }
  if (action === "pending") {
    loadPending(id);
    return;
  }
  if (action === "handoff") {
    showConfirm({
      title: "確認移交整站",
      body: `移交「${name}」（${id}）會匯出可驗證交接包。不含金鑰與其它站資料。本機主本仍在對方站。正式部署狀態不明時會拒絕移交，先確認該環境實際結果。`,
      confirmLabel: "確定移交",
      onConfirm: () => runProductAction(id, "handoff"),
    });
    return;
  }
  if (action === "grant-crm-sync") {
    showConfirm({
      title: "確認允許 CRM 同步",
      body: `允許「${name}」（${id}）把 CRM 欄位同步到 OPS？這與回饋複製分開，不會自動包含會員名單或行銷用途。`,
      confirmLabel: "確定允許",
      danger: false,
      onConfirm: () => setProductCapability(id, { crm_sync: true }),
    });
    return;
  }
  if (action === "revoke-crm-sync") {
    showConfirm({
      title: "確認撤回 CRM 同步",
      body: `撤回「${name}」（${id}）的 CRM 同步授權？既有複本仍保留，不會再收新處理。這不是 DROP。`,
      confirmLabel: "確定撤回",
      onConfirm: () => setProductCapability(id, { crm_sync: false }),
    });
    return;
  }
  if (action === "grant-remote-cs") {
    showConfirm({
      title: "確認允許遠端客服",
      body: `允許從 OPS 對「${name}」（${id}）送客服命令？本站驗證後才寫本機；本站不在線不會假裝已回覆。預設仍關遞送。`,
      confirmLabel: "確定允許",
      danger: false,
      onConfirm: () => setProductCapability(id, { remote_cs: true }),
    });
    return;
  }
  if (action === "revoke-remote-cs") {
    showConfirm({
      title: "確認撤回遠端客服",
      body: `撤回「${name}」（${id}）的遠端客服？新命令會被拒絕，已寫進本站的處理紀錄仍保留。`,
      confirmLabel: "確定撤回",
      onConfirm: () => setProductCapability(id, { remote_cs: false }),
    });
    return;
  }
  if (action === "grant-insight") {
    showConfirm({
      title: "確認允許跨站分析",
      body: `允許用「${name}」（${id}）的 OPS 複本產生新洞察（分析／向量／分群）？回饋複製不會自動包含這一項。去掉 email 不是匿名化。`,
      confirmLabel: "確定允許",
      danger: false,
      onConfirm: () => setProductCapability(id, { cross_site_insight: true }),
    });
    return;
  }
  if (action === "revoke-insight") {
    showConfirm({
      title: "確認撤回跨站分析",
      body: `撤回「${name}」（${id}）的跨站分析？不會再產生新洞察；已寫入的分析／向量仍保留，要清掉請刪 OPS 複本。`,
      confirmLabel: "確定撤回",
      onConfirm: () => setProductCapability(id, { cross_site_insight: false, retain_after_exit: false }),
    });
    return;
  }
  if (action === "grant-retain") {
    showConfirm({
      title: "確認允許退出後保留用途",
      body: `允許「${name}」（${id}）解除訂閱後仍用舊複本產生新洞察？預設是停。`,
      confirmLabel: "確定允許",
      danger: false,
      onConfirm: () => setProductCapability(id, { retain_after_exit: true }),
    });
    return;
  }
  if (action === "revoke-retain") {
    showConfirm({
      title: "確認撤回退出後保留用途",
      body: `撤回「${name}」（${id}）的退出後保留？解除訂閱後不再用該站複本產生新洞察。`,
      confirmLabel: "確定撤回",
      onConfirm: () => setProductCapability(id, { retain_after_exit: false }),
    });
    return;
  }
  if (action === "grant-stats") {
    showConfirm({
      title: "確認允許統計指標",
      body: `允許用「${name}」（${id}）的 OPS 複本列入跨站／未標站指標？這不是新報表。回饋複製與跨站分析都不會自動包含這一項。作業用收件匣計數仍看得到複本。`,
      confirmLabel: "確定允許",
      danger: false,
      onConfirm: () => setProductCapability(id, { stats: true }),
    });
    return;
  }
  if (action === "revoke-stats") {
    showConfirm({
      title: "確認撤回統計指標",
      body: `撤回「${name}」（${id}）的統計指標？該站複本不再列入未標站指標。收件匣與單站作業數字仍在。`,
      confirmLabel: "確定撤回",
      onConfirm: () => setProductCapability(id, { stats: false }),
    });
    return;
  }
  if (action === "grant-followup") {
    showConfirm({
      title: "確認允許後續服務使用",
      body: `允許用「${name}」（${id}）的 OPS 複本做後續通知（例如入庫 webhook）？這不是客服命令，也不會發明新的行銷流程。回饋複製不會自動包含。`,
      confirmLabel: "確定允許",
      danger: false,
      onConfirm: () => setProductCapability(id, { followup_service: true }),
    });
    return;
  }
  if (action === "revoke-followup") {
    showConfirm({
      title: "確認撤回後續服務使用",
      body: `撤回「${name}」（${id}）的後續服務？新的入庫通知不會再送。已寫入的複本與已送出的通知仍在。`,
      confirmLabel: "確定撤回",
      onConfirm: () => setProductCapability(id, { followup_service: false }),
    });
    return;
  }
  if (action === "purge-replica") {
    showConfirm({
      title: "確認刪除 OPS 複本",
      body: `確定清除「${name}」（${id}）在 OPS 的回饋複本、分析摘要、向量、附件與匯出副本？去掉聯絡方式不是匿名化。本機主本不會動。`,
      confirmLabel: "確定清除",
      onConfirm: () => runProductAction(id, "purge-replica"),
    });
    return;
  }
  runProductAction(id, action);
}

function hasLatestDecision(block) {
  return Boolean(block && block.latest_decision);
}

function focusHeading(id) {
  const el = $(id);
  if (!el) return;
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}

function closeDevDetail() {
  devOpen = { taskId: 0, issueId: 0, stagingId: 0, qaRunId: 0, release: null };
  if ($("devDetailCard")) $("devDetailCard").hidden = true;
  if ($("devActions")) $("devActions").hidden = true;
  if ($("gate2Row")) $("gate2Row").hidden = true;
  if ($("devPipeline")) $("devPipeline").innerHTML = "";
  document.querySelectorAll("#devTable tr[data-tid]").forEach((row) => {
    row.setAttribute("aria-selected", "false");
    row.classList.remove("on");
  });
}

async function refreshDashboard() {
  const queue = $("queueBox");
  if (queue) {
    queue.setAttribute("aria-busy", "true");
    queue.removeAttribute("role");
  }
  const { res, data } = await api(`/ops/api/dashboard${productQuery("?")}`);
  if (!res.ok) {
    $("dashMsg").textContent = data.error || "無法讀取總覽";
    $("dashMsg").className = "msg err";
    if (queue) {
      queue.setAttribute("role", "alert");
      queue.textContent = data.error || "待辦無法載入。請再整理。";
      queue.setAttribute("aria-busy", "false");
    }
    return;
  }
  const stats = [
    ["回饋", data.feedback_total],
    ["議題", data.issues_open],
    ["待核准開發", data.waiting_owner_approval],
    ["待核准發布", data.waiting_release_approval],
    ["待送通知", data.pending_release_notifications],
  ];
  $("dashBox").innerHTML = stats.map(([label, n]) => `<div class="stat"><b>${esc(n)}</b><span>${esc(label)}</span></div>`).join("");
  const hook = data.webhook?.configured
    ? `Webhook 已設定（${data.webhook.channel}）${data.webhook.on_ingest ? "，入庫也會通知" : ""}`
    : "尚未設定 OPS_NOTIFY_WEBHOOK_URL，核准／發布通知不會外送";
  const scope = data.selected_product_id ? `站台 ${data.selected_product_id}` : "全部站台";
  const withheld = Array.isArray(data.stats_withheld_product_ids) && data.stats_withheld_product_ids.length
    ? ` · 指標不含未授權站 ${data.stats_withheld_product_ids.join("、")}（作業計數仍含複本）`
    : (data.selected_product_id && data.stats_consent === false ? " · 此站未授權統計指標" : "");
  $("dashMsg").textContent = `Phase ${data.phase} · ${scope} · ${hook}${withheld}`;
  $("dashMsg").className = "msg";

  const issues = await api("/ops/api/issues?limit=80");
  if (!issues.res.ok) {
    if (queue) {
      queue.setAttribute("role", "alert");
      queue.textContent = issues.data.error || "待辦無法載入。請再整理。";
      queue.setAttribute("aria-busy", "false");
    }
    return;
  }
  const waiting = (issues.data.items || []).filter((it) => {
    const gate = it.lifecycle_state === "WAITING_OWNER_APPROVAL" || it.lifecycle_state === "WAITING_RELEASE_APPROVAL";
    if (!gate) return false;
    if (selectedProductId && it.product_id !== selectedProductId) return false;
    return true;
  });
  const dashWaiting = Number(data.waiting_owner_approval || 0) + Number(data.waiting_release_approval || 0);
  if (queue) queue.setAttribute("aria-busy", "false");
  if (!waiting.length) {
    if (queue) {
      queue.removeAttribute("role");
      queue.textContent = dashWaiting > 0
        ? `數字顯示還有 ${dashWaiting} 筆待核准，但目前列表沒列到。請到議題或開發發行分頁查看。`
        : "目前沒有等待 Owner 核准的項目。";
    }
    return;
  }
  if (queue) queue.setAttribute("role", "list");
  $("queueBox").innerHTML = waiting.map((it) => {
    const gate2 = it.lifecycle_state === "WAITING_RELEASE_APPROVAL";
    const label = gate2 ? "Gate #2 待核准發布" : "Gate #1 待核准開發";
    const product = it.product_id || "（無站台）";
    return `<button type="button" class="queue-item" data-iid="${it.id}" data-gate="${gate2 ? "2" : "1"}" aria-label="${esc(label)}：#${it.id} ${esc(it.title || "（無標題）")} ${esc(product)}">
      <strong>#${it.id} ${esc(it.title || "（無標題）")}</strong>
      <span>${esc(label)} · ${esc(product)} · 評估 ${esc(it.evaluation || "—")}</span>
    </button>`;
  }).join("");
}

async function openOwnerQueueItem(issueId, gate) {
  const iid = Number(issueId);
  if (!iid) return;
  if (String(gate) === "2") {
    setTab("dev");
    await refreshDev();
    const task = (devCache.items || []).find((t) => Number(t.issue_id) === iid);
    if (task) {
      await openCodingTask(task.id);
      $("devDetailCard")?.scrollIntoView({ block: "nearest" });
      focusHeading("devDetailTitle");
      return;
    }
    setStatus($("devMsg"), `議題 #${iid} 尚無製作任務。核准開發後才會出現。`, "");
    $("devMsg")?.focus?.();
    return;
  }
  setTab("issues");
  await openIssue(iid);
  $("issueDetailCard")?.scrollIntoView({ block: "nearest" });
  focusHeading("issueDetailTitle");
}

async function refreshInbox() {
  const include = $("showContact")?.checked ? "1" : "0";
  const { res, data } = await api(`/ops/api/feedback?limit=80&includeContact=${include}${productQuery("&")}`);
  if (!res.ok) {
    $("inboxHint").textContent = data.error || "無法讀取收件匣";
    return;
  }
  const scope = selectedProductId ? `（${selectedProductId}）` : "";
  $("inboxHint").textContent = `共 ${data.total} 筆${scope}，顯示最新 ${data.items.length} 筆。`;
  const body = $("inboxTable").querySelector("tbody");
  body.innerHTML = (data.items || []).map((r) => `
    <tr data-fid="${r.id}">
      <td>${r.id}</td>
      <td>${esc(r.product_id || "—")}</td>
      <td>${esc(r.kind)}</td>
      <td>${esc(String(r.content || "").slice(0, 120))}</td>
      <td>${r.issue_id ? "#" + r.issue_id : "—"}</td>
      <td>${esc(r.app_version || "—")}</td>
      <td>${fmtTime(r.received_at || r.submitted_at)}</td>
    </tr>`).join("") || `<tr><td colspan="7" class="hint">尚無回饋。請確認正式站已開 OPS_FEEDBACK_DELIVERY=1。</td></tr>`;
}

async function openFeedback(id) {
  const { res, data } = await api(`/ops/api/feedback/${id}/analysis${productQuery("?")}`);
  const box = $("feedbackDetail");
  if (!res.ok) {
    box.hidden = false;
    box.textContent = data.error || "讀取失敗";
    return;
  }
  const fb = data.feedback || {};
  const cur = data.current || {};
  box.hidden = false;
  box.textContent = [
    `回饋 #${fb.id} · ${fb.kind || ""} · ${fb.source || ""} · ${fb.product_id || ""}`,
    fb.content || "",
    "",
    `分析：${cur.category || "尚未分析"} / ${cur.severity_hint || "—"}`,
    cur.summary || "",
  ].join("\n");
}

async function refreshIssues() {
  const { res, data } = await api("/ops/api/issues?limit=80");
  if (!res.ok) {
    const body = $("issueTable").querySelector("tbody");
    body.innerHTML = `<tr><td colspan="6" class="hint">${esc(data.error || "無法讀取議題")}</td></tr>`;
    return;
  }
  const body = $("issueTable").querySelector("tbody");
  body.innerHTML = (data.items || []).map((it) => `
    <tr data-iid="${it.id}" class="${Number(it.id) === Number(selectedIssueId) ? "on" : ""}">
      <td>${it.id}</td>
      <td>${esc(it.title || "（無標題）")}</td>
      <td><span class="chip ${it.lifecycle_state && it.lifecycle_state.includes("WAITING") ? "warn" : ""}">${esc(it.lifecycle_state)}</span></td>
      <td>${it.impact_level ? esc(it.impact_level) + " " + esc(it.impact_score ?? "") : "—"}</td>
      <td>${esc(it.evaluation || "—")}</td>
      <td>${it.member_count}</td>
    </tr>`).join("") || `<tr><td colspan="6" class="hint">尚無議題。回饋需先被分析／分群。</td></tr>`;
}

async function openIssue(id) {
  selectedIssueId = Number(id);
  const [issue, proposal] = await Promise.all([
    api(`/ops/api/issues/${id}`),
    api(`/ops/api/issues/${id}/proposal`),
  ]);
  $("issueDetailCard").hidden = false;
  $("issueDetailTitle").textContent = `議題 #${id}`;
  const members = issue.data.members || [];
  const cur = proposal.data.current;
  const parentId = issue.data.issue?.parent_issue_id;
  const followUps = issue.data.follow_ups || [];
  const lines = [
    issue.data.issue?.title || "",
    issue.data.issue?.summary || "",
    issue.data.lifecycle_state ? `生命週期 ${issue.data.lifecycle_state}` : "",
    parentId ? `後續開發自議題 #${parentId}，不重用已發布授權` : "",
    followUps.length ? `已建立後續：${followUps.map((f) => `#${f.id}`).join("、")}` : "",
    `成員 ${members.length} 筆回饋`,
    cur ? `提案 v${cur.proposal_version} · ${cur.title || ""}` : "尚無提案",
    cur?.problem_statement || "",
    cur?.proposed_change || "",
  ].filter(Boolean);
  $("issueDetail").textContent = lines.join("\n\n");
  $("gate1Row").hidden = !cur || hasLatestDecision(proposal.data.current_decision);
  $("gate1Row").dataset.proposal = cur ? JSON.stringify({
    proposal_id: cur.id,
    proposal_version: cur.proposal_version,
    proposal_hash: cur.proposal_hash,
  }) : "";
  const life = issue.data.lifecycle_state || "";
  const canFollow = life === "RELEASED" || life === "ROLLED_BACK";
  if ($("followUpRow")) $("followUpRow").hidden = !canFollow;
  $("issueMsg").textContent = "";
  await refreshIssues();
}

async function decideGate1(action) {
  if (!selectedIssueId) return;
  let body = {};
  try { body = JSON.parse($("gate1Row").dataset.proposal || "{}"); } catch { body = {}; }
  body.action = action;
  const { res, data } = await api(`/ops/api/issues/${selectedIssueId}/proposal/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  $("issueMsg").textContent = res.ok ? `已送出 ${action}` : (data.error || "決策失敗");
  $("issueMsg").className = res.ok ? "msg ok" : "msg err";
  if (res.ok) {
    $("gate1Row").hidden = true;
    await refreshDashboard();
    await openIssue(selectedIssueId);
  }
}

async function refreshAudit() {
  const { res, data } = await api("/ops/api/audit?limit=100");
  if (!res.ok) {
    $("auditMsg").textContent = data.error || "無法讀取稽核";
    $("auditMsg").className = "msg err";
    return;
  }
  const body = $("auditTable").querySelector("tbody");
  const rows = data.items || [];
  body.innerHTML = rows.map((r) => `
    <tr>
      <td>${r.id}</td>
      <td>${fmtTime(r.ts)}</td>
      <td>${esc(r.actor)}</td>
      <td>${esc(r.action)}</td>
      <td>${esc(r.entity_type || "")}${r.entity_id ? " · " + esc(String(r.entity_id).slice(0, 8)) : ""}</td>
      <td><code>${esc(String(r.hash).slice(0, 12))}</code></td>
    </tr>`).join("") || `<tr><td colspan="6" class="hint">尚無稽核紀錄</td></tr>`;
  $("auditMsg").textContent = `顯示最新 ${rows.length} 筆 / 共 ${data.total || rows.length} 筆`;
  $("auditMsg").className = "msg";
}

async function refreshTransitions() {
  const { res, data } = await api("/ops/api/state/transitions");
  if (!res.ok) return;
  const body = $("stateTable").querySelector("tbody");
  const rows = data.items || [];
  body.innerHTML = rows.map((r) => `
    <tr>
      <td>${r.id}</td>
      <td>${fmtTime(r.created_at)}</td>
      <td>${esc(r.entity_type)} · ${esc(String(r.entity_id).slice(0, 8))}</td>
      <td>${esc(r.from_state)} → ${esc(r.to_state)}</td>
      <td>${r.entity_version}</td>
      <td>${esc(r.actor)}</td>
    </tr>`).join("") || `<tr><td colspan="6" class="hint">尚無狀態轉移</td></tr>`;
}

let crmCache = { module: { enabled: true }, items: [] };

function crmLagText(item) {
  if (!item.last_synced_at) return "尚未同步";
  const mins = Math.round((item.sync_lag_ms || 0) / 60000);
  return item.sync_stale ? `上次同步已超過 ${mins} 分鐘` : `上次同步 ${mins} 分鐘前`;
}

function publicSiteAdminHref(url) {
  const s = String(url || "").trim();
  return /^https?:\/\//i.test(s) ? s : "";
}

function productHasRemoteCs(productId) {
  const p = (productsCache || []).find((x) => x.id === productId);
  return Boolean(p && p.subscription && p.subscription.capabilities && p.subscription.capabilities.remote_cs);
}

function remoteCsFormHtml(item, handle) {
  if (!productHasRemoteCs(item.product_id)) {
    return `<p class="hint">遠端客服關閉。請前往本站處理，不要在這裡假裝已回覆。</p>`;
  }
  const fb = handle.feedback_id || "";
  const contactId = (item.columns && item.columns.site_crm && item.columns.site_crm.contact && item.columns.site_crm.contact.external_contact_id) || "";
  return `<form class="remote-cs-form" data-product="${esc(item.product_id)}" data-feedback="${esc(fb)}" data-contact="${esc(contactId)}">
    <p class="hint">送出後只有本站套用成功才算回覆。本站離線會顯示失敗。</p>
    ${fb ? `<label>處理進度 <select name="handling_state"><option value="doing">處理中</option><option value="done">已完成</option><option value="declined">暫不處理</option></select></label>
    <label>內部備註 <input name="admin_note" maxlength="500" /></label>` : `<p class="hint">這個聯絡人還沒有對應回饋編號，只能加站內備註。</p>`}
    <label>站內 CRM 備註 <input name="crm_note" maxlength="500" placeholder="寫進本站 CRM（可選）" /></label>
    <button type="submit">送出遠端客服命令</button>
  </form>`;
}

function bindCrmSiteUrlForm(pid) {
  $("crmSiteUrlForm")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const url = new FormData(ev.target).get("site_admin_url");
    const { res, data } = await api("/ops/api/crm/module", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product_id: pid, site_admin_url: url }),
    });
    if (!res.ok) {
      setStatus($("crmMsg"), data.error || "儲存本站連結失敗", "err");
      return;
    }
    await refreshCrm();
    setStatus($("crmMsg"), "已儲存本站後台網址", "ok");
  });
}

function renderCrm() {
  const box = $("crmList");
  const hint = $("crmHint");
  const toggle = $("crmModuleToggle");
  if (!box) return;
  const enabled = crmCache.module?.enabled !== false;
  if (toggle) {
    toggle.textContent = enabled ? "關閉 CRM 模組" : "重新開啟 CRM 模組";
    const needProduct = !selectedProductId;
    toggle.disabled = needProduct;
    toggle.title = needProduct ? "請先選單一站台再開關模組" : "";
  }
  const grant = $("crmGrantSync");
  if (grant) {
    grant.disabled = !selectedProductId;
    grant.title = selectedProductId ? "" : "請先選單一站台再授權";
  }
  if (hint) {
    hint.textContent = enabled
      ? (crmCache.hint || "四欄分開顯示。")
      : "CRM 模組已關閉：不再收新處理，複本仍保留。";
  }
  const items = crmCache.items || [];
  const pid = selectedProductId || crmCache.product?.id || "v3";
  const adminUrl = publicSiteAdminHref(crmCache.module?.site_admin_url || (items[0] && items[0].site_admin_url));
  const setup = `<form id="crmSiteUrlForm" class="row crm-url-form">
    <label>本站後台網址 <input name="site_admin_url" value="${esc(adminUrl)}" placeholder="https://example.com/admin.html#crm" maxlength="400" /></label>
    <button type="submit">儲存本站連結</button>
  </form>`;
  if (!items.length) {
    const grantHint = selectedProductId
      ? "還沒有站方 CRM 複本。先在本站後台建立聯絡人，再按「允許 CRM 同步授權」。"
      : "還沒有站方 CRM 複本。請先選單一站台，再到本站後台建立聯絡人並授權同步。";
    box.innerHTML = `${setup}<p class="hint">${grantHint}</p>`;
    bindCrmSiteUrlForm(pid);
    return;
  }
  box.innerHTML = setup + items.map((item) => {
    const c = item.columns || {};
    const site = c.site_crm || {};
    const contact = site.contact || {};
    const handle = c.site_handling || {};
    const ops = c.ops_progress || {};
    const owner = c.owner_notes || {};
    const href = publicSiteAdminHref(item.site_admin_url);
    return `<article class="crm-card">
      <div class="row">
        <strong>${esc(contact.display_name || "未命名聯絡人")}</strong>
        <span class="chip">${esc(item.product_id)}</span>
        <span class="grow"></span>
        ${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">前往本站處理</a>` : `<span class="hint">尚未設定本站後台網址</span>`}
      </div>
      <p class="hint">${esc(crmLagText(item))} · 來源連結：站方聯絡人 ${esc(contact.external_contact_id || "")}</p>
      <div class="crm-cols">
        <section class="crm-col">
          <h3>${esc(site.label || "站方客戶／客服往來")}</h3>
          <p class="src">站方複本</p>
          <p>${esc(contact.company_name || "—")}<br>${esc([contact.phone, contact.email, contact.line_id].filter(Boolean).join(" / ") || "無聯絡欄")}</p>
          <p class="hint">標籤：${esc((contact.tags || []).join("、") || "—")}</p>
          <p>案件：${(site.cases || []).length
            ? (site.cases || []).map((row) => esc(`${row.title || "未命名"} · ${crmHandlingLabel(row.handling_state)}`)).join("；")
            : "尚未有案件"}</p>
          <p class="hint">備註 ${(site.notes || []).length} 則 · 待辦 ${(site.todos || []).length} 則</p>
        </section>
        <section class="crm-col">
          <h3>${esc(handle.label || "站方處理進度")}</h3>
          <p class="src">由站方事件傳入</p>
          <p>${esc(handle.text || "尚未同步")}</p>
          ${remoteCsFormHtml(item, handle)}
        </section>
        <section class="crm-col">
          <h3>${esc(ops.label || "OPS 開發進度")}</h3>
          <p class="src">與站方客服進度分開</p>
          <p>${esc(ops.text || "尚未連到議題")}</p>
        </section>
        <section class="crm-col owner">
          <h3>${esc(owner.label || "Owner 商務備註")}</h3>
          <p class="src">OPS 自己的資料，不是站方複本</p>
          <p>${esc(owner.body || "尚未填寫")}</p>
          ${enabled ? `<form class="crm-note-form" data-product="${esc(item.product_id)}" data-subject="${esc(contact.external_contact_id || "")}">
            <label class="sr-only" for="ownernote-${esc(contact.external_contact_id || "x")}">商務備註</label>
            <input id="ownernote-${esc(contact.external_contact_id || "x")}" name="body" maxlength="2000" placeholder="只給 Owner 看" />
            <button type="submit">儲存備註</button>
          </form>` : `<p class="hint">模組已關閉，不能新增商務備註。</p>`}
        </section>
      </div>
    </article>`;
  }).join("");
  bindCrmSiteUrlForm(pid);
}

async function refreshCrm() {
  const box = $("crmList");
  if (box) box.setAttribute("aria-busy", "true");
  const { res, data } = await api(`/ops/api/crm${productQuery()}`);
  if (box) box.setAttribute("aria-busy", "false");
  if (!res.ok) {
    setStatus($("crmMsg"), data.error || "載入 CRM 失敗", "err");
    return;
  }
  crmCache = data;
  renderCrm();
  setStatus($("crmMsg"), `${(data.items || []).length} 筆複本`, "ok");
}

let devCache = { items: [] };
let devOpen = { taskId: 0, issueId: 0, stagingId: 0, qaRunId: 0, release: null };

function qaRunCancellable(run) {
  return !!run && ["pending", "failed_retry", "claimed", "running"].includes(run.status);
}

function shortSha(sha) {
  return String(sha || "").slice(0, 12) || "—";
}

function stagingFreshnessLine(stg) {
  if (!stg) return "製作完成後才會建立";
  const reasons = stg.stale_reasons || [];
  if (stg.ttl_expired || reasons.includes("ttl_expired")) {
    return "測試站已到期，可重建相同版本";
  }
  if (stg.slot_occupied || reasons.includes("environment_occupied")) {
    const other = stg.occupying_coding_task_id ? `任務 #${stg.occupying_coding_task_id}` : "另一個候選";
    return `此網址目前是 ${esc(other)} 的版本，不是本任務`;
  }
  if (stg.fresh === false) return `已過期：${esc(reasons.join("、") || "需重佈")}`;
  return `驗證 ${esc(stg.validation_result || "—")}`;
}

function stagingUrlLine(stg) {
  const url = stg?.live_preview ? (stg.staging_url || stg.endpoint) : "";
  if (url) {
    return `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">開啟隔離網址</a>`;
  }
  if (stg?.ttl_expired || (stg?.stale_reasons || []).includes("ttl_expired")) {
    return "已到期網址不當作本任務預覽";
  }
  if (stg?.slot_occupied || (stg?.stale_reasons || []).includes("environment_occupied")) {
    return "共用測試站已被覆蓋，請重佈後再點";
  }
  return stg?.staging_url ? "隔離網址目前不可當作本任務預覽" : "尚無隔離網址";
}

function syncDevActionButtons() {
  const hasStg = Number(devOpen.stagingId) > 0;
  if ($("devCancelStg")) $("devCancelStg").disabled = !hasStg;
  if ($("devCleanupStg")) $("devCleanupStg").disabled = !hasStg;
  if ($("devRedeploy")) $("devRedeploy").disabled = !devOpen.taskId;
  if ($("devRerunQa")) $("devRerunQa").disabled = !devOpen.taskId;
  if ($("devCancelQa")) $("devCancelQa").disabled = !devOpen.qaRunId;
}

async function refreshDev() {
  const table = $("devTable");
  if (table) table.setAttribute("aria-busy", "true");
  const { res, data } = await api(`/ops/api/coding-tasks?limit=40${productQuery("&")}`);
  if (table) table.setAttribute("aria-busy", "false");
  if (!res.ok) {
    setStatus($("devMsg"), data.error || "無法讀取製作任務", "err");
    $("devMsg")?.setAttribute("role", "alert");
    return;
  }
  $("devMsg")?.setAttribute("role", "status");
  devCache = data;
  const items = data.items || [];
  setStatus($("devMsg"), items.length ? `${items.length} 筆製作任務` : "目前沒有製作任務。核准開發後才會出現。", items.length ? "ok" : "");
  const body = $("devTable").querySelector("tbody");
  body.innerHTML = items.length
    ? items.map((t) => `
      <tr data-tid="${t.id}" data-iid="${t.issue_id}" tabindex="0" aria-selected="${Number(devOpen.taskId) === Number(t.id) ? "true" : "false"}">
        <td>${t.id}</td>
        <td>#${t.issue_id} ${esc(t.issue_title || "（無標題）")}${t.product_id ? ` <span class="src">${esc(t.product_id)}</span>` : ""}</td>
        <td>${statusChip(t.status)}</td>
        <td>${esc(t.coding_branch || "—")}</td>
        <td>${t.pr_url ? `<a href="${esc(t.pr_url)}" target="_blank" rel="noopener noreferrer">#${esc(t.pr_number || "")}</a>` : "—"}</td>
      </tr>`).join("")
    : `<tr><td colspan="5" class="hint">尚無隔離開發任務。</td></tr>`;
}

async function openCodingTask(taskId) {
  const id = Number(taskId);
  if (!id) return;
  $("devDetailCard").hidden = false;
  $("devDetailCard").setAttribute("aria-busy", "true");
  $("devDetailTitle").textContent = `製作任務 #${id}`;
  $("devDetailHint").textContent = "載入製作、隔離 staging 與發行候選…";
  $("devPipeline").innerHTML = "";
  $("devActions").hidden = true;
  $("gate2Row").hidden = true;
  document.querySelectorAll("#devTable tr[data-tid]").forEach((row) => {
    row.setAttribute("aria-selected", Number(row.dataset.tid) === id ? "true" : "false");
    row.classList.toggle("on", Number(row.dataset.tid) === id);
  });
  const [taskRes, qaRes, stgRes, relRes] = await Promise.all([
    api(`/ops/api/coding-tasks/${id}`),
    api(`/ops/api/coding-tasks/${id}/qa`),
    api(`/ops/api/coding-tasks/${id}/staging`),
    api(`/ops/api/coding-tasks/${id}/release`),
  ]);
  $("devDetailCard").setAttribute("aria-busy", "false");
  const task = taskRes.res.ok ? taskRes.data : null;
  const qaView = qaRes.res.ok ? qaRes.data : null;
  const stg = stgRes.res.ok ? stgRes.data : null;
  const rel = relRes.res.ok ? relRes.data : null;
  if (!task) {
    $("devDetailHint").textContent = taskRes.data.error || "找不到這筆任務";
    setStatus($("devDetailMsg"), taskRes.data.error || "找不到這筆任務", "err");
    $("devDetailMsg")?.setAttribute("role", "alert");
    return;
  }
  const qaErr = !qaRes.res.ok;
  const stgErr = !stgRes.res.ok;
  const relErr = !relRes.res.ok;
  const currentStg = !stgErr ? (stg?.current || (stg?.deployments || [])[0] || null) : null;
  const currentRel = !relErr ? (rel?.current || null) : null;
  const qa = !qaErr ? (qaView?.current || null) : null;
  const qaLatest = !qaErr ? (qa || (qaView?.runs || [])[0] || null) : null;
  const qaActive = !qaErr
    ? (qaView?.runs || []).find((r) => qaRunCancellable(r)) || (qaRunCancellable(qaLatest) ? qaLatest : null)
    : null;
  devOpen = {
    taskId: id,
    issueId: Number(task.issue_id),
    stagingId: Number(currentStg?.id || 0),
    qaRunId: Number(qaActive?.id || 0),
    qaStatus: qaActive?.status || "",
    release: currentRel && currentRel.id ? {
      manifest_id: Number(currentRel.id),
      manifest_version: Number(currentRel.manifest_version),
      manifest_hash: currentRel.manifest_hash,
      artifact_digest: currentRel.artifact_digest,
      head_sha: currentRel.head_sha,
    } : null,
  };
  $("devDetailTitle").textContent = task.issue_title
    ? `製作任務 #${id} · ${task.issue_title}`
    : `製作任務 #${id}`;
  $("devDetailHint").textContent = `議題 #${task.issue_id}${task.issue_title ? ` ${task.issue_title}` : ""} · 分支 ${task.coding_branch || "—"} · head ${shortSha(task.head_sha)}。隔離環境與正式站分開。`;
  $("devPipeline").innerHTML = `
    <div class="dev-col">
      <h3>製作任務</h3>
      <p class="src">coding task #${task.id}</p>
      <p>${statusChip(task.status)}</p>
      <p>head ${esc(shortSha(task.head_sha))}</p>
      <p>${task.pr_url ? `<a href="${esc(task.pr_url)}" target="_blank" rel="noopener noreferrer">開啟 PR</a>` : "尚無 PR"}</p>
    </div>
    <div class="dev-col">
      <h3>獨立 QA</h3>
      <p class="src">${qaActive ? `待取消 qa run #${qaActive.id} · 不 merge、不部署` : (qaLatest ? `qa run #${qaLatest.id} · 不 merge、不部署` : "不 merge、不部署")}</p>
      <p>${qaErr ? `<span class="chip danger">讀取失敗</span>` : (qaActive ? statusChip(qaActive.status) : (qaLatest ? statusChip(qaLatest.final_result || qaLatest.status) : "尚未跑"))}</p>
      <p>${qaActive ? "這次檢查尚未完成，可用下方取消。" : (qa && qa.fresh === false ? `已過期：${esc((qa.stale_reasons || []).join("、") || "需重跑")}` : (qa ? "與目前 head 對得上" : "製作完成後才會跑"))}</p>
      <p>阻擋 ${esc((Array.isArray(qaLatest?.blocking_checks) ? qaLatest.blocking_checks : []).join("、") || "無")}</p>
    </div>
    <div class="dev-col">
      <h3>隔離 staging</h3>
      <p class="src">測試容器，不是正式站</p>
      <p>${stgErr ? `<span class="chip danger">讀取失敗</span>` : (currentStg ? statusChip(currentStg.status) : "尚未建立")}</p>
      <p>${stagingFreshnessLine(currentStg)}</p>
      <p>${stagingUrlLine(currentStg)}</p>
      <p>環境 ${esc(currentStg?.staging_environment_class || "—")} / ${esc(currentStg?.staging_environment_id || "—")}</p>
    </div>
    <div class="dev-col">
      <h3>發行候選</h3>
      <p class="src">Gate #2 只寫授權</p>
      <p>${relErr ? `<span class="chip danger">讀取失敗</span>` : (currentRel ? statusChip(currentRel.status) : "尚未組候選")}</p>
      <p>manifest #${currentRel?.id || "—"} v${currentRel?.manifest_version || "—"}</p>
      <p>digest ${esc(shortSha(currentRel?.artifact_digest))}</p>
      <p>${currentRel?.fresh === false ? `已過期：${esc((currentRel.stale_reasons || []).join("、") || "—")}` : (currentRel ? "新鮮度足夠才能核准" : "QA 與 staging 都 PASS 才會出現")}</p>
    </div>`;
  $("devActions").hidden = false;
  syncDevActionButtons();
  $("gate2Row").hidden = !(currentRel && currentRel.id && currentRel.fresh !== false && !hasLatestDecision(currentRel.current_decision));
  const loadErr = [
    qaErr ? (qaRes.data.error || "獨立 QA 讀取失敗") : "",
    stgErr ? (stgRes.data.error || "隔離 staging 讀取失敗") : "",
    relErr ? (relRes.data.error || "發行候選讀取失敗") : "",
  ].filter(Boolean).join("；");
  if (loadErr) {
    setStatus($("devDetailMsg"), loadErr, "err");
    $("devDetailMsg")?.setAttribute("role", "alert");
  } else {
    $("devDetailMsg")?.setAttribute("role", "status");
    setStatus($("devDetailMsg"), "", "");
  }
}

const DRAWER_CODE_LABEL = {
  none: "不使用",
  stub: "測試用 stub",
  local: "本機／Ollama",
  openai: "OpenAI 相容",
  anthropic: "Anthropic",
  gemini: "Gemini",
  cursor: "Cursor（尚未整合）",
};

async function refreshProviders() {
  const host = $("providerDrawers");
  if (!host) return;
  host.setAttribute("aria-busy", "true");
  if (!host.querySelector(".drawer-card")) host.textContent = "載入中…";
  const { res, data } = await api("/ops/api/providers");
  if (!res.ok) {
    host.innerHTML = `<p class="msg err">${esc(data.error || "載入供應商失敗")}</p><button type="button" class="ghost" id="providerRetry">重試</button>`;
    $("providerRetry")?.addEventListener("click", refreshProviders);
    host.setAttribute("aria-busy", "false");
    setStatus($("providerMsg"), data.error || "載入供應商失敗", "err");
    return;
  }
  setStatus($("providerMsg"), data.legal || "", "");
  host.innerHTML = (data.items || []).map((item) => {
    const options = (item.codes || []).map((code) => `<option value="${esc(code)}" ${code === item.provider_code ? "selected" : ""}>${esc(DRAWER_CODE_LABEL[code] || code)}</option>`).join("");
    return `<form class="drawer-card" data-drawer="${esc(item.id)}">
      <h3>${esc(item.label)}</h3>
      <p class="hint">環境變數 ${esc(item.env_key)}＝${esc(DRAWER_CODE_LABEL[item.env_kind] || item.env_kind)}；目前決議 ${esc(DRAWER_CODE_LABEL[item.resolved_kind] || item.resolved_kind)}。${item.has_credential ? "金鑰已設定。" : "尚未貼金鑰。"}</p>
      <label class="inline"><input type="checkbox" data-drawer-on ${item.is_enabled ? "checked" : ""} /> 開啟此抽屜</label>
      <label>供應商 <select data-drawer-code>${options}</select></label>
      <label>金鑰或授權（空白則保留）<input type="password" autocomplete="new-password" data-drawer-key placeholder="${item.has_credential ? "已設定，空白則保留" : "貼上後只存在 OPS"}" /></label>
      <div class="row" style="margin-top:10px">
        <button type="submit" class="primary">儲存</button>
      </div>
      <p class="msg" data-drawer-msg role="status"></p>
    </form>`;
  }).join("");
  host.setAttribute("aria-busy", "false");
  host.querySelectorAll("form.drawer-card").forEach((form) => {
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const id = form.dataset.drawer;
      const payload = {
        is_enabled: form.querySelector("[data-drawer-on]")?.checked === true,
        provider_code: form.querySelector("[data-drawer-code]")?.value,
        credential: form.querySelector("[data-drawer-key]")?.value || "",
      };
      const msg = form.querySelector("[data-drawer-msg]");
      const btn = form.querySelector("button[type=submit]");
      if (msg) { msg.textContent = "儲存中…"; msg.className = "msg"; }
      if (btn) btn.disabled = true;
      const { res: saveRes, data: saveData } = await api(`/ops/api/providers/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!saveRes.ok) {
        if (msg) { msg.textContent = saveData.error || "儲存失敗"; msg.className = "msg err"; }
        if (btn) btn.disabled = false;
        return;
      }
      await refreshProviders();
      setStatus($("providerMsg"), `「${id}」已儲存。付費供應商需重啟 OPS 才會啟動 worker。`, "ok");
    });
  });
}

async function refreshAll() {
  await Promise.all([
    refreshProducts(),
    refreshDashboard(),
    refreshInbox(),
    refreshCrm(),
    refreshIssues(),
    refreshDev(),
    refreshProviders(),
    refreshAudit(),
    refreshTransitions(),
  ]);
}

async function init() {
  const { data } = await api("/ops/api/me");
  if (data.ok) {
    CSRF = data.csrfToken || "";
    showLoggedIn(data.email);
    await refreshAll();
  } else {
    showLoggedOut(data.configured);
  }
}

$("loginForm").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const msg = $("loginMsg");
  msg.textContent = "登入中…";
  msg.className = "msg";
  const { res, data } = await api("/ops/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: $("email").value, password: $("password").value }),
  });
  if (!res.ok) {
    msg.textContent = data.error || "登入失敗";
    msg.className = "msg err";
    return;
  }
  const me = await api("/ops/api/me");
  CSRF = me.data.csrfToken || "";
  showLoggedIn(data.email);
  await refreshAll();
});

$("logoutBtn").addEventListener("click", async () => {
  await api("/ops/api/logout", { method: "POST" });
  showLoggedOut(true);
});

document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    setTab(btn.dataset.tab);
    if (btn.dataset.tab === "providers") refreshProviders();
  });
});

$("refreshBtn").addEventListener("click", refreshAll);
$("crmGrantSync")?.addEventListener("click", async () => {
  const pid = selectedProductId;
  if (!pid) {
    setStatus($("crmMsg"), "請先選單一站台再授權", "err");
    return;
  }
  showConfirm({
    title: "確認允許 CRM 同步",
    body: `允許「${pid}」把 CRM 欄位同步到 OPS？這與回饋複製分開，不會自動包含會員名單或行銷用途。`,
    confirmLabel: "確定允許",
    danger: false,
    onConfirm: () => setProductCapability(pid, { crm_sync: true }),
  });
});
$("crmRefresh")?.addEventListener("click", refreshCrm);
$("crmModuleToggle")?.addEventListener("click", async () => {
  const next = crmCache.module?.enabled === false;
  const pid = selectedProductId || crmCache.product?.id || "v3";
  const { res, data } = await api("/ops/api/crm/module", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ product_id: pid, enabled: next }),
  });
  if (!res.ok) {
    setStatus($("crmMsg"), data.error || "切換失敗", "err");
    return;
  }
  await refreshCrm();
});
$("crmList")?.addEventListener("submit", async (ev) => {
  const remote = ev.target.closest(".remote-cs-form");
  if (remote) {
    ev.preventDefault();
    const jobs = [];
    if (remote.dataset.feedback && (remote.handling_state || remote.admin_note)) {
      jobs.push({
        product_id: remote.dataset.product,
        command_kind: "feedback.patch_handling",
        idempotency_key: `remote_cs:feedback:${remote.dataset.feedback}:${Date.now()}`,
        payload: {
          feedback_id: Number(remote.dataset.feedback),
          handling_state: remote.handling_state?.value || "doing",
          admin_note: remote.admin_note?.value || "",
        },
      });
    }
    if (remote.crm_note?.value && remote.dataset.contact) {
      jobs.push({
        product_id: remote.dataset.product,
        command_kind: "crm.add_note",
        idempotency_key: `remote_cs:note:${remote.dataset.contact}:${Date.now()}`,
        payload: { contact_id: Number(remote.dataset.contact), body: remote.crm_note.value },
      });
    }
    if (!jobs.length) {
      setStatus($("crmMsg"), "請填處理進度、內部備註或 CRM 備註", "err");
      return;
    }
    const results = [];
    for (const body of jobs) {
      const { res, data } = await api("/ops/api/site-commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setStatus($("crmMsg"), data.error || "遠端客服命令失敗", "err");
        return;
      }
      const applied = data.job?.apply_state === "applied";
      results.push(applied ? "本站已套用" : `尚未套用（${data.reason || data.job?.job_state || "pending"}）`);
    }
    setStatus($("crmMsg"), results.join(" · "), results.every((x) => x.includes("已套用")) ? "ok" : "err");
    return;
  }
  const form = ev.target.closest(".crm-note-form");
  if (!form) return;
  ev.preventDefault();
  const body = form.body?.value || "";
  const { res, data } = await api("/ops/api/crm/notes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      product_id: form.dataset.product,
      subject_kind: "contact",
      subject_key: form.dataset.subject,
      body,
    }),
  });
  if (!res.ok) {
    setStatus($("crmMsg"), data.error || "備註儲存失敗", "err");
    return;
  }
  await refreshCrm();
});
$("inboxRefresh").addEventListener("click", refreshInbox);
$("issuesRefresh").addEventListener("click", refreshIssues);
$("devRefresh").addEventListener("click", refreshDev);
$("queueBox")?.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-iid][data-gate]");
  if (!btn) return;
  openOwnerQueueItem(btn.dataset.iid, btn.dataset.gate);
});
$("devRerunQa")?.addEventListener("click", () => {
  if (!devOpen.taskId) return;
  showConfirm({
    title: "確認重跑獨立 QA",
    body: `重跑製作任務 #${devOpen.taskId} 的獨立 QA？不會 merge，也不會部署正式站。`,
    confirmLabel: "確定重跑",
    danger: false,
    onConfirm: async () => {
      const { res, data } = await api(`/ops/api/coding-tasks/${devOpen.taskId}/qa/rerun`, { method: "POST" });
      setStatus($("devDetailMsg"), res.ok ? "已要求重跑獨立 QA" : (data.error || "重跑失敗"), res.ok ? "ok" : "err");
      if (res.ok) await openCodingTask(devOpen.taskId);
    },
  });
});
$("devCancelQa")?.addEventListener("click", () => {
  if (!devOpen.qaRunId) return;
  showConfirm({
    title: "確認取消獨立 QA",
    body: `取消獨立 QA #${devOpen.qaRunId}？不會 merge，也不會部署正式站。已在跑的檢查不宣稱撤回；已完成的結果不會被這一步改寫。`,
    confirmLabel: "確定取消 QA",
    onConfirm: async () => {
      const { res, data } = await api(`/ops/api/qa-runs/${devOpen.qaRunId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "owner_console" }),
      });
      const extra = data.in_flight_not_withdrawn ? "已在跑的檢查不宣稱撤回。" : "";
      setStatus($("devDetailMsg"), res.ok ? `已取消獨立 QA。${extra}` : (data.error || "取消失敗"), res.ok ? "ok" : "err");
      if (res.ok && devOpen.taskId) await openCodingTask(devOpen.taskId);
    },
  });
});
$("productsRefresh").addEventListener("click", refreshProducts);
$("exitDetailBody")?.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-cancel-cmd]");
  if (!btn) return;
  const jobId = Number(btn.dataset.cancelCmd);
  const pid = btn.dataset.pid || "";
  const sending = btn.dataset.cmdState === "sending";
  if (!jobId) return;
  showConfirm({
    title: "確認取消遠端客服",
    body: `取消這筆尚未套用的遠端客服 #${jobId}？不會假裝本站已回覆。${sending ? "已在外送的呼叫不宣稱撤回。" : "未送出的命令不會再外送。"}`,
    confirmLabel: "確定取消命令",
    onConfirm: async () => {
      const { res, data } = await api(`/ops/api/site-commands/${jobId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "owner_console" }),
      });
      const extra = data.in_flight_not_withdrawn ? "已在外送的呼叫不宣稱撤回。" : "";
      setStatus($("productMsg"), res.ok ? `已取消遠端客服。${extra}` : (data.error || "取消失敗"), res.ok ? "ok" : "err");
      if (res.ok && pid) await loadPending(pid);
    },
  });
});
$("devTable").addEventListener("click", (ev) => {
  if (ev.target.closest("a")) return;
  const tr = ev.target.closest("tr[data-tid]");
  if (tr) openCodingTask(tr.dataset.tid);
});
$("devTable").addEventListener("keydown", (ev) => {
  if (ev.target.closest("a")) return;
  if (ev.key !== "Enter" && ev.key !== " ") return;
  const tr = ev.target.closest("tr[data-tid]");
  if (!tr) return;
  ev.preventDefault();
  openCodingTask(tr.dataset.tid);
});
$("devCancelTask").addEventListener("click", () => {
  if (!devOpen.taskId) return;
  showConfirm({
    title: "確認取消製作任務",
    body: `取消製作任務 #${devOpen.taskId}？不會部署、也不會動正式站。`,
    confirmLabel: "確定取消任務",
    onConfirm: async () => {
      const { res, data } = await api(`/ops/api/coding-tasks/${devOpen.taskId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "owner_console" }),
      });
      setStatus($("devDetailMsg"), res.ok ? "已取消製作任務" : (data.error || "取消失敗"), res.ok ? "ok" : "err");
      await refreshDev();
      if (res.ok) await openCodingTask(devOpen.taskId);
    },
  });
});
$("devRedeploy").addEventListener("click", () => {
  if (!devOpen.taskId) return;
  showConfirm({
    title: "確認重佈隔離 staging",
    body: `重佈製作任務 #${devOpen.taskId} 的隔離 staging？只動測試容器，正式站無感。`,
    confirmLabel: "確定重佈",
    danger: false,
    onConfirm: async () => {
      const { res, data } = await api(`/ops/api/coding-tasks/${devOpen.taskId}/staging/redeploy`, { method: "POST" });
      setStatus($("devDetailMsg"), res.ok ? "已要求重佈隔離 staging" : (data.error || "重佈失敗"), res.ok ? "ok" : "err");
      if (res.ok) await openCodingTask(devOpen.taskId);
    },
  });
});
$("devCancelStg").addEventListener("click", () => {
  if (!devOpen.stagingId) return;
  showConfirm({
    title: "確認取消隔離 staging",
    body: `取消 staging #${devOpen.stagingId}？只影響測試容器，正式站無感。`,
    confirmLabel: "確定取消 staging",
    onConfirm: async () => {
      const { res, data } = await api(`/ops/api/staging-deployments/${devOpen.stagingId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "owner_console" }),
      });
      setStatus($("devDetailMsg"), res.ok ? "已取消隔離 staging" : (data.error || "取消失敗"), res.ok ? "ok" : "err");
      if (res.ok) await openCodingTask(devOpen.taskId);
    },
  });
});
$("devCleanupStg").addEventListener("click", () => {
  if (!devOpen.stagingId) return;
  showConfirm({
    title: "確認停止測試容器",
    body: `停止並清理 staging #${devOpen.stagingId} 的測試容器？這是反悔隔離環境的方式，正式站不會被碰到。`,
    confirmLabel: "確定停止容器",
    onConfirm: async () => {
      const { res, data } = await api(`/ops/api/staging-deployments/${devOpen.stagingId}/cleanup`, { method: "POST" });
      setStatus($("devDetailMsg"), res.ok ? "已要求停止測試容器" : (data.error || "清理失敗"), res.ok ? "ok" : "err");
      if (res.ok) await openCodingTask(devOpen.taskId);
    },
  });
});
$("gate2Row").addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-gate2]");
  if (!btn || !devOpen.taskId || !devOpen.release) return;
  const action = btn.dataset.gate2;
  const rel = devOpen.release;
  const labels = {
    APPROVE_RELEASE: "核准發布授權（不會部署正式機）",
    REQUEST_CHANGES: "要求修改發行候選",
    CANCEL_RELEASE: "取消發行候選",
  };
  showConfirm({
    title: "確認 Gate #2",
    body: `${labels[action] || action}。manifest #${rel.manifest_id} v${rel.manifest_version}。這一步不會 Deploy v3／Deploy OPS。`,
    confirmLabel: action === "APPROVE_RELEASE" ? "確定寫入授權" : "確定",
    danger: action !== "APPROVE_RELEASE",
    reasonRequired: action === "REQUEST_CHANGES",
    reasonLabel: "請說明要改什麼（會寫進決策紀錄）",
    onConfirm: async (note) => {
      const { res, data } = await api(`/ops/api/coding-tasks/${devOpen.taskId}/release/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          manifest_id: rel.manifest_id,
          manifest_version: rel.manifest_version,
          manifest_hash: rel.manifest_hash,
          artifact_digest: rel.artifact_digest,
          head_sha: rel.head_sha,
          reason: note || (action === "REQUEST_CHANGES" ? "" : "owner_console"),
        }),
      });
      setStatus($("devDetailMsg"), res.ok ? "Gate #2 已送出" : (data.error || "決策失敗"), res.ok ? "ok" : "err");
      if (res.ok) await openCodingTask(devOpen.taskId);
    },
  });
});
$("showContact").addEventListener("change", refreshInbox);
$("createProductForm").addEventListener("submit", createProduct);

$("productSwitch").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-product]");
  if (!btn) return;
  selectedProductId = btn.dataset.product || "";
  renderProductSwitcher();
  await Promise.all([refreshDashboard(), refreshInbox(), refreshCrm(), refreshIssues(), refreshDev()]);
  if (devOpen.taskId && !(devCache.items || []).some((t) => Number(t.id) === Number(devOpen.taskId))) {
    closeDevDetail();
  }
});

$("productCards").addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-pact]");
  if (!btn || btn.disabled) return;
  requestProductAction(btn.dataset.pid, btn.dataset.pact);
});

$("copySecretBtn").addEventListener("click", async () => {
  const text = $("secretOnceText").textContent || "";
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    setStatus($("productMsg"), "密鑰已複製", "ok");
  } catch {
    setStatus($("productMsg"), "無法自動複製，請手動選取", "err");
  }
});
$("dismissSecretBtn").addEventListener("click", hideSecret);

$("confirmCancel").addEventListener("click", hideConfirm);
$("confirmOk").addEventListener("click", async () => {
  const note = ($("confirmReason")?.value || "").trim();
  if (confirmNeedsReason && !note) {
    if ($("confirmReasonErr")) {
      $("confirmReasonErr").hidden = false;
      $("confirmReasonErr").textContent = "請先寫說明再送出";
      $("confirmReasonErr").className = "msg err";
    }
    $("confirmReason")?.focus();
    return;
  }
  const fn = confirmAction;
  hideConfirm();
  if (fn) await fn(note);
});
document.addEventListener("keydown", (ev) => {
  if ($("confirmDlg").hidden) return;
  if (ev.key === "Escape") {
    ev.preventDefault();
    hideConfirm();
    return;
  }
  trapConfirmTab(ev);
});

$("inboxTable").addEventListener("click", (ev) => {
  const tr = ev.target.closest("tr[data-fid]");
  if (tr) openFeedback(tr.dataset.fid);
});
$("issueTable").addEventListener("click", (ev) => {
  const tr = ev.target.closest("tr[data-iid]");
  if (tr) openIssue(tr.dataset.iid);
});
$("gate1Row").addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-gate1]");
  if (btn) decideGate1(btn.dataset.gate1);
});
$("issueFollowUp")?.addEventListener("click", () => {
  if (!selectedIssueId) return;
  showConfirm({
    title: "確認建立後續開發",
    body: `從已發布議題 #${selectedIssueId} 另開一張後續議題。不會重用已發布的開發執行或授權，正式站無感。`,
    confirmLabel: "確定建立後續",
    danger: false,
    reasonRequired: true,
    reasonLabel: "後續要做什麼",
    onConfirm: async (note) => {
      const { res, data } = await api(`/ops/api/issues/${selectedIssueId}/follow-up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: note }),
      });
      setStatus($("issueMsg"), res.ok ? `已建立後續議題 #${data.issue_id}` : (data.error || "建立失敗"), res.ok ? "ok" : "err");
      if (res.ok && data.issue_id) await openIssue(data.issue_id);
    },
  });
});

$("webhookTestBtn").addEventListener("click", async () => {
  const { res, data } = await api("/ops/api/notify/test", { method: "POST" });
  $("dashMsg").textContent = res.ok ? "測試通知已送出" : (data.error || data.reason || "webhook 未設定或送出失敗");
  $("dashMsg").className = res.ok ? "msg ok" : "msg err";
});

$("verifyBtn").addEventListener("click", async () => {
  const { data } = await api("/ops/api/audit/verify");
  $("verifyBox").textContent = data.ok
    ? `鏈完整 ✓  共 ${data.count} 筆  head=${String(data.head || "").slice(0, 16)}`
    : `鏈異常 ✗  在 #${data.brokenAt}（${data.reason}）`;
});

$("checkpointBtn").addEventListener("click", async () => {
  const { res, data } = await api("/ops/api/audit/checkpoint", { method: "POST" });
  if (res.ok && data.checkpoint) {
    $("verifyBox").textContent = `已建立 checkpoint #${data.checkpoint.id}（涵蓋 ${data.checkpoint.fromId}–${data.checkpoint.toId}）`;
    await refreshAudit();
  }
});

init();
