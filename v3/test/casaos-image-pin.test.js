import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isImageDigest } from "../../.github/scripts/deploy-v3-digest.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const casaos = readFileSync(path.join(root, "casaos-compose.yml"), "utf8");
const deployYml = readFileSync(path.join(root, ".github/workflows/deploy-v3.yml"), "utf8");

test("casaos-compose.yml pins the v3 image via V3_IMAGE_PIN interpolation and never :latest", () => {
  // CasaOS 面板「重新部署」用的就是這份 compose；不留 :latest 以免按下去換回未知 tag。
  assert.doesNotMatch(casaos, /image:\s*ghcr\.io\/fyun48\/5151:latest/);
  assert.doesNotMatch(casaos, /:latest/);
  assert.match(casaos, /\$\{V3_IMAGE_PIN:-/);
});

test("casaos-compose.yml default V3_IMAGE_PIN is a valid pinned digest, not a mutable tag", () => {
  const m = casaos.match(/\$\{V3_IMAGE_PIN:-([^}]+)\}/);
  assert.ok(m, "V3_IMAGE_PIN:- interpolation with default value not found");
  const defaultRef = m[1];
  assert.match(defaultRef, /^ghcr\.io\/fyun48\/5151@sha256:[0-9a-f]{64}$/);
  assert.ok(isImageDigest(defaultRef.slice(defaultRef.lastIndexOf("@") + 1)));
});

test("deploy-v3 writes V3_IMAGE_PIN into the CasaOS app .env (backup + single-key grep assertion)", () => {
  const start = deployYml.indexOf("Pull digest-pinned image and recreate v3 only");
  assert.ok(start > 0, "deploy ssh step not found");
  const end = deployYml.indexOf("- name: Recreate A-group web node", start);
  const section = deployYml.slice(start, end === -1 ? deployYml.length : end);

  assert.match(section, /V3_ENV=\/mnt\/Storage1\/apps\/5151\/\.env/);
  // 改前留備份（.bak-<timestamp>），且只動 V3_IMAGE_PIN 這一個鍵。
  assert.match(section, /cp -p "\$V3_ENV" "\$V3_ENV\.bak-\$\(date/);
  // 有鍵就替換值、沒有就附加。
  assert.match(section, /sed -i "s\|\^V3_IMAGE_PIN=/);
  assert.match(section, /printf 'V3_IMAGE_PIN=%s\\n'/);
  // 寫入的是發版那顆 digest，不是 :latest。
  assert.match(section, /V3_IMAGE_PIN=\$\{IMAGE_PIN\}/);
  // 改後用 grep -c 斷言恰好 1 行（冪等）。
  assert.match(section, /grep -c '\^V3_IMAGE_PIN='/);
  assert.match(section, /must be exactly one line/);
  // 保留 .env 原始權限（600），不因 sed -i 重建而掉成 644。
  assert.match(section, /chmod "\$V3_ENV_MODE"/);

  // 寫入段落本身只餵 digest（IMAGE_PIN），不含 :latest。
  const blockStart = section.indexOf("V3_ENV=/mnt/Storage1/apps/5151/.env");
  assert.ok(blockStart > 0, "V3_IMAGE_PIN write block not found");
  const block = section.slice(blockStart, section.indexOf("test -f docker-compose.override.yml", blockStart));
  assert.doesNotMatch(block, /:latest/);
});

test("predeploy PG backup host label is injectable and still defaults to syn-nas", () => {
  const script = readFileSync(
    path.join(root, ".github/scripts/production-predeploy-pg-remote.sh"),
    "utf8",
  );
  // pg_backup_host 不再寫死 syn-nas；由 workflow 依 role 注入 casa-nas/syn-nas，未設時退回 syn-nas。
  assert.match(script, /"pg_backup_host": "\$\{PREDEPLOY_PG_HOST_LABEL:-syn-nas\}"/);

  const wf = readFileSync(
    path.join(root, ".github/workflows/production-predeploy-check.yml"),
    "utf8",
  );
  assert.match(wf, /PREDEPLOY_PG_HOST_LABEL="casa-nas"/);
  assert.match(wf, /PREDEPLOY_PG_HOST_LABEL="syn-nas"/);
  assert.match(wf, /PREDEPLOY_PG_HOST_LABEL='\$PREDEPLOY_PG_HOST_LABEL'/);
});
