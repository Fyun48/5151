// `/api/listings/:id/reject-match` 的 **live PG** 驗證（2026-09-27）。
//
// 離線 parity 測試（reject-match-async.test.js）證明的是「PG 分支與同步版落地同樣的位元組」，
// 但它用的 PG 替身是記憶體 SQLite。**只有真 PG 能證明這些語句真的是合法 PG**
// ——例如 `ON CONFLICT(user_id, post_id, peer_id)` 真的對得上一個唯一索引、
// 欄位真的存在、方言真的沒寫錯。CUTOVER-STALL-ROOTCAUSE 的教訓正是：
// 全離線測試讓「查詢在真 PG 上不成立／很慢」這種問題上了線。
//
// ⚠️ **安全設計（刻意的，不要簡化）**：
//   * 這支**不吃** `PG_TEST_URL`。2026-09-27 實測 `PG_TEST_URL` 指向的
//     `192.168.0.220:15432/5151_shadow` **就是正式站**（同一個 postmaster、同一個資料庫）。
//     若照 repo 慣例 gate 在 `PG_TEST_URL` 上，本機一跑就會寫進正式庫。
//   * 改成只認明確的 `PG_LIVE_REPRO_URL`，且**資料庫名必須在允許清單內**；
//     `5151_shadow` 一律拒絕。雙重防護，避免下一個 session 誤用。
//
// 用法（隔離環境，NAS 上的 prb-repro-pg）：
//   PG_LIVE_REPRO_URL='postgres://postgres:x@192.168.0.220:15434/repro' \
//     node --test v3/test/reject-match-live-pg.test.js
import { test } from "node:test";
import assert from "node:assert/strict";

const RAW = String(process.env.PG_LIVE_REPRO_URL || "").trim();
// 只允許明確的隔離資料庫名。正式庫（5151_shadow）永遠不在此列。
const ALLOWED_DB = new Set(["repro", "tracker_test", "repro2"]);
const DB = (() => { try { return new URL(RAW).pathname.replace(/^\//, ""); } catch { return ""; } })();
const REFUSED = RAW && !ALLOWED_DB.has(DB);
const skip = !RAW ? "PG_LIVE_REPRO_URL 未設定（live PG 驗證需要隔離環境）"
  : REFUSED ? `拒絕執行：資料庫 "${DB}" 不在允許清單 ${[...ALLOWED_DB].join("/")}（正式庫 5151_shadow 一律拒絕）`
    : false;

// 先載入 db.js 建立完整 SQLite schema（本檔仍會用到它的純函式與 listing 裝飾鏈）。
process.env.DATA_DIR ||= "/tmp/v3-live-pg-verify";

// 自己種一筆 listing。欄位清單**從 PG 的 information_schema 推導**，不硬編——
// 手寫欄位一定會漏（本系列已經因為「憑印象寫欄位名」踩過一次），
// 而 NOT NULL 又沒有 default 的欄位漏掉就會直接 INSERT 失敗。
async function seedListing(query, postId, extra = {}) {
  const required = (await query(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'listings'
        AND is_nullable = 'NO' AND column_default IS NULL AND is_identity = 'NO'
      ORDER BY ordinal_position`,
  ));
  const provided = { post_id: postId, source: "591", source_key: `live_${postId}`, title: `live ${postId}`, ...extra };
  const names = [...new Set([...required.map((c) => c.column_name), ...Object.keys(provided)])];
  const values = names.map((name) => {
    if (name in provided) return provided[name];
    const col = required.find((c) => c.column_name === name);
    return /int|numeric|real|double|bigint|smallint/i.test(col?.data_type || "") ? 0 : "";
  });
  await query(
    `INSERT INTO listings(${names.map((n) => `"${n}"`).join(",")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(",")})`,
    values,
  );
}

test("live PG：rejectSuspectedMatchAsync 對真 PostgreSQL 端到端可跑，且票／訊號／事件真的落地", { skip }, async () => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { rejectSuspectedMatchAsync } = await import("../src/sameHouseAsync.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = (sql, params = []) => pgDriver.query(sql, params).then((r) => r.rows);

  // 先確認我們真的連到預期的隔離庫（防止 URL 被改成正式站）。
  const who = (await query("SELECT current_database() AS db"))[0];
  assert.equal(who.db, DB, "連到的資料庫必須與 URL 一致");
  assert.ok(ALLOWED_DB.has(who.db), `拒絕在 ${who.db} 上執行`);

  // 這兩筆是自己種的，id 刻意選在極高處：
  //   * 用明確 id 插入**不會**推進 identity 序列，所以若選在 max 附近，
  //     之後任何「不指定 id 的 INSERT」就可能撞到它們。
  //   * 選在 9e11 這種遠離序列目前值的位置，就不可能被撞到。
  const lo = 900000000001;
  const hi = 900000000002;
  // 自我修復：上一次若死在種資料與清理之間，殘骸會把 `listings.post_id` 的
  // 「max 遠大於序列」狀態留下來，害下一次的序列前置檢查誤報。先清掉再檢查。
  await query("DELETE FROM listings WHERE post_id IN ($1,$2)", [lo, hi]).catch(() => {});

  // ⚠️ 前置條件：identity 序列必須健康。
  // 這一項不是形式主義——本檔第一次跑的時候就是死在這裡的**症狀**上：
  //   duplicate key value violates unique constraint "user_match_signals_pkey"
  // 根因是匯入資料時帶了明確 id、但序列沒有前進（`is_called=false`），
  // 於是 `nextval()` 回傳已經存在的 max。若不在前面大聲講，後面的失敗訊息會誤導人
  // 去查應用程式的 SQL（我一開始就是這樣）。修法見 `v3/scripts/pg-identity-sequences.mjs`。
  const behind = [];
  for (const { table_name: t, column_name: c } of (await query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema='public' AND is_identity='YES' ORDER BY 1,2`,
  ))) {
    const seq = (await query("SELECT pg_get_serial_sequence($1,$2) AS s", [t, c]))[0]?.s;
    if (!seq) continue;
    const max = Number((await query(`SELECT COALESCE(max("${c}"),0) AS m FROM "${t}"`))[0].m);
    const v = (await query(`SELECT last_value AS lv, is_called FROM ${seq}`))[0];
    const next = v.is_called === true ? Number(v.lv) + 1 : Number(v.lv);
    if (next <= max) behind.push(`${t}.${c} (next=${next} max=${max})`);
  }
  assert.deepEqual(behind, [],
    `identity 序列落後，任何不指定 id 的 INSERT 都會撞主鍵。請先跑 `
    + `node v3/scripts/pg-identity-sequences.mjs --repair --apply --database ${DB}`);

  // 自己種一組配對，**不依賴既有 fixture 資料**。
  // 第一版是「從真資料挑一組」，在本機的 repro PG（由生產 dump 還原）行得通，
  // 但 CI 的 tracker_test 是從 repo 的 fixture 灌的，裡面沒有任何 match_post_id，
  // 於是這條斷言在 CI 直接失敗。**測試必須自給自足**，不能假設別人的資料長什麼樣。
  await seedListing(query, lo, { match_post_id: hi, match_level: "high" });
  await seedListing(query, hi, { match_post_id: lo, match_level: "high" });

  // 用一個刻意挑選、且不屬於任何真實會員的 uid，避免污染既有資料。
  // users 表在 PG 上沒有 FK 約束（已查 information_schema），所以不需要先建 user。
  const uid = 987654321;
  const before = {
    votes: (await query("SELECT count(*) AS n FROM user_match_votes WHERE user_id = $1", [uid]))[0].n,
    signals: (await query("SELECT count(*) AS n FROM user_match_signals WHERE user_id = $1", [uid]))[0].n,
    events: (await query("SELECT count(*) AS n FROM user_events WHERE user_id = $1", [uid]))[0].n,
  };

  let out;
  let decorationError = null;
  try {
    try {
      out = await rejectSuspectedMatchAsync(lo, uid, {
        peerId: hi,
        driver: "postgres",
        pgDriver,
      });
    } catch (error) {
      // getListingAsync 需要完整的裝飾鏈（settings／crawl_covers／route_cache…）。
      // 它是在**所有寫入之後**才呼叫，所以下面「實際落地的列」的斷言完全不受影響。
      // 但失敗必須看得見，不能靜默通過（沿用離線測試的處理方式）。
      decorationError = error;
    }

    if (decorationError) {
      assert.match(decorationError.message, /listing|decorat|provider|not a function|no such table|does not exist/i,
        `PG 分支非預期錯誤（不是裝飾鏈問題）：${decorationError.message}`);
    } else {
      assert.equal(out.ok, true, `PG 分支應該成功，實際：${JSON.stringify(out)}`);
      assert.equal(out.personal, true);
    }

    const after = {
      votes: (await query("SELECT count(*) AS n FROM user_match_votes WHERE user_id = $1", [uid]))[0].n,
      signals: (await query("SELECT count(*) AS n FROM user_match_signals WHERE user_id = $1", [uid]))[0].n,
      events: (await query("SELECT count(*) AS n FROM user_events WHERE user_id = $1", [uid]))[0].n,
    };
    assert.equal(after.votes, before.votes + 1, "真 PG 上必須新增 1 筆 user_match_votes（upsert 的 ON CONFLICT 目標必須真的存在）");
    assert.equal(after.signals, before.signals + 1, "真 PG 上必須新增 1 筆 user_match_signals");
    assert.equal(after.events, before.events + 1, "真 PG 上必須新增 1 筆 user_events");

    const vote = (await query(
      "SELECT vote, confidence FROM user_match_votes WHERE user_id = $1 AND post_id = $2 AND peer_id = $3",
      [uid, lo, hi],
    ))[0];
    assert.equal(vote.vote, "split", "票種必須是 split");
    console.log(`[live-pg] OK post_id=${lo} peer=${hi} confidence=${vote.confidence}`
      + ` decorated=${decorationError ? "no" : "yes"}`);

    // 第二次拆開必須走 already 分支，不得再插訊號（真 PG 上的冪等性）。
    // 這一項只需要 DB，與裝飾鏈無關，所以不因 decorationError 而跳過。
    const again = await rejectSuspectedMatchAsync(lo, uid, { peerId: hi, driver: "postgres", pgDriver })
      .catch((error) => ({ __error: error }));
    if (again.__error) {
      assert.match(again.__error.message, /listing|decorat|provider|not a function|no such table|does not exist/i,
        `第二次拆開非預期錯誤：${again.__error.message}`);
    } else {
      assert.equal(again.already, true, "第二次拆開應該回 already");
    }
    const signals2 = (await query("SELECT count(*) AS n FROM user_match_signals WHERE user_id = $1", [uid]))[0].n;
    assert.equal(signals2, after.signals, "第二次拆開不得再寫訊號");
  } finally {
    // 清乾淨：這顆是隔離庫，但仍不留測試殘骸。
    await query("DELETE FROM user_match_signals WHERE user_id = $1", [uid]).catch(() => {});
    await query("DELETE FROM user_match_votes WHERE user_id = $1", [uid]).catch(() => {});
    await query("DELETE FROM user_events WHERE user_id = $1", [uid]).catch(() => {});
    await query("DELETE FROM user_same_house_members WHERE user_id = $1", [uid]).catch(() => {});
    await query("DELETE FROM listings WHERE post_id IN ($1,$2)", [lo, hi]).catch(() => {});
    await pgDriver.close?.();
  }
});

test("live PG：未登入與找不到物件的錯誤路徑不寫入任何東西", { skip }, async () => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { rejectSuspectedMatchAsync } = await import("../src/sameHouseAsync.js");
  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  try {
    const guest = await rejectSuspectedMatchAsync(1, 0, { driver: "postgres", pgDriver });
    assert.deepEqual(guest, { ok: false, code: "guest", error: "請先登入才能拆開同屋源" });
    const missing = await rejectSuspectedMatchAsync(-1, 987654321, { driver: "postgres", pgDriver });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "not_found");
  } finally {
    await pgDriver.close?.();
  }
});
