import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultHelpQaItems, mergeMissingDefaultHelpQa, normalizeHelpQaItems, publicHelpQa } from "../src/helpQa.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("default Q&A explains walkable MRT distance not straight-line", () => {
  const items = defaultHelpQaItems();
  const mrt = items.find((row) => row.id === "mrt-walk");
  assert.ok(mrt);
  assert.match(mrt.question, /捷運站/);
  assert.match(mrt.answer, /步行/);
  assert.match(mrt.answer, /1\.5/);
  assert.match(mrt.answer, /不是房子到捷運站的直線距離/);
  assert.match(mrt.answer, /管理員在後台/);
  assert.match(mrt.answer, /會員不能開關/);
  assert.ok(items.some((row) => row.id === "hidden-admin"));
  assert.ok(items.some((row) => row.id === "extra-fees"));
  const oauth = items.find((row) => row.id === "oauth-idle");
  assert.match(oauth.answer, /開通連結/);
  assert.match(oauth.answer, /帶入/);
  assert.match(oauth.answer, /個人資料/);
  assert.match(oauth.answer, /不能更改/);
  assert.match(oauth.answer, /兩個月/);
  assert.match(oauth.answer, /不會另外寄信/);
  assert.match(oauth.answer, /仍在評估/);
  assert.ok(items.some((row) => row.id === "interval"));
  assert.ok(items.some((row) => row.id === "pwa-ios"));
  assert.ok(items.some((row) => row.id === "self-listings"));
  assert.ok(items.some((row) => row.id === "demand-wall"));
  assert.ok(items.some((row) => row.id === "extra-portals"));
  assert.ok(items.some((row) => row.id === "listing-fit"));
  assert.ok(items.some((row) => row.id === "same-house-cost"));
  const sameHouse = items.find((row) => row.id === "same-house-cost");
  assert.match(sameHouse.answer, /先別打這則/);
  assert.match(sameHouse.answer, /變更時間/);
  assert.match(sameHouse.answer, /交叉比對/);
  assert.match(sameHouse.answer, /收合/);
  assert.match(sameHouse.answer, /主列表只留/);
  assert.match(sameHouse.answer, /不是同一間/);
  assert.match(sameHouse.answer, /先只從你的列表拆開/);
  assert.doesNotMatch(sameHouse.answer, /確認同一間後/);
  assert.match(oauth.answer, /開站使用/);
  assert.ok(items.some((row) => row.id === "viewed-once"));
  assert.ok(items.some((row) => row.id === "register-verify"));
  assert.ok(items.some((row) => row.id === "notify-page"));
  assert.ok(items.some((row) => row.id === "profile-nick"));
  assert.ok(items.some((row) => row.id === "profile-privacy"));
  assert.ok(items.some((row) => row.id === "self-verify"));
  assert.ok(items.some((row) => row.id === "self-rich"));
  assert.ok(items.some((row) => row.id === "not-broker"));
  const fit = items.find((row) => row.id === "listing-fit");
  assert.match(fit.answer, /不是成交預測/);
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

test("mergeMissingDefaultHelpQa appends new default ids", () => {
  const merged = mergeMissingDefaultHelpQa([
    { id: "extra-portals", question: "舊問？", answer: "舊答。" },
  ]);
  assert.equal(merged.find((row) => row.id === "extra-portals").answer, "舊答。");
  assert.ok(merged.some((row) => row.id === "listing-fit"));
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
  assert.match(db, /profileOnboardedBackfill/);
});

test("index puts Q&A beside the account name and as its own view", () => {
  const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  const who = html.indexOf('id="who"');
  const btn = html.indexOf('id="helpQaBtn"');
  assert.ok(who > 0 && btn > who);
  assert.match(html, /who-cluster/);
  assert.match(html, /\/api\/help-qa/);
  assert.match(html, /功能說明 Q&amp;A/);
  assert.match(html, /id="qaView"/);
  assert.match(html, /id="meHelpQaBtn"/);
  assert.match(html, /setAppView\("qa"\)/);
  assert.match(html, /html\.no-session #helpQaBtn/);
  assert.match(html, /body\.role-guest #helpQaBtn/);
  assert.match(html, /helpQaBtn"\)\.hidden = isGuest/);
  assert.doesNotMatch(html, /id="helpQaDialog"/);
});

test("admin page can add and save Q&A items", () => {
  const html = readFileSync(path.join(dir, "../public/admin.html"), "utf8");
  assert.match(html, /功能說明 Q&amp;A/);
  assert.match(html, /helpQaAdd/);
  assert.match(html, /\/api\/admin\/help-qa/);
  assert.match(html, /reset: true/);
});
