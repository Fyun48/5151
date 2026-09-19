// Runtime role abstraction (Phase 3). Splits the single v3 process into
// independent Web / Crawler / Worker roles so the HTTP server is not blocked
// by background crawl/worker loops (and vice versa).
//
//   APP_ROLE=web      HTTP/REST/SSE only (no crawl scheduler, no background jobs)
//   APP_ROLE=crawler  591/5168/信義/住商/... source crawling only
//   APP_ROLE=worker   geocode/route/MRT/enrich/notifications/CRM/OPS/lifecycle
//   APP_ROLE=all      backward-compatible local-development mode (default)
export const ROLES = Object.freeze(["web", "crawler", "worker", "all"]);

export function resolveAppRole(env = process.env) {
  const raw = String(env.APP_ROLE || "all").trim().toLowerCase();
  return ROLES.includes(raw) ? raw : "all";
}

export function roleRunsWeb(role) {
  return role === "web" || role === "all";
}

export function roleRunsCrawler(role) {
  return role === "crawler" || role === "all";
}

export function roleRunsWorker(role) {
  return role === "worker" || role === "all";
}
