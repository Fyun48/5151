// 租屋通知偏好／配對訂閱／取消訂閱的 **live PG** 驗證（2026-09-28，第四十三批）。
//
// 離線 parity 用的是記憶體 SQLite 替身，證明不了四件事：
//
//   1. **`ensureRentalNotifyPrefsWriteOnce()` 在真 PG 上真的跑得起來**，而且補出來的
//      `rental_match_subscriptions(owner_user_id, listing_id)` 唯一索引**真的存在**
//      （SQLite 的表約束鏡射不到，這是本系列第五次踩到）。
//   2. **`rental_notify_prefs.user_id` 不是 identity**：`ensurePgSchema()` 會把 SQLite 的
//      `INTEGER PRIMARY KEY` 翻成 identity，而這個欄位是使用者帶來的 id ⇒ 明確寫入不會推進
//      序列，`pg-identity-sequences` 的健檢會永遠紅著、把真正落後的序列蓋掉。
//   3. **prefs 的 `ON CONFLICT(user_id) DO UPDATE` 在 PG 上真的可用**（靠的是鏡射過去的
//      主鍵；這一條在離線夾具裡是 SQLite 在驗，PG 的語意要另外確認）。
//   4. **取消連結端到端**：PG 上真的標記 `used_at`、訂閱真的被關掉、第二次回 already。
//
// ⚠️ 安全設計照抄 `demand-live-pg.test.js`：**不吃 `PG_TEST_URL`**（本機那個指向
// `5151_shadow` 正式影子庫），只認 `PG_LIVE_REPRO_URL` 且資料庫名要在允許清單內。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const RAW = String(process.env.PG_LIVE_REPRO_URL || "").trim();
const ALLOWED_DB = new Set(["repro", "tracker_test", "repro2"]);
const DB = (() => { try { return new URL(RAW).pathname.replace(/^\//, ""); } catch { return ""; } })();
const REFUSED = RAW && !ALLOWED_DB.has(DB);
const skip = !RAW ? "PG_LIVE_REPRO_URL 未設定（live PG 驗證需要隔離環境）"
  : REFUSED ? `拒絕執行：資料庫 "${DB}" 不在允許清單 ${[...ALLOWED_DB].join("/")}（正式庫 5151_shadow 一律拒絕）`
    : false;

const OLD = "2026-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";
const TOKEN = "livetest-nprefs-token-0001";
const FLAGS_ON = JSON.stringify({ wish: { notifications_enabled: true } });

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-nprefs-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;

test("live PG：prefs／訂閱／取消訂閱端到端，唯一索引與 identity 都正確", { skip }, async (t) => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const prefsAsync = await import("../src/rentalNotifyPrefsAsync.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  const who = (await query("SELECT current_database() AS db"))[0];
  assert.equal(who.db, DB, "連到的資料庫必須與 URL 一致");

  const syncSequence = async (table) => {
    await query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM ${table}), 1))`,
      [table],
    );
  };
  // `settings` 是站台層級的共用狀態：先記下原值，收尾要還原（別的 live 測試會讀它）。
  const savedFlags = (await query("SELECT value FROM settings WHERE key = 'rentalMarketplaceFlags'"))[0]?.value ?? null;
  const cleanup = async () => {
    if (savedFlags == null) await query("DELETE FROM settings WHERE key = 'rentalMarketplaceFlags'");
    else await query("UPDATE settings SET value = $1 WHERE key = 'rentalMarketplaceFlags'", [savedFlags]);
    const users = await query("SELECT id FROM users WHERE email LIKE 'live-nprefs-%@example.com'");
    if (!users.length) return;
    const ids = users.map((r) => Number(r.id));
    await query("DELETE FROM rental_unsubscribe_tokens WHERE user_id = ANY($1)", [ids]);
    await query("DELETE FROM rental_match_subscriptions WHERE owner_user_id = ANY($1)", [ids]);
    await query("DELETE FROM rental_notify_prefs WHERE user_id = ANY($1)", [ids]);
    await query("DELETE FROM listings WHERE listed_by_user_id = ANY($1)", [ids]);
    await query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  };
  t.after(async () => {
    try { await cleanup(); } catch { /* 盡力而為 */ }
    try { await pgDriver.close(); } catch { /* 已關就算了 */ }
  });

  await cleanup();
  await syncSequence("users");
  await syncSequence("listings");
  await syncSequence("rental_match_subscriptions");
  // 通知要開著，否則寫入會被 `assertRentalNotificationsEnabled()` 擋下（那是站台政策）。
  await query(
    "INSERT INTO settings(key, value) VALUES ('rentalMarketplaceFlags', $1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [FLAGS_ON],
  );

  // 模組自己的 ensure：鏡射建表 ＋ 補兩條 unique index ＋ DROP IDENTITY（正式路徑同一個順序）。
  await prefsAsync.ensureRentalNotifyPrefsWriteOnce(pgDriver);

  // 1) 唯一索引真的在 PG 上
  const idx = (await query(
    "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'rental_match_subscriptions'",
  )).map((r) => r.indexdef).join("\n");
  assert.match(idx, /UNIQUE INDEX.*\(owner_user_id, listing_id\)/i, `PG 上必須有訂閱的唯一索引（實際：${idx}）`);
  assert.match(idx, /UNIQUE INDEX.*\(public_token\)/i, "PG 上必須有 public_token 的唯一索引");
  // 2) user_id 不是 identity
  const identity = (await query(
    `SELECT is_identity FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'rental_notify_prefs' AND column_name = 'user_id'`,
  ))[0];
  assert.equal(identity?.is_identity, "NO", "user_id 不該是 identity 欄位（否則健檢會永遠紅著）");

  const [UID] = (await query(
    "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'屋主','member','free',$2) RETURNING id",
    ["live-nprefs-owner@example.com", OLD],
  )).map((r) => Number(r.id));
  assert.ok(UID);
  // `listings` 的 NOT NULL 欄位要填齊（`source` 要是 'self' 才會被 `listingOwnedBy()` 看到）
  const LISTING_ID = Number((await query(
    `INSERT INTO listings(source_key, title, url, source, listed_by_user_id, self_status, first_seen_at, last_seen_at)
     VALUES ($1,'live 刊登','https://example.com/live-nprefs','self',$2,'open',$3,$3) RETURNING post_id`,
    [`live-nprefs-${TOKEN}`, UID, OLD],
  ))[0].post_id);

  const exec = async (sql, params = []) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  };
  const opts = { driver: "postgres", pgDriver, exec, strict: true };

  // 3) prefs：第一次是 INSERT（ON CONFLICT 的 insert 分支），第二次是 UPDATE
  const first = await prefsAsync.saveRentalNotifyPrefsForAsync(UID, { new_match: true, channel_mail: true }, opts);
  assert.equal(first.new_match, true);
  assert.equal(first.enabled, true, "caps 必須跟 PG 的 settings（通知是開的）");
  let prefsRow = (await query("SELECT new_match, channel_mail, lifecycle_reminder FROM rental_notify_prefs WHERE user_id = $1", [UID]))[0];
  assert.ok(prefsRow, "prefs 必須真的寫進 PG");
  assert.equal(Number(prefsRow.new_match), 1);
  assert.equal(Number(prefsRow.channel_mail), 1);
  assert.equal(Number(prefsRow.lifecycle_reminder), 1, "沒有給的鍵要沿用預設值");
  const second = await prefsAsync.saveRentalNotifyPrefsForAsync(UID, { new_match: false }, opts);
  assert.equal(second.new_match, false);
  prefsRow = (await query("SELECT new_match, channel_mail FROM rental_notify_prefs WHERE user_id = $1", [UID]))[0];
  assert.equal(Number(prefsRow.new_match), 0, "第二次必須走 UPDATE 分支");
  assert.equal(Number(prefsRow.channel_mail), 1, "UPDATE 不得把其他鍵洗掉");
  assert.equal(
    (await query("SELECT COUNT(*)::int AS n FROM rental_notify_prefs WHERE user_id = $1", [UID]))[0].n, 1,
    "ON CONFLICT 不得寫出第二列",
  );

  // 4) 訂閱：INSERT → UPDATE，而且唯一的索引真的擋得住第二列
  const subFirst = await prefsAsync.saveMatchSubscriptionAsync(UID, LISTING_ID, "instant", opts);
  assert.equal(subFirst.mode, "instant");
  assert.ok(subFirst.subscription_ref, "必須產生 public_token");
  const subSecond = await prefsAsync.saveMatchSubscriptionAsync(UID, LISTING_ID, "daily_digest", opts);
  assert.equal(subSecond.mode, "daily_digest");
  assert.equal(subSecond.subscription_ref, subFirst.subscription_ref, "UPDATE 不得換 token");
  assert.equal(
    (await query("SELECT COUNT(*)::int AS n FROM rental_match_subscriptions WHERE owner_user_id = $1 AND listing_id = $2", [UID, LISTING_ID]))[0].n, 1,
    "同一刊登只能有一列訂閱",
  );
  await assert.rejects(
    () => query(
      `INSERT INTO rental_match_subscriptions(public_token, owner_user_id, listing_id, mode, created_at, updated_at)
       VALUES ($1, $2, $3, 'off', $4, $4)`,
      [`${TOKEN}-dup`, UID, LISTING_ID, OLD],
    ),
    /rental_match_subscriptions_owner_listing_key|duplicate key/i,
    "PG 的唯一索引必須真的擋下第二列",
  );

  // 5) 取消連結：PG 上真的生效、第二次 already
  await query(
    "INSERT INTO rental_unsubscribe_tokens(token, user_id, scope, expires_at, used_at) VALUES ($1, $2, 'all', $3, NULL)",
    [`${TOKEN}-unsub`, UID, FUTURE],
  );
  const unsub = await prefsAsync.applyUnsubscribeTokenAsync(`${TOKEN}-unsub`, opts);
  assert.deepEqual(unsub, { ok: true, already: false });
  prefsRow = (await query("SELECT new_match, daily_digest, channel_mail, channel_push FROM rental_notify_prefs WHERE user_id = $1", [UID]))[0];
  assert.equal(Number(prefsRow.new_match), 0, "scope=all 要關掉 new_match");
  assert.equal(Number(prefsRow.channel_mail), 0, "scope=all 要關掉 mail 通道");
  assert.equal(
    (await query("SELECT mode FROM rental_match_subscriptions WHERE owner_user_id = $1 AND listing_id = $2", [UID, LISTING_ID]))[0].mode, "off",
    "scope=all 要把訂閱關掉",
  );
  assert.ok(
    (await query("SELECT used_at FROM rental_unsubscribe_tokens WHERE token = $1", [`${TOKEN}-unsub`]))[0].used_at,
    "token 必須被標記已用（否則連結可以一直用）",
  );
  const unsubAgain = await prefsAsync.applyUnsubscribeTokenAsync(`${TOKEN}-unsub`, opts);
  assert.deepEqual(unsubAgain, { ok: true, already: true }, "第二次必須回 already");
});
