// 訪客快取前置：自動配對（setListingMatch／reconcileListingById）的 bump 覆蓋（2026-10-10）。
//
// 釘住：`setListingMatch`（同步 + PG）寫 `match_post_id`／`match_level`／`match_detail`／
// `match_rejected`＋群組綁定，會改變同屋摺疊（same_house 裝飾）——那是訪客快取回應的一部分，
// 所以跑完要 `data_revision.MAX(id)` 嚴格變大；bump 失敗不 rollback 主寫入、且被記錄。
//
// 隔離子程序模式（db.js 是 singleton，與 revision-bump-coverage.test.js 同一慣例）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const ISOLATED_TIMEOUT_MS = Math.max(30_000, Number(process.env.V3_ISOLATED_TEST_TIMEOUT_MS) || 180_000);

function runIsolated(body) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-match-bump-"));
  const script = `
    import * as app from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/db.js")).href)};
    import { currentRevision, ensureDataRevisionTable } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/dataRevision.js")).href)};
    const db = app.sqliteHandle();
    ensureDataRevisionTable(db);
    function seed(post_id, overrides = {}) {
      app.upsertListing({
        post_id, source: overrides.source || "591", source_id: String(post_id),
        source_key: "1|8|" + post_id, search_key: "https://example.test/search",
        title: "合成住宅 " + post_id, url: "https://example.test/" + post_id,
        price: "20000元", price_num: 20000, extra_fees: [],
        address: "台北市士林區測試路" + post_id + "號", area_name: "20坪",
        layout: "2房1廳", floor_name: "5/12", kind_name: "整層住家/電梯大樓",
        role_name: "", cover: "", tags: "[]",
        refresh_time: "2026-09-01T00:00:00.000Z",
        first_seen_at: "2026-09-01T00:00:00.000Z",
        last_seen_at: "2026-09-01T00:00:00.000Z", last_event: "new",
        ...overrides,
      });
    }
    const bump = (fn) => {
      const before = currentRevision(db);
      fn();
      const after = currentRevision(db);
      if (!(after > before)) throw new Error("revision 沒有嚴格變大：before=" + before + " after=" + after);
    };
    ${body}
    console.log(JSON.stringify({ ok: true }));
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: ISOLATED_TIMEOUT_MS,
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim().split("\n").filter((row) => row.startsWith("{")).at(-1));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

test("同步 setListingMatch 寫 match_post_id／群組 ⇒ revision 嚴格變大", () => {
  runIsolated(`
    seed(3001); seed(3002);
    bump(() => app.setListingMatch(3001, { match_post_id: 3002, match_level: "medium", match_detail: "嫌疑" }));
    // 解綁（match_post_id 設回 null）也是可見性寫入（同屋摺疊還原）⇒ 也要 bump。
    bump(() => app.setListingMatch(3001, { match_post_id: null, match_level: null, match_detail: "" }));
  `);
});

test("PG setListingMatchAsync（注入式 exec）寫 match_post_id ⇒ revision 嚴格變大", () => {
  runIsolated(`
    seed(3101); seed(3102);
    const writes = await import(${JSON.stringify(pathToFileURL(path.join(dir, "../src/listingMatchAsync.js")).href)});
    const shim = async (sql, params = []) => {
      const text = String(sql).replace(/\\$(\\d+)/g, "?");
      const stmt = db.prepare(text);
      if (/^\\s*(select|with)/i.test(text)) return stmt.all(...params);
      stmt.run(...params);
      return [];
    };
    const pg = { driver: "postgres", exec: shim, strict: true };
    await (async () => {
      const before = currentRevision(db);
      await writes.setListingMatchAsync(3101, { match_post_id: 3102, match_level: "medium", match_detail: "嫌疑" }, pg);
      if (!(currentRevision(db) > before)) throw new Error("PG setListingMatch 沒 bump");
    })();
  `);
});

test("bump 失敗不 rollback 主寫入（match_post_id 照寫）且被記錄", () => {
  runIsolated(`
    import { resetRevisionBumpFailureStats, revisionBumpFailureStats } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/dataRevisionHealth.js")).href)};
    resetRevisionBumpFailureStats();
    seed(3201); seed(3202);
    db.exec("CREATE TRIGGER fail_revision BEFORE INSERT ON data_revision BEGIN SELECT RAISE(ABORT, 'forced revision failure'); END");
    try {
      app.setListingMatch(3201, { match_post_id: 3202, match_level: "medium", match_detail: "嫌疑" });
      const row = db.prepare("SELECT match_post_id FROM listings WHERE post_id = ?").get(3201);
      if (Number(row.match_post_id) !== 3202) throw new Error("主寫入（match_post_id）必須成功");
      if (revisionBumpFailureStats().failures < 1) throw new Error("bump 失敗必須被記錄");
    } finally {
      db.exec("DROP TRIGGER IF EXISTS fail_revision");
    }
  `);
});
