import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "os";
import path from "path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("sidebar stats count profile-scoped listings, not the whole catalog", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-profile-stats-"));
  const script = `
    import { listListings, upsertListing, saveSettings, stats, defaultUserId, setFlags } from ${JSON.stringify(path.join(dir, "../src/db.js"))};
    import { allDistricts } from ${JSON.stringify(path.join(dir, "../src/regions.js"))};
    const keyByName = (n) => { for (const d of allDistricts()) if (d.name === n) return d.region + "-" + d.id; return ""; };
    const shilin = keyByName("士林區");
    const xitun = keyByName("西屯區");
    const [sr, ss] = shilin.split("-");
    const [xr, xs] = xitun.split("-");
    const stamp = "2026-09-12T00:00:00.000Z";
    function mk(post_id, region, section, title, address, extra = {}) {
      upsertListing({
        post_id, source: extra.source || "591", source_key: region + "|" + section + "|||",
        search_key: "https://example.test", title, url: "https://rent.591.com.tw/" + post_id,
        price: "20000元", price_num: extra.price_num || 20000, extra_fees: [],
        address, area_name: "20坪", layout: "2房1廳", floor_name: extra.floor_name || "5/12",
        kind_name: extra.kind_name || "整層住家", role_name: "", cover: "", tags: extra.tags || "[]",
        refresh_time: "", first_seen_at: stamp, last_seen_at: stamp, last_event: "new",
      });
    }
    mk(910001, sr, ss, "士林有電梯三房", "台北市士林區中正路100號", { kind_name: "整層住家" });
    mk(910002, sr, ss, "士林一樓", "台北市士林區中正路200號", { floor_name: "1/4" });
    mk(910003, xr, xs, "西屯物件", "台中市西屯區台灣大道三段100號");
    mk(910005, sr, ss, "士林有電梯二房", "台北市士林區中正路300號", { kind_name: "電梯大樓" });
    const uid = defaultUserId();
    saveSettings({
      watchDistricts: [shilin],
      searchUrls: [],
      excludeLowFloors: true,
      excludeRooftop: true,
      priceMin: 0,
      priceMax: 0,
    }, uid);
    setFlags(910001, { watched: true }, uid);
    const st = stats([], uid);
    const listed = listListings({ filter: "all", sort: "newest", userId: uid, districts: [], searchKeys: [] });
    const watched = listListings({ filter: "watched", sort: "newest", userId: uid, districts: [], searchKeys: [] });
    console.log(JSON.stringify({
      total: st.total,
      elevator: st.elevator,
      watched: st.watched,
      watchedTotal: st.watchedTotal,
      hidden: st.hidden,
      filteredOut: st.filteredOut,
      listed: (listed.listings || []).map((x) => x.post_id),
      watchedIds: (watched.listings || []).map((x) => x.post_id),
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
    assert.equal(out.filteredOut, 0, JSON.stringify(out));
    assert.deepEqual(out.listed, [910005], JSON.stringify(out));
    assert.deepEqual(out.watchedIds, [910001], JSON.stringify(out));
    assert.equal(out.total, 1, JSON.stringify(out));
    assert.equal(out.watched, 1, JSON.stringify(out));
    assert.equal(out.watchedTotal, 1, JSON.stringify(out));
    assert.equal(out.elevator, 1, JSON.stringify(out));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
