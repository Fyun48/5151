import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listingBodyHasUnsafe,
  listingBodyPlain,
  sanitizeListingBodyHtml,
} from "../src/listingBody.js";

test("listing body keeps simple formatting and strips links/scripts", () => {
  const html = sanitizeListingBodyHtml('<b>採光佳</b><script>alert(1)</script><a href="https://evil.test">連</a>近捷運');
  assert.match(html, /<b>採光佳<\/b>/);
  assert.doesNotMatch(html, /script|href|evil/i);
  assert.equal(listingBodyPlain(html).includes("採光佳"), true);
  assert.equal(listingBodyHasUnsafe('<a href="x">x</a>'), true);
});

test("listing body strips img, svg, event handlers and unsafe style", () => {
  const html = sanitizeListingBodyHtml(
    '<span style="color:#0d9488;background:url(javascript:alert(1))">綠</span><img src=x onerror=alert(1)><svg onload=alert(1)></svg>',
  );
  assert.match(html, /<span style="color:#0d9488">綠<\/span>/);
  assert.doesNotMatch(html, /img|svg|onerror|onload|javascript|background/i);
});

test("listing body counts visible text against 500 chars", () => {
  const long = "字".repeat(501);
  const out = sanitizeListingBodyHtml(`<b>${long}</b>`);
  assert.equal(listingBodyPlain(out).length, 500);
});
