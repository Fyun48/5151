import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dbUrl = JSON.stringify(pathToFileURL(path.join(dir, "../src/db.js")).href);

test("upsertListing bumps the data revision change-log (add then update)", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-revision-wiring-"));
  const script = `
    import assert from "node:assert/strict";
    import * as app from ${dbUrl};
    import { currentRevision, changesSince } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/dataRevision.js")).href)};
    const uid = app.defaultUserId();
    const before = currentRevision(app.db);
    app.upsertListing({
      post_id: 1, source: "591", source_id: "1",
      source_key: "1|8|1", search_key: "https://e.test",
      title: "住宅1", url: "https://e.test/1", price: "20000元", price_num: 20000,
      extra_fee: 0, extra_fees: [], address: "台北市士林區測試路1號", area_name: "20坪",
      layout: "2房1廳", floor_name: "3F/5F", kind_name: "整層住家/電梯大樓",
      role_name: "", cover: "", tags: "[]", refresh_time: "2026-09-01T00:00:00.000Z",
      first_seen_at: "2026-09-01T00:00:00.000Z", last_seen_at: "2026-09-01T00:00:00.000Z", last_event: "new",
    });
    const afterAdd = currentRevision(app.db);
    const addChanges = changesSince(app.db, before).filter((c) => c.entity_id === 1);
    app.upsertListing({
      post_id: 1, source: "591", source_id: "1",
      source_key: "1|8|1", search_key: "https://e.test",
      title: "住宅1改", url: "https://e.test/1", price: "21000元", price_num: 21000,
      extra_fee: 0, extra_fees: [], address: "台北市士林區測試路1號", area_name: "20坪",
      layout: "2房1廳", floor_name: "3F/5F", kind_name: "整層住家/電梯大樓",
      role_name: "", cover: "", tags: "[]", refresh_time: "2026-09-01T00:00:00.000Z",
      first_seen_at: "2026-09-01T00:00:00.000Z", last_seen_at: "2026-09-01T00:00:00.000Z", last_event: "new",
    });
    const afterUpdate = currentRevision(app.db);
    const updateChanges = changesSince(app.db, afterAdd).filter((c) => c.entity_id === 1);
    console.log(JSON.stringify({
      advancedAfterAdd: afterAdd > before,
      addEvent: addChanges[0]?.event_type,
      advancedAfterUpdate: afterUpdate > afterAdd,
      updateEvent: updateChanges[0]?.event_type,
    }));
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const line = result.stdout.trim().split("\n").filter((row) => row.startsWith("{")).at(-1);
    const out = JSON.parse(line);
    assert.equal(out.advancedAfterAdd, true);
    assert.equal(out.addEvent, "listing_added");
    assert.equal(out.advancedAfterUpdate, true);
    assert.equal(out.updateEvent, "listing_updated");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("api/events/revision returns the durable change-log", () => {
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  assert.match(server, /app\.get\("\/api\/events\/revision"/);
  assert.match(server, /revision: currentRevision\(db\)/);
  assert.match(server, /changes: changesSince\(db, since, \{ limit: 500 \}\)/);
});
