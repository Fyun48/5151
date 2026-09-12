import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("site catalog stats only count admin-checked districts and keep self listings", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-catalog-stats-"));
  const script = `
    import { upsertListing, saveSystemCrawl, refreshSiteCatalogStats } from ${JSON.stringify(path.join(dir, "../src/db.js"))};
    import { allDistricts } from ${JSON.stringify(path.join(dir, "../src/regions.js"))};
    const keyByName = (n) => { for (const d of allDistricts()) if (d.name === n) return d.region + "-" + d.id; return ""; };
    const shilin = keyByName("士林區");
    const xitun = keyByName("西屯區");
    const kinmen = keyByName("金城鎮") || keyByName("金湖鎮");
    const [sr, ss] = shilin.split("-");
    const [xr, xs] = xitun.split("-");
    const stamp = "2026-09-12T00:00:00.000Z";
    function mk(post_id, region, section, title, address, source = "591") {
      upsertListing({
        post_id, source, source_key: region + "|" + section + "|||",
        search_key: "https://example.test", title, url: "https://example.test/" + post_id,
        price: "20000元", price_num: 20000, extra_fees: [],
        address, area_name: "20坪", layout: "2房1廳", floor_name: "5/12",
        kind_name: "整層住家", role_name: "", cover: "", tags: "[]",
        refresh_time: "", first_seen_at: stamp, last_seen_at: stamp, last_event: "new",
      });
    }
    mk(920001, sr, ss, "士林外站", "台北市士林區中正路100號", "591");
    mk(920002, sr, ss, "士林本站", "台北市士林區中正路101號", "self");
    mk(920003, xr, xs, "西屯外站", "台中市西屯區台灣大道三段100號", "sinyi");
    if (kinmen) {
      const [kr, ks] = String(kinmen).split("-");
      mk(920004, kr, ks, "金門外站", "金門縣金城鎮民生路1號", "591");
    }
    saveSystemCrawl({ watchDistricts: [shilin] });
    const snap = refreshSiteCatalogStats();
    console.log(JSON.stringify(snap));
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const line = result.stdout.trim().split("\n").filter((row) => row.startsWith("{")).at(-1);
    const out = JSON.parse(line);
    assert.equal(out.total, 2, JSON.stringify(out));
    assert.equal(out.self, 1, JSON.stringify(out));
    assert.equal(out.sources, 1, JSON.stringify(out));
    assert.equal(out.districtCount, 1, JSON.stringify(out));
    assert.equal(out.bySource["591"], 1, JSON.stringify(out));
    assert.equal(out.bySource.self, 1, JSON.stringify(out));
    assert.equal(out.bySource.sinyi, undefined, JSON.stringify(out));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
