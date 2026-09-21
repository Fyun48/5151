// 自動程式碼審查（advisory）：reviewer 是 **OpenAI 相容的 chat-completions 呼叫**，模型可換。
//
// 這裡驗的是「與供應商無關」這件事：端點正規化、請求內容、回應解析、沒有金鑰就跳過、
// 以及 workflow 只留言（不 merge、不部署、不是 gate）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  MAX_DIFF_CHARS,
  buildMessages,
  configFromEnv,
  extractReview,
  main,
  requestReview,
  reviewBody,
  reviewEndpoint,
  truncateDiff,
} from "../../.github/scripts/code-review.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("the endpoint works for any OpenAI-compatible provider", () => {
  assert.equal(reviewEndpoint(), `${DEFAULT_BASE_URL}/chat/completions`);
  assert.equal(reviewEndpoint("https://api.openai.com/v1"), "https://api.openai.com/v1/chat/completions");
  // DeepSeek documents both https://api.deepseek.com and .../v1 - either way lands correctly.
  assert.equal(reviewEndpoint("https://api.deepseek.com"), "https://api.deepseek.com/v1/chat/completions");
  assert.equal(reviewEndpoint("https://api.deepseek.com/v1/"), "https://api.deepseek.com/v1/chat/completions");
  // A base that already carries its own version segment is left alone (Groq, gateways).
  assert.equal(reviewEndpoint("https://api.groq.com/openai/v1"), "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(reviewEndpoint("http://192.168.0.140:11434/v1"), "http://192.168.0.140:11434/v1/chat/completions");
});

test("a huge diff is truncated instead of being rejected by the provider", () => {
  const small = truncateDiff("+ one line");
  assert.equal(small.truncated, false);
  const big = truncateDiff("x".repeat(MAX_DIFF_CHARS + 10));
  assert.equal(big.truncated, true);
  assert.ok(big.text.length < MAX_DIFF_CHARS + 200);
  assert.match(big.text, /diff truncated at/);
});

test("the prompt carries the diff and the review stays advisory", () => {
  const messages = buildMessages({
    diff: "+ const a = 1;",
    title: "test: something",
    body: "why",
    number: "123",
  });
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /severity/);
  assert.equal(messages[1].role, "user");
  assert.match(messages[1].content, /PR #123/);
  assert.match(messages[1].content, /\+ const a = 1;/);
  const body = reviewBody("### findings", { model: "deepseek-chat", baseUrl: "https://api.deepseek.com" });
  assert.match(body, /不擋合併/);
  assert.match(body, /deepseek-chat/);
  assert.match(body, /不是 merge gate/);
});

test("extractReview accepts the OpenAI-shaped and text-shaped responses", () => {
  assert.equal(extractReview({ choices: [{ message: { content: "  ok  " } }] }), "ok");
  assert.equal(extractReview({ choices: [{ text: "legacy" }] }), "legacy");
  assert.equal(extractReview({}), "");
});

test("requestReview posts an OpenAI-shaped body with the provider's model and key", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: "## review" } }] }),
    };
  };
  const review = await requestReview({
    apiKey: "sk-test",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-chat",
    messages: [{ role: "user", content: "hi" }],
    fetchImpl: fakeFetch,
  });
  assert.equal(review, "## review");
  assert.equal(calls[0].url, "https://api.deepseek.com/v1/chat/completions");
  assert.equal(calls[0].init.headers.authorization, "Bearer sk-test");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.model, "deepseek-chat");
  assert.deepEqual(sent.messages, [{ role: "user", content: "hi" }]);
});

test("a provider error is reported, not swallowed", async () => {
  const failing = async () => ({ ok: false, status: 401, text: async () => "bad key" });
  await assert.rejects(
    () => requestReview({ apiKey: "x", messages: [], fetchImpl: failing }),
    /review provider returned 401: bad key/,
  );
});

test("no key means skip, and nothing is sent", async () => {
  let called = 0;
  const result = await main(
    { REVIEW_API_KEY: "" },
    { fetchImpl: async () => { called += 1; }, log: () => {} },
  );
  assert.equal(result.skipped, true);
  assert.equal(result.exitCode, 0);
  assert.equal(called, 0);
  assert.equal(configFromEnv({}).baseUrl, DEFAULT_BASE_URL);
  assert.equal(configFromEnv({}).model, DEFAULT_MODEL);
});

test("main() sends the diff and writes the markdown comment body", async () => {
  const workDir = mkdtempSync(path.join(os.tmpdir(), "v3-review-"));
  const diffFile = path.join(workDir, "diff.patch");
  const outFile = path.join(workDir, "out.md");
  writeFileSync(diffFile, "+ const a = 1;\n- const a = 2;\n", "utf8");
  const urls = [];
  const result = await main(
    {
      REVIEW_API_KEY: "k",
      REVIEW_BASE_URL: "https://api.openai.com/v1",
      REVIEW_MODEL: "gpt-4o-mini",
      REVIEW_DIFF_FILE: diffFile,
      REVIEW_OUTPUT: outFile,
      REVIEW_PR_NUMBER: "7",
      REVIEW_PR_TITLE: "t",
    },
    {
      fetchImpl: async (url) => {
        urls.push(url);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ choices: [{ message: { content: "找到 1 個 nit" } }] }),
        };
      },
      log: () => {},
    },
  );
  assert.equal(result.skipped, false);
  assert.deepEqual(urls, ["https://api.openai.com/v1/chat/completions"]);
  const body = readFileSync(outFile, "utf8");
  assert.match(body, /找到 1 個 nit/);
  assert.match(body, /gpt-4o-mini/);
  rmSync(workDir, { recursive: true, force: true });
});

test("the workflow only comments: no gate, no auto-fix, no merge, no deploy", () => {
  const workflow = readFileSync(path.join(dir, "../../.github/workflows/code-review.yml"), "utf8");
  // 只讀 repo ＋ 留言權限
  assert.match(workflow, /permissions:\n  contents: read\n  pull-requests: write/);
  assert.match(workflow, /gh pr comment "\$PR" --body-file \.review-output\.md/);
  // 沒有金鑰時整支跳過（fork PR 也安全）
  assert.match(workflow, /REVIEW_API_KEY is not configured - skipping the advisory review/);
  // provider 失敗不影響其他東西
  assert.match(workflow, /continue-on-error: true/);
  // 任何「會動到程式或發版」的字眼都不該出現在這支 workflow
  assert.doesNotMatch(workflow, /gh pr merge|git push|--auto/);
  assert.doesNotMatch(workflow, /\bdeploy\b/i);
  assert.doesNotMatch(workflow, /autofix|auto-fix/i);
});


