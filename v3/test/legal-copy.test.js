import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultLegalCopy, ensureIdleLegalClauses, IDLE_LEGAL_PARAGRAPH, normalizeLegalCopy, publicLegalCopy } from "../src/legalCopy.js";

test("legal copy keeps disclaimer and privacy for register and profile", () => {
  const defaults = defaultLegalCopy();
  assert.match(defaults.disclaimer, /免費/);
  assert.match(defaults.disclaimer, /兩個月/);
  assert.match(defaults.disclaimer, /不會另外寄信/);
  assert.match(defaults.disclaimer, /一年/);
  assert.match(defaults.disclaimer, /仍在評估/);
  assert.match(defaults.disclaimerCheck, /免責/);
  assert.match(defaults.privacy, /不公開/);
  assert.match(defaults.privacyCheck, /個資/);
  const next = normalizeLegalCopy({
    disclaimer: " 免責本文 ",
    disclaimerCheck: "勾免責",
    privacy: "個資本文",
    privacyCheck: "勾個資",
  });
  assert.equal(next.disclaimer, "免責本文");
  const pub = publicLegalCopy(next);
  assert.equal(pub.privacy_text, "個資本文");
  assert.equal(pub.disclaimerCheck, "勾免責");
  assert.match(pub.disclaimer, /兩個月/);
  assert.match(pub.disclaimer, /一年/);
  assert.match(pub.text, /仍在評估/);
});

test("old stored disclaimer still gets idle and year-deletion clauses", () => {
  assert.equal(ensureIdleLegalClauses(""), IDLE_LEGAL_PARAGRAPH);
  const merged = ensureIdleLegalClauses("這是免費系統。");
  assert.match(merged, /這是免費系統/);
  assert.match(merged, /兩個月/);
  assert.match(merged, /不會另外寄信/);
  assert.match(merged, /一年/);
  const already = ensureIdleLegalClauses(IDLE_LEGAL_PARAGRAPH);
  assert.equal(already, IDLE_LEGAL_PARAGRAPH);
  const yearOnly = ensureIdleLegalClauses("超過約兩個月沒登入會暫停抓取。");
  assert.match(yearOnly, /停權或刪除/);
});
