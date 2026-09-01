import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySmtpEnv,
  composeForgotPasswordMail,
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
