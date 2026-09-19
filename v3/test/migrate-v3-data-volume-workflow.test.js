import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const wf = readFileSync(path.join(root, ".github/workflows/migrate-v3-data-volume.yml"), "utf8");
const sh = readFileSync(path.join(root, ".github/scripts/migrate-v3-data-volume-remote.sh"), "utf8");
const compose = readFileSync(path.join(root, "docker-compose.yml"), "utf8");

test("data migration workflow is manual only and never builds or pushes", () => {
  assert.match(wf, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(wf, /^  push:/m);
  assert.doesNotMatch(wf, /build-push-action|docker build |docker push /);
  assert.match(wf, /MIGRATE-V3-DATA-APPLY/);
  assert.match(wf, /MIGRATE-V3-DATA"/);
  assert.match(wf, /refs\/heads\/master/);
  assert.match(wf, /PRODUCTION_DEPLOY_ALLOWED_ACTOR/);
  assert.match(wf, /environment: production/);
  assert.match(wf, /group: production-data-migration/);
});

test("data migration script is fail-closed about source, target and free space", () => {
  assert.match(sh, /SOURCE_DIR and TARGET_DIR must differ/);
  assert.match(sh, /TARGET_DIR must live on the Storage1 pool/);
  assert.match(sh, /not enough free space/);
  assert.match(sh, /sha256sum/);
  assert.match(sh, /file_count source=/);
  assert.match(sh, /live database row counts do not match the pre-move source/);
  assert.match(sh, /rendered_data_mount/);
  assert.match(sh, /live_data_mount/);
  assert.match(sh, /MIGRATE_PLAN_OK/);
  assert.match(sh, /MIGRATE_OK/);
  assert.match(sh, /rollback_hint/);
  assert.doesNotMatch(sh, /rm -rf/);
});

test("data migration script is valid bash", () => {
  const probe = spawnSync("bash", ["-n", path.join(root, ".github/scripts/migrate-v3-data-volume-remote.sh")], { encoding: "utf8" });
  if (probe.error && probe.error.code === "ENOENT") return;
  assert.equal(probe.status, 0, probe.stderr || "migration script is not valid bash");
});

test("inline migration ssh step stays comment-free and join-safe", () => {
  const start = wf.indexOf("- name: Run the data volume migration");
  assert.ok(start > 0, "migration ssh step not found");
  const bodyAt = wf.indexOf("script: |", start);
  assert.ok(bodyAt > start, "migration ssh script block not found");
  const lines = [];
  for (const line of wf.slice(bodyAt).split("\n").slice(1)) {
    if (!line.trim()) continue;
    if (!/^\s{12,}\S/.test(line)) break;
    lines.push(line.slice(12));
  }
  assert.ok(lines.length > 4, `inline migration script looks empty (${lines.length} lines)`);
  assert.deepEqual(lines.filter((line) => line.trim().startsWith("#")), []);
  const probe = spawnSync("bash", ["-n"], { input: lines.join("; ") + "\n", encoding: "utf8" });
  if (probe.error && probe.error.code === "ENOENT") return;
  assert.equal(probe.status, 0, probe.stderr || "inline migration ssh script is not join-safe");
});

test("compose moves the live v3 data volume to the Storage1 pool by default", () => {
  assert.match(compose, /\$\{V3_DATA_ROOT:-\/mnt\/Storage1\/docker_data\/591-tracker-v3\}:\/data/);
  assert.doesNotMatch(compose, /\$\{DATA_ROOT:-\/DATA\}\/AppData\/591-tracker-v3:\/data/);
  assert.match(compose, /\$\{DATA_ROOT:-\/DATA\}\/AppData\/591-tracker-v2:\/v2-data:ro/);
});
