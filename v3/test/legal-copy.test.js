import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultLegalCopy, normalizeLegalCopy, publicLegalCopy } from "../src/legalCopy.js";

test("legal copy keeps disclaimer and privacy for register and profile", () => {
  const defaults = defaultLegalCopy();
  assert.match(defaults.disclaimer, /免費/);
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
  assert.equal(pub.text, "免責本文");
  assert.equal(pub.privacy_text, "個資本文");
  assert.equal(pub.disclaimerCheck, "勾免責");
});
