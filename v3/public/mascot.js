(function () {
  const KEY = {
    welcome: "jibby-mascot-welcome-v1",
    sponsor: "jibby-mascot-sponsor-v1",
    confusedAt: "jibby-mascot-confused-at",
    playRegister: "jibby-play-register",
  };
  let brand = null;
  let strikes = 0;
  let hideTimer = 0;

  function $(id) {
    return document.getElementById(id);
  }

  function ensureUi() {
    if ($("jibbyMascot")) return;
    const wrap = document.createElement("div");
    wrap.id = "jibbyMascot";
    wrap.className = "jibby-mascot";
    wrap.hidden = true;
    wrap.setAttribute("role", "dialog");
    wrap.innerHTML = `
      <div class="jibby-mascot-card">
        <button type="button" class="ghost jibby-mascot-close" id="jibbyMascotClose" aria-label="關閉">×</button>
        <div class="jibby-mascot-media" id="jibbyMascotMedia"></div>
        <div class="jibby-mascot-copy">
          <p class="jibby-mascot-title" id="jibbyMascotTitle"></p>
          <p class="jibby-mascot-body" id="jibbyMascotBody"></p>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    $("jibbyMascotClose").onclick = hide;
    wrap.addEventListener("click", (ev) => {
      if (ev.target === wrap) hide();
    });
  }

  function applyChrome() {
    if (!brand) return;
    document.querySelectorAll("[data-brand-en]").forEach((el) => {
      el.textContent = brand.englishName || "JibbyRentH";
    });
    document.querySelectorAll("img.brand-mark").forEach((img) => {
      const onLogin = img.closest(".card") && location.pathname.includes("login");
      const show = brand.enabled && brand.markUrl && (onLogin ? brand.login !== false : brand.header !== false);
      img.hidden = !show;
      if (show) img.src = brand.markUrl;
    });
    document.querySelectorAll(".brand-lockup").forEach((el) => {
      el.classList.toggle("is-off", brand.enabled === false);
    });
  }

  function hide() {
    const box = $("jibbyMascot");
    if (!box) return;
    box.hidden = true;
    const media = $("jibbyMascotMedia");
    if (media) media.innerHTML = "";
    if (hideTimer) window.clearTimeout(hideTimer);
  }

  function show(slot, { force = false } = {}) {
    ensureUi();
    if (!brand?.enabled && !force) return false;
    const clip = brand?.clips?.[slot];
    if (!clip || (clip.enabled === false && !force)) return false;
    const media = $("jibbyMascotMedia");
    const title = $("jibbyMascotTitle");
    const body = $("jibbyMascotBody");
    if (!media) return false;
    media.innerHTML = "";
    if (clip.kind === "video") {
      const video = document.createElement("video");
      video.src = clip.url;
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      video.addEventListener("ended", () => window.setTimeout(hide, 400));
      media.appendChild(video);
      video.play?.().catch(() => {});
    } else {
      const img = document.createElement("img");
      img.src = clip.url;
      img.alt = "";
      media.appendChild(img);
    }
    if (title) title.textContent = clip.title || "";
    if (body) body.textContent = clip.body || "";
    $("jibbyMascot").hidden = false;
    if (hideTimer) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(hide, clip.kind === "video" ? 12000 : 5200);
    return true;
  }

  function remembered(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function remember(key, value = "1") {
    try { localStorage.setItem(key, value); } catch { /* ignore */ }
  }

  function maybeWelcome() {
    if (remembered(KEY.welcome)) return;
    if (show("welcome")) remember(KEY.welcome);
  }

  function maybeSponsor(me) {
    const sponsored = Boolean(me?.sponsor?.sponsored || me?.plan === "sponsor");
    if (!sponsored || remembered(KEY.sponsor)) return;
    if (show("sponsor")) remember(KEY.sponsor);
  }

  function maybeRegister() {
    try {
      if (sessionStorage.getItem(KEY.playRegister) !== "1") return;
      sessionStorage.removeItem(KEY.playRegister);
    } catch { return; }
    show("register");
  }

  function noteConfused() {
    if (!brand?.enabled) return;
    const wait = 20 * 60 * 1000;
    const last = Number(remembered(KEY.confusedAt) || 0);
    if (Date.now() - last < wait) return;
    strikes += 1;
    const need = Math.max(3, Number(brand.confusedThreshold) || 6);
    if (strikes < need) return;
    strikes = 0;
    remember(KEY.confusedAt, String(Date.now()));
    show("confused");
  }

  function markRegisterThanks() {
    try { sessionStorage.setItem(KEY.playRegister, "1"); } catch { /* ignore */ }
  }

  async function load() {
    try {
      const res = await fetch("/api/brand", { cache: "no-store" });
      brand = await res.json();
    } catch {
      brand = null;
    }
    applyChrome();
    return brand;
  }

  window.JibbyMascot = {
    load,
    show,
    hide,
    maybeWelcome,
    maybeSponsor,
    maybeRegister,
    noteConfused,
    markRegisterThanks,
  };
})();
