import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { communityId, matchVeto, scoreMatch } from "../src/match.js";
import {
  blockMatchCandidates,
  evaluateListingReconciliation,
  hasReconcileEvidence,
  significantListingUpdate,
} from "../src/sameHouseReconcile.js";
import { DatabaseSync } from "node:sqlite";
import { ensureListingGroupSchema } from "../src/listingGroups.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("community ids are namespaced by source", () => {
  assert.equal(communityId({ source: "591", community_id: 12345 }), "591:12345");
  assert.equal(communityId({ source: "sinyi", community_id: 12345 }), "sinyi:12345");
  assert.notEqual(communityId({ source: "591", community_id: 12345 }), communityId({ source: "sinyi", community_id: 12345 }));
});

test("coarse address is not enough evidence until detail arrives", () => {
  const coarse = { post_id: 1, address: "台北市士林區", source: "591" };
  const rich = {
    post_id: 1,
    address: "台北市士林區福華路141巷8號",
    floor_name: "3/4",
    area_name: "17坪",
    layout: "2房1廳",
    source: "591",
  };
  assert.equal(hasReconcileEvidence(coarse), false);
  assert.equal(hasReconcileEvidence(rich), true);
  assert.equal(significantListingUpdate(coarse, rich), true);
});

test("candidate blocking stays on district/street and does not scan the whole table", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE listings (
      post_id INTEGER PRIMARY KEY,
      address TEXT, community_name TEXT, floor_name TEXT, area_name TEXT, layout TEXT,
      lat REAL, lng REAL, last_seen_at TEXT, offline INTEGER DEFAULT 0, source TEXT
    );
  `);
  ensureListingGroupSchema(db);
  for (let i = 1; i <= 30; i += 1) {
    db.prepare("INSERT INTO listings(post_id, address, last_seen_at, source) VALUES (?, ?, '2026-09-01', '591')")
      .run(i, i === 2 ? "台北市士林區福華路141巷8號" : `新北市淡水區中山路${i}號`);
  }
  const incoming = {
    post_id: 99,
    address: "台北市士林區福華路141巷8號",
    floor_name: "3/4",
    area_name: "17坪",
    layout: "2房1廳",
    source: "591",
  };
  const blocked = blockMatchCandidates(db, incoming);
  assert.ok(blocked.length <= 5);
  assert.ok(blocked.some((row) => row.post_id === 2));
  assert.ok(!blocked.some((row) => String(row.address).includes("淡水")));
  db.close();
});

test("detail enrichment can confirm a pair that failed on coarse ingest", () => {
  const incomingCoarse = {
    post_id: 501,
    source: "sinyi",
    address: "台北市士林區",
    community_id: 9,
    floor_name: "",
    area_name: "",
  };
  const previous = {
    post_id: 502,
    source: "591",
    address: "台北市士林區福華路141巷8號",
    community_id: 88,
    floor_name: "3/4",
    area_name: "17坪",
    layout: "2房1廳",
  };
  assert.equal(scoreMatch(incomingCoarse, previous), null);
  const incomingRich = {
    ...incomingCoarse,
    address: "台北市士林區福華路141巷8號",
    floor_name: "3/4",
    area_name: "17.2坪",
    layout: "2房1廳",
  };
  assert.equal(matchVeto(incomingRich, previous).includes("community_id_mismatch"), false);
  const hit = scoreMatch(incomingRich, previous);
  assert.ok(hit);
  assert.ok(hit.evidence?.signals?.length);
  assert.ok(hit.evidence?.matcher_version);
  assert.ok(["high", "medium"].includes(hit.level));
});

function runIsolated(body) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-reconcile-"));
  const script = `
    import assert from "node:assert/strict";
    import * as app from ${JSON.stringify(path.join(dir, "../src/db.js"))};
    function seed(post_id, overrides = {}) {
      app.upsertListing({
        post_id, source: overrides.source || "591", source_id: String(post_id),
        source_key: (overrides.source || "591") + "|8|" + post_id,
        search_key: "https://example.test/search",
        title: "合成住宅 " + post_id, url: "https://example.test/" + post_id,
        price: "20000元", price_num: 20000, extra_fees: [],
        address: overrides.address || "台北市士林區",
        area_name: overrides.area_name || "",
        layout: overrides.layout || "",
        floor_name: overrides.floor_name || "",
        kind_name: "整層住家/電梯大樓",
        role_name: "", cover: "", tags: "[]",
        refresh_time: "2026-09-01T00:00:00.000Z",
        first_seen_at: "2026-09-01T00:00:00.000Z",
        last_seen_at: "2026-09-01T00:00:00.000Z", last_event: "new",
        community_id: overrides.community_id || 0,
        community_name: overrides.community_name || "",
        lat: overrides.lat, lng: overrides.lng,
      });
    }
    ${body}
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("A: coarse ingest does not match, detail enrichment reconciles", () => {
  runIsolated(`
    seed(801, { source: "591", address: "台北市士林區福華路141巷8號", floor_name: "3/4", area_name: "17坪", layout: "2房1廳" });
    seed(802, { source: "sinyi", address: "台北市士林區", community_id: 77 });
    const first = app.reconcileListingById(802, { reason: "initial" });
    assert.notEqual(first.applied, true);
    app.db.prepare("UPDATE listings SET address = ?, floor_name = '3/4', area_name = '17.1坪', layout = '2房1廳' WHERE post_id = 802")
      .run("台北市士林區福華路141巷8號");
    const again = app.reconcileListingById(802, { reason: "detail_enrichment" });
    assert.equal(again.skipped, false);
    assert.ok(again.best);
    assert.equal(Number(again.best.candidate_post_id), 801);
    assert.ok(["high", "medium"].includes(again.best.level));
  `);
});
