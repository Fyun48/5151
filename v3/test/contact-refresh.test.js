import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

// 591 刊登可能換仲介／換電話，但聯絡資料只抓一次就快取。過期的線上物件要被「明細補抓」重新撈，
// 且每輪硬上限，避免加重來源負載。
test("stale contact 591 listings are re-queued for detail (bounded), fresh ones are not", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-contact-refresh-"));
  const script = `
    import { db, upsertListing, setListingDetail, listingsNeedingFeeDetail } from ${JSON.stringify(path.join(dir, "../src/db.js"))};
    const stamp = "2026-09-06T00:00:00.000Z";
    function seedFetched(post_id) {
      upsertListing({ post_id, source: "591", source_key: "1|8|||", search_key: "https://example.test",
        title: "t" + post_id, url: "https://rent.591.com.tw/" + post_id, price: "20000元", price_num: 20000, extra_fees: [],
        address: "台北市士林區中正路" + post_id + "號", area_name: "20坪", layout: "2房1廳", floor_name: "5/12",
        kind_name: "整層住家", role_name: "", cover: "", tags: "[]", refresh_time: "", first_seen_at: stamp, last_seen_at: stamp, last_event: "new" });
      // 帶入聯絡資料 + 座標 => contact_fetched=1, extra_fees_fetched=1, lat/lng 齊 => 不在 needy 內
      setListingDetail(post_id, { extraFees: [{ name: "管理費", amount: 100 }], contact: { contact_name: "王先生", mobile: "0911-000-000" }, fetched: 1, lat: 25.0, lng: 121.5, geo_source: "591" });
    }
    seedFetched(700001);
    const afterSet = db.prepare("SELECT contact_fetched_at FROM listings WHERE post_id=?").get(700001);
    const freshHas = (listingsNeedingFeeDetail(20).some((r) => r.post_id === 700001));
    // 過期：把 contact_fetched_at 倒退，應被重新排入補抓
    db.prepare("UPDATE listings SET contact_fetched_at=? WHERE post_id=?").run("2020-01-01T00:00:00.000Z", 700001);
    const staleHas = (listingsNeedingFeeDetail(20).some((r) => r.post_id === 700001));
    // 上限：再塞 8 筆過期，needy 為空時每輪最多補 CONTACT_REFRESH_CAP(6) 筆
    for (let i = 2; i <= 9; i++) { seedFetched(700000 + i); db.prepare("UPDATE listings SET contact_fetched_at=? WHERE post_id=?").run("2020-01-01T00:00:00.000Z", 700000 + i); }
    const capCount = listingsNeedingFeeDetail(20).length;
    console.log(JSON.stringify({ contactStampSet: Boolean(afterSet.contact_fetched_at), freshHas, staleHas, capCount }));
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, DATA_DIR: dataDir } });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const line = result.stdout.trim().split("\n").filter((r) => r.startsWith("{")).at(-1);
    const out = JSON.parse(line);
    assert.equal(out.contactStampSet, true, "setListingDetail should stamp contact_fetched_at");
    assert.equal(out.freshHas, false, "freshly-fetched listing must NOT be re-queued");
    assert.equal(out.staleHas, true, "stale-contact listing must be re-queued");
    assert.equal(out.capCount, 6, `stale refresh must be bounded to 6 per run, got ${out.capCount}`);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
