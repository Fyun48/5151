import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("v2 docker service is separate from v1 and binds 5152", () => {
  const compose = readFileSync(path.join(root, "docker-compose.yml"), "utf8");
  assert.match(compose, /591-tracker-v2:/);
  assert.match(compose, /127\.0\.0\.1:5152:5152/);
  assert.match(compose, /591-tracker-v2:\/data/);
  assert.match(compose, /591-tracker:\/v1-data:ro/);
  assert.match(compose, /V1_DB_PATH: \/v1-data\/591\.db/);
  assert.match(compose, /\.\/v2\/src:\/app\/src/);
  assert.match(compose, /b5151\.reversalplay\.me/);
});

function serviceBlock(yaml, name) {
  const start = yaml.search(new RegExp(`^  ${name}:\\s*$`, "m"));
  assert.notEqual(start, -1, `missing service ${name}`);
  const rest = yaml.slice(start + `  ${name}:\n`.length);
  const next = rest.search(/^  [A-Za-z0-9._-]+:\s*$/m);
  return rest.slice(0, next === -1 ? rest.length : next);
}

test("v1 docker service is profile-gated and not a default compose dependency", () => {
  const compose = readFileSync(path.join(root, "docker-compose.yml"), "utf8");
  const v1 = serviceBlock(compose, "591-tracker");
  assert.match(v1, /profiles:\s*\["v1"\]/);
  assert.match(v1, /127\.0\.0\.1:5151:5151/);
  const tunnel = serviceBlock(compose, "cloudflared");
  assert.equal(/^      - 591-tracker\s*$/m.test(tunnel), false);
  assert.match(tunnel, /^      - 591-tracker-v2\s*$/m);
});

test("CasaOS compose does not make v1 the main or default service", () => {
  const casaos = readFileSync(path.join(root, "casaos-compose.yml"), "utf8");
  const v1 = serviceBlock(casaos, "591-tracker");
  assert.match(v1, /profiles:\s*\["v1"\]/);
  assert.equal(/^  main: 591-tracker\s*$/m.test(casaos), false);
  assert.match(casaos, /^  main: 591-tracker-v[23]\s*$/m);
  assert.match(casaos, /591-tracker-v2:/);
});

test("deploy workflows do not copy or start v1 as the live app", () => {
  const deploy = readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8");
  const docker = readFileSync(path.join(root, ".github/workflows/docker.yml"), "utf8");
  const deployV2 = readFileSync(path.join(root, ".github/workflows/deploy-v2.yml"), "utf8");
  assert.equal(deploy.includes('source: "src,public"'), false);
  assert.equal(deploy.includes("- \"src/**\""), false);
  assert.equal(deploy.includes("- \"public/**\""), false);
  assert.match(deploy, /docker compose stop 591-tracker/);
  assert.equal(/docker compose up[^\n]*591-tracker(?!-v)/.test(deploy), false);
  assert.match(docker, /docker compose stop 591-tracker/);
  assert.equal(/docker compose up[^\n]*591-tracker(?!-v)/.test(docker), false);
  assert.match(docker, /591-tracker-v2/);
  assert.match(deployV2, /591-tracker-v2/);
  assert.equal(/docker compose up[^\n]*591-tracker(?!-v)/.test(deployV2), false);
  const deployV3Path = path.join(root, ".github/workflows/deploy-v3.yml");
  if (existsSync(deployV3Path)) {
    const deployV3 = readFileSync(deployV3Path, "utf8");
    assert.match(deployV3, /591-tracker-v3/);
    assert.equal(/docker compose up[^\n]*591-tracker(?!-v)/.test(deployV3), false);
  }
});
