import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
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
      const name = author.name || "ai-dev-bot";
      const email = author.email || "ai-dev-bot@local";
      // 決定性 commit：固定 author/committer 日期，讓相同內容+base 得到相同 head SHA，
      // 使同一 task 的重試具冪等性（重推同分支為 no-op，毋須 force-push）。
      const date = author.date || "2020-01-01T00:00:00Z";
      const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
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

    // ── Phase 11 QA：只讀檢核用（不建分支、不改 master） ──
    // 兩個 SHA 之間的 numstat（含檔案狀態 A/M/D/R）。回傳 { files:[{path,insertions,deletions,binary}], insertions, deletions }。
    numstatRange(baseSha, headSha) {
      const numstat = execFileSync("git", ["-C", repoPath, "diff", "--numstat", baseSha, headSha], { encoding: "utf8" }).trim();
      const nameStatus = execFileSync("git", ["-C", repoPath, "diff", "--name-status", baseSha, headSha], { encoding: "utf8" }).trim();
      const statusByPath = {};
      for (const line of nameStatus.split("\n").filter(Boolean)) {
        const [st, ...rest] = line.split("\t");
        statusByPath[rest[rest.length - 1]] = st[0];
      }
      const files = []; let ins = 0, del = 0;
      for (const line of numstat.split("\n").filter(Boolean)) {
        const [a, b, ...rest] = line.split("\t");
        const p = rest.join("\t");
        const binary = a === "-" || b === "-";
        const i = binary ? 0 : Number(a) || 0;
        const d = binary ? 0 : Number(b) || 0;
        ins += i; del += d;
        files.push({ path: p, insertions: i, deletions: d, binary, status: statusByPath[p] || "M" });
      }
      return { files, insertions: ins, deletions: del };
    },

    // 兩 SHA 間新增的行（給 secret/migration/config 掃描）。
    // 決策用 scan metadata 與顯示裁切分離：達上限時標記 truncated，不得假裝掃描完整。
    addedLinesScan(baseSha, headSha, { maxLines = 5000 } = {}) {
      const out = execFileSync("git", ["-C", repoPath, "diff", "--unified=0", baseSha, headSha], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
      const lines = []; let cur = null; let truncated = false;
      for (const raw of out.split("\n")) {
        if (raw.startsWith("+++ b/")) { cur = raw.slice(6); continue; }
        if (raw.startsWith("+++ ")) { cur = raw.replace(/^\+\+\+\s+b?\/?/, ""); continue; }
        if (raw.startsWith("+") && !raw.startsWith("+++")) {
          if (lines.length >= maxLines) { truncated = true; break; }
          lines.push({ path: cur, line: raw.slice(1) });
        }
      }
      return {
        lines,
        truncated,
        added_line_count: lines.length,
        max_lines: maxLines,
        base_sha: String(baseSha),
        head_sha: String(headSha),
        scan_complete: !truncated,
      };
    },

    // 相容舊呼叫端：只回傳行陣列。完整性請用 addedLinesScan。
    addedLines(baseSha, headSha, opts) {
      return this.addedLinesScan(baseSha, headSha, opts).lines;
    },

    // 建立 detached worktree（指定 SHA）供 QA 跑指令；不建立分支、不影響 master。
    createDetachedWorktree(sha) {
      const dir = mkdtempSync(path.join(os.tmpdir(), "qa-wt-"));
      try { git(["worktree", "remove", "--force", dir]); } catch { /* noop */ }
      git(["worktree", "add", "--detach", dir, sha]);
      return dir;
    },

    readFileAt(worktreeDir, rel) {
      try { return readFileSync(path.join(worktreeDir, rel), "utf8"); } catch { return null; }
    },

    // ── Phase 12 Staging：來源身分驗證用 ──
    resolveRef(ref) { try { return git(["rev-parse", ref]); } catch { return null; } },
    treeHash(sha) { try { return git(["rev-parse", `${sha}^{tree}`]); } catch { return null; } },
  };
}

export function makeCodingRepo(env = process.env) {
  const p = String(env.OPS_CODING_REPO_PATH || "").trim();
  if (!p) return makeUnavailableRepo("not_configured");
  return makeGitRepo(p);
}
