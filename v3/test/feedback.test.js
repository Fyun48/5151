import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createFeedback,
  ensureFeedbackSchema,
  feedbackMeta,
  feedbackStats,
  FEEDBACK_LEGAL,
  listFeedback,
  normalizeFeedbackContext,
  normalizeFeedbackKind,
  normalizeFeedbackStatus,
  updateFeedback,
} from "../src/feedback.js";

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      nickname TEXT,
      created_at TEXT
    );
  `);
  db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (?, ?, ?, ?)")
    .run(1, "a@example.com", "小明", "2026-01-01T00:00:00.000Z");
  ensureFeedbackSchema(db);
  return db;
}

test("normalizers coerce to known values", () => {
  assert.equal(normalizeFeedbackKind("bug"), "bug");
  assert.equal(normalizeFeedbackKind("BUG"), "bug");
  assert.equal(normalizeFeedbackKind("nope"), "other");
  assert.equal(normalizeFeedbackStatus("done"), "done");
  assert.equal(normalizeFeedbackStatus("weird"), "new");
});

test("context is capped and only keeps known fields", () => {
  const ctx = normalizeFeedbackContext({
    route: "/",
    view: "listings",
    q: "士林",
    filter: "排除頂樓",
    ua: "x".repeat(1000),
    errors: ["a", "b", "c", "d", "e", "f", "g"],
    secret: "should be dropped",
  });
  assert.equal(ctx.view, "listings");
  assert.equal(ctx.q, "士林");
  assert.equal(ctx.ua.length, 400);
  assert.equal(ctx.errors.length, 5);
  assert.equal(ctx.secret, undefined);
  assert.deepEqual(normalizeFeedbackContext("not json"), {});
});

test("createFeedback stores structured feedback and rejects too-short body", () => {
  const db = open();
  assert.match(feedbackMeta().legal, /只給站方看/);
  assert.match(FEEDBACK_LEGAL, /修 bug/);
  assert.throws(() => createFeedback(db, 1, { kind: "bug", body: "短" }), /至少/);
  const created = createFeedback(db, 1, {
    kind: "bug",
    body: "手機上篩選面板的關閉鈕蓋到標題",
    contact: "a@example.com",
    context: { view: "listings", viewport: "412x915" },
  });
  assert.equal(created.ok, true);
  assert.ok(created.id > 0);
  const items = listFeedback(db);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "bug");
  assert.equal(items[0].nickname, "小明");
  assert.equal(items[0].context.view, "listings");
  assert.equal(items[0].status, "new");
  db.close();
});

test("honeypot silently drops spam without storing", () => {
  const db = open();
  const res = createFeedback(db, 1, { kind: "idea", body: "spam spam", website: "http://spam" });
  assert.equal(res.ok, true);
  assert.equal(res.id, 0);
  assert.equal(listFeedback(db).length, 0);
  db.close();
});

test("rate limit blocks rapid repeat submissions", () => {
  const db = open();
  const t0 = new Date("2026-02-01T00:00:00.000Z");
  createFeedback(db, 1, { kind: "idea", body: "第一則建議" }, t0);
  assert.throws(
    () => createFeedback(db, 1, { kind: "idea", body: "第二則建議" }, new Date(t0.getTime() + 1000)),
    /稍等|上限/,
  );
  // 間隔夠久就可以再送
  const ok = createFeedback(db, 1, { kind: "idea", body: "第二則建議" }, new Date(t0.getTime() + 60 * 1000));
  assert.equal(ok.ok, true);
  db.close();
});

test("admin can update status and note; stats aggregate", () => {
  const db = open();
  const a = createFeedback(db, 1, { kind: "bug", body: "問題描述一" }, new Date("2026-03-01T00:00:00.000Z"));
  createFeedback(db, 1, { kind: "idea", body: "建議描述一" }, new Date("2026-03-01T01:00:00.000Z"));
  const updated = updateFeedback(db, a.id, { status: "done", admin_note: "已於 3.48 修好" });
  assert.equal(updated.status, "done");
  assert.equal(updated.admin_note, "已於 3.48 修好");
  const stats = feedbackStats(db);
  assert.equal(stats.total, 2);
  assert.equal(stats.byStatus.done, 1);
  assert.equal(stats.byStatus.new, 1);
  assert.equal(stats.byKind.bug, 1);
  assert.equal(stats.byKind.idea, 1);
  assert.equal(listFeedback(db, { status: "done" }).length, 1);
  assert.equal(listFeedback(db, { kind: "idea" }).length, 1);
  assert.throws(() => updateFeedback(db, 9999, { status: "done" }), /找不到/);
  db.close();
});

const dir = path.dirname(fileURLToPath(import.meta.url));
const readSrc = (rel) => readFileSync(path.join(dir, "..", rel), "utf8");

test("server wires feedback endpoints", () => {
  const server = readSrc("src/server.js");
  assert.match(server, /app\.post\("\/api\/feedback"/);
  assert.match(server, /app\.get\("\/api\/admin\/feedback"/);
  assert.match(server, /app\.patch\("\/api\/admin\/feedback\/:id"/);
  assert.match(server, /submitFeedback/);
  const db = readSrc("src/db.js");
  assert.match(db, /ensureFeedbackSchema\(db\)/);
  assert.match(db, /export function submitFeedback/);
});

test("index.html exposes feedback entry, modal and context capture", () => {
  const html = readSrc("public/index.html");
  assert.match(html, /id="feedbackBtn"/);
  assert.match(html, /id="feedbackDialog"/);
  assert.match(html, /id="feedbackForm"/);
  assert.match(html, /data-fb-kind="bug"/);
  assert.match(html, /function buildFeedbackContext/);
  assert.match(html, /window\.__fbErrors/);
  assert.match(html, /"\/api\/feedback"/);
  // honeypot field present and visually hidden
  assert.match(html, /id="feedbackHp"/);
});

test("admin.html exposes feedback inbox", () => {
  const html = readSrc("public/admin.html");
  assert.match(html, /data-admin-panel="feedback"/);
  assert.match(html, /data-admin-nav="feedback"/);
  assert.match(html, /async function loadFeedback/);
  assert.match(html, /\/api\/admin\/feedback/);
  assert.match(html, /data-fb-save/);
  assert.match(html, /id="opsOutboxCompact"[^>]*hidden/);
  assert.match(html, /button\[hidden\], a\.ghost\[hidden\], a\.primary\[hidden\]/);
  assert.match(html, /display:\s*none\s*!important/);
});
