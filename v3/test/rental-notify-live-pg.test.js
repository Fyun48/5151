// 租屋通知寫入的 **live PG** 驗證（2026-09-28）。
//
// 離線 parity（`rental-notify-write-async.test.js`）用的是記憶體 SQLite 夾具，它證明不了：
//
//   1. **`ensurePgSchema` 鏡射 + 補唯一索引在真 PG 上真的跑得起來**。`UNIQUE(event_id, channel)`
//      與 `event_key` UNIQUE 在 SQLite 是**表約束／隱式索引**，鏡射抓不到，要靠
//      `RENTAL_NOTIFY_UNIQUE_INDEXES` 自己補——這一段程式碼離線**碰不到**
//      （只在沒有注入 exec 時才跑），所以只能靠 live 驗。
//   2. `ON CONFLICT(event_key)` / `ON CONFLICT(event_id, channel)` 在真 PG 上合法
//      （需要真的有那個唯一索引，否則會是 `42P10`）。
//   3. 寫入真的生效（不是只回了一個看起來對的結果）。
//
// ⚠️ 安全設計照抄其他 live 測試：**不吃 `PG_TEST_URL`**，只認 `PG_LIVE_REPRO_URL`
// 且資料庫名要在允許清單內（正式庫 5151_shadow 一律拒絕）。
import { test } from "node:test";
import assert from "node:assert/strict";

const RAW = String(process.env.PG_LIVE_REPRO_URL || "").trim();
const ALLOWED_DB = new Set(["repro", "tracker_test", "repro2"]);
const DB = (() => { try { return new URL(RAW).pathname.replace(/^\//, ""); } catch { return ""; } })();
const REFUSED = RAW && !ALLOWED_DB.has(DB);
const skip = !RAW ? "PG_LIVE_REPRO_URL 未設定（live PG 驗證需要隔離環境）"
  : REFUSED ? `拒絕執行：資料庫 "${DB}" 不在允許清單 ${[...ALLOWED_DB].join("/")}（正式庫 5151_shadow 一律拒絕）`
    : false;

const UID = 900000000971;
const KEY = "live-notify-write-0001";

test("live PG：通知寫入端建得起唯一索引，而且去重與遞送真的生效", { skip }, async () => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const writeAsync = await import("../src/rentalNotifyWriteAsync.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const { setRentalNotifyHydrate } = await import("../src/rentalNotify.js");
  const { setRentalMarketplaceFlags } = await import("../src/demand.js");
  const { defaultCatalog } = await import("../src/rentalCatalog.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  const who = (await query("SELECT current_database() AS db"))[0];
  assert.equal(who.db, DB, "連到的資料庫必須與 URL 一致");

  const cleanup = async () => {
    await query("DELETE FROM rental_notify_deliveries WHERE user_id = $1", [UID]);
    await query("DELETE FROM rental_notify_events WHERE user_id = $1", [UID]);
    await query("DELETE FROM rental_notify_prefs WHERE user_id = $1", [UID]);
    await query("DELETE FROM users WHERE id = $1", [UID]);
  };
  await cleanup();
  await query(
    "INSERT INTO users(id, email, nickname, created_at) VALUES ($1,$2,'租客','2026-01-01T00:00:00.000Z')",
    [UID, `live-notify-${UID}@example.com`],
  );

  const flags = {
    rental_catalog_v2: { enabled: true },
    wish: {
      lifecycle_enabled: true, owner_matching_enabled: true, offer_enabled: true,
      notifications_enabled: true, digest_enabled: true,
      outbound_mail_enabled: true, outbound_push_enabled: true,
    },
  };
  setRentalMarketplaceFlags(flags);
  setRentalNotifyHydrate(flags);
  void defaultCatalog;

  // 真正的 exec（走 toPostgresSql，與正式站同一條路）——**不注入 exec**，
  // 這樣 `ensureRentalNotifyWriteOnce()` 才會真的跑（含補唯一索引）。
  const exec = async (sql, params = []) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  };
  const pgDriverForEnsure = pgDriver;
  // ⚠️ 一定要先跑 bootstrap：`ON CONFLICT(event_key)`／`ON CONFLICT(event_id, channel)` 需要
  // **真的存在**的唯一索引，否則 PG 直接回 `42P10`。
  // 這也正是離線測不到的那一段（`ensureRentalNotifyWriteOnce()` 只在沒有注入 exec 時才會跑，
  // 所以正式站在第一次寫入前會自己補；CI 第一次跑就是紅在這裡，證明這個守衛有效）。
  await writeAsync.ensureRentalNotifyWriteOnce(pgDriverForEnsure);

  const emitted = await writeAsync.emitRentalNotifyEventAsync({
    eventType: "tenant_offer_received",
    userId: UID,
    eventKey: KEY,
    subjectType: "offer",
    subjectRef: "tok-live",
    now: new Date("2026-09-28T04:00:00.000Z"),
  }, { driver: "postgres", pgDriver: pgDriverForEnsure, exec, strict: true });
  assert.equal(emitted.emitted, true, "第一次必須真的發出");

  // 1) 去重：第二次不得再寫事件
  const dup = await writeAsync.emitRentalNotifyEventAsync({
    eventType: "tenant_offer_received",
    userId: UID,
    eventKey: KEY,
    now: new Date("2026-09-28T04:00:00.000Z"),
  }, { driver: "postgres", pgDriver: pgDriverForEnsure, exec, strict: true });
  assert.equal(dup.emitted, false, "第二次必須去重");
  assert.equal(dup.reason, "deduped");
  assert.equal(
    (await query("SELECT COUNT(*)::int AS n FROM rental_notify_events WHERE event_key = $1", [KEY]))[0].n, 1,
    "同一個 event_key 只能有一筆",
  );

  // 2) 遞送列真的落地（PG 的 ON CONFLICT 需要 (event_id, channel) 唯一索引才合法）
  const deliveries = await query(
    "SELECT channel, status FROM rental_notify_deliveries WHERE user_id = $1 ORDER BY channel", [UID],
  );
  assert.ok(deliveries.length > 0, "至少要排出一個通道的遞送");

  // 3) 那兩條唯一索引必須真的存在（離線測不到的那段程式碼）
  const idx = await query(
    "SELECT indexname FROM pg_indexes WHERE schemaname = current_schema() AND tablename IN ('rental_notify_events','rental_notify_deliveries') ORDER BY indexname",
  );
  const names = idx.map((r) => r.indexname);
  assert.ok(names.includes("rental_notify_events_event_key_key"), `event_key 唯一索引必須存在（實際：${names.join(",")}）`);
  assert.ok(names.includes("rental_notify_deliveries_event_channel_key"), `(event_id, channel) 唯一索引必須存在（實際：${names.join(",")}）`);

  // 4) 同一 (event_id, channel) 再寫一次必須被 ON CONFLICT 吃掉，不得變成兩列
  const eventRow = (await query("SELECT id FROM rental_notify_events WHERE event_key = $1", [KEY]))[0];
  await exec(
    "INSERT INTO rental_notify_deliveries(event_id, user_id, channel, status, attempt, next_retry_at, last_error, created_at, updated_at) VALUES (?, ?, 'dock', 'queued', 0, NULL, '', ?, ?) ON CONFLICT(event_id, channel) DO NOTHING",
    [eventRow.id, UID, "2026-09-28T04:00:00.000Z", "2026-09-28T04:00:00.000Z"],
  );
  assert.equal(
    (await query("SELECT COUNT(*)::int AS n FROM rental_notify_deliveries WHERE event_id = $1 AND channel = 'dock'", [eventRow.id]))[0].n,
    1,
    "同一 (event_id, channel) 只能有一列",
  );

  await cleanup();
  await pgDriver.close();
});
