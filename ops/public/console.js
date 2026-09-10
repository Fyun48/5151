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
  processing: "執行中",
  claimed: "已領取",
  running: "執行中",
  changes_ready: "變更待收",
  failed_retry: "失敗可重試",
  completed: "已完成",
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
  coding: "製作任務",
  release_notification: "發布通知",
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
  if (status === "active" || status === "connected") return "ok";
  if (status === "exited") return "danger";
  if (status === "paused" || status === "exiting" || status === "reconnecting" || status === "connecting") return "warn";
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
  $("secretOnceHint").textContent = `${context}：此密鑰只顯示一次，請立刻複製到該站 OPS_INGEST_SECRET。`;
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
    return;
  }
  dlg.hidden = true;
  confirmAction = null;
  for (const el of confirmChrome()) el.inert = false;
  const back = confirmReturnFocus;
  confirmReturnFocus = null;
  if (back && typeof back.focus === "function") back.focus();
}

function showConfirm({ title, body, confirmLabel, onConfirm, danger = true }) {
  confirmReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $("confirmTitle").textContent = title;
  $("confirmBody").textContent = body;
  $("confirmOk").textContent = confirmLabel || "確定";
  $("confirmOk").classList.toggle("danger", danger !== false);
  confirmAction = onConfirm;
  $("confirmDlg").hidden = false;
  for (const el of confirmChrome()) el.inert = true;
  $("confirmCancel").focus();
}

function trapConfirmTab(ev) {
  if (ev.key !== "Tab" || $("confirmDlg").hidden) return;
  const cancel = $("confirmCancel");
  const ok = $("confirmOk");
  if (!cancel || !ok) return;
  if (ev.shiftKey && document.activeElement === cancel) {
    ev.preventDefault();
    ok.focus();
  } else if (!ev.shiftKey && document.activeElement === ok) {
    ev.preventDefault();
    cancel.focus();
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
      <p class="hint">授權：回饋複製 ${caps.feedback_copy ? "開" : "關"} · CRM 同步 ${caps.crm_sync ? "開" : "關"} · 跨站分析 ${caps.cross_site_insight ? "開" : "關"}</p>
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
  for (const it of items) {
    lines.push(`- ${PENDING_KIND_LABEL[it.kind] || it.kind} #${it.id} ${STATUS_LABEL[it.state] || it.state}${it.blocking ? "（阻擋）" : ""}${it.unscoped ? "（尚未分站）" : ""} ${it.note || ""}`);
  }
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
  $("exitDetailBody").textContent = lines.join("\n");
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
    setStatus($("productMsg"), patch.crm_sync ? "已允許 CRM 同步" : "已撤回 CRM 同步", "ok");
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
      body: `確定解除「${name}」（${id}）的訂閱？此站將停止傳送，現有密鑰立即失效。產品卡會留下摘要，之後可重新連接。`,
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
      body: `移交「${name}」（${id}）會匯出可驗證交接包。不含金鑰與其它站資料。本機主本仍在對方站。`,
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
  if (action === "purge-replica") {
    showConfirm({
      title: "確認刪除 OPS 複本",
      body: `確定清除「${name}」（${id}）在 OPS 的回饋複本內容？本機主本不會動。這不是暫停，也不能靠這一步還原複本。`,
      confirmLabel: "確定清除",
      onConfirm: () => runProductAction(id, "purge-replica"),
    });
    return;
  }
  runProductAction(id, action);
}

async function refreshDashboard() {
  const { res, data } = await api(`/ops/api/dashboard${productQuery("?")}`);
  if (!res.ok) {
    $("dashMsg").textContent = data.error || "無法讀取總覽";
    $("dashMsg").className = "msg err";
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
  $("dashMsg").textContent = `Phase ${data.phase} · ${scope} · ${hook}`;
  $("dashMsg").className = "msg";

  const issues = await api("/ops/api/issues?limit=80");
  const waiting = (issues.data.items || []).filter((it) =>
    it.lifecycle_state === "WAITING_OWNER_APPROVAL" || it.lifecycle_state === "WAITING_RELEASE_APPROVAL");
  $("queueBox").innerHTML = waiting.length
    ? waiting.map((it) => `#${it.id} ${esc(it.title || "（無標題）")} · ${esc(it.lifecycle_state)} · 評估 ${esc(it.evaluation || "—")}`).join("\n")
    : "目前沒有等待 Owner 核准的項目。";
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
  const lines = [
    issue.data.issue?.title || "",
    issue.data.issue?.summary || "",
    `成員 ${members.length} 筆回饋`,
    cur ? `提案 v${cur.proposal_version} · ${cur.title || ""}` : "尚無提案",
    cur?.problem_statement || "",
    cur?.proposed_change || "",
  ].filter(Boolean);
  $("issueDetail").textContent = lines.join("\n\n");
  $("gate1Row").hidden = !cur || proposal.data.current_decision;
  $("gate1Row").dataset.proposal = cur ? JSON.stringify({
    proposal_id: cur.id,
    proposal_version: cur.proposal_version,
    proposal_hash: cur.proposal_hash,
  }) : "";
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

async function refreshAll() {
  await Promise.all([
    refreshProducts(),
    refreshDashboard(),
    refreshInbox(),
    refreshCrm(),
    refreshIssues(),
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
  btn.addEventListener("click", () => setTab(btn.dataset.tab));
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
$("productsRefresh").addEventListener("click", refreshProducts);
$("showContact").addEventListener("change", refreshInbox);
$("createProductForm").addEventListener("submit", createProduct);

$("productSwitch").addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-product]");
  if (!btn) return;
  selectedProductId = btn.dataset.product || "";
  renderProductSwitcher();
  await Promise.all([refreshDashboard(), refreshInbox(), refreshCrm()]);
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
  const fn = confirmAction;
  hideConfirm();
  if (fn) await fn();
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
