// Client state (Phase 12). The browser persists filter / district / sort /
// panel / more-condition / current profile / pagination cursor / scroll state
// in localStorage so F5 does not reset search conditions. This module defines
// the versioned schema + normalization/migration contract the frontend uses.
//
// The server remains authoritative for authorization, canonical listing state,
// shared candidates, notification/same-house state and DB truth — the client
// only stores view/layout/pagination state, never the dataset.

export const CLIENT_STATE_VERSION = 1;

export function defaultClientState() {
  return {
    version: CLIENT_STATE_VERSION,
    filter: "all",
    district: [],
    sort: "newest",
    panel: { collapsed: false, filterCompact: false },
    moreCondition: { expanded: false },
    currentProfile: "",
    pagination: { cursor: null, offset: 0 },
    scroll: { top: 0 },
  };
}

// v0 -> v1 (no schema changes yet; placeholder for future migrations).
function migrateV0(raw = {}) {
  return {
    ...raw,
    version: 1,
    panel: raw.panel ?? {},
    moreCondition: raw.moreCondition ?? {},
    pagination: raw.pagination ?? { cursor: raw.cursor ?? null, offset: raw.offset ?? 0 },
    scroll: raw.scroll ?? {},
  };
}

export function normalizeClientState(raw) {
  const base = defaultClientState();
  if (!raw || typeof raw !== "object") return base;
  const src = raw.version == null ? migrateV0(raw) : raw;
  return {
    version: CLIENT_STATE_VERSION,
    filter: typeof src.filter === "string" ? src.filter : base.filter,
    district: Array.isArray(src.district) ? src.district : base.district,
    sort: typeof src.sort === "string" ? src.sort : base.sort,
    panel: { ...base.panel, ...(src.panel && typeof src.panel === "object" ? src.panel : {}) },
    moreCondition: { ...base.moreCondition, ...(src.moreCondition && typeof src.moreCondition === "object" ? src.moreCondition : {}) },
    currentProfile: typeof src.currentProfile === "string" ? src.currentProfile : base.currentProfile,
    pagination: { ...base.pagination, ...(src.pagination && typeof src.pagination === "object" ? src.pagination : {}) },
    scroll: { ...base.scroll, ...(src.scroll && typeof src.scroll === "object" ? src.scroll : {}) },
  };
}

export function serializeClientState(state) {
  return JSON.stringify(normalizeClientState(state));
}

export function deserializeClientState(json) {
  try {
    return normalizeClientState(JSON.parse(json));
  } catch {
    return defaultClientState();
  }
}
