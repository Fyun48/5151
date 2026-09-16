(function (root) {
  const WISH_BULK_SECTION_SELECTOR = ".wish-v2-cat";

  function findWishBulkSection(el) {
    if (!el || typeof el.closest !== "function") return null;
    return el.closest(WISH_BULK_SECTION_SELECTOR);
  }

  function nextWishBulkStates(rows, action) {
    const out = {};
    for (const row of rows || []) {
      const id = String(row?.id || "");
      if (!id) continue;
      if (action === "clear") {
        out[id] = "unspecified";
        continue;
      }
      if (action === "want") {
        out[id] = row.allowWant === true ? "want" : "unspecified";
        continue;
      }
      if (action === "avoid") {
        out[id] = row.allowAvoid === true ? "avoid" : "unspecified";
        continue;
      }
      out[id] = row.current === "want" || row.current === "avoid" ? row.current : "unspecified";
    }
    return out;
  }

  function wishBulkConditionRowsFromSection(section) {
    if (!section || typeof section.querySelectorAll !== "function") return [];
    const ids = [...new Set(
      [...section.querySelectorAll("[data-wish-v2]")]
        .map((btn) => btn.dataset?.wishV2)
        .filter(Boolean),
    )];
    return ids.map((id) => {
      const btns = [...section.querySelectorAll(`[data-wish-v2="${id}"]`)];
      const pressed = btns.find((btn) => btn.getAttribute("aria-pressed") === "true");
      return {
        id,
        allowWant: btns.some((btn) => btn.dataset?.wishAction === "want"),
        allowAvoid: btns.some((btn) => btn.dataset?.wishAction === "avoid"),
        current: pressed?.dataset?.wishAction || "unspecified",
      };
    });
  }

  function applyWishBulkToSection(section, action) {
    const states = nextWishBulkStates(wishBulkConditionRowsFromSection(section), action);
    if (!section || typeof section.querySelectorAll !== "function") return states;
    for (const [id, next] of Object.entries(states)) {
      section.querySelectorAll(`[data-wish-v2="${id}"]`).forEach((btn) => {
        btn.setAttribute("aria-pressed", btn.dataset?.wishAction === next ? "true" : "false");
      });
    }
    return states;
  }

  function isWishDraftContext({ editingId = 0, activeId = 0, fullReconfirm = false } = {}) {
    if (fullReconfirm) return false;
    if (activeId && Number(editingId) === Number(activeId)) return false;
    return true;
  }

  function planWishDraftSave({ editingId = 0, activeId = 0, fullReconfirm = false } = {}) {
    if (!isWishDraftContext({ editingId, activeId, fullReconfirm })) {
      return { allowed: false, reason: activeId && Number(editingId) === Number(activeId) ? "active_edit" : "active_reconfirm" };
    }
    const id = Number(editingId) || 0;
    if (id) {
      return { allowed: true, method: "PATCH", url: `/api/wish-rooms/${id}`, body: { draft: true }, publish: false };
    }
    return { allowed: true, method: "POST", url: "/api/wish-rooms", body: { draft: true }, publish: false };
  }

  function planWishPublish({ editingId = 0, activeId = 0 } = {}) {
    const id = Number(editingId) || 0;
    if (id && activeId && Number(id) === Number(activeId)) {
      return { method: "PATCH", publish: false, create: false };
    }
    if (id) return { method: "PATCH", publish: true, create: false };
    return { method: "POST", publish: false, create: true, draft: false };
  }

  function wishCreateButtonLabel({ active = null, draft = null } = {}) {
    if (!active && draft) return "繼續編輯草稿";
    return "建立我的許願房";
  }

  function beginWishFormMutation(state) {
    if (state?.inFlight) return { allowed: false, state };
    return {
      allowed: true,
      state: { ...(state || {}), inFlight: true, draftDisabled: true, publishDisabled: true },
    };
  }

  function endWishFormMutation(state) {
    return { ...(state || {}), inFlight: false, draftDisabled: false, publishDisabled: false };
  }

  function newSelfListingIdempotencyKey(randomUuid) {
    const makeUuid = typeof randomUuid === "function"
      ? randomUuid
      : globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
    if (typeof makeUuid === "function") return makeUuid();
    const cryptoObj = globalThis.crypto;
    if (!cryptoObj || typeof cryptoObj.getRandomValues !== "function") {
      throw new Error("缺少安全隨機來源，無法建立刊登");
    }
    const hex = [...cryptoObj.getRandomValues(new Uint8Array(16))].map((n) => n.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  function selfListingClientFingerprint(payload) {
    const { idempotency_key: _ignored, ...rest } = payload || {};
    return JSON.stringify(rest);
  }

  function resolveSelfListingCreateKey(state, fingerprint, makeKey) {
    const current = state || {};
    if (current.key && current.fingerprint === fingerprint) {
      return { ...current, key: current.key, fingerprint };
    }
    return { ...current, key: (makeKey || newSelfListingIdempotencyKey)(), fingerprint };
  }

  function beginSelfListingSubmit(state) {
    if (state?.inFlight) return { allowed: false, state };
    return { allowed: true, state: { ...(state || {}), inFlight: true, submitDisabled: true } };
  }

  function endSelfListingSubmit(state, { success = false } = {}) {
    const next = { ...(state || {}), inFlight: false, submitDisabled: false };
    if (success) {
      next.key = "";
      next.fingerprint = "";
    }
    return next;
  }

  const api = {
    WISH_BULK_SECTION_SELECTOR,
    findWishBulkSection,
    nextWishBulkStates,
    wishBulkConditionRowsFromSection,
    applyWishBulkToSection,
    isWishDraftContext,
    planWishDraftSave,
    planWishPublish,
    wishCreateButtonLabel,
    beginWishFormMutation,
    endWishFormMutation,
    newSelfListingIdempotencyKey,
    selfListingClientFingerprint,
    resolveSelfListingCreateKey,
    beginSelfListingSubmit,
    endSelfListingSubmit,
  };
  root.PraHelpers = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
