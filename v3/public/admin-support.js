(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  function money(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    return "NT$ " + Math.round(v).toLocaleString("zh-Hant-TW");
  }

  async function readApi(res) {
    return res.json().catch(() => ({}));
  }

  function setMsg(id, text, ok) {
    const el = $(id);
    if (!el) return;
    el.textContent = text || "";
    el.style.color = ok ? "var(--accent-deep)" : "var(--rose, #b08989)";
  }

  function showTab(name) {
    document.querySelectorAll("[data-support-panel]").forEach((el) => {
      el.hidden = el.dataset.supportPanel !== name;
    });
    document.querySelectorAll("[data-support-tab]").forEach((btn) => {
      btn.setAttribute("aria-selected", btn.dataset.supportTab === name ? "true" : "false");
    });
  }

  async function loadDashboard(period) {
    const res = await fetch(`/api/admin/support/dashboard?period=${encodeURIComponent(period || "month")}`, { cache: "no-store" });
    const data = await readApi(res);
    const t = data.totals || {};
    const box = $("supportDashCards");
    if (!box) return;
    box.innerHTML = [
      ["本月維運成本", money(data.operating_cost)],
      ["收到支持", money(t.net || t.gross)],
      ["支持覆蓋", data.coverage?.coverageLabel || "—"],
      ["支持筆數", t.count ?? 0],
      ["平均支持", money(t.average)],
      ["手續費", money(t.fee)],
      ["支持人數", t.people ?? 0],
      ["匿名支持", t.anonymous ?? 0],
      ["企業贊助", money(t.corporate)],
      ["個人支持", money(t.personal)],
    ].map(([k, v]) => `<div class="support-metric"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join("");
    const funnel = data.funnel || {};
    $("supportFunnel").innerHTML = `
      <p>CTA 顯示 ${funnel.cta_shown || 0}　CTA 點擊 ${funnel.cta_clicked || 0}　Support page ${funnel.page_viewed || 0}　Checkout ${funnel.checkout_opened || 0}　Completed ${funnel.completed_available ? funnel.completed : "data unavailable"}</p>
      ${funnel.completed_available ? "" : `<p class="hint">${esc(funnel.completed_note || "Completed data unavailable")}</p>`}
    `;
    const max = Math.max(1, ...(data.daily || []).map((row) => Number(row.amount) || 0));
    $("supportBars").innerHTML = (data.daily || []).slice(-14).map((row) => {
      const h = Math.round(((Number(row.amount) || 0) / max) * 64);
      return `<div class="support-bar" title="${esc(row.date)} ${esc(money(row.amount))}"><i style="height:${h}px"></i></div>`;
    }).join("");
  }

  function fillConfig(cfg) {
    const flags = cfg.flags || {};
    $("supportFlagEnabled").checked = flags.enabled === true;
    $("supportFlagCta").checked = flags.cta_enabled === true;
    $("supportFlagSponsor").checked = flags.sponsor_enabled === true;
    $("supportFlagCost").checked = flags.public_cost_enabled === true;
    const draft = cfg.draft || {};
    const copy = draft.copy || {};
    $("supportHeroTitle").value = copy.hero_title || "";
    $("supportHeroDesc").value = copy.hero_description || "";
    $("supportFreeStatement").value = copy.free_statement || "";
    $("supportCostTitle").value = copy.cost_section_title || "";
    $("supportSectionTitle").value = copy.support_section_title || "";
    $("supportFooterNote").value = copy.footer_note || "";
    $("supportShowGoal").checked = draft.show_goal !== false;
    $("supportShowCost").checked = draft.show_cost !== false;
    $("supportShowSupporters").checked = draft.show_supporters !== false;
    $("supportShowSponsors").checked = draft.show_sponsors !== false;
    $("supportGoalAmount").value = cfg.goal_amount || "";
    $("supportGoalLabel").value = cfg.goal_label || "";
    $("supportGoalDisplay").value = cfg.goal_display || "exact";
    $("supportWallEnabled").checked = cfg.wall_enabled === true;
  }

  async function loadConfig() {
    const res = await fetch("/api/admin/support/config", { cache: "no-store" });
    fillConfig(await readApi(res));
  }

  function configBody() {
    return {
      flags: {
        enabled: $("supportFlagEnabled").checked,
        cta_enabled: $("supportFlagCta").checked,
        sponsor_enabled: $("supportFlagSponsor").checked,
        public_cost_enabled: $("supportFlagCost").checked,
      },
      draft: {
        copy: {
          hero_title: $("supportHeroTitle").value,
          hero_description: $("supportHeroDesc").value,
          free_statement: $("supportFreeStatement").value,
          cost_section_title: $("supportCostTitle").value,
          support_section_title: $("supportSectionTitle").value,
          footer_note: $("supportFooterNote").value,
        },
        show_goal: $("supportShowGoal").checked,
        show_cost: $("supportShowCost").checked,
        show_supporters: $("supportShowSupporters").checked,
        show_sponsors: $("supportShowSponsors").checked,
      },
      goal_amount: Number($("supportGoalAmount").value) || 0,
      goal_label: $("supportGoalLabel").value,
      goal_display: $("supportGoalDisplay").value,
      wall_enabled: $("supportWallEnabled").checked,
    };
  }

  async function loadCosts() {
    const res = await fetch("/api/admin/support/costs", { cache: "no-store" });
    const data = await readApi(res);
    $("supportCostRows").innerHTML = (data.items || []).map((row) => `
      <tr>
        <td>${esc(row.name)}<div class="hint">${esc(row.category)}</div></td>
        <td>${esc(money(row.amount))}／${esc(row.billing_cycle)}<div class="hint">月計 ${esc(money(row.monthly_amount))}</div></td>
        <td>${row.is_public ? "公開" : "內部"}</td>
        <td><button type="button" class="ghost" data-cost-edit="${row.id}">編輯</button></td>
      </tr>
    `).join("") || `<tr><td colspan="4" class="hint">尚無成本</td></tr>`;
    $("supportCostRows").querySelectorAll("[data-cost-edit]").forEach((btn) => {
      btn.onclick = () => {
        const row = (data.items || []).find((item) => String(item.id) === btn.dataset.costEdit);
        if (!row) return;
        $("supportCostId").value = row.id;
        $("supportCostName").value = row.name;
        $("supportCostCategory").value = row.category;
        $("supportCostAmount").value = row.amount;
        $("supportCostCycle").value = row.billing_cycle;
        $("supportCostPublic").checked = row.is_public;
        $("supportCostNote").value = row.note || "";
      };
    });
  }

  async function loadTiers() {
    const res = await fetch("/api/admin/support/tiers", { cache: "no-store" });
    const data = await readApi(res);
    $("supportTierRows").innerHTML = (data.items || []).map((row) => `
      <tr>
        <td>${esc(row.icon)} ${esc(row.title)}</td>
        <td>${row.amount > 0 ? esc(money(row.amount)) : "自訂"}</td>
        <td>${row.is_active ? "啟用" : "停用"} ${row.is_default ? "· 預設" : ""}</td>
        <td><button type="button" class="ghost" data-tier-edit="${row.id}">編輯</button></td>
      </tr>
    `).join("");
    $("supportTierRows").querySelectorAll("[data-tier-edit]").forEach((btn) => {
      btn.onclick = () => {
        const row = (data.items || []).find((item) => String(item.id) === btn.dataset.tierEdit);
        if (!row) return;
        $("supportTierId").value = row.id;
        $("supportTierTitle").value = row.title;
        $("supportTierDesc").value = row.description;
        $("supportTierAmount").value = row.amount;
        $("supportTierIcon").value = row.icon;
        $("supportTierOrder").value = row.sort_order;
        $("supportTierActive").checked = row.is_active;
        $("supportTierDefault").checked = row.is_default;
      };
    });
  }

  async function loadProviders() {
    const res = await fetch("/api/admin/support/providers", { cache: "no-store" });
    const data = await readApi(res);
    $("supportProviderRows").innerHTML = (data.items || []).map((row) => `
      <article class="support-provider">
        <h3>${esc(row.display_name)} <small>${esc(row.kind)}</small></h3>
        <label>顯示名稱<input data-prov-name="${row.id}" value="${esc(row.display_name)}" /></label>
        <label>Checkout URL<input data-prov-url="${row.id}" value="${esc(row.page_url)}" placeholder="https://" /></label>
        <label class="checks"><input type="checkbox" data-prov-active="${row.id}" ${row.is_active ? "checked" : ""} /> 啟用</label>
        <label class="checks"><input type="checkbox" data-prov-default="${row.id}" ${row.is_default ? "checked" : ""} /> 預設</label>
        <button type="button" class="primary" data-prov-save="${row.id}">儲存收款設定</button>
      </article>
    `).join("");
    $("supportProviderRows").querySelectorAll("[data-prov-save]").forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.provSave;
        const res2 = await fetch(`/api/admin/support/providers/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            display_name: document.querySelector(`[data-prov-name="${id}"]`).value,
            page_url: document.querySelector(`[data-prov-url="${id}"]`).value,
            is_active: document.querySelector(`[data-prov-active="${id}"]`).checked,
            is_default: document.querySelector(`[data-prov-default="${id}"]`).checked,
          }),
        });
        const data2 = await readApi(res2);
        setMsg("supportProviderMsg", res2.ok ? "已儲存收款設定" : (data2.error || "儲存失敗"), res2.ok);
        if (res2.ok) loadProviders();
      };
    });
  }

  async function loadTransactions() {
    const res = await fetch("/api/admin/support/transactions", { cache: "no-store" });
    const data = await readApi(res);
    $("supportTxRows").innerHTML = (data.items || []).map((row) => `
      <tr>
        <td>${esc(row.received_at).slice(0, 10)}</td>
        <td>${esc(row.provider)}</td>
        <td>${esc(money(row.amount))}／手續費 ${esc(money(row.fee))}</td>
        <td>${esc(row.status)} ${row.anonymous ? "匿名" : esc(row.supporter_name)}</td>
      </tr>
    `).join("") || `<tr><td colspan="4" class="hint">尚無紀錄</td></tr>`;
  }

  async function loadSponsors() {
    const res = await fetch("/api/admin/support/sponsors", { cache: "no-store" });
    const data = await readApi(res);
    $("supportSponsorRows").innerHTML = (data.items || []).map((row) => `
      <tr>
        <td>${esc(row.name)} <span class="hint">${esc(row.disclosure_text)}</span></td>
        <td>${esc(row.status)}／${esc(row.resolved_status)}</td>
        <td><button type="button" class="ghost" data-sp-edit="${row.id}">編輯</button></td>
      </tr>
    `).join("") || `<tr><td colspan="3" class="hint">尚無企業贊助</td></tr>`;
    $("supportSponsorRows").querySelectorAll("[data-sp-edit]").forEach((btn) => {
      btn.onclick = () => {
        const row = (data.items || []).find((item) => String(item.id) === btn.dataset.spEdit);
        if (!row) return;
        $("supportSpId").value = row.id;
        $("supportSpName").value = row.name;
        $("supportSpUrl").value = row.website_url;
        $("supportSpDesc").value = row.description;
        $("supportSpStatus").value = row.status;
        $("supportSpStart").value = (row.start_at || "").slice(0, 10);
        $("supportSpEnd").value = (row.end_at || "").slice(0, 10);
      };
    });
  }

  async function loadRules() {
    const res = await fetch("/api/admin/support/cta-rules", { cache: "no-store" });
    const data = await readApi(res);
    $("supportRuleRows").innerHTML = (data.items || []).map((row) => `
      <tr>
        <td>${esc(row.rule_type)} ≥ ${esc(row.threshold)}</td>
        <td>${esc(row.message)}</td>
        <td>${row.enabled ? "開" : "關"}／${esc(row.cooldown_days)} 日</td>
        <td>
          <button type="button" class="ghost" data-rule-toggle="${row.id}" data-on="${row.enabled ? "1" : "0"}">${row.enabled ? "停用" : "啟用"}</button>
        </td>
      </tr>
    `).join("");
    $("supportRuleRows").querySelectorAll("[data-rule-toggle]").forEach((btn) => {
      btn.onclick = async () => {
        await fetch(`/api/admin/support/cta-rules/${btn.dataset.ruleToggle}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: btn.dataset.on !== "1" }),
        });
        loadRules();
      };
    });
  }

  async function loadAudit() {
    const res = await fetch("/api/admin/audit?limit=80", { cache: "no-store" });
    const data = await readApi(res);
    const items = (data.items || data || []).filter((row) => String(row.action || "").startsWith("support."));
    $("supportAuditRows").innerHTML = items.slice(0, 30).map((row) => `
      <tr>
        <td>${esc(row.at)}</td>
        <td>${esc(row.actorEmail || row.actor_email || "")}</td>
        <td>${esc(row.action)}</td>
        <td>${esc(row.target)}</td>
      </tr>
    `).join("") || `<tr><td colspan="4" class="hint">尚無支持稽核</td></tr>`;
  }

  function bind() {
    if (!$("supportAdminRoot")) return;
    document.querySelectorAll("[data-support-tab]").forEach((btn) => {
      btn.addEventListener("click", () => showTab(btn.dataset.supportTab));
    });
    $("supportPeriod")?.addEventListener("change", () => loadDashboard($("supportPeriod").value));
    $("supportConfigSaveBtn")?.addEventListener("click", async () => {
      const res = await fetch("/api/admin/support/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(configBody()),
      });
      const data = await readApi(res);
      setMsg("supportCmsMsg", res.ok ? "已存草稿" : (data.error || "儲存失敗"), res.ok);
    });
    $("supportConfigPublishBtn")?.addEventListener("click", async () => {
      await fetch("/api/admin/support/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(configBody()),
      });
      const res = await fetch("/api/admin/support/config/publish", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const data = await readApi(res);
      setMsg("supportCmsMsg", res.ok ? "已發布前台文案" : (data.error || "發布失敗"), res.ok);
    });
    $("supportCostForm")?.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const id = $("supportCostId").value;
      const body = {
        name: $("supportCostName").value,
        category: $("supportCostCategory").value,
        amount: Number($("supportCostAmount").value) || 0,
        billing_cycle: $("supportCostCycle").value,
        is_public: $("supportCostPublic").checked,
        note: $("supportCostNote").value,
      };
      const res = await fetch(id ? `/api/admin/support/costs/${id}` : "/api/admin/support/costs", {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setMsg("supportCostMsg", res.ok ? "已儲存成本" : "儲存失敗", res.ok);
      if (res.ok) {
        $("supportCostForm").reset();
        $("supportCostId").value = "";
        loadCosts();
      }
    });
    $("supportTierForm")?.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const id = $("supportTierId").value;
      const body = {
        title: $("supportTierTitle").value,
        description: $("supportTierDesc").value,
        amount: Number($("supportTierAmount").value) || 0,
        icon: $("supportTierIcon").value,
        sort_order: Number($("supportTierOrder").value) || 0,
        is_active: $("supportTierActive").checked,
        is_default: $("supportTierDefault").checked,
      };
      const res = await fetch(id ? `/api/admin/support/tiers/${id}` : "/api/admin/support/tiers", {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setMsg("supportTierMsg", res.ok ? "已儲存方案" : "儲存失敗", res.ok);
      if (res.ok) {
        $("supportTierForm").reset();
        $("supportTierId").value = "";
        loadTiers();
      }
    });
    $("supportTxForm")?.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const res = await fetch("/api/admin/support/transactions/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: $("supportTxProvider").value,
          amount: Number($("supportTxAmount").value) || 0,
          fee: Number($("supportTxFee").value) || 0,
          anonymous: $("supportTxAnon").checked,
          supporter_name: $("supportTxName").value,
          received_at: $("supportTxDate").value,
          message: $("supportTxNote").value,
        }),
      });
      setMsg("supportTxMsg", res.ok ? "已新增支持紀錄" : "新增失敗", res.ok);
      if (res.ok) {
        $("supportTxForm").reset();
        $("supportTxAnon").checked = true;
        loadTransactions();
        loadDashboard($("supportPeriod")?.value || "month");
      }
    });
    $("supportSpForm")?.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const id = $("supportSpId").value;
      const body = {
        name: $("supportSpName").value,
        website_url: $("supportSpUrl").value,
        description: $("supportSpDesc").value,
        status: $("supportSpStatus").value,
        start_at: $("supportSpStart").value,
        end_at: $("supportSpEnd").value,
        disclosure_text: "贊助",
      };
      const res = await fetch(id ? `/api/admin/support/sponsors/${id}` : "/api/admin/support/sponsors", {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setMsg("supportSpMsg", res.ok ? "已儲存企業贊助" : "儲存失敗", res.ok);
      if (res.ok) {
        $("supportSpForm").reset();
        $("supportSpId").value = "";
        loadSponsors();
      }
    });
    $("supportPreviewDesk")?.addEventListener("click", () => {
      $("supportPreviewFrame").style.width = "100%";
      $("supportPreviewFrame").src = "/support.html?preview=1";
    });
    $("supportPreviewMobile")?.addEventListener("click", () => {
      $("supportPreviewFrame").style.width = "375px";
      $("supportPreviewFrame").src = "/support.html?preview=1";
    });
  }

  window.loadSupportAdmin = async function loadSupportAdmin() {
    if (!$("supportAdminRoot")) return;
    await Promise.all([
      loadDashboard("month"),
      loadConfig(),
      loadCosts(),
      loadTiers(),
      loadProviders(),
      loadTransactions(),
      loadSponsors(),
      loadRules(),
      loadAudit(),
    ]).catch(() => {});
  };

  document.addEventListener("DOMContentLoaded", bind);
})();
