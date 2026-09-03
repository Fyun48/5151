import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function serviceBlock(yaml, name) {
  const start = yaml.search(new RegExp(`^  ${name}:\\s*$`, "m"));
  assert.notEqual(start, -1, `missing service ${name}`);
  const rest = yaml.slice(start + `  ${name}:\n`.length);
  const next = rest.search(/^  [A-Za-z0-9._-]+:\s*$/m);
  return rest.slice(0, next === -1 ? rest.length : next);
}

test("v3 docker service binds 5153 and mounts v2 db read-only", () => {
  const compose = readFileSync(path.join(root, "docker-compose.yml"), "utf8");
  const v3 = serviceBlock(compose, "591-tracker-v3");
  assert.match(v3, /127\.0\.0\.1:5153:5153/);
  assert.match(v3, /591-tracker-v3:\/data/);
  assert.match(v3, /591-tracker-v2:\/v2-data:ro/);
  assert.match(v3, /591-tracker:\/v1-data:ro/);
  assert.match(v3, /V2_DB_PATH: \/v2-data\/v2\.db/);
  assert.match(v3, /\.\/v3\/src:\/app\/src/);
  assert.match(v3, /c5151\.reversalplay\.me/);
});

test("CasaOS compose lists v3 as main on port 5153", () => {
  const casaos = readFileSync(path.join(root, "casaos-compose.yml"), "utf8");
  assert.match(casaos, /^  main: 591-tracker-v3\s*$/m);
  assert.match(casaos, /591-tracker-v3:/);
  assert.match(casaos, /port_map: "5153"/);
  assert.match(casaos, /c5151\.reversalplay\.me/);
});

test("deploy-v3 workflow recreates only the v3 container", () => {
  const file = path.join(root, ".github/workflows/deploy-v3.yml");
  assert.equal(existsSync(file), true);
  const yml = readFileSync(file, "utf8");
  assert.match(yml, /v3\/src\/\*\*/);
  assert.match(yml, /v3\/public\/\*\*/);
  assert.match(yml, /docker compose up -d --no-build --no-deps --force-recreate 591-tracker-v3/);
  assert.equal(/docker compose up[^\n]*591-tracker(?!-v)/.test(yml), false);
});
