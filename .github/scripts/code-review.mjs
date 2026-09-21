// Model-agnostic pull-request reviewer.
//
// A code review is one OpenAI-compatible chat-completions call, so any provider works - the
// model is a configuration, not a dependency:
//
//   OpenAI       REVIEW_BASE_URL=https://api.openai.com/v1     REVIEW_MODEL=gpt-4o-mini
//   DeepSeek     REVIEW_BASE_URL=https://api.deepseek.com      REVIEW_MODEL=deepseek-chat
//   OpenRouter   REVIEW_BASE_URL=https://openrouter.ai/api/v1  REVIEW_MODEL=...
//   Groq         REVIEW_BASE_URL=https://api.groq.com/openai/v1 REVIEW_MODEL=...
//   local vLLM / Ollama: any OpenAI-compatible base URL
//
// Fail-open by design: with no REVIEW_API_KEY the script prints a skip line and exits 0, so a
// checkout without a key does not turn the workflow red. The review is advisory - it is never a
// merge gate, and nothing here fixes or merges anything.
//
// Environment:
//   REVIEW_API_KEY    provider key                                        [required to review]
//   REVIEW_BASE_URL   provider base URL (default https://api.openai.com/v1)
//   REVIEW_MODEL      model id (default gpt-4o-mini)
//   REVIEW_DIFF_FILE  file holding the PR diff (default .review-diff.patch)
//   REVIEW_PR_TITLE / REVIEW_PR_BODY / REVIEW_PR_NUMBER   optional context
//   REVIEW_OUTPUT     where to write the markdown review (default .review-output.md)
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL = "gpt-4o-mini";
// Providers count tokens, not characters; this keeps a huge diff from being rejected outright.
export const MAX_DIFF_CHARS = 120_000;

export const SYSTEM_PROMPT = [
  "You are reviewing a pull request in the 5151 repository (Node.js, Express, a PostgreSQL/SQLite",
  "dual-driver port in progress). Review ONLY what the diff shows.",
  "Report findings as a short markdown list, each with severity (blocker / should-fix / nit), the",
  "file and line, why it matters, and the smallest fix. Call out: correctness bugs, silently",
  "swallowed errors, tests that cannot fail, security or credential leaks, behaviour changes on the",
  "SQLite path (production runs DB_DRIVER=sqlite), and docs that no longer match the code.",
  "If you find nothing significant, say so in one line. Do not restate the diff, do not rewrite the",
  "code, and never invent files or line numbers that are not in the diff.",
].join(" ");

// Accepts "https://host", "https://host/v1", "https://host/openai/v1" ... and always ends up at
// the chat-completions path. A base that already carries a version segment is left alone, so
// providers with a non-standard prefix (Groq, Azure-style gateways) work as-is.
export function reviewEndpoint(baseUrl = DEFAULT_BASE_URL) {
  const base = String(baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  const withVersion = /\/v\d+$/.test(base) ? base : `${base}/v1`;
  return `${withVersion}/chat/completions`;
}

export function truncateDiff(diff, limit = MAX_DIFF_CHARS) {
  const text = String(diff || "");
  if (text.length <= limit) return { text, truncated: false };
  return {
    text: `${text.slice(0, limit)}\n\n[diff truncated at ${limit} characters]`,
    truncated: true,
  };
}

export function buildMessages({ diff, title = "", body = "", number = "" } = {}) {
  const { text, truncated } = truncateDiff(diff);
  const context = [
    number ? `PR #${number}` : "",
    title ? `Title: ${title}` : "",
    body ? `Description:\n${body}` : "",
  ].filter(Boolean).join("\n");
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `${context}\n\nDiff:\n\`\`\`diff\n${text}\n\`\`\`${truncated ? "\n(The diff was truncated; say so if the cut could hide something.)" : ""}`,
    },
  ];
}

export function extractReview(payload) {
  const choice = payload?.choices?.[0];
  const content = choice?.message?.content ?? choice?.text ?? "";
  return typeof content === "string" ? content.trim() : "";
}

export function reviewBody(markdown, { model, baseUrl } = {}) {
  return [
    "## 自動程式碼審查（advisory，不擋合併）",
    "",
    markdown,
    "",
    `---\n_模型：\`${model || DEFAULT_MODEL}\`（${baseUrl || DEFAULT_BASE_URL}）· 由 \`.github/workflows/code-review.yml\` 產生，僅供參考，不是 merge gate。_`,
  ].join("\n");
}

export async function requestReview({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  model = DEFAULT_MODEL,
  messages,
  fetchImpl = fetch,
  timeoutMs = 120_000,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(reviewEndpoint(baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature: 0.2 }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`review provider returned ${response.status}: ${text.slice(0, 400)}`);
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`review provider returned non-JSON: ${text.slice(0, 200)}`);
    }
    return extractReview(payload);
  } finally {
    clearTimeout(timer);
  }
}

export function configFromEnv(env = process.env) {
  return {
    apiKey: String(env.REVIEW_API_KEY || "").trim(),
    baseUrl: String(env.REVIEW_BASE_URL || DEFAULT_BASE_URL).trim(),
    model: String(env.REVIEW_MODEL || DEFAULT_MODEL).trim(),
    diffFile: String(env.REVIEW_DIFF_FILE || ".review-diff.patch"),
    outputFile: String(env.REVIEW_OUTPUT || ".review-output.md"),
    title: env.REVIEW_PR_TITLE || "",
    body: env.REVIEW_PR_BODY || "",
    number: env.REVIEW_PR_NUMBER || "",
  };
}

export async function main(env = process.env, { fetchImpl = fetch, log = console.log } = {}) {
  const cfg = configFromEnv(env);
  if (!cfg.apiKey) {
    log("code-review: REVIEW_API_KEY is not set - skipping (advisory review, nothing to gate)");
    return { skipped: true, exitCode: 0 };
  }
  let diff = "";
  try {
    diff = readFileSync(cfg.diffFile, "utf8");
  } catch {
    log(`code-review: no diff at ${cfg.diffFile} - skipping`);
    return { skipped: true, exitCode: 0 };
  }
  if (!diff.trim()) {
    log("code-review: empty diff - skipping");
    return { skipped: true, exitCode: 0 };
  }
  const messages = buildMessages({ diff, title: cfg.title, body: cfg.body, number: cfg.number });
  const markdown = await requestReview({
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    messages,
    fetchImpl,
  });
  if (!markdown) {
    log("code-review: the provider returned an empty review");
    return { skipped: false, empty: true, exitCode: 0 };
  }
  writeFileSync(cfg.outputFile, reviewBody(markdown, { model: cfg.model, baseUrl: cfg.baseUrl }), "utf8");
  log(`code-review: wrote ${cfg.outputFile} (${markdown.length} characters) using ${cfg.model}`);
  return { skipped: false, outputFile: cfg.outputFile, exitCode: 0 };
}

// Run only when executed as a script (`node .github/scripts/code-review.mjs`), never on import.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
    .then((result) => { process.exitCode = result.exitCode || 0; })
    .catch((error) => {
      // A provider outage must not look like a failed review of the code.
      console.error(`code-review: ${error.message}`);
      process.exitCode = 1;
    });
}

