import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveAppRole,
  roleRunsWeb,
  roleRunsCrawler,
  roleRunsWorker,
  ROLES,
} from "../src/appRole.js";

test("resolveAppRole defaults to all and accepts each valid role", () => {
  assert.equal(resolveAppRole({}), "all");
  assert.equal(resolveAppRole({ APP_ROLE: "web" }), "web");
  assert.equal(resolveAppRole({ APP_ROLE: "crawler" }), "crawler");
  assert.equal(resolveAppRole({ APP_ROLE: "worker" }), "worker");
  assert.equal(resolveAppRole({ APP_ROLE: "all" }), "all");
  assert.equal(resolveAppRole({ APP_ROLE: "WEB" }), "web");
  assert.equal(resolveAppRole({ APP_ROLE: "bogus" }), "all");
});

test("role predicates include all", () => {
  for (const role of ROLES) {
    assert.equal(roleRunsWeb(role), role === "web" || role === "all");
    assert.equal(roleRunsCrawler(role), role === "crawler" || role === "all");
    assert.equal(roleRunsWorker(role), role === "worker" || role === "all");
  }
});

test("server.js gates background loops by role and keeps a no-HTTP branch", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  assert.match(src, /const APP_ROLE = resolveAppRole\(\)/);
  assert.match(src, /if \(roleRunsWeb\(APP_ROLE\)\)/);
  assert.match(src, /function startWorkerLoops\(\)/);
  assert.match(src, /function startStartupWork\(\)/);
  // crawler gating
  assert.match(src, /if \(roleRunsCrawler\(APP_ROLE\)\) schedule\(\)/);
  // worker gating
  assert.match(src, /if \(roleRunsWorker\(APP_ROLE\)\) startWorkerLoops\(\)/);
  // no-HTTP branch for crawler/worker
  assert.match(src, /以 \$\{APP_ROLE\} 角色啟動（不提供 HTTP）/);
});
