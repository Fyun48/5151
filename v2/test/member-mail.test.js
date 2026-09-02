import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GMAIL_APP_PASSWORD_HINT,
  listingMailPresetById,
  listingMailPresets,
  looksLikeGmail,
  publicMemberMail,
  smtpReady,
} from "../src/memberMail.js";
import { mailConfigured, smtpConfigFrom } from "../src/mail.js";

test("listing mail presets include concise, detailed, and facts", () => {
  const ids = listingMailPresets().map((row) => row.id);
  assert.deepEqual(ids, ["concise", "detailed", "facts"]);
  const detailed = listingMailPresetById("detailed");
  assert.match(detailed.text, /\{\{facts\}\}/);
  assert.equal(listingMailPresetById("missing").id, "detailed");
});

test("gmail detection and app-password hint", () => {
  assert.equal(looksLikeGmail({ host: "smtp.gmail.com" }), true);
  assert.equal(looksLikeGmail({ user: "me@gmail.com" }), true);
  assert.equal(looksLikeGmail({ host: "smtp.mail.yahoo.com" }), false);
  assert.match(GMAIL_APP_PASSWORD_HINT, /應用程式密碼/);
});

test("public member mail never returns the SMTP password", () => {
  const pub = publicMemberMail(
    { host: "smtp.gmail.com", port: 587, user: "me@gmail.com", pass: "secret-app-pass", from: "me@gmail.com" },
    listingMailPresetById("concise"),
    "concise",
  );
  assert.equal(pub.configured, true);
  assert.equal(pub.gmail, true);
  assert.equal(pub.smtp.passSet, true);
  assert.equal(pub.smtp.host, "smtp.gmail.com");
  assert.equal(JSON.stringify(pub).includes("secret-app-pass"), false);
  assert.equal(smtpReady({ host: "", from: "a@b.com" }), false);
});

test("sendMail can use a member SMTP override without touching env defaults", () => {
  const cfg = smtpConfigFrom({
    host: "smtp.member.test",
    port: 587,
    user: "me@example.com",
    pass: "x",
    from: "me@example.com",
    fromName: "591",
  });
  assert.equal(cfg.host, "smtp.member.test");
  assert.equal(mailConfigured(cfg), true);
});

test("index page has a same-page notify hub and Discord guide", () => {
  const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"), "utf8");
  assert.match(html, /id="notifyHub"/);
  assert.match(html, /data-open-hub="webhook"/);
  assert.match(html, /data-open-hub="mail"/);
  assert.match(html, /discord.com\/register/);
  assert.match(html, /應用程式密碼/);
  assert.match(html, /id="mailPreset"/);
  assert.match(html, /function openNotifyHub/);
  assert.match(html, /\/api\/member-mail/);
});

test("server exposes member-mail APIs", () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/server.js"), "utf8");
  assert.match(src, /app\.get\("\/api\/member-mail"/);
  assert.match(src, /app\.post\("\/api\/member-mail"/);
  assert.match(src, /app\.post\("\/api\/member-mail\/test"/);
});
