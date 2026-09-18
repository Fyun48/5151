import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dbPath = JSON.stringify(pathToFileURL(path.join(root, "v3/src/db.js")).href);

function runIsolated(script) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-commute-fixture-"));
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const line = result.stdout.trim().split("\n").filter((row) => row.startsWith("{")).at(-1);
    return JSON.parse(line);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("P1-16 commute snapshot never reveals a fixture listing to ordinary members", () => {
  const out = runIsolated(`
    import { db, defaultUserId, listingCommutePatch, upsertListing } from ${dbPath};
    function seed(id) {
      upsertListing({
        post_id: id, source_key: "1|1", search_key: "https://example.test",
        title: "commute " + id, url: "https://rent.591.com.tw/" + id,
        price: "22000\\u5143", price_num: 22000, extra_fees: [],
        address: "\\u53f0\\u5317\\u5e02\\u58eb\\u6797\\u5340\\u4e2d\\u6b63\\u8def" + id + "\\u865f",
        area_name: "20\\u576a", layout: "2\\u623f1\\u5ef3", floor_name: "5/12",
        kind_name: "\\u6574\\u5c64\\u4f4f\\u5bb6", role_name: "", cover: "", tags: "[]",
        refresh_time: "", first_seen_at: "2026-09-01T00:00:00.000Z",
        last_seen_at: "2026-09-01T00:00:00.000Z", last_event: "new", source: "591",
      });
    }
    const uid = defaultUserId();
    seed(950001);
    seed(950002);
    db.prepare("UPDATE listings SET fixture_namespace = ? WHERE post_id = ?").run("stage1-fix", 950002);
    const normal = listingCommutePatch(950001, uid);
    const fixture = listingCommutePatch(950002, uid);
    const enumeration = [950001, 950002]
      .map((id) => listingCommutePatch(id, uid))
      .filter(Boolean)
      .map((row) => row.post_id);
    console.log(JSON.stringify({
      normal_ok: Boolean(normal && normal.post_id === 950001),
      fixture_null: fixture === null,
      enumeration,
    }));
  `);
  // ordinary member + normal listing -> unchanged result
  assert.equal(out.normal_ok, true);
  // ordinary member + fixture post_id -> null
  assert.equal(out.fixture_null, true);
  // direct enumeration through the snapshot payload reveals nothing about the fixture
  assert.deepEqual(out.enumeration, [950001]);
});

test("P1-16 listingCommutePatch enforces the centralized MAP fixture policy (not ad-hoc SQL)", () => {
  const db = readFileSync(path.join(root, "v3/src/db.js"), "utf8");
  const start = db.indexOf("export function listingCommutePatch");
  assert.ok(start >= 0, "listingCommutePatch missing");
  const body = db.slice(start, start + 400);
  assert.match(body, /listingVisibleOnSurface\(row, \{ surface: LISTING_SURFACE\.MAP, viewerId: uid \}\)/);
});
