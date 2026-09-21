import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

// Same reasoning as the other isolated suites: a slow runner must not turn timing into a
// failure, so the cap only guards against a real hang.
const ISOLATED_TIMEOUT_MS = Math.max(30_000, Number(process.env.V3_ISOLATED_TEST_TIMEOUT_MS) || 180_000);

test("the preloaded decoration provider decorates exactly like the SQLite pipeline", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-decoration-parity-"));
  try {
    const result = spawnSync(process.execPath, [path.join(dir, "decoration-parity-child.mjs")], {
      encoding: "utf8",
      timeout: ISOLATED_TIMEOUT_MS,
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /decoration parity ok/);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
