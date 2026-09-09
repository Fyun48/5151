import { httpError } from "../errors.js";

// 只讀 GitHub evidence adapter。永遠只查受信任 repo Fyun48/5151。
// 不接受任意 repository URL（避免 SSRF）。Client 送來的 title/head/base/merged 一律不採信。
// 無法取得 GitHub evidence → available=false，呼叫端必須 fail-closed。

export const TRUSTED_GITHUB_OWNER = "Fyun48";
export const TRUSTED_GITHUB_REPO = "5151";
export const TRUSTED_REPOSITORY = `${TRUSTED_GITHUB_OWNER}/${TRUSTED_GITHUB_REPO}`;

const EXACT_SHA = /^[0-9a-f]{40}$/;

export function isExactGitSha(value) {
  return EXACT_SHA.test(String(value || ""));
}

export function isTrustedRepository(name) {
  return String(name || "") === TRUSTED_REPOSITORY;
}

export function makeUnavailableGithubRead(reason = "not_configured") {
  return {
    name: "github",
    available: false,
    reason,
    trustedRepository: TRUSTED_REPOSITORY,
    async getPull() { throw Object.assign(new Error("github evidence unavailable"), { status: 503, code: "github_evidence_unavailable" }); },
    async getCommit() { throw Object.assign(new Error("github evidence unavailable"), { status: 503, code: "github_evidence_unavailable" }); },
  };
}

function normalizePull(pr) {
  if (!pr) return null;
  const repository = String(pr.base?.repo?.full_name || "").trim();
  if (!isTrustedRepository(repository)) {
    throw httpError("pull request is not in the trusted repository", 409);
  }
  const headSha = String(pr.head?.sha || "").toLowerCase();
  const baseSha = String(pr.base?.sha || "").toLowerCase();
  if (!isExactGitSha(headSha)) throw httpError("github PR head SHA is not an exact 40-char SHA", 502);
  if (baseSha && !isExactGitSha(baseSha)) throw httpError("github PR base SHA is not an exact 40-char SHA", 502);
  return {
    number: Number(pr.number),
    repository: TRUSTED_REPOSITORY,
    head_sha: headSha,
    base_branch: String(pr.base?.ref || ""),
    base_sha: baseSha || null,
    state: String(pr.state || ""),
    merged: pr.merged === true,
    merge_commit_sha: pr.merge_commit_sha && isExactGitSha(String(pr.merge_commit_sha).toLowerCase())
      ? String(pr.merge_commit_sha).toLowerCase()
      : null,
    title: String(pr.title || ""),
    html_url: String(pr.html_url || ""),
    head_ref: pr.head?.ref ? String(pr.head.ref) : null,
  };
}

function normalizeCommit(c, requestedSha) {
  if (!c) return null;
  const sha = String(c.sha || "").toLowerCase();
  if (!isExactGitSha(sha)) throw httpError("github commit SHA is not an exact 40-char SHA", 502);
  if (requestedSha && sha !== String(requestedSha).toLowerCase()) {
    throw httpError("github commit SHA is not an exact match", 409);
  }
  return {
    sha,
    tree_sha: c.commit?.tree?.sha && isExactGitSha(String(c.commit.tree.sha).toLowerCase())
      ? String(c.commit.tree.sha).toLowerCase()
      : null,
    html_url: String(c.html_url || ""),
    repository: TRUSTED_REPOSITORY,
    parents: (c.parents || []).map((p) => String(p.sha || "").toLowerCase()).filter(isExactGitSha),
  };
}

export function makeStubGithubRead({ pulls = {}, commits = {}, fail = false } = {}) {
  return {
    name: "stub",
    available: !fail,
    reason: fail ? "stub_unavailable" : null,
    trustedRepository: TRUSTED_REPOSITORY,
    async getPull(number) {
      if (fail) throw Object.assign(new Error("github evidence unavailable"), { status: 503, code: "github_evidence_unavailable" });
      const n = Number(number);
      if (!Number.isInteger(n) || n < 1) throw httpError("invalid pr_number", 400);
      const pr = pulls[n];
      if (pr == null) return null;
      if (pr === "error") throw Object.assign(new Error("github evidence unavailable"), { status: 503, code: "github_evidence_unavailable" });
      return normalizePull(pr);
    },
    async getCommit(sha) {
      if (fail) throw Object.assign(new Error("github evidence unavailable"), { status: 503, code: "github_evidence_unavailable" });
      if (!isExactGitSha(sha)) throw httpError("source_sha must be a complete 40-char git SHA", 400);
      const c = commits[String(sha).toLowerCase()];
      if (c == null) return null;
      if (c === "error") throw Object.assign(new Error("github evidence unavailable"), { status: 503, code: "github_evidence_unavailable" });
      return normalizeCommit(c, sha);
    },
  };
}

export function makeGithubRead(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || env.OPS_GITHUB_TOKEN;
  if (!token || typeof fetchImpl !== "function") return makeUnavailableGithubRead("not_configured");

  const api = async (apiPath) => {
    let res;
    try {
      res = await fetchImpl(`https://api.github.com${apiPath}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "fyun48-5151-ops",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch {
      throw Object.assign(new Error("github evidence unavailable"), { status: 503, code: "github_evidence_unavailable" });
    }
    if (res.status === 404) return null;
    if (!res.ok) throw Object.assign(new Error(`github_read_failed:${res.status}`), { status: 503, code: "github_evidence_unavailable" });
    try { return await res.json(); } catch {
      throw Object.assign(new Error("github evidence unavailable"), { status: 503, code: "github_evidence_unavailable" });
    }
  };

  return {
    name: "github",
    available: true,
    trustedRepository: TRUSTED_REPOSITORY,
    async getPull(number) {
      const n = Number(number);
      if (!Number.isInteger(n) || n < 1) throw httpError("invalid pr_number", 400);
      const pr = await api(`/repos/${TRUSTED_REPOSITORY}/pulls/${n}`);
      return normalizePull(pr);
    },
    async getCommit(sha) {
      if (!isExactGitSha(sha)) throw httpError("source_sha must be a complete 40-char git SHA", 400);
      const c = await api(`/repos/${TRUSTED_REPOSITORY}/commits/${sha}`);
      return normalizeCommit(c, sha);
    },
  };
}
