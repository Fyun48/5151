(function () {
  const STORAGE_KEY = "support_cta_state_v1";
  const USAGE_KEY = "support_cta_usage_v1";

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore quota
    }
  }

  function bumpUsage(field) {
    const usage = readJson(USAGE_KEY, {});
    usage[field] = (Number(usage[field]) || 0) + 1;
    if (!usage.firstDay) usage.firstDay = new Date().toISOString().slice(0, 10);
    const first = new Date(usage.firstDay + "T00:00:00Z").getTime();
    usage.daysUsed = Math.max(1, Math.floor((Date.now() - first) / 86400000) + 1);
    writeJson(USAGE_KEY, usage);
    return usage;
  }

  window.SupportCtaUsage = {
    bumpSearch() { return bumpUsage("searches"); },
    bumpView() { return bumpUsage("views"); },
    bumpWatch() { return bumpUsage("watches"); },
    bumpCommute() { return bumpUsage("commuteUses"); },
    bumpSameHouse() { return bumpUsage("sameHouseUsed"); },
    read() { return readJson(USAGE_KEY, {}); },
  };

  function trapFocus(dialog) {
    const nodes = [...dialog.querySelectorAll("button, a, [href], input, select, textarea")].filter((el) => !el.disabled);
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    function onKey(ev) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        dismiss(7, true);
        return;
      }
      if (ev.key !== "Tab" || nodes.length < 2) return;
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    }
    dialog.addEventListener("keydown", onKey);
    first?.focus();
    return () => dialog.removeEventListener("keydown", onKey);
  }

  let releaseFocus = null;

  function hideCard() {
    const card = document.getElementById("supportCtaCard");
    if (!card) return;
    card.hidden = true;
    if (releaseFocus) {
      releaseFocus();
      releaseFocus = null;
    }
  }

  async function dismiss(days, silent) {
    const clientState = readJson(STORAGE_KEY, {});
    const next = { ...clientState };
    const until = new Date(Date.now() + (Number(days) || 7) * 86400000).toISOString();
    next.dismissedUntil = until;
    writeJson(STORAGE_KEY, next);
    hideCard();
    if (!silent) {
      fetch("/api/support/cta/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days, clientState: next }),
      }).catch(() => {});
    }
  }

  function showCard(payload) {
    const card = document.getElementById("supportCtaCard");
    const msg = document.getElementById("supportCtaMessage");
    if (!card || !msg) return;
    msg.textContent = payload.message || "如果本站真的幫你省下時間，可以自願支持網站維護。";
    card.hidden = false;
    releaseFocus = trapFocus(card);
  }

  async function boot() {
    const entry = document.getElementById("supportHeaderLink");
    const footer = document.getElementById("supportFooterLink");
    const meLink = document.getElementById("supportMeLink");
    const meWrap = document.getElementById("supportMeLinkWrap");
    let pub = null;
    try {
      const res = await fetch("/api/support/public", { cache: "no-store" });
      pub = await res.json();
    } catch {
      return;
    }
    if (pub && pub.enabled && pub.entry?.show) {
      if (entry) {
        entry.hidden = false;
        entry.href = "/support.html";
      }
      if (meLink) meLink.hidden = false;
      if (meWrap) meWrap.hidden = false;
      if (footer) {
        footer.href = "/support.html";
        footer.onclick = null;
      }
      fetch("/api/support/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "support_entry_viewed" }),
      }).catch(() => {});
    }
    if (!pub?.flags?.cta_enabled || !pub.enabled) return;
    const usage = window.SupportCtaUsage.read();
    const clientState = readJson(STORAGE_KEY, {});
    try {
      const res = await fetch("/api/support/cta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usage, clientState }),
      });
      const data = await res.json();
      if (data?.state) writeJson(STORAGE_KEY, { ...clientState, ...data.state });
      if (data?.show) showCard(data);
    } catch {
      // 失敗不得影響找房
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("supportCtaGo")?.addEventListener("click", () => {
      fetch("/api/support/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "support_cta_clicked" }),
      }).catch(() => {});
      window.location.href = "/support.html";
    });
    document.getElementById("supportCtaLater")?.addEventListener("click", () => dismiss(7));
    document.querySelectorAll("[data-support-dismiss]").forEach((btn) => {
      btn.addEventListener("click", () => dismiss(Number(btn.dataset.supportDismiss) || 7));
    });
    boot();
  });
})();
