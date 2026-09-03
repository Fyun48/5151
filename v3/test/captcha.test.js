import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertHoneypot,
  assertHuman,
  issueCaptcha,
  normalizeCaptchaAnswer,
  resetCaptchaUsed,
  verifyCaptcha,
} from "../src/captcha.js";
import {
  assertCaptchaIssuable,
  assertNotLocked,
  recordAuthFailure,
  resetAuthRateLimits,
} from "../src/rateLimit.js";

test("captcha verifies case-insensitively and cannot be reused", () => {
  resetCaptchaUsed();
  const cap = issueCaptcha({ code: "ab3k" });
  assert.equal(normalizeCaptchaAnswer(" ab 3k "), "AB3K");
  assert.equal(JSON.stringify(cap).includes("AB3K"), false);
  assert.match(cap.svg, /<svg /);
  assert.match(cap.svg, />A<\/text>/);
  assert.match(cap.svg, />K<\/text>/);
  verifyCaptcha(cap.id, "ab3k");
  assert.throws(() => verifyCaptcha(cap.id, "ab3k"), /已用過/);
});

test("wrong or empty captcha fails", () => {
  resetCaptchaUsed();
  const cap = issueCaptcha({ code: "AB3K" });
  assert.throws(() => verifyCaptcha(cap.id, "ZZZZ"), /驗證碼不對/);
  const cap2 = issueCaptcha({ code: "AB3K" });
  assert.throws(() => verifyCaptcha(cap2.id, ""), /我不是機器人/);
  assert.throws(() => verifyCaptcha("nope", "AB3K"), /我不是機器人|失效/);
});

test("expired captcha is rejected", () => {
  resetCaptchaUsed();
  const cap = issueCaptcha({ code: "AB3K", now: 1_000 });
  assert.throws(() => verifyCaptcha(cap.id, "AB3K", { now: 1_000 + 11 * 60 * 1000 }), /過期/);
});

test("honeypot traps automated form fillers", () => {
  assert.throws(() => assertHoneypot({ website: "http://spam" }), /驗證失敗/);
  assert.doesNotThrow(() => assertHoneypot({ website: "" }));
  resetCaptchaUsed();
  const cap = issueCaptcha({ code: "AB3K" });
  assert.doesNotThrow(() => assertHuman({ captchaId: cap.id, captchaAnswer: "AB3K", website: "" }));
});

test("eight password failures lock that IP or email only", () => {
  resetAuthRateLimits();
  const attacker = ["ip:1.2.3.4", "email:victim@example.com"];
  const neighbor = ["ip:9.9.9.9"];
  for (let i = 0; i < 8; i++) recordAuthFailure(attacker, 1_000);
  assert.throws(() => assertNotLocked(attacker, 1_001), /嘗試太多次/);
  assert.doesNotThrow(() => assertNotLocked(neighbor, 1_001));
  assert.doesNotThrow(() => assertNotLocked(attacker, 1_000 + 15 * 60 * 1000));
});

test("captcha refresh is rate-limited per IP", () => {
  resetAuthRateLimits();
  for (let i = 0; i < 40; i++) assertCaptchaIssuable("1.2.3.4", 5_000);
  assert.throws(() => assertCaptchaIssuable("1.2.3.4", 5_001), /換太多次/);
  assert.doesNotThrow(() => assertCaptchaIssuable("8.8.8.8", 5_001));
});
