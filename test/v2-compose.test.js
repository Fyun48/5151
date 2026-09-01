import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.match(compose, /127\.0\.0\.1:5151:5151/);
});
