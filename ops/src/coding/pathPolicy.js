// Phase 10 集中式「敏感/受保護路徑」政策。Coding Provider 不得為了讓任務通過而擅改部署/安全控制檔。
// 若核准範圍真的需要動到受保護路徑，不得靜默略過——標記為需人工/升級審查（Phase 11），且不得弱化部署安全（PR #174）。

export const CODING_PATH_POLICY_VERSION = "coding-path-policy-v1";

// 部署安全控制（PR #174）：任何改到這些檔案都視為「部署安全」高風險。
const DEPLOY_SAFETY = [
  /^\.github\/workflows\/deploy.*\.ya?ml$/i,
  /^\.github\/workflows\/docker\.ya?ml$/i,
  /^\.github\/workflows\/test\.ya?ml$/i,
  /^(^|.*\/)?deploy[^/]*\.(sh|ya?ml|js|mjs|cjs)$/i,
  /docker-compose.*\.ya?ml$/i,
  /casaos-compose\.ya?ml$/i,
  /^test\/deploy-safety\.test\.js$/i,
];

// 其它敏感基礎設施（CI、驗證/授權、密鑰管理、分支保護）。
const SENSITIVE = [
  /^\.github\/workflows\//i,
  /^\.github\//i,
  /(^|\/)auth[^/]*\.js$/i,
  /(^|\/)ingestSignature\.js$/i,
  /(^|\/)opsSignature\.js$/i,
  /(^|\/)malwareScan\.js$/i,
  /secret|credential|\.env($|\.)/i,
  /(^|\/)storage\//i,
];

function matchAny(patterns, p) { return patterns.some((re) => re.test(p)); }

// 分類變更檔清單。回傳 { deploy_safety:[], sensitive:[], has_protected }。
export function classifyChangedPaths(paths) {
  const list = (Array.isArray(paths) ? paths : []).map((p) => String(p || "").replace(/^\/+/, "").trim()).filter(Boolean);
  const deploySafety = list.filter((p) => matchAny(DEPLOY_SAFETY, p));
  const sensitive = list.filter((p) => matchAny(SENSITIVE, p) && !deploySafety.includes(p));
  return {
    policy_version: CODING_PATH_POLICY_VERSION,
    deploy_safety: deploySafety,
    sensitive,
    has_protected: deploySafety.length > 0 || sensitive.length > 0,
  };
}

export function isDeploySafetyPath(p) { return matchAny(DEPLOY_SAFETY, String(p || "").replace(/^\/+/, "")); }
