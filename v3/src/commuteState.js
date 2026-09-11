export const COMMUTE_STATES = {
  WAIT_GEO: "wait_geo",
  WAIT_ROUTE: "wait_route",
  COMPUTING: "computing",
  DONE: "done",
  RETRY: "retry",
  FAILED: "failed",
};

export const COMMUTE_STATE_LABELS = {
  wait_geo: "等待定位",
  wait_route: "等待計算",
  computing: "計算中",
  done: "",
  retry: "稍後重試",
  failed: "無法計算",
};

export function commuteStateLabel(state) {
  return COMMUTE_STATE_LABELS[String(state || "")] || "";
}

export function normalizeRouteDirection(value) {
  return String(value || "") === "from_work" ? "from_work" : "to_work";
}

export function commuteSettingsFingerprint(settings = {}) {
  const lat = Number(settings.workLat);
  const lng = Number(settings.workLng);
  const mode = String(settings.commuteMode || "").trim() === "car" ? "car" : "scooter";
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "";
  return `${Math.round(lat * 1e5) / 1e5},${Math.round(lng * 1e5) / 1e5}|${mode}`;
}

export function commuteFieldKey(item = {}) {
  const routes = Array.isArray(item.commute_routes) ? item.commute_routes.join(",") : "";
  return [
    item.post_id,
    item.commute_km,
    item.commute_return_km,
    item.commute_state,
    routes,
    item.lat,
    item.lng,
    item.mrt_station,
    item.mrt_walk_km,
  ].join("|");
}

export function pickCommuteFields(row = {}) {
  return {
    commute_km: row.commute_km ?? null,
    commute_return_km: row.commute_return_km ?? null,
    commute_state: row.commute_state || "",
    commute_mode: row.commute_mode || "",
    commute_routes: Array.isArray(row.commute_routes) ? row.commute_routes : [],
    commute_hint: row.commute_hint || "",
    lat: row.lat,
    lng: row.lng,
    geo_source: row.geo_source,
    mrt_station: row.mrt_station,
    mrt_walk_km: row.mrt_walk_km,
    route_km: row.route_km,
    route_kms: row.route_kms,
  };
}

export function mergeCommutePatch(cacheItem, patch, { fingerprint = "", currentFingerprint = "" } = {}) {
  if (!cacheItem || !patch) return cacheItem;
  if (fingerprint && currentFingerprint && fingerprint !== currentFingerprint) return cacheItem;
  return { ...cacheItem, ...pickCommuteFields(patch) };
}

export function shouldPaintCommute({ fieldChanged = false, htmlChanged = false } = {}) {
  return Boolean(fieldChanged || htmlChanged);
}

export function isPendingCommuteState(item = {}, commuteEnabled = false) {
  const state = String(item.commute_state || "");
  if (["wait_geo", "wait_route", "computing", "retry"].includes(state)) return true;
  if (commuteEnabled && (item.commute_km == null || item.commute_km === "")) return true;
  return false;
}

export function shouldHoldListLayout({ sameIds = false, busy = false, filterChanged = false } = {}) {
  if (sameIds && !filterChanged) return true;
  if (busy && filterChanged) return true;
  return false;
}

export function resolveCommuteState({
  commuteOn = false,
  hasCoords = false,
  commuteKm = null,
  job = null,
} = {}) {
  if (!commuteOn) return "";
  if (commuteKm != null && commuteKm !== "" && Number.isFinite(Number(commuteKm))) return COMMUTE_STATES.DONE;
  if (!hasCoords) return COMMUTE_STATES.WAIT_GEO;
  const state = String(job?.job_state || "");
  if (state === COMMUTE_STATES.COMPUTING) return COMMUTE_STATES.COMPUTING;
  if (state === COMMUTE_STATES.RETRY) return COMMUTE_STATES.RETRY;
  if (state === COMMUTE_STATES.FAILED) return COMMUTE_STATES.FAILED;
  if (state === COMMUTE_STATES.WAIT_ROUTE || state === "pending") return COMMUTE_STATES.WAIT_ROUTE;
  return COMMUTE_STATES.WAIT_ROUTE;
}

export function nextRetryAt(attempts = 1, now = Date.now()) {
  const n = Math.max(1, Number(attempts) || 1);
  const waits = [30_000, 120_000, 480_000, 1_800_000, 7_200_000];
  const wait = waits[Math.min(n - 1, waits.length - 1)];
  return new Date(now + wait).toISOString();
}

export function routeRetryDecision(reason, attempts = 1) {
  const code = String(reason || "error");
  if (code === "no_coords" || code === "no_route") {
    return { job_state: COMMUTE_STATES.FAILED, fail_reason: code, next_retry_at: "" };
  }
  if (attempts >= 8) {
    return { job_state: COMMUTE_STATES.FAILED, fail_reason: "exhausted", next_retry_at: "" };
  }
  return { job_state: COMMUTE_STATES.RETRY, fail_reason: code, next_retry_at: nextRetryAt(attempts) };
}

export function rememberBackfillRequest(state = {}) {
  if (state.busy) {
    state.queued = true;
    return "queued";
  }
  state.busy = true;
  state.queued = false;
  return "start";
}

export function finishBackfillRequest(state = {}) {
  state.busy = false;
  if (state.queued) {
    state.queued = false;
    return "restart";
  }
  return "idle";
}
