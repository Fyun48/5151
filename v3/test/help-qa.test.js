import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultHelpQaItems, normalizeHelpQaItems, publicHelpQa } from "../src/helpQa.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("default Q&A explains walkable MRT distance not straight-line", () => {
  const items = defaultHelpQaItems();
  const mrt = items.find((row) => row.id === "mrt-walk");
  assert.ok(mrt);
  assert.match(mrt.question, /捷運站/);
  assert.match(mrt.answer, /步行/);
  assert.match(mrt.answer, /1\.5/);
  assert.match(mrt.answer, /不是房子到捷運站的直線距離/);
  assert.ok(items.some((row) => row.id === "hidden-admin"));
  assert.ok(items.some((row) => row.id === "interval"));
  assert.ok(items.some((row) => row.id === "pwa-ios"));
  assert.ok(items.some((row) => row.id === "demand-wall"));
  assert.ok(items.some((row) => row.id === "not-broker"));
});

test("normalizeHelpQaItems drops empty rows and caps length", () => {
  const out = normalizeHelpQaItems([
    { id: "ok", question: "問？", answer: "答。" },
    { question: "   ", answer: "沒問題" },
    { id: "bad id", question: "第二題", answer: "第二答" },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, "ok");
  assert.equal(out[1].question, "第二題");
  assert.equal(publicHelpQa(out).items.length, 2);
});

test("public help-qa route and admin editor exist", () => {
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  const auth = readFileSync(path.join(dir, "../src/auth.js"), "utf8");
  const db = readFileSync(path.join(dir, "../src/db.js"), "utf8");
  assert.match(server, /app\.get\("\/api\/help-qa"/);
  assert.match(server, /\/api\/admin\/help-qa/);
  assert.match(auth, /\/api\/help-qa/);
  assert.match(db, /helpQa/);
  assert.match(db, /defaultHelpQaItems/);
});

test("index puts Q&A beside the account name", () => {
  const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  const who = html.indexOf('id="who"');
  const btn = html.indexOf('id="helpQaBtn"');
  assert.ok(who > 0 && btn > who);
  assert.match(html, /who-cluster/);
  assert.match(html, /\/api\/help-qa/);
  assert.match(html, /功能說明 Q&amp;A/);
});

test("admin page can add and save Q&A items", () => {
  const html = readFileSync(path.join(dir, "../public/admin.html"), "utf8");
  assert.match(html, /功能說明 Q&amp;A/);
  assert.match(html, /helpQaAdd/);
  assert.match(html, /\/api\/admin\/help-qa/);
  assert.match(html, /reset: true/);
});
