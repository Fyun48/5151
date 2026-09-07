import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

// 5168 物件補到座標後，必須被通勤／捷運距離的回填查詢採用（geo_source 需被視為可信）。
test("houseprice listings with a geo pin feed the MRT/geo backfill", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-hp-geo-"));
  const script = `
    import { upsertListing, listingsNeedingMrt, listingHasTrustedGeo } from ${JSON.stringify(path.join(dir, "../src/db.js"))};
    const stamp = "2026-09-06T00:00:00.000Z";
    const common = {
      source: "houseprice",
      source_key: "3|39||新北市淡水區中山路93號|6|11|1房0廳1衛",
      search_key: "https://example.test",
      url: "https://rent.houseprice.tw/house/16705651",
      price: "14500", price_num: 14500, extra_fees: [],
      address: "新北市淡水區中山路93號", area_name: "11坪", layout: "1房0廳1衛",
      floor_name: "6/12", kind_name: "獨立套房", role_name: "5168租屋", cover: "",
      tags: '["5168"]', refresh_time: "", first_seen_at: stamp, last_seen_at: stamp, last_event: "new",
    };
    // 有座標 + geo_source=houseprice：應可信、應進 MRT 回填清單
    upsertListing({ ...common, post_id: 2400000101, source_id: "hp-pinned", title: "淡水已定位", lat: 25.1696, lng: 121.442, geo_source: "houseprice" });
    // 有座標但沒有 geo_source：不可信、不該進回填清單
    upsertListing({ ...common, post_id: 2400000102, source_id: "hp-nogeo", title: "淡水未標記", lat: 25.17, lng: 121.44 });
    const mrt = listingsNeedingMrt(50);
    console.log(JSON.stringify({
      pinnedTrusted: listingHasTrustedGeo(2400000101),
      nogeoTrusted: listingHasTrustedGeo(2400000102),
      mrtHasPinned: mrt.some((r) => Math.abs(Number(r.lat) - 25.1696) < 1e-6 && Math.abs(Number(r.lng) - 121.442) < 1e-6),
      mrtHasNogeo: mrt.some((r) => Math.abs(Number(r.lat) - 25.17) < 1e-6 && Math.abs(Number(r.lng) - 121.44) < 1e-6),
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
    assert.equal(out.pinnedTrusted, true, JSON.stringify(out));
    assert.equal(out.nogeoTrusted, false, JSON.stringify(out));
    assert.equal(out.mrtHasPinned, true, JSON.stringify(out));
    assert.equal(out.mrtHasNogeo, false, JSON.stringify(out));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
