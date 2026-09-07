import { execFileSync } from "node:child_process";

// Phase 11 安全指令執行：只跑「允許清單」內、由可信 repo 設定推導的指令。
// 絕不從 raw feedback / Proposal / provider prose / PR body / 程式註解取指令。
// 一律加 timeout、擷取 exit code/輸出、對敏感資訊做 redaction、剝除 production 憑證環境變數。

// 允許清單：邏輯名稱 → 實際指令（皆為 repo 標準工具）。
export const ALLOWED_COMMANDS = {
  test: { cmd: "npm", args: ["test", "--silent"], script: "test" },
  build: { cmd: "npm", args: ["run", "build", "--silent"], script: "build" },
  lint: { cmd: "npm", args: ["run", "lint", "--silent"], script: "lint" },
  typecheck: { cmd: "npm", args: ["run", "typecheck", "--silent"], script: "typecheck" },
  "deploy-safety": { cmd: "node", args: ["--test", "test/deploy-safety.test.js"], file: "test/deploy-safety.test.js" },
};

const SECRET_ENV = /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|ACCESS_KEY|SESSION|COOKIE|PROD|PRODUCTION|SSH|NAS|DEPLOY|GITGUARDIAN|OPENAI|ANTHROPIC|GH_TOKEN|GITHUB_TOKEN)/i;
const ENV_ALLOW = new Set(["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "NODE_ENV", "SHELL", "USER", "PWD", "HOSTNAME"]);

// 只保留白名單 + 明顯非敏感的變數；剔除任何看起來像 production 憑證/密鑰的變數。
export function sanitizeEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (ENV_ALLOW.has(k)) { out[k] = v; continue; }
    if (SECRET_ENV.test(k)) continue;
    // 其餘一律不帶入 QA 執行環境（最小化）。
  }
  out.NODE_ENV = "test";
  out.CI = "1";
  return out;
}

const REDACT = [
  /(?<=(password|passwd|token|secret|api[_-]?key|access[_-]?key|authorization)\s*[:=]\s*)\S+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];
export function redact(text) {
  let s = String(text || "");
  for (const re of REDACT) s = s.replace(re, "[REDACTED]");
  return s;
}

// 執行一個允許清單指令，回傳 { ran, exitCode, output, timedOut }。輸出經 redaction 並截斷。
export function makeCommandRunner({ cwd, timeoutMs = 5 * 60 * 1000, env = process.env, maxOutput = 4000 } = {}) {
  const safeEnv = sanitizeEnv(env);
  return function run(name) {
    const spec = ALLOWED_COMMANDS[name];
    if (!spec) return { ran: false, reason: "not_allowlisted" };
    try {
      const out = execFileSync(spec.cmd, spec.args, { cwd, timeout: timeoutMs, encoding: "utf8", env: safeEnv, stdio: ["ignore", "pipe", "pipe"] });
      return { ran: true, exitCode: 0, output: redact(out).slice(0, maxOutput) };
    } catch (e) {
      const timedOut = e.killed === true || e.signal === "SIGTERM";
      const output = redact(`${e.stdout || ""}\n${e.stderr || ""}`).slice(0, maxOutput);
      return { ran: true, exitCode: typeof e.status === "number" ? e.status : 1, output, timedOut };
    }
  };
}
