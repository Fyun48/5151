import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureProviderDrawerSchema, listDrawers, resolveDrawerKind, saveDrawer } from "../src/providerDrawer.js";
import { makeProvider } from "../src/ai/provider.js";
import { makeCodingProvider } from "../src/coding/provider.js";

function open() {
  const db = new DatabaseSync(":memory:");
  ensureProviderDrawerSchema(db);
  return db;
}

test("drawers default off and env still wins until enabled", () => {
  const db = open();
  const env = { AI_PROVIDER: "stub" };
  assert.equal(resolveDrawerKind(db, "analysis", "AI_PROVIDER", env), "stub");
  const items = listDrawers(db, env);
  assert.equal(items.length, 6);
  assert.equal(items.every((row) => row.is_enabled === false), true);
  db.close();
});

test("enabled drawer overrides env and does not echo secrets", () => {
  const db = open();
  const saved = saveDrawer(db, "analysis", {
    is_enabled: true,
    provider_code: "stub",
    credential: "ops-secret-key",
  }, { env: { AI_PROVIDER: "local" } });
  assert.equal(saved.resolved_kind, "stub");
  assert.equal(saved.has_credential, true);
  assert.equal(JSON.stringify(saved).includes("ops-secret-key"), false);
  assert.equal(resolveDrawerKind(db, "analysis", "AI_PROVIDER", { AI_PROVIDER: "local" }), "stub");
  db.close();
});

test("cursor coding drawer stays unavailable", () => {
  const provider = makeCodingProvider({}, { kind: "cursor" });
  assert.equal(provider.available, false);
  assert.equal(provider.setup.status, "pending_integration");
});

test("openai drawer kind does not invent a live adapter", () => {
  const provider = makeProvider({}, { kind: "openai" });
  assert.equal(provider.available, false);
});

test("console has provider drawer tab", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(path.join(dir, "../public/console.html"), "utf8");
  const js = readFileSync(path.join(dir, "../public/console.js"), "utf8");
  assert.match(html, /data-tab="providers"/);
  assert.match(html, /id="tab-providers"[^>]*hidden/);
  assert.match(html, /供應商抽屜/);
  assert.match(js, /\/ops\/api\/providers/);
  assert.match(js, /refreshProviders/);
  assert.match(js, /DRAWER_CODE_LABEL/);
  assert.match(js, /儲存中…/);
});
