import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = readFileSync(path.join(root, "docker-compose.yml"), "utf8");

function serviceBlock(yaml, name) {
  const start = yaml.search(new RegExp(`^  ${name}:\\s*$`, "m"));
  assert.notEqual(start, -1, `missing service ${name}`);
  const rest = yaml.slice(start + `  ${name}:\n`.length);
  const next = rest.search(/^  [A-Za-z0-9._-]+:\s*$/m);
  return rest.slice(0, next === -1 ? rest.length : next);
}

test("v3 docker service binds 5153 only (5155 alias reclaimed 2026-09-24) and mounts historical dbs read-only", () => {
  const compose = readFileSync(path.join(root, "docker-compose.yml"), "utf8");
  const v3 = serviceBlock(compose, "591-tracker-v3");
  assert.match(v3, /127\.0\.0\.1:5153:5153/);
  // 2026-09-24：5155 別名埠已收回（公開入口走 HAProxy 25153），不得再發佈。
  assert.doesNotMatch(v3, /127\.0\.0\.1:5155:5153/);
  assert.match(v3, /\$\{V3_DATA_ROOT:-\/mnt\/Storage1\/docker_data\/591-tracker-v3\}:\/data/);
  assert.match(v3, /591-tracker-v2:\/v2-data:ro/);
  assert.match(v3, /591-tracker:\/v1-data:ro/);
  assert.match(v3, /V2_DB_PATH: \/v2-data\/v2\.db/);
  assert.match(v3, /\.\/v3\/src:\/app\/src/);
  assert.match(v3, /jibbyrenth\.reversalplay\.me/);
  assert.doesNotMatch(v3, /c5151\.reversalplay\.me/);
  assert.match(readFileSync(path.join(root, "README.md"), "utf8"), /jibbyrenth\.reversalplay\.me/);
  assert.doesNotMatch(compose, /^  591-tracker:\s*$/m);
  assert.doesNotMatch(compose, /^  591-tracker-v2:\s*$/m);
});

test("CasaOS compose lists v3 as the only app on port 5153", () => {
  const casaos = readFileSync(path.join(root, "casaos-compose.yml"), "utf8");
  assert.match(casaos, /^  main: 591-tracker-v3\s*$/m);
  assert.match(casaos, /591-tracker-v3:/);
  assert.match(casaos, /port_map: "5153"/);
  assert.doesNotMatch(casaos, /127\.0\.0\.1:5155:5153/);
  assert.match(casaos, /jibbyrenth\.reversalplay\.me/);
  assert.doesNotMatch(casaos, /c5151\.reversalplay\.me/);
  assert.doesNotMatch(casaos, /^  591-tracker:\s*$/m);
  assert.doesNotMatch(casaos, /^  591-tracker-v2:\s*$/m);
});

test("OPS console is a separate loopback service on 5154", () => {
  const casaos = readFileSync(path.join(root, "casaos-compose.yml"), "utf8");
  const ops = serviceBlock(compose, "5151-ops");
  assert.match(ops, /127\.0\.0\.1:5154:5154/);
  assert.match(ops, /5151-ops:\/data/);
  assert.match(ops, /\.\/ops:\/app\/ops:ro/);
  assert.match(ops, /node", "ops\/src\/server\.js/);
  assert.equal(ops.includes("5153:5153"), false, "OPS must not bind the v3 port");
  assert.doesNotMatch(ops, /591-tracker-v3/);
  // CasaOS manifest 也要帶 OPS 服務
  const casaOps = serviceBlock(casaos, "5151-ops");
  assert.match(casaOps, /127\.0\.0\.1:5154:5154/);
  // v3 仍是唯一 live app，cloudflared 仍指向 v3；OPS 不得取代 v3
  const v3 = serviceBlock(compose, "591-tracker-v3");
  assert.match(v3, /127\.0\.0\.1:5153:5153/);
  assert.doesNotMatch(v3, /127\.0\.0\.1:5155:5153/);
  const tunnel = serviceBlock(compose, "cloudflared");
  assert.match(tunnel, /cloudflared/);
  assert.doesNotMatch(tunnel, /5154/);
  assert.doesNotMatch(compose, /^  591-tracker:\s*$/m);
  assert.doesNotMatch(compose, /^  591-tracker-v2:\s*$/m);
});

test("deploy-v3 workflow recreates only the v3 container (manual dispatch after Phase 3.5)", () => {
  const file = path.join(root, ".github/workflows/deploy-v3.yml");
  assert.equal(existsSync(file), true);
  const yml = readFileSync(file, "utf8");
  const onBlock = yml.match(/\non:\n([\s\S]*?)\n[a-zA-Z]/)?.[1] || "";
  assert.match(onBlock, /workflow_dispatch:/);
  assert.doesNotMatch(onBlock, /push:/);
  assert.match(yml, /source: "v3\/src,v3\/public/);
  assert.match(yml, /up -d --no-build --no-deps --force-recreate 591-tracker-v3/);
  assert.equal(/docker compose[^\n]*up[^\n]*591-tracker(?!-v)/.test(yml), false);
  assert.match(yml, /docker compose stop 591-tracker 591-tracker-v2/);
});

test("production image bakes v3 sources", () => {
  const docker = readFileSync(path.join(root, "Dockerfile"), "utf8");
  assert.match(docker, /COPY v3\/src \.\/src/);
  assert.match(docker, /COPY v3\/public \.\/public/);
  assert.match(docker, /ENV PORT=5153/);
  assert.match(docker, /EXPOSE 5153/);
  assert.doesNotMatch(docker, /COPY src \.\/src/);
  assert.doesNotMatch(docker, /EXPOSE 5151/);
});
