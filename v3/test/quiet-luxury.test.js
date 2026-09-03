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
  assert.match(tokens, /--touch: 44px/);
  assert.match(tokens, /--text-price: 20px/);

  for (const rel of ["index.html", "login.html", "admin.html", "disclaimer.html", "reset.html"]) {
    const html = pub(rel);
    assert.match(html, /href="\/tokens\.css"/);
    assert.doesNotMatch(html, /class="hero"/);
    const bodyCss = html.slice(html.indexOf("body {"), html.indexOf("body {") + 280);
    assert.doesNotMatch(bodyCss, /radial-gradient/);
    assert.doesNotMatch(html, /:root \{\s*--bg:/);
  }

  const index = pub("index.html");
  assert.match(index, /font-variant-numeric: tabular-nums/);
  assert.match(index, /font-size: 20px/);
  assert.match(index, /:focus-visible/);
  assert.match(index, /item-cover\$\{item\.cover \? "" : " empty"\}/);
  assert.match(index, /\.item-title a \{/);
  assert.match(index, /@media \(max-width: 767px\)/);
  assert.match(index, /min-height: var\(--touch\)/);
  assert.doesNotMatch(index, /滿版/);
});

test("MASTER matches shipped Quiet Luxury tokens", () => {
  const master = readFileSync(path.join(dir, "../../design-system/property-platform/MASTER.md"), "utf8");
  assert.match(master, /#f3efe8/);
  assert.match(master, /#0f6f6a/);
  assert.match(master, /不要再複製一份/);
  assert.match(master, /768 起晶片改換行/);
});
