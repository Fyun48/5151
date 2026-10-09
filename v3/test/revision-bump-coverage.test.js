// 訪客快取前置：補 bump 覆蓋面（2026-10-09）。
//
// 釘住兩件事：
//   1. 每一類「會改變訪客可見性結果集」的寫入，跑完之後 `data_revision.MAX(id)` 都要**嚴格變大**
//      （SQLite 同步版 + 注入式 exec 的 PG 版）。
//   2. bump 失敗**不得**讓主寫入 rollback／丟失，但失敗會被記錄
//      （`revisionBumpFailureStats().failures` 累計，接到 /api/health）。
//
// 隔離子程序模式：db.js 是 singleton，`DB_DRIVER`／`DATA_DIR` 在 import 階段就定死，
// 所以用 spawn 拿乾淨的 process（與 admin-same-house.test.js 同一慣例）。
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
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-rev-bump-"));
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

test("同步寫入：下架／上架／確認下架／批次確認／來源停用都 bump revision", () => {
  runIsolated(`
    seed(1001); seed(1002); seed(1003); seed(1004); seed(1005);

    bump(() => app.markListingOffline(1001));
    bump(() => app.restoreListingOnline(1001));
    bump(() => app.markListingAlive(1002));

    app.markListingOffline(1003);
    bump(() => app.confirmListingOffline(1003));

    app.markListingOffline(1005);
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    db.prepare("UPDATE listings SET offline_at = ?, last_checked_at = ? WHERE post_id = ?").run(old, old, 1005);
    bump(() => { const n = app.confirmExpiredOfflineListings(7); if (n < 1) throw new Error("逾期下線應至少改 1 列"); });

    bump(() => app.saveCrawlSources({ items: [{ id: "rakuya", enabled: false }] }));
  `);
});

test("同步寫入：管理員合併／管理員拆開／全站拆開（global split）都 bump revision", () => {
  runIsolated(`
    seed(1101); seed(1102);
    const admin = app.defaultUserId();

    // 管理員合併（confirmSameHouseAsAdmin → bindListingsToGroup）
    app.setListingMatch(1101, { match_post_id: 1102, match_level: "medium", match_detail: "嫌疑" });
    bump(() => {
      const r = app.confirmSuspectedMatch(1101, admin, { admin: true });
      if (!r?.ok) throw new Error("管理員合併應成功：" + JSON.stringify(r));
    });

    // 管理員拆開
    bump(() => {
      const r = app.adminSplitSameHouse(admin, 1101, 1102);
      if (!r?.ok) throw new Error("管理員拆開應成功：" + JSON.stringify(r));
    });

    // 全站拆開（rejectSuspectedMatch 的 promoted 路徑：2 個會員投 split）
    seed(1103); seed(1104);
    app.setListingMatch(1103, { match_post_id: 1104, match_level: "medium", match_detail: "嫌疑" });
    const u1 = app.ensureUser("splitter-1@example.test");
    const u2 = app.ensureUser("splitter-2@example.test");
    bump(() => {
      app.rejectSuspectedMatch(1103, u1, { peerId: 1104 });
      app.rejectSuspectedMatch(1103, u2, { peerId: 1104 });
    });
  `);
});

test("同步寫入：自租刊登隱藏 bump revision", () => {
  runIsolated(`
    seed(1201, { source: "self" });
    const uid = app.defaultUserId();
    db.prepare("UPDATE listings SET listed_by_user_id = ? WHERE post_id = ?").run(uid, 1201);
    bump(() => app.hideSelfListing(1201));
  `);
});

test("PG 寫入（注入式 exec）：markListingOffline／restore／alive／confirmExpired 都 bump revision", () => {
  runIsolated(`
    seed(1301); seed(1302); seed(1303); seed(1304);
    const writes = await import(${JSON.stringify(pathToFileURL(path.join(dir, "../src/crawlerWrites.js")).href)});
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
      await writes.markListingOfflineAsync(1301, pg);
      const after = currentRevision(db);
      if (!(after > before)) throw new Error("PG markListingOffline 沒 bump revision");
    })();

    await (async () => {
      const before = currentRevision(db);
      await writes.restoreListingOnlineAsync(1301, pg);
      if (!(currentRevision(db) > before)) throw new Error("PG restoreListingOnline 沒 bump");
    })();

    await (async () => {
      const before = currentRevision(db);
      await writes.markListingAliveAsync(1302, { ...pg, wasOffline: false });
      if (!(currentRevision(db) > before)) throw new Error("PG markListingAlive 沒 bump");
    })();

    await (async () => {
      app.markListingOffline(1304);
      const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
      db.prepare("UPDATE listings SET offline_at = ?, last_checked_at = ? WHERE post_id = ?").run(old, old, 1304);
      writes.resetExpiredOfflineSweepForTests();
      const before = currentRevision(db);
      await writes.confirmExpiredOfflineAsync({ days: 7, now: Date.now() + 61_000 }, pg);
      if (!(currentRevision(db) > before)) throw new Error("PG confirmExpiredOffline 沒 bump");
    })();
  `);
});

test("bump 失敗不 rollback 主寫入，而且被記錄到 revisionBumpFailureStats", () => {
  runIsolated(`
    import { resetRevisionBumpFailureStats, revisionBumpFailureStats } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/dataRevisionHealth.js")).href)};
    resetRevisionBumpFailureStats();
    seed(1401);

    // 用 trigger 讓 data_revision 的 INSERT 一定失敗，但 listings 的 UPDATE 不受影響。
    db.exec("CREATE TRIGGER fail_revision BEFORE INSERT ON data_revision BEGIN SELECT RAISE(ABORT, 'forced revision failure'); END");
    try {
      const row = app.markListingOffline(1401);
      if (!row || Number(row.offline) !== 1) throw new Error("主寫入（offline=1）必須成功");
      if (revisionBumpFailureStats().failures < 1) throw new Error("bump 失敗必須被記錄");
    } finally {
      db.exec("DROP TRIGGER IF EXISTS fail_revision");
    }
  `);
});

test("PG bump 走 SAVEPOINT：INSERT 失敗時回捲 savepoint、主交易不受影響", async () => {
  const { bumpRevisionPgClient } = await import("../src/revisionBumpAsync.js");
  const { resetRevisionBumpFailureStats, revisionBumpFailureStats } = await import("../src/dataRevisionHealth.js");
  resetRevisionBumpFailureStats();
  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push(String(sql));
      if (/^INSERT INTO data_revision/.test(String(sql))) throw new Error("forced bump failure");
      return { rows: [], rowCount: 0 };
    },
  };
  const ok = await bumpRevisionPgClient(client, { entityType: "listing", eventType: "listing_offline" });
  assert.equal(ok, false);
  assert.ok(calls.includes("SAVEPOINT revision_bump"), "要先開 SAVEPOINT");
  assert.ok(calls.includes("ROLLBACK TO SAVEPOINT revision_bump"), "INSERT 失敗要回捲 SAVEPOINT");
  assert.equal(revisionBumpFailureStats().failures, 1, "失敗要累計");
});
