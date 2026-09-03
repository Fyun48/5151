import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const pub = (rel) => readFileSync(path.join(dir, "../public", rel), "utf8");

test("Quiet Luxury tokens exist and pages do not use classifieds candy", () => {
  const tokens = pub("tokens.css");
  assert.match(tokens, /Quiet Luxury Property Intelligence/);
  assert.match(tokens, /--accent: #0f6f6a/);
  assert.match(tokens, /--foreground: var\(--ink\)/);
  assert.match(tokens, /--primary: var\(--accent\)/);
  assert.doesNotMatch(tokens, /radial-gradient/);

  for (const rel of ["index.html", "login.html", "admin.html", "disclaimer.html"]) {
    const html = pub(rel);
    assert.match(html, /href="\/tokens\.css"/);
    assert.doesNotMatch(html, /class="hero"/);
    const bodyCss = html.slice(html.indexOf("body {"), html.indexOf("body {") + 280);
    assert.doesNotMatch(bodyCss, /radial-gradient/);
  }

  const index = pub("index.html");
  assert.match(index, /font-variant-numeric: tabular-nums/);
  assert.match(index, /font-size: 20px/);
  assert.match(index, /:focus-visible/);
  assert.match(index, /item-cover\$\{item\.cover \? "" : " empty"\}/);
  assert.match(index, /\.item-title a \{/);
  assert.doesNotMatch(index, /滿版/);
});
