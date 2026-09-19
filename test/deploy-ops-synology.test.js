import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = readFileSync(path.join(ROOT, "docker-compose.ops.synology.yml"), "utf8");
const workflow = readFileSync(path.join(ROOT, ".github/workflows/deploy-ops-synology.yml"), "utf8");
const script = readFileSync(path.join(ROOT, ".github/scripts/deploy-ops-synology-remote.sh"), "utf8");
const predeployWorkflow = readFileSync(path.join(ROOT, ".github/workflows/predeploy-ops-synology.yml"), "utf8");
const predeployScript = readFileSync(path.join(ROOT, ".github/scripts/predeploy-ops-synology-remote.sh"), "utf8");

function fnBody(src, name) {
  const start = src.indexOf(`${name}() {`);
  assert.ok(start !== -1, `${name}() must exist`);
  const fromStart = src.slice(start);
  const closeMatch = fromStart.match(/\r?\n\}\s*\r?\n/);
  const end = closeMatch ? start + closeMatch.index : src.length;
  return src.slice(start, end);
}

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

test("compose runtime image is fail-closed (no :latest fallback)", () => {
  assert.match(compose, /OPS_RUNTIME_IMAGE:\?OPS_RUNTIME_IMAGE is required/);
  assert.doesNotMatch(compose, /:latest/);
  assert.doesNotMatch(compose, /:\$\{OPS_RUNTIME_IMAGE:-/);
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
  assert.doesNotMatch(workflow, /docker-compose\.yml/);
});

test("deploy workflow has no double-quoted expression literal (parse regression)", () => {
  assert.doesNotMatch(workflow, /\$\{\{[^}]*"/);
  assert.doesNotMatch(workflow, /\|\|\s*"/);
  assert.doesNotMatch(predeployWorkflow, /\$\{\{[^}]*"/);
  assert.doesNotMatch(predeployWorkflow, /\|\|\s*"/);
});

test("deploy workflow uses dedicated OPS_SYNOLOGY_* credentials + independent environment", () => {
  assert.match(workflow, /environment:\s*ops-synology-production/);
  assert.match(workflow, /secrets\.OPS_SYNOLOGY_HOST/);
  assert.match(workflow, /secrets\.OPS_SYNOLOGY_PORT/);
  assert.match(workflow, /secrets\.OPS_SYNOLOGY_USER/);
  assert.match(workflow, /secrets\.OPS_SYNOLOGY_SSH_KEY/);
  assert.doesNotMatch(workflow, /secrets\.NAS_HOST/);
  assert.doesNotMatch(workflow, /secrets\.NAS_PORT/);
  assert.doesNotMatch(workflow, /secrets\.NAS_USER/);
  assert.doesNotMatch(workflow, /secrets\.NAS_SSH_KEY/);
});

test("deploy workflow requires immutable image_digest and validates OCI metadata before NAS mutation", () => {
  assert.match(workflow, /image_digest:/);
  assert.match(workflow, /sha256:<64 lowercase hex>/);
  assert.match(workflow, /\^sha256:\[0-9a-f\]\{64\}\$/);
  assert.match(workflow, /org\.opencontainers\.image\.revision/);
  assert.match(workflow, /org\.opencontainers\.image\.source/);
  assert.match(workflow, /docker pull --platform linux\/amd64/);
  assert.match(workflow, /OPS_RUNTIME_IMAGE=\$PIN/);
  assert.match(workflow, /IMAGE_REPO="ghcr\.io\/\$\{GITHUB_REPOSITORY,,}"/);
  assert.match(workflow, /PIN="\$IMAGE_REPO@\$IMAGE_DIGEST"/);
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

test("deploy is versioned: each release holds source + compose + runtime-image + sha", () => {
  assert.match(script, /\$RELEASES\/\$DEPLOY_SHA/);
  assert.match(script, /INCOMING/);
  assert.match(script, /CURRENT/);
  assert.match(script, /\.runtime-image/);
  assert.match(script, /\.deployed-sha/);
  assert.match(script, /\$RELEASES\/\$DEPLOY_SHA\/docker-compose\.ops\.synology\.yml/);
  assert.match(script, /ghcr\.io\/fyun48\/5151@sha256:\[0-9a-f\]\{64\}/);
  assert.match(script, /tail -n \+7/);
});

test("rollback restores previous source + image + compose (no old source + new image)", () => {
  const body = fnBody(script, "rollback");
  assert.match(body, /ln -sfn "\$PREVIOUS" "\$CURRENT"/);
  assert.match(body, /cat "\$PREVIOUS\/\.runtime-image"/);
  assert.match(body, /OPS_RUNTIME_IMAGE="\$PREV_IMAGE" docker compose -f "\$PREVIOUS\/docker-compose\.ops\.synology\.yml"/);
  const stopIdx = body.indexOf('docker stop 5151-ops');
  const restoreIdx = body.indexOf('cp -p "$BACKUP_DIR/$f" "${DATA_ROOT}/$f"');
  assert.ok(stopIdx !== -1 && restoreIdx !== -1 && stopIdx < restoreIdx, "rollback must stop before restoring DB");
});

test("rollback is fail-closed and reports ROLLBACK_OK/ROLLBACK_FAILED (never silent)", () => {
  const body = fnBody(script, "rollback");
  // 不得再有 `|| true` 的 DB/auth restore 或 `up ... || true`（會 silent 失敗）。
  assert.doesNotMatch(body, /cp -p "\$BACKUP_DIR\/\$f" "\$\{DATA_ROOT\}\/\$f" \|\| true/);
  assert.doesNotMatch(body, /docker compose .* up -d .* \|\| true/);
  assert.match(body, /db_ok=0/);
  assert.match(body, /rollback_ok=1/);
  // 驗證 PREV_IMAGE 為 immutable repo digest。
  assert.match(body, /\^ghcr\.io\/fyun48\/5151@sha256:\[0-9a-f\]\{64\}\$/);
  // 區分 ROLLBACK_OK / ROLLBACK_FAILED，不再有 bare "rollback complete"。
  assert.match(body, /ROLLBACK_OK/);
  assert.match(body, /ROLLBACK_FAILED/);
  assert.doesNotMatch(body, /log "rollback complete/);
});

test("first-deploy failure stops and removes failed release without restarting it", () => {
  const body = fnBody(script, "rollback");
  const elseIdx = body.indexOf("else");
  assert.ok(elseIdx !== -1, "rollback must have a first-deploy (else) branch");
  const elseBranch = body.slice(elseIdx);
  assert.doesNotMatch(elseBranch, /docker compose .* up -d/);
  assert.match(elseBranch, /rm -f "\$CURRENT"/);
  assert.match(elseBranch, /rm -rf "\$RELEASES\/\$DEPLOY_SHA"/);
});

test("deploy fails closed on unknown unmanaged 5151-ops container", () => {
  assert.match(script, /existing 5151-ops container has no managed current release metadata/);
  assert.match(script, /\.deployed-sha/);
  assert.match(script, /\.runtime-image/);
});

test("Synology compose mounts the versioned current pointer, not the live ops dir", () => {
  assert.match(compose, /current\/ops:\/app\/ops:ro/);
  assert.doesNotMatch(compose, /\$\{OPS_SYNOLOGY_APP_ROOT[^}]*\}\/ops:\/app\/ops:ro/);
});

test("predeploy workflow is manual-only, read-only, and non-mutating", () => {
  assert.match(predeployWorkflow, /workflow_dispatch:/);
  assert.doesNotMatch(predeployWorkflow, /on:\s*\n\s*push/);
  assert.match(predeployWorkflow, /environment:\s*ops-synology-production/);
  // 不得 recreate/stop/delete container、不得改 DB、不得切 current、不得 scp。
  assert.doesNotMatch(predeployScript, /docker\s+(compose\s+)?(up|run|create|start|stop|rm|restart|down|pull|exec)/);
  assert.doesNotMatch(predeployScript, /\brm\s+-/);
  assert.doesNotMatch(predeployScript, /ln\s+-s/);
  assert.doesNotMatch(predeployScript, /\b(INSERT|UPDATE|DELETE|DROP|PRAGMA)\b/);
  assert.doesNotMatch(predeployScript, /\bscp\b/);
  // 檢查項目存在。
  assert.match(predeployScript, /uname -m/);
  assert.match(predeployScript, /df -h/);
  assert.match(predeployScript, /docker compose version/);
  assert.match(predeployScript, /auth_env_perms/);
  assert.match(predeployScript, /secret_at_rest_key=present_64hex/);
  assert.match(predeployScript, /ops_db=present|ops_db=absent/);
  assert.match(predeployScript, /first_deploy/);
  // 絕不輸出 secret value。
  assert.doesNotMatch(predeployScript, /echo.*OPS_SECRET_AT_REST_KEY=/);
});

test("predeploy hard-fails on invalid deploy prerequisites (not just WARN)", () => {
  // 這些是 deploy 的 fail-closed 條件，predeploy 必須 exit 非零。
  assert.match(predeployScript, /BLOCKED=0/);
  assert.match(predeployScript, /block\(\) \{ printf 'FAIL/);
  assert.match(predeployScript, /auth.env absent/);
  assert.match(predeployScript, /auth.env perms must be 0400\/0600/);
  assert.match(predeployScript, /owner email key missing/);
  assert.match(predeployScript, /owner password key missing/);
  assert.match(predeployScript, /OPS_SECRET_AT_REST_KEY missing or not 64-hex/);
  assert.match(predeployScript, /port 5154 listening but 5151-ops container is not running/);
  assert.match(predeployScript, /port 5154 listening but 5151-ops binding is not exactly 127\.0\.0\.1:5154/);
  assert.match(predeployScript, /docker port 5151-ops 5154/);
  assert.match(predeployScript, /docker inspect -f '\{\{\.State\.Status\}\}' 5151-ops/);
  assert.match(predeployScript, /existing 5151-ops container has no managed current release metadata/);
  assert.match(predeployScript, /managed current metadata incomplete/);
  assert.match(predeployScript, /PREDEPLOY_RESULT=PASS/);
  assert.match(predeployScript, /PREDEPLOY_RESULT=FAIL/);
  assert.match(predeployScript, /exit 1/);
});

test("deploy + predeploy workflows declare packages: read for GHCR pull", () => {
  assert.match(workflow, /contents: read\s*\n\s*packages: read/);
  assert.match(predeployWorkflow, /contents: read\s*\n\s*packages: read/);
});

test("deploy workflow uses native scp/ssh with correct port flags, not mutable third-party actions", () => {
  assert.doesNotMatch(workflow, /appleboy\/(scp|ssh)-action@/);
  assert.match(workflow, /\bscp\s/);
  assert.match(workflow, /\bssh\s/);
  assert.match(workflow, /StrictHostKeyChecking=accept-new/);
  // scp 的 port flag 是 -P（大寫），ssh 是 -p（小寫）。
  assert.match(workflow, /SCP_OPTS=\([^)]*-P "\$OPS_SYNOLOGY_PORT"/);
  assert.match(workflow, /SSH_OPTS=\([^)]*-p "\$OPS_SYNOLOGY_PORT"/);
});

test("deploy stages into a clean per-SHA incoming dir (no stale-file merge)", () => {
  assert.match(workflow, /incoming\/\$DEPLOY_SHA/);
  assert.match(workflow, /rm -rf '\$INCOMING' && mkdir -p '\$INCOMING'/);
  assert.match(workflow, /incoming path escapes APP_ROOT/);
  assert.match(script, /INCOMING="\$APP_ROOT\/incoming\/\$DEPLOY_SHA"/);
});

test("deploy script arms an EXIT trap before destructive ops and commits after health/identity", () => {
  assert.match(script, /DEPLOY_COMMITTED=0/);
  assert.match(script, /DEPLOY_COMMITTED=1/);
  assert.match(script, /trap 'code=\$\?; if \[ "\$code" != "0" \] && \[ "\$DEPLOY_COMMITTED" != "1" \]; then rollback; fi; exit "\$code"' EXIT/);
  assert.doesNotMatch(script, /trap .* ERR/);
  const trapIdx = script.indexOf("trap 'code=$?;");
  const stopIdx = script.indexOf('docker compose -f "$PREVIOUS/docker-compose.ops.synology.yml" stop 5151-ops');
  assert.ok(trapIdx !== -1 && stopIdx !== -1 && trapIdx < stopIdx, "EXIT trap must be armed before stopping the container");
});

test("deploy backup is fail-closed and records predeploy SQLite files", () => {
  assert.match(script, /failed to snapshot/);
  assert.match(script, /PRE_SQLITE_FILES/);
  assert.match(script, /cp -p "\$AUTH_ENV" "\$BACKUP_DIR\/auth\.env" \|\| fail/);
  assert.match(script, /failed to write backup metadata/);
  // 不得再有 `|| true` 的 DB/auth.env snapshot（會 silent 失敗）。
  assert.doesNotMatch(script, /cp -p "\$AUTH_ENV" "\$BACKUP_DIR\/auth\.env" 2>\/dev\/null \|\| true/);
});

test("executable deploy failure-path tests (rollback on fail, fail-closed backup)", { skip: process.platform === "win32", timeout: 120000 }, () => {
  const out = execFileSync("bash", [path.join(ROOT, "test", "synology-deploy-failpath.sh")], { encoding: "utf8" });
  assert.match(out, /ALL FAILURE-PATH TESTS PASS/);
});

test("remote scripts export Synology-compatible PATH and fail-closed docker resolution", () => {
  const expectedPath = 'PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/var/packages/ContainerManager/target/usr/bin:$PATH"';
  // 兩份 script 都 export 同一組 PATH（避免 predeploy PASS 但 deploy command not found）。
  assert.ok(script.includes(expectedPath), "deploy script must export Synology-compatible PATH");
  assert.ok(predeployScript.includes(expectedPath), "predeploy script must export Synology-compatible PATH");
  assert.match(script, /export PATH/);
  assert.match(predeployScript, /export PATH/);
  // 兩份都用 command -v docker 做 fail-closed 解析（同一套邏輯，不 hardcode 單一路徑）。
  assert.match(script, /command -v docker/);
  assert.match(predeployScript, /command -v docker/);
  // 優先 PATH resolution，且納入已人工確認的相容路徑。
  assert.match(script, /\/usr\/local\/bin/);
  assert.match(script, /\/var\/packages\/ContainerManager\/target\/usr\/bin/);
  assert.match(predeployScript, /\/usr\/local\/bin/);
  assert.match(predeployScript, /\/var\/packages\/ContainerManager\/target\/usr\/bin/);
  // 不直接 hardcode 單一 docker binary 絕對路徑執行。
  assert.doesNotMatch(script, /\/usr\/local\/bin\/docker( |$)/);
  assert.doesNotMatch(predeployScript, /\/usr\/local\/bin\/docker( |$)/);
});
