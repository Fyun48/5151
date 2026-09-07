import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// Phase 10 RepoGateway：以「真實 git worktree」提供隔離工作區，並以 git diff 作為變更範圍的唯一真相來源。
// 絕不直接寫 master：pushBranch 會拒絕把 base/master 當成 coding branch。

function makeUnavailableRepo(reason) {
  return { available: false, reason, resolveBaseSha() { throw new Error("git repo unavailable: " + reason); } };
}

export function makeGitRepo(repoPath, opts = {}) {
  if (!repoPath || !existsSync(path.join(repoPath, ".git"))) return makeUnavailableRepo("not_a_git_repo");
  const remote = opts.remote || "origin";
  const git = (args, cwd = repoPath) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

  return {
    available: true,
    repoPath,
    resolveBaseSha(branch = "master") { return git(["rev-parse", branch]); },

    // 建立以 baseSha 為基準、名為 branch 的隔離 worktree。回傳工作區路徑。
    createWorktree(baseSha, branch) {
      const dir = mkdtempSync(path.join(os.tmpdir(), "ai-dev-wt-"));
      // 先移除可能殘留的同名分支（stale claim 復原時）。
      try { git(["worktree", "remove", "--force", dir]); } catch { /* noop */ }
      try { git(["branch", "-D", branch]); } catch { /* noop */ }
      git(["worktree", "add", "-b", branch, dir, baseSha]);
      return dir;
    },

    // 將 worktree 內所有變更提交為單一 commit，回傳 head SHA（無變更則回傳 null）。
    commitAll(worktreeDir, message, author = {}) {
      git(["add", "-A"], worktreeDir);
      const status = git(["status", "--porcelain"], worktreeDir);
      if (!status) return null;
      const env = { ...process.env };
      const name = author.name || "ai-dev-bot";
      const email = author.email || "ai-dev-bot@local";
      execFileSync("git", ["-C", worktreeDir, "-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "-m", message], { encoding: "utf8", env });
      return git(["rev-parse", "HEAD"], worktreeDir);
    },

    // 以 baseSha..HEAD 的「已提交」diff 為權威來源。回傳 { files:[{path,insertions,deletions,binary}], insertions, deletions }。
    numstat(worktreeDir, baseSha) {
      const out = execFileSync("git", ["-C", worktreeDir, "diff", "--numstat", baseSha, "HEAD"], { encoding: "utf8" }).trim();
      const files = []; let ins = 0, del = 0;
      for (const line of out.split("\n").filter(Boolean)) {
        const [a, b, ...rest] = line.split("\t");
        const p = rest.join("\t");
        const binary = a === "-" || b === "-";
        const i = binary ? 0 : Number(a) || 0;
        const d = binary ? 0 : Number(b) || 0;
        ins += i; del += d;
        files.push({ path: p, insertions: i, deletions: d, binary });
      }
      return { files, insertions: ins, deletions: del };
    },

    // 推送 coding 分支到 remote。硬性拒絕把 base/master 當作 coding 分支，且僅允許 ai-dev/ 前綴。
    pushBranch(worktreeDir, branch, baseBranch = "master") {
      if (!branch || branch === baseBranch || branch === "master") throw new Error("refusing to push protected base branch");
      if (!/^ai-dev\//.test(branch)) throw new Error("coding branch must use ai-dev/ prefix");
      git(["push", "-u", remote, `${branch}:${branch}`], worktreeDir);
      return true;
    },

    cleanupWorktree(worktreeDir) {
      try { git(["worktree", "remove", "--force", worktreeDir]); } catch { try { rmSync(worktreeDir, { recursive: true, force: true }); } catch { /* noop */ } }
    },
  };
}

export function makeCodingRepo(env = process.env) {
  const p = String(env.OPS_CODING_REPO_PATH || "").trim();
  if (!p) return makeUnavailableRepo("not_configured");
  return makeGitRepo(p);
}
