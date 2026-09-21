#!/usr/bin/env node
/**
 * 5151 Gitea agent（P2）
 * 在 Gitea Actions runner 內，用 DeepSeek 執行**一句任務**：讀檔 → 改檔 → 跑測試，迭代到通過為止。
 * push / 開 PR 由 workflow 負責（本檔**不執行 git push**，也**不碰 master**）。
 *
 * 設計原則（與本專案其他自動化一致）
 *  - 零 npm 依賴：只用 node: 內建模組（node 22 的 fetch）。
 *  - 可審計：每一步（模型說了什麼、執行了什麼、輸出是什麼）都寫進 agent-log.md，run log 可讀。
 *  - 護欄：
 *      * 禁止改動 `.github/**`、`.gitea/**`、`deploy/gitea/**`、任何 `.env*` / `*secret*` 路徑
 *      * 指令白名單（npm test / npm ci / node / git status|diff|add … 等），其餘一律拒絕
 *      * 步數（AGENT_MAX_STEPS）、總時間（AGENT_MAX_SECONDS）、單次 token（AGENT_MAX_TOKENS）上限
 *  - 失敗要看得懂：達到上限或模型給不出合法動作時，留下摘要並以非零 exit code 結束。
 *
 * 環境變數
 *  AGENT_TASK（必填）        任務描述（＝你在 Gitea 上打的提示詞）
 *  DEEPSEEK_API_KEY（必填）
 *  AGENT_MODEL=deepseek-chat 也可用 deepseek-reasoner / deepseek-v4-pro
 *  AGENT_BASE_URL=https://api.deepseek.com
 *  AGENT_MAX_STEPS=20 / AGENT_MAX_SECONDS=900 / AGENT_MAX_TOKENS=2000
 *  AGENT_DRY_RUN=1           只印出模型想做的事，不真的改檔或執行
 *  AGENT_LOG=agent-log.md    逐輪記錄檔；AGENT_SUMMARY=agent-summary.md 總結
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

const env = process.env;
const TASK = (env.AGENT_TASK || "").trim();
const KEY = (env.DEEPSEEK_API_KEY || "").trim();
const MODEL = env.AGENT_MODEL || "deepseek-chat";
const BASE_URL = (env.AGENT_BASE_URL || "https://api.deepseek.com").replace(/\/+$/, "");
const MAX_STEPS = Number(env.AGENT_MAX_STEPS || 20);
const MAX_SECONDS = Number(env.AGENT_MAX_SECONDS || 900);
const MAX_TOKENS = Number(env.AGENT_MAX_TOKENS || 2000);
const DRY = env.AGENT_DRY_RUN === "1";
const LOG_FILE = env.AGENT_LOG || "agent-log.md";
const SUMMARY_FILE = env.AGENT_SUMMARY || "agent-summary.md";
const ROOT = process.cwd();
const START = Date.now();

const PROTECTED = [
  /^\.github\//, /^\.gitea\//, /^deploy\/gitea\//, /^\.git\//,
  /(^|\/)\.env/, /(^|\/)\.env\.[^/]+$/, /secret/i, /credential/i,
];
const ALLOWED_CMD = [
  /^npm (ci|test|run [a-z0-9:_-]+)$/i,
  /^node (--test|--input-type=module|-e )/i,
  /^git (status|diff|add|checkout|log|rev-parse|ls-files)\b/i,
  /^(ls|cat|head|tail|grep|find|wc|sha256sum)\b/,
];
const log = [];
function say(line) {
  const s = String(line);
  log.push(s);
  process.stdout.write(s + "\n");
}
function flushLog() {
  try { writeFileSync(LOG_FILE, log.join("\n") + "\n", "utf8"); } catch { /* runner 仍需保留 stdout */ }
}
function elapsed() { return Math.round((Date.now() - START) / 1000); }
function overBudget() { return elapsed() > MAX_SECONDS; }

function isProtected(p) {
  const rel = normalize(p).replace(/\\/g, "/").replace(/^\.\//, "");
  return rel.startsWith("../") || rel.startsWith("/") || PROTECTED.some((re) => re.test(rel));
}
function cmdAllowed(cmd) { return ALLOWED_CMD.some((re) => re.test(cmd.trim())); }

function sh(cmd, timeoutMs = 300000) {
  // 白名單已在呼叫端檢查；用 shell 執行以支援管線。
  return execFileSync("bash", ["-lc", cmd], { cwd: ROOT, encoding: "utf8", timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}
function readCapped(p, limit = 20000) {
  try {
    const full = join(ROOT, p);
    if (!existsSync(full) || statSync(full).isDirectory()) return null;
    const s = readFileSync(full, "utf8");
    return s.length > limit ? s.slice(0, limit) + `\n…［已截斷，原長 ${s.length} 字元］` : s;
  } catch (e) { return `［讀取失敗：${e.message}］`; }
}
function writeCapped(p, content) {
  const full = join(ROOT, p);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
  return `已寫入 ${p}（${content.length} 字元）`;
}
function listFiles(limit = 400) {
  try {
    const out = sh("git ls-files", 60000).split("\n").filter(Boolean);
    return out.length > limit ? [...out.slice(0, limit), `…（共 ${out.length} 個檔案，僅列前 ${limit} 個）`] : out;
  } catch { return readdirSync(ROOT).filter((n) => !n.startsWith(".")).slice(0, limit); }
}

const SYSTEM = `你是 5151 專案的自動修正 agent，在 Gitea Actions runner 內工作。
你只能輸出**單一 JSON 物件**（不要 markdown 圍籬、不要多餘文字），格式：
{"thought":"一句話說明","done":false,"summary":"","actions":[{"op":"read","path":"x"},{"op":"write","path":"x","content":"完整檔案內容"},{"op":"run","cmd":"npm test"}]}

規則（違反會被系統拒絕）：
1. 禁止修改 .github/**、.gitea/**、deploy/gitea/**、任何 .env* 或含 secret/credential 的路徑。
2. 指令只能用：npm ci、npm test、npm run <script>、node ...、git status|diff|add|checkout|log|rev-parse|ls-files、ls|cat|head|tail|grep|find|wc。
3. 一次最多 6 個 action；write 必須給「整個檔案」的完整內容（不能只給片段）。
4. 改完務必自己跑 \`npm test\`（或任務指定的測試）確認；測試通過且任務完成才把 done 設 true 並填 summary。
5. 不要 push、不要碰 master、不要新增 npm 依賴（除非任務明確要求）。
6. 保持既有風格與 zh-TW 註解慣例；最小改動。`;

async function callModel(messages) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: MAX_TOKENS, response_format: { type: "json_object" }, stream: false }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${text.slice(0, 500)}`);
  const body = JSON.parse(text);
  return { content: body?.choices?.[0]?.message?.content || "", usage: body?.usage || {}, model: body?.model };
}

function parsePlan(raw) {
  let s = String(raw).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

function applyAction(a) {
  const op = String(a?.op || "").toLowerCase();
  if (op === "read") {
    if (!a.path) return "read 缺少 path";
    if (isProtected(a.path)) return `拒絕讀取受保護路徑 ${a.path}`;
    const c = readCapped(a.path);
    return c === null ? `（${a.path} 不存在）` : `----- ${a.path} -----\n${c}`;
  }
  if (op === "write") {
    if (!a.path || typeof a.content !== "string") return "write 需要 path 與 content";
    if (isProtected(a.path)) return `拒絕寫入受保護路徑 ${a.path}`;
    if (DRY) return `[dry-run] 會寫入 ${a.path}`;
    return writeCapped(a.path, a.content);
  }
  if (op === "run") {
    if (!a.cmd) return "run 缺少 cmd";
    if (!cmdAllowed(a.cmd)) return `指令不在白名單：${a.cmd}`;
    if (DRY) return `[dry-run] 會執行 ${a.cmd}`;
    try {
      const out = sh(a.cmd);
      return `$ ${a.cmd}\n${out.length > 6000 ? out.slice(-6000) + "\n…［輸出已截斷］" : out}`;
    } catch (e) {
      const out = `${e.stdout || ""}${e.stderr || ""}`.slice(-6000);
      return `$ ${a.cmd}\nexit=${e.status ?? "?"}\n${out}`;
    }
  }
  return `未知操作：${op}`;
}

async function main() {
  if (!TASK) { say("AGENT_TASK 未設定 → 沒有事要做"); writeFileSync(SUMMARY_FILE, "no task\n"); process.exit(2); }
  if (!KEY) { say("DEEPSEEK_API_KEY 未設定 → 無法執行"); writeFileSync(SUMMARY_FILE, "missing DEEPSEEK_API_KEY\n"); process.exit(2); }

  say(`# Agent run ${new Date().toISOString()}`);
  say(`- model: ${MODEL}`);
  say(`- task: ${TASK}`);
  say(`- limits: steps=${MAX_STEPS} seconds=${MAX_SECONDS} tokens=${MAX_TOKENS} dry_run=${DRY}`);

  const files = listFiles();
  const msgs = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: [
        `任務：${TASK}`,
        "",
        `repo 檔案清單（git ls-files）：\n${files.join("\n")}`,
        "",
        `AGENTS.md（節錄）：\n${readCapped("AGENTS.md", 4000) || "（無）"}`,
        "",
        `package.json（節錄）：\n${(readCapped("package.json", 4000) || "").slice(0, 2000)}`,
        "",
        "請開始；需要某個檔案的內容就用 read。",
      ].join("\n"),
    },
  ];

  let done = false;
  let summary = "";
  let tokens = 0;
  for (let step = 1; step <= MAX_STEPS; step++) {
    if (overBudget()) { say(`\n## 中止：超過時間上限（${MAX_SECONDS}s）`); break; }
    say(`\n## step ${step}/${MAX_STEPS} (${elapsed()}s, tokens=${tokens})`);
    let out;
    try { out = await callModel(msgs); }
    catch (e) { say(`模型呼叫失敗：${e.message}`); break; }
    tokens += out.usage.total_tokens || 0;

    let plan;
    try { plan = parsePlan(out.content); }
    catch {
      say(`回應不是合法 JSON，原文前 500 字：\n${out.content.slice(0, 500)}`);
      msgs.push({ role: "user", content: "你剛才的回覆不是合法 JSON。請只輸出規定的 JSON 物件。" });
      continue;
    }
    if (plan.thought) say(`thought: ${plan.thought}`);

    const results = [];
    for (const a of Array.isArray(plan.actions) ? plan.actions.slice(0, 6) : []) {
      const r = applyAction(a);
      say(`action ${a.op} ${a.path || a.cmd || ""} → ${String(r).split("\n")[0].slice(0, 200)}`);
      results.push(r);
    }
    if (plan.done === true) { done = true; summary = plan.summary || "(模型未提供 summary)"; say(`\n## 模型回報完成：${summary}`); break; }

    msgs.push({ role: "assistant", content: out.content });
    msgs.push({
      role: "user",
      content: `動作結果：\n\n${results.map((r, i) => `### ${i + 1}\n${r}`).join("\n\n")}\n\n若任務已完成請 done=true；否則繼續（需要看檔案就 read）。`,
    });
  }

  const verdict = done ? "DONE" : "INCOMPLETE";
  say(`\n# 結果：${verdict}（${elapsed()}s, tokens=${tokens}）`);
  writeFileSync(SUMMARY_FILE, `status=${verdict}\ntask=${TASK}\nmodel=${MODEL}\nseconds=${elapsed()}\ntokens=${tokens}\nsummary=${summary}\n`, "utf8");
  flushLog();
  process.exit(done ? 0 : 1);
}

main().catch((e) => {
  say(`致命錯誤：${e.stack || e.message}`);
  try { writeFileSync(SUMMARY_FILE, `status=FATAL\n${e.message}\n`); } catch { /* 忽略 */ }
  flushLog();
  process.exit(3);
});
