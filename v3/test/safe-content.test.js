import { test } from "node:test";
import assert from "node:assert/strict";
import {
  containsUnsafeMarkup,
  escapeHtml,
  renderSafeContent,
  sanitizeDocumentBody,
} from "../src/safeContent.js";

test("unsafe script iframe and event handlers are detected", () => {
  assert.equal(containsUnsafeMarkup("<script>alert(1)</script>"), true);
  assert.equal(containsUnsafeMarkup("<iframe src='https://x'></iframe>"), true);
  assert.equal(containsUnsafeMarkup("<img src=x onerror=alert(1)>"), true);
  assert.equal(containsUnsafeMarkup("javascript:alert(1)"), true);
  assert.equal(containsUnsafeMarkup("一般條款與 emoji ✅"), false);
});

test("sanitize strips unsafe markup and keeps Traditional Chinese plus emoji", () => {
  const cleaned = sanitizeDocumentBody(
    "免責<script>alert(1)</script>聲明\n可接受 ✅ 與「繁中」",
    "plain",
  );
  assert.equal(cleaned.includes("<script>"), false);
  assert.match(cleaned, /免責/);
  assert.match(cleaned, /✅/);
  assert.match(cleaned, /繁中/);
});

test("safe renderer escapes HTML and only allows limited markdown", () => {
  const html = renderSafeContent("第一段 **粗體**\n\n- 項目一\n- 項目二", "markdown");
  assert.match(html, /<strong>粗體<\/strong>/);
  assert.match(html, /<ul>/);
  assert.equal(html.includes("<script>"), false);
  const escaped = renderSafeContent("<b>raw</b>", "plain");
  assert.equal(escaped.includes("<b>"), false);
  assert.match(escaped, /&lt;b&gt;raw&lt;\/b&gt;/);
  assert.equal(escapeHtml("<x>"), "&lt;x&gt;");
});
