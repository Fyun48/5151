/** Category bulk 必須找外層 section，不能用會命中 button 自己的 [data-wish-cat]。 */
export const WISH_BULK_SECTION_SELECTOR = ".wish-v2-cat";

export function findWishBulkSection(el) {
  if (!el || typeof el.closest !== "function") return null;
  return el.closest(WISH_BULK_SECTION_SELECTOR);
}

export function nextWishBulkStates(rows = [], action = "") {
  const out = {};
  for (const row of rows) {
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

export function wishBulkConditionRowsFromSection(section) {
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

export function applyWishBulkToSection(section, action) {
  const states = nextWishBulkStates(wishBulkConditionRowsFromSection(section), action);
  if (!section || typeof section.querySelectorAll !== "function") return states;
  for (const [id, next] of Object.entries(states)) {
    section.querySelectorAll(`[data-wish-v2="${id}"]`).forEach((btn) => {
      btn.setAttribute("aria-pressed", btn.dataset?.wishAction === next ? "true" : "false");
    });
  }
  return states;
}
