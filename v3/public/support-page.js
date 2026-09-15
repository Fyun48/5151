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

  function render(data) {
    if (!data || data.enabled === false) {
      text($("heroTitle"), "支持本站");
      text($("heroDesc"), "本站維持免費使用。目前尚未開放線上支持入口。");
      $("supportWays").hidden = true;
      return;
    }
    const copy = data.copy || {};
    text($("heroTitle"), copy.hero_title || "讓 5151 持續免費");
    text($("heroDesc"), copy.hero_description || "");
    text($("freeStatement"), copy.free_statement || data.free_statement || "");
    text($("heroCta"), copy.cta_label || "支持本站");
    text($("costTitle"), copy.cost_section_title || "這些錢用在哪裡");
    text($("tierTitle"), copy.support_section_title || "支持方式");
    text($("footerNote"), copy.footer_note || "");
    text($("wallTitle"), copy.wall_title || "感謝支持 5151");
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
      amt.textContent = tier.amount > 0 ? money(tier.amount) : "自訂";
      const desc = document.createElement("p");
      desc.className = "muted";
      desc.textContent = tier.description || "";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "primary";
      btn.textContent = copy.cta_label || "支持本站";
      btn.disabled = !available;
      btn.addEventListener("click", () => checkout(tier.id));
      card.append(title, amt, desc, btn);
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

  async function checkout(tierId) {
    fetch("/api/support/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "support_tier_clicked", meta: { tierId } }),
    }).catch(() => {});
    try {
      const res = await fetch("/api/support/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tierId }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.available && data.url) {
        window.location.href = data.url;
        return;
      }
      $("checkoutFallback").hidden = false;
      $("checkoutFallback").textContent = data.message || "目前支持付款服務暫時無法使用，稍後再試即可。";
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
