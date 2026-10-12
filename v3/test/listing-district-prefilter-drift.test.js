// 行政區投影守門的**正確性紅線**（se-p7，2026-10-12）：漂移不可能被快取掩蓋。
//
// 這一檔是**唯一會寫入**的 prefilter 測試，所以 gate 比照 `member-listing-cache-live-pg.test.js`：
// 只認資料庫名在允許清單內（CI 的拋棄式 `tracker_test`／隔離庫 `repro`／`repro2`／`crawl_sandbox`），
// 名稱是正式影子庫（`5151_shadow`）就**拒絕執行**。它注入的兩列（人造 post_id ≥ 990000000）
// 在測試結束時一定刪掉。
//
// 紅線要證明的兩件事（缺一不可）：
//   (i)  drift 是「有人直接把一列寫進 `listings`、投影表沒有、**`data_revision` 也沒有任何紀錄**」
//        ⇒ 下一個請求的守門**仍然**必須判 `ok=false`。快取（watermark／增量）不得把它蓋掉。
//   (ii) 把投影補上之後，下一個請求必須回到 `ok=true`（而且不是靠「指紋一直變」誤打誤撞）。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const RAW = String(process.env.PG_TEST_URL || process.env.PG_LIVE_REPRO_URL || "").trim();
const ALLOWED_DB = new Set(["repro", "tracker_test", "repro2", "crawl_sandbox"]);
const DB = (() => { try { return new URL(RAW).pathname.replace(/^\//, ""); } catch { return ""; } })();
const REFUSED = RAW && !ALLOWED_DB.has(DB);
const skip = !RAW ? "PG_TEST_URL／PG_LIVE_REPRO_URL 未設定（紅線測試需要可寫的隔離環境）"
  : REFUSED ? `拒絕執行：資料庫 "${DB}" 不在允許清單 ${[...ALLOWED_DB].join("/")}（正式庫 5151_shadow 一律拒絕）`
    : false;

const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "v3-prefilter-drift-"));
process.env.DATA_DIR = DATA_DIR;
after(() => rmSync(DATA_DIR, { recursive: true, force: true }));

const NAMES = ["中山區"];
const DRIFT_PID = 990000123; // 人造 post_id：遠離正式資料（正式庫最大 post_id 是 9 碼以內）

// 注入用的專用連線：`end()` 會讓 backend 把待送的統計計數落地（結構指紋才看得到），
// 這正是「下一次請求」之前必須成立的事。
async function inject(sql, params) {
  const pg = (await import("pg")).default;
  const client = new pg.Client({ connectionString: RAW });
  await client.connect();
  try {
    return await client.query(sql, params);
  } finally {
    await client.end();
  }
}

async function withDriver(run) {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const driver = await createPostgresDriver({ connectionString: RAW });
  const exec = (sql, params = []) => driver.query(toPostgresSql(sql), params).then((res) => res.rows);
  try {
    return await run(exec);
  } finally {
    await driver.close();
  }
}

test("紅線：listings 有列、投影沒有、data_revision 也沒動 ⇒ 下一個請求的守門仍必須判 ok=false（快取不得掩蓋漂移）", { skip }, async () => {
  const { districtProjectionVerified, resetDistrictProjectionCompletenessCache } =
    await import("../src/listingDistrictPrefilter.js");
  const { districtKeyLists } = await import("../src/listDistrictSql.js");
  const verifyArgs = { districtNames: NAMES, allowedKeys: districtKeyLists(NAMES).allowed };

  await withDriver(async (exec) => {
    await exec("DELETE FROM listing_search_projection WHERE post_id = ?", [DRIFT_PID]);
    await exec("DELETE FROM listings WHERE post_id = ?", [DRIFT_PID]);

    // 0) CI 的拋棄式庫可能**是空的**（表在、`listings`／`data_revision` 都沒有列）。本測試要證的
    //    是「版本沒前進，所以快取不得被沿用」，所以沒有版本號時先用**等一下要注入的 post_id**
    //    造一個基準版本（測完刪掉）—— 不新增任何 listings 假列，也不把測試跳過（跳過就等於
    //    這條紅線在 CI 上不存在）。
    let seededRevision = null;
    let revisionBefore = (await exec("SELECT MAX(id) AS n FROM data_revision"))[0]?.n ?? null;
    if (revisionBefore == null) {
      seededRevision = (await exec(
        "INSERT INTO data_revision (entity_type, entity_id, event_type, created_at) VALUES ('listing', ?, 'listing_updated', ?) RETURNING id",
        [DRIFT_PID, Date.now()],
      ))[0]?.id ?? null;
      revisionBefore = (await exec("SELECT MAX(id) AS n FROM data_revision"))[0]?.n ?? null;
    }

    // 1) 乾淨狀態：全掃一次並把驗證範圍記進快取。
    resetDistrictProjectionCompletenessCache();
    const cachedVerdict = await districtProjectionVerified(exec, verifyArgs);
    assert.equal(cachedVerdict, true, "前置條件：乾淨的投影必須先驗證通過");

    assert.notEqual(revisionBefore, null, "前置條件：data_revision 必須有版本號（否則本測試證明不了『版本沒前進』）");
    assert.equal(cachedVerdict, true, "前置條件：驗證過的乾淨狀態必須進了快取（否則這條測試證明不了『快取不得掩蓋漂移』）");

    // 2) 注入漂移：人造 listings 列，**不寫投影、也不 bump data_revision**。
    await inject(
      "INSERT INTO listings (post_id, source_key, title, url, first_seen_at, last_seen_at) VALUES ($1, '999|999|x', 'se-p7 drift probe', 'https://se-p7.invalid/drift', 1, 1)",
      [DRIFT_PID],
    );
    const revisionAfter = (await exec("SELECT MAX(id) AS n FROM data_revision"))[0]?.n ?? null;
    assert.equal(String(revisionAfter), String(revisionBefore),
      "前置條件：注入漂移不得讓 data_revision 前進（否則就不是『revision 沒有前進』的情境）");

    // 3) 紅線：下一個請求必須判 false。
    assert.equal(
      await districtProjectionVerified(exec, verifyArgs),
      false,
      "紅線破了：listings 有一列而投影沒有、data_revision 沒有前進時，守門卻回 ok=true（＝篩選會靜默少算，預篩把這一列濾掉了）",
    );

    // 4) 再問一次（版本仍然沒動）：不得因為任何快取又變回 true。
    assert.equal(
      await districtProjectionVerified(exec, verifyArgs),
      false,
      "紅線破了：漂移還沒修好（data_revision 也沒動）時，第二次請求把 ok 判回 true（負面結果被快取掩蓋）",
    );

    // 5) 修好投影：下一個請求必須回到 true。
    await inject(
      "INSERT INTO listing_search_projection (post_id, district) VALUES ($1, '') ON CONFLICT (post_id) DO NOTHING",
      [DRIFT_PID],
    );
    assert.equal(
      await districtProjectionVerified(exec, verifyArgs),
      true,
      "投影補上之後，守門必須回到 ok=true（否則修好了也不會回復預篩）",
    );

    // 清理（不留人造列給後續測試／後續請求）。
    await exec("DELETE FROM listing_search_projection WHERE post_id = ?", [DRIFT_PID]);
    await exec("DELETE FROM listings WHERE post_id = ?", [DRIFT_PID]);
    if (seededRevision != null) await exec("DELETE FROM data_revision WHERE id = ?", [seededRevision]);
    resetDistrictProjectionCompletenessCache();
    assert.equal((await exec("SELECT COUNT(*) AS n FROM listings WHERE post_id = ?", [DRIFT_PID]))[0]?.n, 0, "清理乾淨");
  });
});
