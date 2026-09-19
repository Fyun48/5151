import { test } from "node:test";
import assert from "node:assert/strict";
import { notifyConfig, detectChannel, buildWebhookPayload, deliverWebhook, sendOpsNotification } from "../src/notify/webhook.js";

test("webhook stays off without https URL", () => {
  const cfg = notifyConfig({ OPS_NOTIFY_WEBHOOK_URL: "" });
  assert.equal(cfg.configured, false);
});

test("detects discord and slack channels", () => {
  assert.equal(detectChannel("https://discord.com/api/webhooks/1/abc"), "discord");
  assert.equal(detectChannel("https://hooks.slack.com/services/T/B/X"), "slack");
  assert.equal(detectChannel("https://example.com/hook"), "generic");
});

test("payload never includes contact or user_ref", () => {
  const payload = buildWebhookPayload({
    event: "ops.feedback.ingested",
    title: "新的使用者回饋",
    text: "有一筆新回饋",
    fields: [{ name: "kind", value: "bug" }],
    channel: "generic",
  });
  const raw = JSON.stringify(payload);
  assert.doesNotMatch(raw, /@/);
  assert.doesNotMatch(raw, /user_ref/);
  assert.equal(payload.event, "ops.feedback.ingested");
});

test("discord payload uses embed without PII", () => {
  const payload = buildWebhookPayload({
    event: "ops.proposal.ready",
    title: "議題等待核准",
    text: "議題 #3",
    fields: [{ name: "issue", value: 3 }],
    channel: "discord",
  });
  assert.ok(payload.embeds?.[0]?.title);
  assert.doesNotMatch(JSON.stringify(payload), /leak@|reporter-/);
});

test("deliverWebhook posts JSON and reports http errors", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 204 };
  };
  const r = await deliverWebhook("https://example.com/hook", { hello: 1 }, { fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(calls[0].url, "https://example.com/hook");
  assert.equal(calls[0].opts.method, "POST");

  const bad = await deliverWebhook("https://example.com/hook", {}, { fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "http_500");
});

test("sendOpsNotification no-ops when unconfigured", async () => {
  const r = await sendOpsNotification({
    event: "ops.notify.test",
    title: "t",
    env: { OPS_NOTIFY_WEBHOOK_URL: "not-https" },
    fetchImpl: async () => { throw new Error("should not send"); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_adapter_configured");
});
