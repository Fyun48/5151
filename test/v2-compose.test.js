import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("v1 and v2 services are removed from compose", () => {
  const compose = readFileSync(path.join(root, "docker-compose.yml"), "utf8");
  assert.doesNotMatch(compose, /^  591-tracker:\s*$/m);
  assert.doesNotMatch(compose, /^  591-tracker-v2:\s*$/m);
  assert.doesNotMatch(compose, /127\.0\.0\.1:5151:5151/);
  assert.doesNotMatch(compose, /127\.0\.0\.1:5152:5152/);
  assert.doesNotMatch(compose, /\.\/v2\/src:\/app\/src/);
  assert.doesNotMatch(compose, /b5151\.reversalplay\.me/);
  assert.match(compose, /591-tracker-v3:/);
});

test("cloudflared depends only on v3", () => {
  const compose = readFileSync(path.join(root, "docker-compose.yml"), "utf8");
  const start = compose.search(/^  cloudflared:\s*$/m);
  assert.notEqual(start, -1);
  const rest = compose.slice(start);
  assert.match(rest, /^      - 591-tracker-v3\s*$/m);
  assert.doesNotMatch(rest, /^      - 591-tracker-v2\s*$/m);
  assert.doesNotMatch(rest, /^      - 591-tracker\s*$/m);
});

test("CasaOS compose does not start v1 or v2", () => {
  const casaos = readFileSync(path.join(root, "casaos-compose.yml"), "utf8");
  assert.doesNotMatch(casaos, /^  591-tracker:\s*$/m);
  assert.doesNotMatch(casaos, /^  591-tracker-v2:\s*$/m);
  assert.equal(/^  main: 591-tracker\s*$/m.test(casaos), false);
  assert.match(casaos, /^  main: 591-tracker-v3\s*$/m);
});

test("deploy workflows do not start v1 or v2 as the live app", () => {
  const deploy = readFileSync(path.join(root, ".github/workflows/deploy.yml"), "utf8");
  const docker = readFileSync(path.join(root, ".github/workflows/docker.yml"), "utf8");
  const deployV2 = readFileSync(path.join(root, ".github/workflows/deploy-v2.yml"), "utf8");
  assert.equal(deploy.includes('source: "src,public"'), false);
  assert.equal(deploy.includes("- \"src/**\""), false);
  assert.equal(deploy.includes("- \"public/**\""), false);
  assert.match(deploy, /docker compose stop 591-tracker/);
  assert.equal(/docker compose up[^\n]*591-tracker(?!-v)/.test(deploy), false);
  assert.match(docker, /docker compose stop 591-tracker 591-tracker-v2/);
  assert.equal(/docker compose up[^\n]*591-tracker(?!-v)/.test(docker), false);
  assert.match(docker, /591-tracker-v3/);
  assert.doesNotMatch(docker, /up -d[^\n]*591-tracker-v2/);
  assert.match(deployV2, /v2 已拆除/);
  assert.doesNotMatch(deployV2, /force-recreate 591-tracker-v2/);
  const deployV3Path = path.join(root, ".github/workflows/deploy-v3.yml");
  if (existsSync(deployV3Path)) {
    const deployV3 = readFileSync(deployV3Path, "utf8");
    assert.match(deployV3, /591-tracker-v3/);
    assert.equal(/docker compose up[^\n]*591-tracker(?!-v)/.test(deployV3), false);
    assert.doesNotMatch(deployV3, /force-recreate 591-tracker-v2/);
  }
});
