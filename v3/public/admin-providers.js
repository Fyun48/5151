/**
 * 吉比後台：外掛與預算（`#system/providers`）。
 *
 * 對應 API（皆為管理員專用）：
 *   GET  /api/admin/providers            → { items, logs, site_daily_budget_twd, site_monthly_budget_twd, legal, ... }
 *   PUT  /api/admin/providers            → 單一類別（category／provider_code／is_enabled／每日・每月・單筆預算／金鑰）
 *   POST /api/admin/providers/test       → 測連線（不會真的產生費用；stub 供應商只回 ping）
 *   PUT  /api/admin/providers/site-budget→ 全站每日／每月上限
 *
 * 設計原則：預設全部關閉、關閉時走免費路徑；金鑰只存資料庫（加密）。每一列各自「儲存」，
 * 不使用 AdminIA 的 sticky save（同一頁有多個類別的表單）。
 */
(function adminProviders(global) {
  const $ = (id) => global.document?.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  const money = (n) => {
    const v = Number(n);
    return Number.isFinite(v) ? `NT$ ${Math.round(v).toLocaleString("zh-Hant-TW")}` : "—";
  };
  // 上限欄位的值：保留小數（單筆上限可能是 0.2 這種零錢級數字，用 Math.round 會變成 0，
  // 一按儲存就靜默把上限改成 0）。整數欄位輸出仍會是 "20" 這種乾淨字串。
  const moneyInput = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return "";
    return String(Math.round(v * 100) / 100);
  };

  const API = "/api/admin/providers";

  function setMsg(id, text, ok) {
    const el = $(id);
    if (!el) return;
    el.textContent = text || "";
    el.style.color = ok ? "var(--accent-deep)" : "var(--rose, #b08989)";
  }

  async function readApi(res) {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }

  function fuseLabel(item) {
    if (item.fuse === "tripped") return `<span class="msg err" style="margin:0">今日額度已滿（已停止呼叫）</span>`;
    if (item.fuse === "warn") return `<span class="msg" style="margin:0">今日用量已達 8 成</span>`;
    return "";
  }

  function rowHtml(item) {
    const c = esc(item.category);
    const options = (item.codes || [])
      .map((code) => `<option value="${esc(code)}"${code === item.provider_code ? " selected" : ""}>${esc(code)}</option>`)
      .join("");
    return `
      <div class="provider" data-provider-row="${c}" style="border:1px solid var(--line);border-radius:12px;padding:14px;margin:0 0 12px">
        <h3 style="margin:0 0 4px;font-size:15px">${esc(item.label)} <span class="hint" style="font-weight:400">（${c}）</span></h3>
        <p class="meta hint" style="margin:0 0 10px">
          今日 ${money(item.today_settled_twd)} 已結算／${money(item.today_reserved_twd)} 保留，上限 ${money(item.today_limit_twd)}
          ｜本月已結算 ${money(item.month_settled_twd)}｜金鑰：${item.has_credential ? "已設定" : "未設定"}
          ｜建議每日 ${money(item.suggested_daily_twd)}
        </p>
        <label class="checks"><input type="checkbox" data-field="is_enabled"${item.is_enabled ? " checked" : ""} /> 啟用（未啟用時走免費路徑，不會花費）</label>
        <div class="grid-2" style="margin-top:10px">
          <div>
            <label>供應商</label>
            <select data-field="provider_code">${options}</select>
          </div>
          <div>
            <label>單筆上限（TWD）</label>
            <input type="number" min="0" step="0.1" data-field="ceiling_twd" value="${esc(moneyInput(item.ceiling_twd))}" />
          </div>
          <div>
            <label>每日上限（TWD，0＝不花錢）</label>
            <input type="number" min="0" step="1" data-field="daily_budget_twd" value="${esc(moneyInput(item.daily_budget_twd))}" />
          </div>
          <div>
            <label>每月上限（TWD）</label>
            <input type="number" min="0" step="1" data-field="monthly_budget_twd" value="${esc(moneyInput(item.monthly_budget_twd))}" />
          </div>
        </div>
        <label>API 金鑰／憑證（已設定可留白）</label>
        <input type="password" autocomplete="new-password" data-field="credential" placeholder="${item.has_credential ? "已設定，留白＝不變更" : "尚未設定"}" />
        <div class="row" style="margin:12px 0 0">
          <button type="button" class="primary" data-act="save">儲存這一類</button>
          <button type="button" class="ghost" data-act="test">測試連線</button>
          <button type="button" class="ghost" data-act="clear">刪除金鑰</button>
        </div>
        <p class="msg" data-field="msg"></p>
      </div>`;
  }


  function renderLogs(logs) {
    const box = $("providersLogs");
    if (!box) return;
    const rows = (logs || []).slice(0, 50);
    if (!rows.length) {
      box.innerHTML = `<p class="hint">目前沒有任何付費呼叫紀錄（全部類別關閉時就是這個狀態）。</p>`;
      return;
    }
    const head = ["時間", "類別", "事件", "狀態", "金額"]
      .map((h) => `<th style="text-align:left;border-bottom:1px solid var(--line);padding:6px 4px">${h}</th>`)
      .join("");
    const body = rows.map((r) => `<tr>
        <td style="padding:6px 4px">${esc(r.created_at || "")}</td>
        <td style="padding:6px 4px">${esc(r.category_label || r.category || "")}</td>
        <td style="padding:6px 4px">${esc(r.event_label || r.event_kind || "")}</td>
        <td style="padding:6px 4px">${esc(r.state_label || "—")}</td>
        <td style="padding:6px 4px">${r.amount_twd == null ? "—" : esc(money(r.amount_twd))}</td>
      </tr>`).join("");
    box.innerHTML = `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function render(payload) {
    const grid = $("providersGrid");
    const items = payload?.items || [];
    if (grid) {
      grid.innerHTML = items.length
        ? items.map(rowHtml).join("")
        : `<p class="hint">沒有可設定的類別。</p>`;
    }
    if ($("siteDailyTwd")) $("siteDailyTwd").value = moneyInput(payload?.site_daily_budget_twd);
    if ($("siteMonthlyTwd")) $("siteMonthlyTwd").value = moneyInput(payload?.site_monthly_budget_twd);
    const note = $("providersMsg");
    if (note) {
      const parts = [];
      if (payload?.legal) parts.push(`<span class="hint">${esc(payload.legal)}</span>`);
      items.forEach((item) => { const f = fuseLabel(item); if (f) parts.push(f); });
      note.innerHTML = parts.join("　");
    }
    renderLogs(payload?.logs);
  }

  function rowPayload(row) {
    const read = (field) => row.querySelector(`[data-field="${field}"]`);
    return {
      category: row.dataset.providerRow,
      provider_code: read("provider_code")?.value || "none",
      is_enabled: read("is_enabled")?.checked === true,
      ceiling_twd: Number(read("ceiling_twd")?.value || 0),
      daily_budget_twd: Number(read("daily_budget_twd")?.value || 0),
      monthly_budget_twd: Number(read("monthly_budget_twd")?.value || 0),
      credential: String(read("credential")?.value || "").trim(),
    };
  }

  async function saveRow(row, { clearCredential = false } = {}) {
    const payload = rowPayload(row);
    if (clearCredential) payload.clear_credential = true;
    const res = await fetch(API, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await readApi(res);
    render(data.overview || data);
    setMsg("providersMsg", `${payload.category}：已儲存 ✓`, true);
    return data;
  }

  async function testRow(row) {
    const res = await fetch(`${API}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: row.dataset.providerRow }),
    });
    return readApi(res);
  }

  function wireGrid() {
    const grid = $("providersGrid");
    if (!grid || grid.dataset.wired === "1") return;
    grid.dataset.wired = "1";
    grid.addEventListener("click", async (event) => {
      const btn = event.target.closest("button[data-act]");
      if (!btn) return;
      const row = btn.closest("[data-provider-row]");
      if (!row) return;
      const category = row.dataset.providerRow;
      btn.disabled = true;
      try {
        if (btn.dataset.act === "save") {
          await saveRow(row);
        } else if (btn.dataset.act === "test") {
          const out = await testRow(row);
          setMsg("providersMsg", `${category}：測試 ${JSON.stringify(out.result ?? out.ok ?? out)}`, out.ok !== false);
        } else if (btn.dataset.act === "clear") {
          if (!global.confirm(`要刪除「${category}」已存的金鑰嗎？刪除後該類別回到未設定狀態（不會自動停用）。`)) return;
          await saveRow(row, { clearCredential: true });
        }
      } catch (error) {
        setMsg("providersMsg", `${category}：${String(error?.message || error)}`, false);
      } finally {
        btn.disabled = false;
      }
    });
  }

  function wireBudgetForm() {
    const form = $("providersBudgetForm");
    if (!form || form.dataset.wired === "1") return;
    form.dataset.wired = "1";
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const btn = $("providersBudgetSave");
      if (btn) btn.disabled = true;
      try {
        const res = await fetch(`${API}/site-budget`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            site_daily_budget_twd: Number($("siteDailyTwd")?.value || 0),
            site_monthly_budget_twd: Number($("siteMonthlyTwd")?.value || 0),
          }),
        });
        const data = await readApi(res);
        render(data.overview || data);
        setMsg("providersBudgetMsg", "全站預算已儲存 ✓", true);
      } catch (error) {
        setMsg("providersBudgetMsg", String(error?.message || error), false);
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  async function load() {
    wireGrid();
    wireBudgetForm();
    try {
      const res = await fetch(API, { cache: "no-store" });
      const data = await readApi(res);
      render(data);
      return data;
    } catch (error) {
      setMsg("providersMsg", `讀取外掛設定失敗：${String(error?.message || error)}`, false);
      return null;
    }
  }

  global.AdminProviders = { load, render, saveRow };
  if (global.document) {
    const boot = () => { wireGrid(); wireBudgetForm(); };
    if (global.document.readyState === "loading") {
      global.document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  }
})(typeof window !== "undefined" ? window : globalThis);

