// fold 刷新失敗不可無聲吞掉（D）：寫入路徑的 fold 刷新失敗要累進 rental_analytics_daily，
// 讓「fold_refresh_failed」成為容器外可讀的訊號。
//
// 用 repository/listingState.js 的 markListingOffline（PG 路徑）＋注入式 exec 模擬一次
// 「fold 欄缺失」的失敗：SQLite 的 listings 沒有 fold_* 欄，refreshFoldColumns 的 UPDATE 必然拋錯。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-fold-count-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file locked while the process holds it.
  }
});

test("markListingOffline：fold 刷新失敗會讓 rental_analytics_daily 的 fold_refresh_failed 前進", async () => {
  const app = await import("../src/db.js");
  const { markListingOffline } = await import("../src/repository/listingState.js");
  const db = app.sqliteHandle();

  const postId = 950001;
  app.upsertListing({
    post_id: postId,
    source: "591",
    source_id: String(postId),
    source_key: `1|8|${postId}`,
    search_key: "https://example.test/search",
    title: "合成住宅",
    url: `https://example.test/listing/${postId}`,
    price: "25000元",
    price_num: 25000,
    extra_fee: 0,
    extra_fees: [],
    cover: "https://example.test/cover.png",
    tags: "[]",
    address: "台北市士林區測試路",
    area_name: "20坪",
    layout: "2房1廳1衛",
    floor_name: "5/12",
    kind_name: "整層住家/電梯大樓",
    role_name: "",
    refresh_time: "2026-09-07T00:00:00.000Z",
    first_seen_at: "2026-09-07T00:00:00.000Z",
    last_seen_at: "2026-09-07T00:00:00.000Z",
    last_event: "new",
  });

  const counter = () => {
    const row = db.prepare("SELECT value FROM rental_analytics_daily WHERE metric = ?").get("fold_refresh_failed");
    return Number(row?.value) || 0;
  };
  const before = counter();

  // 注入式 exec：語句原樣跑在同一顆 SQLite（走 PG 路徑的程式碼），但對 fold 的 UPDATE 拋錯
  // （模擬 fold 欄缺失）⇒ refreshFoldColumns 失敗 → countRefreshFailure 累進 fold_refresh_failed。
  const shim = async (sql, params = []) => {
    if (/UPDATE listings SET fold_rent_num/.test(sql)) throw new Error("no such column: fold_rent_num");
    return db.prepare(String(sql)).all(...params);
  };
  const result = await markListingOffline(shim, postId);

  assert.equal(result.offline, true, "主寫入（offline=1）仍要成功");
  assert.equal(counter(), before + 1, "fold 刷新失敗必須讓 fold_refresh_failed 前進");
  db.close();
});
