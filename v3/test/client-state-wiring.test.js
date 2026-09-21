import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("frontend persists filter/sort/district into a versioned client state", () => {
  const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  assert.match(html, /CLIENT_STATE_KEY = "5151-client-state-v1"/);
  assert.match(html, /function readClientState\(\)/);
  assert.match(html, /function writeClientState\(patch\)/);
  assert.match(html, /function persistSearchState\(\)/);
  assert.match(html, /function restoreSearchState\(\)/);
  // restore on boot + persist on the three search-condition handlers.
  assert.match(html, /restoreSearchState\(\);[\s\S]*?filter = btn\.dataset\.filter;[\s\S]*?persistSearchState\(\);/);
  assert.match(html, /persistSearchState\(\);[\s\S]*?sort = btn\.dataset\.sort/);
});

test("panel / filter-compact / more-condition live in the versioned client state", () => {
  const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  // The two legacy keys are only read once (adoption) and then removed: no code writes them.
  assert.doesNotMatch(html, /localStorage\.setItem\(PANEL_KEY/);
  assert.doesNotMatch(html, /localStorage\.setItem\(FILTER_COMPACT_KEY/);
  assert.match(html, /function adoptLegacyLayoutState\(\)/);
  assert.match(html, /localStorage\.removeItem\(PANEL_KEY\)/);
  assert.match(html, /localStorage\.removeItem\(FILTER_COMPACT_KEY\)/);
  // Both toggles write through the versioned state.
  assert.match(html, /function setPanelCollapsed\(on\)[\s\S]*?writeClientState\(\{ panel: \{ \.\.\.readClientState\(\)\.panel, collapsed: Boolean\(on\) \} \}\)/);
  assert.match(html, /function setFilterCompact\(on\)[\s\S]*?moreCondition: \{ expanded: !on \}/);
  // Boot restores the layout from the versioned state (legacy values folded in first).
  assert.match(html, /bootLayout\.panel\.collapsed/);
  assert.match(html, /bootLayout\.panel\.filterCompact !== false/);
  assert.match(html, /const bootLayout = \(\(\) => \{/);
});

test("pagination and scroll are captured into the versioned client state on page hide", () => {
  const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  assert.match(html, /function persistListPositionState\(\)/);
  assert.match(html, /pagination: \{ cursor: listCursor, offset: listOffset \}/);
  assert.match(html, /scroll: \{ top: Math\.max\(0, Math\.round\(getScrollTop\(\)\)\) \}/);
  assert.match(html, /window\.addEventListener\("pagehide", persistListPositionState\)/);
  assert.match(html, /visibilitychange[\s\S]{0,160}persistListPositionState\(\)/);
});
