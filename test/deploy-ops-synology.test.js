import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = readFileSync(path.join(ROOT, "docker-compose.ops.synology.yml"), "utf8");
const workflow = readFileSync(path.join(ROOT, ".github/workflows/deploy-ops-synology.yml"), "utf8");
const script = readFileSync(path.join(ROOT, ".github/scripts/deploy-ops-synology-remote.sh"), "utf8");

test("Synology OPS compose runs only 5151-ops and never v3/tunnel", () => {
  assert.match(compose, /5151-ops:/);
  assert.doesNotMatch(compose, /591-tracker-v3/);
  assert.doesNotMatch(compose, /cloudflared/);
  assert.doesNotMatch(compose, /tunnel/);
  assert.doesNotMatch(compose, /network_mode:\s*host/);
});

test("Synology OPS compose pins loopback port, restart policy, TZ, read-only source and live-mutation off", () => {
  assert.match(compose, /127\.0\.0\.1:5154:5154/);
  assert.match(compose, /restart:\s*unless-stopped/);
  assert.match(compose, /TZ:\s*Asia\/Taipei/);
  assert.match(compose, /:\/app\/ops:ro/);
  assert.match(compose, /:\/data/);
  assert.match(compose, /PRODUCTION_RELEASE_ALLOW_LIVE:\s*"0"/);
  // 路徑以可設定的 DSM volume 變數為主，不硬編 CasaOS /DATA、/mnt/Storage1。
  assert.match(compose, /OPS_SYNOLOGY_APP_ROOT/);
  assert.match(compose, /OPS_SYNOLOGY_DATA_ROOT/);
  assert.doesNotMatch(compose, /\/mnt\/Storage1/);
  assert.doesNotMatch(compose, /\/DATA\/AppData/);
});

test("Synology deploy workflow is manual-only with DEPLOY-OPS confirmation and master/SHA gating", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /on:\s*\n\s*push/);
  assert.doesNotMatch(workflow, /schedule:/);
  assert.match(workflow, /DEPLOY-OPS/);
  assert.match(workflow, /refs\/heads\/master/);
  assert.match(workflow, /merge-base --is-ancestor/);
  assert.match(workflow, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(workflow, /docker-compose\.ops\.synology\.yml/);
  assert.doesNotMatch(workflow, /docker-compose\.yml/); // 不用主 compose 部署 OPS
});

test("Synology remote script preflights secrets without printing, backs up, and rolls back", () => {
  assert.match(script, /auth\.env/);
  assert.match(script, /OPS_SECRET_AT_REST_KEY/);
  assert.match(script, /64-hex/);
  assert.match(script, /600/); // 0600 fail-closed 權限
  assert.match(script, /OPS_OWNER_EMAIL\|AUTH_EMAIL/);
  assert.match(script, /OPS_OWNER_PASSWORD\|AUTH_PASSWORD/);
  assert.match(script, /BACKUP_DIR/);
  assert.match(script, /ops\.db/);
  assert.match(script, /rollback/);
  assert.match(script, /\/ops\/api\/health/);
  // 不碰 v3 / cloudflared / tunnel
  assert.doesNotMatch(script, /591-tracker-v3/);
  assert.doesNotMatch(script, /cloudflared/);
});

test("Synology deploy is staged/versioned and rollback restores previous source pointer", () => {
  // 版本化 release 目錄 + incoming staging + atomic current symlink。
  assert.match(script, /releases\/\$DEPLOY_SHA/);
  assert.match(script, /INCOMING/);
  assert.match(script, /current/);
  assert.match(script, /ln -sfn/);
  assert.match(script, /PREVIOUS/);
  assert.match(script, /readlink/);
  // rollback 切回 PREVIOUS source（不是只還 DB/config）。
  assert.match(script, /ln -sfn "\$PREVIOUS"/);
  // 一致性 DB 快照：先 stop 再 copy。
  assert.match(script, /docker compose -f "\$COMPOSE_FILE" stop/);
  // 有界保留舊 release。
  assert.match(script, /tail -n \+7/);
});

test("Synology compose mounts the versioned current pointer, not the live ops dir", () => {
  assert.match(compose, /current\/ops:\/app\/ops:ro/);
  assert.doesNotMatch(compose, /\$\{OPS_SYNOLOGY_APP_ROOT[^}]*\}\/ops:\/app\/ops:ro/);
});

test("Synology rollback stops the failed/new container before restoring the DB snapshot", () => {
  // 只取 rollback() 函式本體（腳本內另有 backup 段的 stop，需避免誤判）。
  const rbStart = script.indexOf("rollback() {");
  assert.ok(rbStart !== -1, "rollback() must exist");
  const rbEnd = script.indexOf("\n}\n", rbStart);
  const body = script.slice(rbStart, rbEnd === -1 ? script.length : rbEnd);
  const stopIdx = body.indexOf('docker compose -f "$COMPOSE_FILE" stop 5151-ops');
  const restoreIdx = body.indexOf('cp -p "$BACKUP_DIR/$f" "${DATA_ROOT}/$f"');
  assert.ok(stopIdx !== -1, "rollback() must stop the container fail-safe");
  assert.ok(restoreIdx !== -1, "rollback() must restore the DB/WAL/SHM snapshot");
  assert.ok(stopIdx < restoreIdx, "rollback() must stop the container BEFORE restoring the DB snapshot");
});
