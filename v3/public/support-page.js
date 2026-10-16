(function () {
  const preview = /(?:\?|&)preview=1(?:&|$)/.test(location.search);
  const rootPath = preview ? "/api/admin/support/preview" : "/api/support/public";

  function $(id) {
    return document.getElementById(id);
  }

  function text(el, value) {
    if (el) el.textContent = value == null ? "" : String(value);
  }

  function money(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "—";
    return "NT$ " + Math.round(v).toLocaleString("zh-Hant-TW");
  }

  // 「自訂支持」的金額範圍，與後端 v3/src/supportDomain.js 的 SUPPORT_AMOUNT_MIN／MAX、
  // SUPPORT_AMOUNT_MESSAGE 保持一致（support-ui.test.js 會斷言兩邊一致）。
  const AMOUNT_MIN = 10;
  const AMOUNT_MAX = 100000;
  const AMOUNT_MESSAGE = `自訂金額請填 ${AMOUNT_MIN} 到 ${AMOUNT_MAX} 之間的整數。`;
  const providerFallbackLabels = {
    buy_me_a_coffee: "Buy Me a Coffee",
    external_url: "外部收款頁",
    custom: "外部收款頁",
  };

  function providerLabel(kind, provider) {
    const name = provider && provider.display_name;
    return String(name || providerFallbackLabels[kind] || "支持服務");
  }

  // 公開頁 payload 裡的收款管道資訊（含後台設定的顯示名稱），給送出前確認訊息用。
  let providerInfo = null;

  /** 只收整數、10–100000；回傳 { ok, amount, message }，不合法時 amount 為 null。 */
  function readAmount(input) {
    const raw = String((input && input.value) == null ? "" : input.value).trim();
    if (!raw) return { ok: false, amount: null, message: "請先填寫自訂金額。" };
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < AMOUNT_MIN || n > AMOUNT_MAX) {
      return { ok: false, amount: null, message: AMOUNT_MESSAGE };
    }
    return { ok: true, amount: n, message: "" };
  }

  function setAmountError(errorEl, message) {
    if (!errorEl) return;
    errorEl.textContent = message || "";
    errorEl.hidden = !message;
  }

  // 後台「贊助連結」的公開收款頁（與 Support domain 的旗標無關）。沒有這些連結時，
  // 支持頁在 domain 關閉的狀態下只會剩一句「尚未開放」，使用者找不到任何出口。
  function renderDirectWays(list, { domainOpen }) {
    const wrap = $("directWays");
    const box = $("directWaysList");
    if (!wrap || !box) return;
    const ways = Array.isArray(list) ? list : [];
    box.innerHTML = "";
    wrap.hidden = ways.length === 0;
    if (!ways.length) return;
    text($("directWaysTitle"), domainOpen ? "其他支持方式" : "支持方式");
    text($("directWaysHint"), domainOpen
      ? "也可以用這些服務直接支持，金額與流程由該服務處理。"
      : "選一個你方便的服務，到該服務的頁面完成支持。");
    for (const way of ways) {
      const a = document.createElement("a");
      a.className = "primary";
      a.href = way.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = way.label || "支持";
      if (way.blurb) {
        const small = document.createElement("small");
        small.textContent = way.blurb;
        a.append(" ", small);
      }
      box.appendChild(a);
    }
  }

  function render(data) {
    providerInfo = (data && data.provider) || null;
    const ways = Array.isArray(data?.sponsor_links) ? data.sponsor_links : [];
    const domainOpen = Boolean(data && data.enabled !== false);
    renderDirectWays(ways, { domainOpen });
    if (!data || data.enabled === false) {
      text($("heroTitle"), "支持本站");
      text($("heroDesc"), ways.length
        ? "本站維持免費使用。支持完全自願，不支持也不會減少任何功能。"
        : "本站維持免費使用。目前尚未開放線上支持入口。");
      $("supportWays").hidden = true;
      // hero CTA 不要指向已經被藏起來的方案卡；有贊助連結就帶到下面的支持方式。
      const heroCta = $("heroCta");
      if (heroCta) {
        heroCta.hidden = ways.length === 0;
        if (ways.length) heroCta.href = "#directWays";
      }
      return;
    }
    const copy = data.copy || {};
    text($("heroTitle"), copy.hero_title || "讓吉比租房追蹤持續免費");
    text($("heroDesc"), copy.hero_description || "");
    text($("freeStatement"), copy.free_statement || data.free_statement || "");
    text($("heroCta"), copy.cta_label || "支持本站");
    text($("costTitle"), copy.cost_section_title || "這些錢用在哪裡");
    text($("tierTitle"), copy.support_section_title || "支持方式");
    text($("footerNote"), copy.footer_note || "");
    text($("wallTitle"), copy.wall_title || "感謝支持吉比租房追蹤");
    text($("goalTitle"), copy.goal_title || "本月維運");

    const goal = data.goal || {};
    if (data.show_goal) {
      $("goalSection").hidden = false;
      if (goal.display === "percent") {
        text($("goalCost"), "");
        text($("goalGot"), goal.coverageLabel || "");
      } else {
        text($("goalCost"), money(goal.target || goal.cost));
        text($("goalGot"), money(goal.received));
      }
      const visual = Math.min(100, Number(goal.visualPercent) || 0);
      $("goalFill").style.width = visual + "%";
      $("goalBar").setAttribute("aria-valuenow", String(visual));
      $("goalBar").setAttribute("aria-valuetext", goal.over
        ? `已達成本 ${goal.percent}%`
        : `支持覆蓋 ${goal.percent}%`);
      text($("goalPct"), goal.over
        ? `${money(goal.received)} / ${money(goal.target)}　已達成本 ${goal.percent}%`
        : `${goal.percent}%`);
    }

    if (data.show_cost && Array.isArray(data.costs) && data.costs.length) {
      $("costSection").hidden = false;
      const ul = $("costList");
      ul.innerHTML = "";
      for (const row of data.costs) {
        const li = document.createElement("li");
        li.textContent = `${row.name || row.category}　${money(row.monthly_amount)}／月`;
        ul.appendChild(li);
      }
    }

    const list = $("tierList");
    list.innerHTML = "";
    const available = data.checkout_available === true;
    $("checkoutFallback").hidden = available;
    for (const tier of data.tiers || []) {
      const card = document.createElement("article");
      card.className = "tier";
      const title = document.createElement("strong");
      title.textContent = `${tier.icon || ""} ${tier.title}`.trim();
      const amt = document.createElement("div");
      amt.className = "amt";
      const desc = document.createElement("p");
      desc.className = "muted";
      desc.textContent = tier.description || "";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "primary";
      btn.textContent = copy.cta_label || "支持本站";
      btn.disabled = !available;
      // amount > 0 是固定金額方案；只有 amount = 0（種子資料的「自訂支持」）才給輸入框，
      // 而且卡片絕不顯示「NT$ 0」——未填時顯示「自訂金額」，填了才顯示實際金額。
      if (Number(tier.amount) > 0) {
        amt.textContent = money(tier.amount);
        btn.addEventListener("click", () => checkout({ tierId: tier.id, amount: Number(tier.amount), title: tier.title }));
        card.append(title, amt, desc, btn);
        list.appendChild(card);
        continue;
      }
      amt.textContent = "自訂金額";
      const field = document.createElement("div");
      field.className = "amount-field";
      const inputId = `tierAmount-${tier.id}`;
      const hintId = `tierAmountHint-${tier.id}`;
      const errorId = `tierAmountError-${tier.id}`;
      const label = document.createElement("label");
      label.className = "amount-label";
      label.setAttribute("for", inputId);
      label.htmlFor = inputId;
      label.textContent = "自訂金額（新台幣）";
      const input = document.createElement("input");
      input.setAttribute("type", "number");
      input.setAttribute("id", inputId);
      input.setAttribute("name", inputId);
      input.setAttribute("inputmode", "numeric");
      input.setAttribute("min", String(AMOUNT_MIN));
      input.setAttribute("max", String(AMOUNT_MAX));
      input.setAttribute("step", "1");
      input.setAttribute("autocomplete", "off");
      input.setAttribute("placeholder", "例如 500");
      input.setAttribute("aria-describedby", `${hintId} ${errorId}`);
      const hint = document.createElement("p");
      hint.className = "amount-hint";
      hint.setAttribute("id", hintId);
      hint.textContent = `請填 ${AMOUNT_MIN} 到 ${AMOUNT_MAX} 的整數，單位是新台幣。`;
      const error = document.createElement("p");
      error.className = "amount-error";
      error.setAttribute("id", errorId);
      error.setAttribute("role", "status");
      error.setAttribute("aria-live", "polite");
      error.hidden = true;
      input.addEventListener("input", () => {
        setAmountError(error, "");
        input.removeAttribute("aria-invalid");
        const parsed = readAmount(input);
        amt.textContent = parsed.ok ? money(parsed.amount) : "自訂金額";
      });
      btn.addEventListener("click", () => {
        const parsed = readAmount(input);
        if (!parsed.ok) {
          // 不合法就不送 API：把訊息留在卡片裡（aria-live 會唸出來）並把焦點移回輸入框。
          setAmountError(error, parsed.message);
          input.setAttribute("aria-invalid", "true");
          if (typeof input.focus === "function") input.focus();
          return;
        }
        setAmountError(error, "");
        input.removeAttribute("aria-invalid");
        amt.textContent = money(parsed.amount);
        checkout({ tierId: tier.id, amount: parsed.amount, title: tier.title });
      });
      field.append(label, input, hint, error);
      card.append(title, amt, desc, field, btn);
      list.appendChild(card);
    }

    if (data.show_sponsors && (data.sponsors || []).length) {
      $("sponsorSection").hidden = false;
      const box = $("sponsorList");
      box.innerHTML = "";
      for (const row of data.sponsors) {
        const card = document.createElement("article");
        card.className = "sponsor-card";
        const kicker = document.createElement("small");
        kicker.textContent = row.disclosure_text || "贊助";
        const name = document.createElement("p");
        name.textContent = `感謝 ${row.name} 支持本站維持免費`;
        card.append(kicker, name);
        if (row.website_url) {
          const a = document.createElement("a");
          a.href = row.website_url;
          a.rel = "noopener noreferrer";
          a.target = "_blank";
          a.textContent = "了解贊助方";
          a.addEventListener("click", () => {
            fetch("/api/support/event", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ kind: "sponsor_clicked", meta: { sponsorId: row.id } }),
            }).catch(() => {});
          });
          card.appendChild(a);
        }
        box.appendChild(card);
        fetch("/api/support/event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "sponsor_impression", meta: { sponsorId: row.id } }),
        }).catch(() => {});
      }
    }

    if (data.show_supporters && (data.thanks || []).length) {
      $("thanksSection").hidden = false;
      const box = $("thanksList");
      box.innerHTML = "";
      for (const row of data.thanks) {
        const item = document.createElement("div");
        item.className = "thanks-item";
        item.textContent = row.message ? `${row.name}：${row.message}` : row.name;
        box.appendChild(item);
      }
    }
  }

  /** 送出前的確認訊息（不必 modal）：沿用 .fallback 的輕量樣式，並由 aria-live 唸出。 */
  function showConfirm(message) {
    const note = $("checkoutConfirm") || $("checkoutFallback");
    if (!note) return;
    note.textContent = message;
    note.hidden = false;
  }

  async function checkout({ tierId, amount, title } = {}) {
    const body = { tierId };
    if (Number.isInteger(amount) && amount > 0) body.amount = amount;
    fetch("/api/support/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "support_tier_clicked", meta: { tierId, amount: body.amount } }),
    }).catch(() => {});
    try {
      const res = await fetch("/api/support/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (data.available && data.url) {
        // 先講清楚「去哪個管道、多少錢」再導外；等一個 frame 讓訊息真的畫出來，
        // 也讓讀屏有時間唸完（不必使用者再按一次，故不是 modal）。
        const payAmount = Number.isInteger(data.amount) ? data.amount : body.amount;
        showConfirm(`將前往「${providerLabel(data.provider, providerInfo)}」完成支持${payAmount ? ` NT$ ${Number(payAmount).toLocaleString("zh-Hant-TW")}` : ""}${title ? `（${title}）` : ""}…`);
        const go = () => { window.location.href = data.url; };
        if (typeof setTimeout === "function") setTimeout(go, 700);
        else go();
        return;
      }
      const note = $("checkoutFallback");
      note.hidden = false;
      note.textContent = data.message || "目前支持付款服務暫時無法使用，稍後再試即可。";
    } catch {
      $("checkoutFallback").hidden = false;
    }
  }

  fetch(rootPath, { cache: "no-store" })
    .then((res) => res.json())
    .then((data) => {
      render(data);
      if (data && data.enabled) {
        fetch("/api/support/event", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "support_page_viewed" }),
        }).catch(() => {});
      }
    })
    .catch(() => {
      render({ enabled: false });
    });
})();
