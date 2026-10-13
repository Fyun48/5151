// `settings.foldRootWriteGen` 世代鍵的**真 PG** 驗收（升級層 2026-10-13 開閘硬條件）。
//
// 劇本（交辦單第 6 條：「寫入後立即的下一句請求被拒、不靠快取救回」）：
//   A. 沒有寫入過（世代鍵缺鍵 ⇒ 0）＋戳記 writeGen=0 ⇒ 開閘前檢放行；同一個 gen 再問一次吃快取。
//   B. 用**生產寫入器** `refreshFoldComponentRoot()` 做一次**原地 UPDATE** `fold_component_root`
//      （rows／maxPostId 都不變）⇒ 世代鍵 +1 ⇒ **下一句**（同一個行程、不 reset 快取）必須被拒，
//      reason=`fold_root_drift_stamp_gen_stale`。
//   C. 重寫戳記＝`--stamp` 捕捉當下的世代鍵 ⇒ 又放行；把 writeGen 拿掉（舊式戳記）⇒ gen_missing。
//
// 為什麼在**自己的 schema** 裡做：這支會 CREATE／DROP 表，不能碰任何既有的表；`search_path`
// 讓 `listings`／`settings` 全部解析到本測試自己的表（`to_regclass('listings')` 也跟著 search_path，
// 與線上閘門同一條探測）。CI 的拋棄式庫有沒有 `fold_component_root` 欄都不影響這一支。
//
// 只在真 PG 上跑（`PG_TEST_URL` gate；CI 的 test-postgres job 就是這一顆）。
// ⚠️ 會寫入 ⇒ 目標庫必須落在**可寫白名單**（repro／tracker_test／crawl_sandbox），且明文**排除
//    repro2**（凍結髒基準，寫了會毀掉它）；不在名單一律 SKIP（fail-closed，永不寫正式庫）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import {
  foldSqlGateReady, resetFoldSqlGate, resetFoldRootRefreshProbe,
  readFoldRootWriteGen, refreshFoldComponentRoot,
  FOLD_DRIFT_STAMP_KEY,
} from "../src/foldComponentRoot.js";

const pgUrl = process.env.PG_TEST_URL || process.env.PG_URL || "";
const WRITABLE_DBS = ["repro", "tracker_test", "crawl_sandbox"];
function dbNameOf(url) {
  try { return new URL(url).pathname.replace(/^\//, ""); } catch { return ""; }
}
const dbName = dbNameOf(pgUrl);
const skip = !pgUrl
  ? "PG_TEST_URL 未設定（CI 的 test-postgres job 會設定）"
  : (WRITABLE_DBS.includes(dbName)
    ? false
    : `PG_TEST_URL 的資料庫 "${dbName || "?"}" 不在可寫白名單（僅 ${WRITABLE_DBS.join("／")}）⇒ 拒跑（fail-closed，永不寫 repro2／正式庫）`);

const SCHEMA = "fold_genkey_live";
const A = 900001; // 指向 B 的 match 邊（會被 union 成同一個分量）
const B = 900002;
const LONE = 900003; // 孤列（保持 NULL，不參與分量）

async function writeStamp(exec, { rows, maxPostId, writeGen }) {
  const payload = { at: new Date().toISOString(), rows, components: 1, mismatches: 0 };
  if (writeGen !== undefined) payload.writeGen = writeGen;
  payload.dataVersion = { rows, maxPostId, rootsMd5: "live-test" };
  await exec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [FOLD_DRIFT_STAMP_KEY, JSON.stringify(payload)]);
  return payload;
}

test("原地 UPDATE fold_component_root ⇒ 世代鍵過時 ⇒ 下一句就被拒（不靠快取救回）", { skip }, async () => {
  const drv = await createPostgresDriver({ env: { ...process.env, PG_URL: pgUrl } });
  const client = await drv.pool.connect();
  const rawExec = (sql, params = []) => client.query(toPostgresSql(sql), params).then((r) => r.rows);
  const counters = { listings: 0 };
  const countedExec = (sql, params = []) => {
    if (/FROM listings/.test(sql)) counters.listings += 1;
    return rawExec(sql, params);
  };
  try {
    // 冪等：前一次跑失敗留下的 schema 一律先清掉（只清自己建的那一個）。
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.query("CREATE SCHEMA " + SCHEMA);
    await client.query("SET search_path TO " + SCHEMA);
    await rawExec(`
      CREATE TABLE listings (post_id bigint PRIMARY KEY, source text, match_post_id bigint,
                             match_verdict text, fold_component_root bigint);
      CREATE TABLE listing_prep (post_id bigint PRIMARY KEY, display_ready integer);
      CREATE TABLE listing_group_members (post_id bigint, group_id text);
      CREATE TABLE settings (key text PRIMARY KEY, value text NOT NULL);
    `);
    await rawExec(
      "INSERT INTO listings (post_id, source, match_post_id, match_verdict, fold_component_root) VALUES (?, '591', ?, 'match', NULL), (?, '591', NULL, NULL, NULL), (?, '591', NULL, NULL, NULL)",
      [A, B, B, LONE],
    );
    resetFoldRootRefreshProbe(); resetFoldSqlGate();

    // ── A. 尚未寫入 root：戳記 writeGen=0 ⇒ 放行；同 gen 再問一次吃快取 ──────────────
    const before = (await rawExec("SELECT count(*) AS n, max(post_id) AS max_post_id FROM listings"))[0];
    assert.equal(await readFoldRootWriteGen(rawExec), 0, "沒有寫入過 ⇒ 世代鍵缺鍵 ⇒ 0");
    await writeStamp(rawExec, { rows: Number(before.n), maxPostId: Number(before.max_post_id), writeGen: 0 });
    const gateA = await foldSqlGateReady(countedExec);
    assert.equal(gateA.ok, true, `A 階段必須放行（${JSON.stringify(gateA)}）`);
    assert.equal(gateA.detail.writeGen, 0);
    const listingsAfterA = counters.listings;
    assert.equal((await foldSqlGateReady(countedExec)).ok, true, "同 gen、TTL 內必須吃快取");
    assert.equal(counters.listings, listingsAfterA, "快取命中不得再查 listings 資料版本");

    // ── B. 生產寫入器的**原地 UPDATE**：rows／maxPostId 不變，只有世代鍵動 ────────────
    const refreshed = await refreshFoldComponentRoot(rawExec, A);
    assert.ok(refreshed.changed >= 1, `refreshFoldComponentRoot 必須真的改到列：${JSON.stringify(refreshed)}`);
    const after = (await rawExec("SELECT count(*) AS n, max(post_id) AS max_post_id FROM listings"))[0];
    assert.equal(Number(after.n), Number(before.n), "原地 UPDATE 不改列數");
    assert.equal(Number(after.max_post_id), Number(before.max_post_id), "原地 UPDATE 不改 max(post_id)");
    assert.equal(Number((await rawExec("SELECT fold_component_root FROM listings WHERE post_id = ?", [B]))[0].fold_component_root), A);
    assert.equal(await readFoldRootWriteGen(rawExec), 1, "寫入路徑必須把世代鍵 +1");

    const gateB = await foldSqlGateReady(countedExec); // 不 reset ⇒ 這是「寫入後的下一句」
    assert.equal(gateB.ok, false, `原地寫入後的下一句必須被拒（${JSON.stringify(gateB)}）`);
    assert.equal(gateB.reason, "fold_root_drift_stamp_gen_stale");
    assert.equal(gateB.detail.stampedWriteGen, 0);
    assert.equal(gateB.detail.liveWriteGen, 1);
    assert.equal(counters.listings > listingsAfterA, true, "gen 一變就重驗（不是吃舊的成功快取）");

    // ── C. 重跑 --stamp（捕捉當下世代鍵）⇒ 放行；舊式戳記（缺 writeGen）⇒ gen_missing ──
    resetFoldSqlGate();
    const gen = await readFoldRootWriteGen(rawExec);
    await writeStamp(rawExec, { rows: Number(after.n), maxPostId: Number(after.max_post_id), writeGen: gen });
    const gateC1 = await foldSqlGateReady(countedExec);
    assert.equal(gateC1.ok, true, `重寫戳記後必須放行（${JSON.stringify(gateC1)}）`);
    assert.equal(gateC1.detail.writeGen, 1);

    resetFoldSqlGate();
    await writeStamp(rawExec, { rows: Number(after.n), maxPostId: Number(after.max_post_id) }); // 舊式：沒有 writeGen
    const gateC2 = await foldSqlGateReady(countedExec);
    assert.equal(gateC2.ok, false);
    assert.equal(gateC2.reason, "fold_root_drift_stamp_gen_missing");
  } finally {
    resetFoldRootRefreshProbe(); resetFoldSqlGate();
    try {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } catch { /* 清理失敗不要蓋掉真正的斷言 */ }
    client.release();
    await drv.close();
  }
});
