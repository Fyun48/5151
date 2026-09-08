import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const WRITER = path.join(ROOT, ".github/scripts/write-phase15-workflow-evidence.py");
const INTEGRITY = path.join(ROOT, ".github/scripts/verify-sqlite-integrity-json.py");
const REMOTE = path.join(ROOT, ".github/scripts/production-predeploy-remote.sh");

const BASE_ENV = {
  WF_FILE: ".github/workflows/deploy-v3.yml",
  WF_REF: "refs/heads/master",
  WF_RUN_ID: "34219160999",
  WF_ATTEMPT: "1",
  WF_HEAD_SHA: "a".repeat(40),
  SOURCE_SHA: "a".repeat(40),
  WF_ACTOR: "Fyun48",
  WF_TRIGGERING_ACTOR: "Fyun48",
  RELEASE_INTENT_ID: "intent_writer_regression",
  WF_ENVIRONMENT: "production",
  CONFIRMATION: "DEPLOY-PRODUCTION",
  IMAGE_DIGEST: "sha256:" + "ab".repeat(32),
  OCI_REVISION: "a".repeat(40),
  OCI_SOURCE: "https://github.com/Fyun48/5151",
};

function writeEvidence(extraEnv = {}, outfile = "phase15-workflow-evidence.json") {
  const dir = mkdtempSync(path.join(tmpdir(), "phase15-ev-"));
  const dest = path.join(dir, outfile);
  try {
    execFileSync("python3", [WRITER, dest], {
      env: { ...process.env, ...BASE_ENV, ...extraEnv },
      encoding: "utf8",
    });
    return { dir, dest, doc: JSON.parse(readFileSync(dest, "utf8")) };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

async function writeEvidenceFails(extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "phase15-ev-"));
  const dest = path.join(dir, "phase15-workflow-evidence.json");
  await assert.rejects(
    () => execFileAsync("python3", [WRITER, dest], {
      env: { ...process.env, ...BASE_ENV, ...extraEnv },
    }),
    /required|must be exactly|HEALTH_OBSERVED|BACKUP_VERIFIED/i,
  );
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(dest), false);
  rmSync(dir, { recursive: true, force: true });
}

test("integrity JSON requires integrity_check ok and boolean ok true", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "phase15-int-"));
  const failPath = path.join(dir, "bad.json");
  writeFileSync(failPath, JSON.stringify({ integrity_check: "ok", ok: false }));
  assert.throws(() => execFileSync("python3", [INTEGRITY, failPath], { encoding: "utf8" }), /integrity check failed/);
  writeFileSync(failPath, JSON.stringify({ integrity_check: "not ok", ok: true }));
  assert.throws(() => execFileSync("python3", [INTEGRITY, failPath], { encoding: "utf8" }), /integrity check failed/);
  writeFileSync(failPath, JSON.stringify({ integrity_check: "ok" }));
  assert.throws(() => execFileSync("python3", [INTEGRITY, failPath], { encoding: "utf8" }), /integrity check failed/);
  const okPath = path.join(dir, "ok.json");
  writeFileSync(okPath, JSON.stringify({ integrity_check: "ok", ok: true }));
  execFileSync("python3", [INTEGRITY, okPath], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
});

test("predeploy remote script no longer greps for the ok token", () => {
  const script = readFileSync(REMOTE, "utf8");
  assert.doesNotMatch(script, /grep -q '"ok"'/);
  assert.match(script, /verify-sqlite-integrity-json\.py/);
});

test("host-node, Python, and container-node integrity producers share one fail-closed schema", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "phase15-int-e2e-"));
  const dbPath = path.join(dir, "v3.db");
  execFileSync("python3", ["-c", `
import sqlite3
con = sqlite3.connect(${JSON.stringify(dbPath)})
con.execute("CREATE TABLE t(id INTEGER)")
con.commit()
con.close()
`]);
  const inspect = path.join(ROOT, ".github/scripts/sqlite-readonly-inspect.mjs");
  const nodeJson = JSON.parse(execFileSync("node", [inspect, dbPath, "integrity"], { encoding: "utf8" }));
  const pythonJson = JSON.parse(execFileSync("python3", ["-c", `
import json, sqlite3, sys, urllib.parse
path = sys.argv[1]
uri = "file:" + urllib.parse.quote(path, safe="/") + "?mode=ro"
con = sqlite3.connect(uri, uri=True)
try:
    row = con.execute("PRAGMA integrity_check").fetchone()
    result = row[0] if row else None
finally:
    con.close()
print(json.dumps({"integrity_check": result, "ok": result == "ok"}))
`, dbPath], { encoding: "utf8" }));
  for (const doc of [nodeJson, pythonJson]) {
    assert.equal(doc.integrity_check, "ok");
    assert.equal(doc.ok, true);
    assert.deepEqual(Object.keys(doc).sort(), ["integrity_check", "ok"]);
    execFileSync("python3", [INTEGRITY], { input: JSON.stringify(doc), encoding: "utf8" });
  }
  assert.throws(() => execFileSync("python3", [INTEGRITY], {
    input: JSON.stringify({ integrity_check: "ok" }),
    encoding: "utf8",
  }));
  rmSync(dir, { recursive: true, force: true });
});

test("BACKUP_VERIFIED missing fails evidence creation", async () => {
  await writeEvidenceFails({
    BACKUP_ID: "/tmp/backup",
    BACKUP_HASH: "sha256:" + "11".repeat(32),
  });
});

test("HEALTH_API missing fails evidence creation", async () => {
  await writeEvidenceFails({
    HEALTH_OBSERVED: "true",
    HEALTH_LANDING: "true",
    HEALTH_LOGIN: "true",
    HEALTH_CONTAINER: "true",
  });
});

test("HEALTH_LANDING missing fails evidence creation", async () => {
  await writeEvidenceFails({
    HEALTH_OBSERVED: "true",
    HEALTH_API: "true",
    HEALTH_LOGIN: "true",
    HEALTH_CONTAINER: "true",
  });
});

test("HEALTH_LOGIN missing fails evidence creation", async () => {
  await writeEvidenceFails({
    HEALTH_OBSERVED: "true",
    HEALTH_API: "true",
    HEALTH_LANDING: "true",
    HEALTH_CONTAINER: "true",
  });
});

test("HEALTH_CONTAINER missing fails evidence creation", async () => {
  await writeEvidenceFails({
    HEALTH_OBSERVED: "true",
    HEALTH_API: "true",
    HEALTH_LANDING: "true",
    HEALTH_LOGIN: "true",
  });
});

test("explicit health and backup flags are recorded without defaults", () => {
  const { dir, doc } = writeEvidence({
    BACKUP_ID: "/tmp/backup",
    BACKUP_HASH: "sha256:" + "11".repeat(32),
    BACKUP_VERIFIED: "true",
    HEALTH_OBSERVED: "true",
    HEALTH_API: "true",
    HEALTH_LANDING: "true",
    HEALTH_LOGIN: "true",
    HEALTH_CONTAINER: "true",
  });
  assert.equal(doc.db_backup.verified, true);
  assert.equal(doc.health.health, true);
  assert.equal(doc.health.landing, true);
  assert.equal(doc.health.login, true);
  assert.equal(doc.health.container_running, true);
  rmSync(dir, { recursive: true, force: true });
});
