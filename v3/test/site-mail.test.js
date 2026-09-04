import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySmtpEnv,
  composeAccountMail,
  composeForgotPasswordMail,
  composeListingNotifyMail,
  defaultMailTemplates,
  mergeEnvMap,
  normalizeSmtp,
  parseEnvFileText,
  publicSmtp,
  renderMailTemplate,
  serializeEnvMap,
  smtpFromEnv,
} from "../src/siteMail.js";

test("renderMailTemplate fills placeholders", () => {
  const token = ["ab", "12"].join("");
  const out = renderMailTemplate(
    { subject: "密碼 {{tempPassword}}", text: "給 {{email}}：{{tempPassword}}" },
    { tempPassword: token, email: "a@b.com" },
  );
  assert.equal(out.subject, `密碼 ${token}`);
  assert.match(out.text, /a@b\.com/);
  assert.match(out.text, /ab12/);
});

test("normalizeSmtp keeps previous password when blank or masked", () => {
  const dummy = ["keep", "me"].join("-");
  const blank = normalizeSmtp({ host: "localhost", pass: "" }, { pass: dummy });
  assert.equal(blank.pass, dummy);
  const masked = normalizeSmtp({ host: "localhost", pass: "(unchanged)" }, { pass: dummy });
  assert.equal(masked.pass, dummy);
  const next = normalizeSmtp({ host: "localhost", pass: ["replace", "me"].join("-") }, { pass: dummy });
  assert.equal(next.pass, "replace-me");
});

test("publicSmtp never includes the raw password", () => {
  const hidden = ["hidden", "value"].join("-");
  const row = { host: "localhost", from: "a@b.com", port: 465, secure: true };
  row.pass = hidden;
  const pub = publicSmtp(row);
  assert.equal(pub.passSet, true);
  assert.equal(pub.pass, undefined);
  assert.doesNotMatch(JSON.stringify(pub), /hidden-value/);
});

test("auth.env merge keeps non-SMTP keys", () => {
  const existing = parseEnvFileText("AUTH_EMAIL=admin@test.local\nSMTP_HOST=old.example.com\n");
  const merged = mergeEnvMap(existing, { SMTP_HOST: "smtp.example.com", SMTP_PORT: "587" });
  const text = serializeEnvMap(merged);
  assert.match(text, /AUTH_EMAIL=admin@test.local/);
  assert.match(text, /SMTP_HOST=smtp.example.com/);
});

test("composeAccountMail fills welcome, password, and sponsor templates", () => {
  const welcome = composeAccountMail("welcome", defaultMailTemplates(), { email: "a@b.com" });
  assert.match(welcome.subject, /確認信箱/);
  assert.match(welcome.text, /a@b\.com/);
  assert.match(welcome.text, /\{\{verifyUrl\}\}|verifyUrl|自己的 SMTP/);
  const verifyMail = composeAccountMail("welcome", defaultMailTemplates(), {
    email: "a@b.com",
    verifyUrl: "https://c5151.reversalplay.me/verify-email?token=abc",
  });
  assert.match(verifyMail.text, /verify-email\?token=abc/);
  const verified = composeAccountMail("verified_welcome", defaultMailTemplates(), {
    email: "a@b.com",
    spiritUrl: "https://c5151.reversalplay.me/spirit.html",
  });
  assert.match(verified.subject, /歡迎加入/);
  assert.match(verified.text, /spirit\.html/);
  assert.match(verified.text, /有沒有贊助都不影響/);
  const expired = composeAccountMail("verify_expired", defaultMailTemplates(), { email: "a@b.com" });
  assert.match(expired.subject, /失效/);
  assert.match(expired.text, /3 天/);
  const changed = composeAccountMail("password_changed", defaultMailTemplates(), { email: "a@b.com" });
  assert.match(changed.subject, /密碼已變更/);
  assert.match(changed.text, /忘記密碼/);
  const sponsor = composeAccountMail("sponsor_thanks", defaultMailTemplates(), { email: "a@b.com" });
  assert.match(sponsor.subject, /贊助/);
  assert.match(sponsor.text, /已標成已贊助/);
  const empty = composeAccountMail("nope", defaultMailTemplates(), { email: "a@b.com" });
  assert.equal(empty.subject, "");
  const deleted = composeAccountMail("account_deleted", defaultMailTemplates(), {
    email: "a@b.com",
    reason: "同時間多個不同 IP 使用",
  });
  assert.match(deleted.subject, /關閉/);
  assert.match(deleted.text, /同時間多個不同 IP/);
});

test("forgot-password compose falls back if template drops the password", () => {
  const token = ["temp", "pass", "99"].join("-");
  const ok = composeForgotPasswordMail(defaultMailTemplates(), { tempPassword: token, email: "a@b.com" });
  assert.match(ok.text, /temp-pass-99/);
  const dropped = composeForgotPasswordMail(
    { forgot_password: { subject: "密碼信", text: "沒有寫密碼" } },
    { tempPassword: token },
  );
  assert.match(dropped.text, /temp-pass-99/);
});

test("listing notify compose fills event title price facts url", () => {
  const one = composeListingNotifyMail(defaultMailTemplates(), [{
    event: "全新物件",
    title: "士林二房",
    price: "28000 元/月",
    facts: "士林區 · 2房",
    url: "https://rent.591.com.tw/99",
    detail: "",
    email: "member@example.com",
  }]);
  assert.match(one.subject, /全新物件/);
  assert.match(one.text, /士林二房/);
  assert.match(one.text, /28000/);
  assert.match(one.text, /rent\.591\.com\.tw\/99/);
  const many = composeListingNotifyMail(defaultMailTemplates(), [
    { event: "全新物件", title: "甲", price: "1", facts: "", url: "https://example.com/a" },
    { event: "價格調降", title: "乙", price: "2", facts: "", url: "https://example.com/b" },
  ]);
  assert.match(many.subject, /2 則更新/);
  assert.match(many.text, /甲/);
  assert.match(many.text, /乙/);
});

test("smtpFromEnv and applySmtpEnv round-trip host/from", () => {
  const keys = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "SMTP_FROM_NAME", "SMTP_SECURE"];
  const prev = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    applySmtpEnv({ host: "smtp.roundtrip.test", port: 587, from: "bot@roundtrip.test", user: "", pass: "", fromName: "591", secure: false });
    const parsed = smtpFromEnv();
    assert.equal(parsed.host, "smtp.roundtrip.test");
    assert.equal(parsed.from, "bot@roundtrip.test");
  } finally {
    for (const key of keys) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
});
