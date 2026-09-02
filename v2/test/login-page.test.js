import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("login page can register after accepting the disclaimer", () => {
  const html = readFileSync(path.join(dir, "../public/login.html"), "utf8");
  assert.match(html, /id="tabRegister"/);
  assert.match(html, /id="registerForm"/);
  assert.match(html, /\/api\/register/);
  assert.match(html, /acceptDisclaimer/);
  assert.match(html, /disclaimer\.html/);
  assert.match(html, /這是免費系統/);
  assert.match(html, /--accent: #0da5a0/);
  assert.equal(html.includes("#c45c26"), false);
  assert.equal(html.includes("IwanMincho"), false);
  assert.match(html, /reversal play tech \| 逆遊科技/);
  assert.match(html, /顯示密碼/);
  assert.match(html, /記住帳號/);
  assert.match(html, /591_v2_remember_email/);
  assert.match(html, /id="forgotForm"/);
  assert.match(html, /\/api\/forgot-password/);
  assert.match(html, /寄出臨時密碼/);
  assert.match(html, /!register && !forgot/);
  assert.match(html, /請證明你不是機器人/);
  assert.match(html, /\/api\/captcha/);
  assert.match(html, /captchaId/);
  assert.match(html, /換一張/);
  const blocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    if (/\bsrc\s*=/i.test(block[1])) continue;
    assert.doesNotThrow(() => new Function(block[2]));
  }
});

test("disclaimer page loads the shared copy", () => {
  const html = readFileSync(path.join(dir, "../public/disclaimer.html"), "utf8");
  assert.match(html, /\/api\/disclaimer/);
  assert.match(html, /免費系統/);
  assert.match(html, /贊助是自願/);
  assert.match(html, /reversal play tech \| 逆遊科技/);
});
