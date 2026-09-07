import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

// 預設列表（未點特定行政區＝「全部」）必須限縮在使用者自己設定的行政區，
// 不可顯示共用池裡別人/系統抓的其它縣市（例如台中西屯）。
test("default listing scope is limited to the member's own configured districts", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-region-scope-"));
  const script = `
    import { listListings, upsertListing, memberRegionDistrictNames, getSettings } from ${JSON.stringify(path.join(dir, "../src/db.js"))};
    import { allDistricts } from ${JSON.stringify(path.join(dir, "../src/regions.js"))};
    const keyByName = (n) => { for (const d of allDistricts()) if (d.name === n) return d.region + "-" + d.id; return ""; };
    const shilin = keyByName("士林區");
    const xitun = keyByName("西屯區");
    const [sr, ss] = shilin.split("-");
    const [xr, xs] = xitun.split("-");
    const stamp = "2026-09-06T00:00:00.000Z";
    function mk(post_id, region, section, title, address) {
      upsertListing({ post_id, source: "591", source_key: region + "|" + section + "|||", search_key: "https://example.test",
        title, url: "https://rent.591.com.tw/" + post_id, price: "20000元", price_num: 20000, extra_fees: [],
        address, area_name: "20坪", layout: "2房1廳", floor_name: "5/12", kind_name: "整層住家", role_name: "",
        cover: "", tags: "[]", refresh_time: "", first_seen_at: stamp, last_seen_at: stamp, last_event: "new" });
    }
    mk(900001, sr, ss, "士林物件", "台北市士林區中正路100號");
    mk(900002, xr, xs, "西屯物件", "台中市西屯區台灣大道三段100號");
    const def = getSettings();
    const withRegions = { ...def, watchDistricts: [shilin], searchUrls: [] };
    const noRegions = { ...def, watchDistricts: [], searchUrls: [] };
    const ids = (r) => (r.listings || []).map((x) => x.post_id).sort();
    const scoped = ids(listListings({ filter: "all", sort: "newest", userId: 0, settings: withRegions, districts: [] }));
    const explicit = ids(listListings({ filter: "all", sort: "newest", userId: 0, settings: withRegions, districts: ["士林區"] }));
    const global = ids(listListings({ filter: "all", sort: "newest", userId: 0, settings: noRegions, districts: [] }));
    console.log(JSON.stringify({ names: memberRegionDistrictNames(withRegions), scoped, explicit, global }));
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, DATA_DIR: dataDir } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const line = result.stdout.trim().split("\n").filter((r) => r.startsWith("{")).at(-1);
    const out = JSON.parse(line);
    assert.deepEqual(out.names, ["士林區"], JSON.stringify(out));
    assert.deepEqual(out.scoped, [900001], JSON.stringify(out));   // 「全部」只顯示自己的行政區
    assert.deepEqual(out.explicit, [900001], JSON.stringify(out)); // 指定行政區也正確
    assert.deepEqual(out.global, [900001, 900002], JSON.stringify(out)); // 未設定行政區者維持不限縮（demo/訪客）
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
