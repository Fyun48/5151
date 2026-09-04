import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isWatchIntervalPending } from "../src/watcher.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("manual watch is pending when the last check is still inside the interval", () => {
  const now = Date.parse("2026-09-04T12:00:00.000Z");
  assert.equal(isWatchIntervalPending("2026-09-04T11:59:00.000Z", 5, now), true);
  assert.equal(isWatchIntervalPending("2026-09-04T11:50:00.000Z", 5, now), false);
  assert.equal(isWatchIntervalPending("", 5, now), false);
});

test("member save does not crawl immediately; admin immediate check still forces", () => {
  const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  const saveFn = html.slice(html.indexOf('$("saveBtn").onclick'), html.indexOf('$("scrollTopBtn")'));
  assert.doesNotMatch(saveFn, /\/api\/watch/);
  assert.match(saveFn, /\/api\/profiles/);
  assert.match(html, /body: JSON.stringify\(\{ force: true \}\)/);
  assert.match(server, /req.body\?\.force === true \? "force" : "manual"/);
  assert.match(server, /skipped: "interval"/);
  assert.match(server, /isSystemCoveringDue/);
});
