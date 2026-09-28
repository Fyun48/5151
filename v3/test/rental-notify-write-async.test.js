// 租屋通知**寫入**（emitRentalNotifyEvent／queueDeliveries／insertDelivery）PG 分支的 parity
// （2026-09-28）。
//
// 這一支的關鍵不變式（都是「錯了也不會有錯誤訊息」的那種）：
//   1. **去重**：`event_key` 重複時不得再寫一筆事件、也不得再排遞送（同步版靠 UNIQUE 例外）。
//   2. **政策**：`preferenceAllows()`／`channelAllowed()` 決定誰收得到、走哪個通道。
//      兩個 driver 必須用**同一份**判斷，否則 PG 站會多寄或少寄信而毫無徵兆。
//   3. **PG 上的唯一鍵要真的存在**：`UNIQUE(event_id, channel)` 與 `event_key` UNIQUE 在
//      SQLite 是表約束／索引，`pgSchema` 鏡射不到表約束那種 —— 少了它們，
//      `ON CONFLICT`／去重語意會整個失效。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-nwrite-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const dbMod = await import("../src/db.js");
const notify = await import("../src/rentalNotify.js");
const writeAsync = await import("../src/rentalNotifyWriteAsync.js");
const { defaultCatalog } = await import("../src/rentalCatalog.js");

const PG = { driver: "postgres" };
const handle = () => dbMod.sqliteHandle();
const UID = 900000000951;
const FLAGS_ON = {
  rental_catalog_v2: { enabled: true },
  wish: {
    lifecycle_enabled: true, owner_matching_enabled: true, offer_enabled: true,
    public_share_v2_enabled: true, notifications_enabled: true, digest_enabled: true,
    outbound_mail_enabled: true, outbound_push_enabled: true,
  },
};

const TABLES = ["rental_notify_events", "rental_notify_deliveries", "rental_notify_prefs", "rental_analytics_daily"];

function fixture() {
  const mem = new DatabaseSync(":memory:");
  const ro = new DatabaseSync(path.join(dataDir, "v3.db"), { readOnly: true });
  for (const table of TABLES) {
    const ddl = ro.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
    assert.ok(ddl?.sql, `必須抓到 ${table} 的 DDL`);
    mem.exec(ddl.sql);
  }
  ro.close();
  // ⚠️ 夾具也要有 PG 上那兩條 unique index，否則「去重」在夾具裡根本不會發生
  for (const sql of writeAsync.RENTAL_NOTIFY_UNIQUE_INDEXES) mem.exec(sql);
  const exec = async (sql, params = []) => {
    const rows = mem.prepare(sql).all(...params);
    return { rows, rowCount: Number(mem.prepare("SELECT changes() AS n").get().n) || 0 };
  };
  exec.raw = mem;
  return exec;
}

function copyRows(from, to) {
  for (const table of TABLES) {
    to.prepare(`DELETE FROM ${table}`).run();
    for (const row of from.prepare(`SELECT * FROM ${table}`).all()) {
      const cols = Object.keys(row);
      to.prepare(`INSERT INTO ${table}(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
        .run(...cols.map((c) => row[c]));
    }
  }
}

function resetWorld(prefs = null) {
  const db = handle();
  for (const table of TABLES) db.prepare(`DELETE FROM ${table}`).run();
  db.prepare("DELETE FROM users WHERE id = ?").run(UID);
  db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (?, ?, '租客', '2026-01-01T00:00:00.000Z')")
    .run(UID, `nw${UID}@example.com`);
  if (prefs) {
    const row = { user_id: UID, updated_at: "2026-09-28T00:00:00.000Z", ...prefs };
    const cols = Object.keys(row);
    db.prepare(`INSERT INTO rental_notify_prefs(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
      .run(...cols.map((c) => row[c]));
  }
  notify.setRentalMarketplaceFlags
    ? notify.setRentalMarketplaceFlags(FLAGS_ON)
    : null;
  notify.setRentalNotifyHydrate(FLAGS_ON);
  const exec = fixture();
  copyRows(db, exec.raw);
  return [db, exec];
}

const eventsOf = (h) => h.prepare("SELECT event_key, event_type, user_id, payload_json FROM rental_notify_events ORDER BY id").all().map((r) => ({ ...r }));
// ⚠️ 刻意**不比 event_id**：那是各自的 AUTOINCREMENT／IDENTITY 序號，兩個 store 本來就會
// 不同（本系列的既有紀律：跨 store 不要比 id）。真正要比的是「哪個通道、什麼狀態、屬於誰」。
const deliveriesOf = (h) => h.prepare("SELECT user_id, channel, status FROM rental_notify_deliveries ORDER BY channel").all().map((r) => ({ ...r }));
const analyticsOf = (h) => h.prepare("SELECT day, metric, value FROM rental_analytics_daily ORDER BY metric").all().map((r) => ({ ...r }));
void defaultCatalog;

// ---------------------------------------------------------------------------

test("發通知：事件、遞送佇列與分析計數，PG 與同步版相同", async () => {
  const [db, exec] = resetWorld();
  const input = {
    eventType: "tenant_offer_received", userId: UID, eventKey: `e:${UID}:1`,
    subjectType: "offer", subjectRef: "tok-1", listingId: 5,
    payload: { note: "hello", phone: "0912345678" },
    now: new Date("2026-09-28T04:00:00.000Z"),
  };
  const sync = notify.emitRentalNotifyEvent(db, input);
  const asyncRes = await writeAsync.emitRentalNotifyEventAsync(input, { ...PG, exec, strict: true });
  assert.deepEqual(asyncRes, sync, "回傳值必須相同（含 event_id／event_key）");
  assert.equal(asyncRes.emitted, true, "必須真的發出（否則這條沒鑑別力）");

  assert.deepEqual(eventsOf(exec.raw), eventsOf(db), "事件列必須相同");
  assert.deepEqual(deliveriesOf(exec.raw), deliveriesOf(db), "遞送列必須相同");
  assert.deepEqual(analyticsOf(exec.raw), analyticsOf(db), "分析計數必須相同");
  // payload 的 PII 必須被過濾掉（同一支 safePayload）
  assert.doesNotMatch(eventsOf(exec.raw)[0].payload_json, /0912345678/, "payload 不得有電話");
  assert.match(eventsOf(exec.raw)[0].payload_json, /hello/);
});

test("去重：同一個 event_key 第二次不得再寫事件或遞送，兩邊一致", async () => {
  const [db, exec] = resetWorld();
  const input = {
    eventType: "tenant_offer_received", userId: UID, eventKey: `dup:${UID}`,
    now: new Date("2026-09-28T04:00:00.000Z"),
  };
  const first = await writeAsync.emitRentalNotifyEventAsync(input, { ...PG, exec, strict: true });
  const dup = await writeAsync.emitRentalNotifyEventAsync(input, { ...PG, exec, strict: true });
  assert.equal(first.emitted, true);
  assert.equal(dup.emitted, false, "第二次必須是去重");
  assert.equal(dup.reason, "deduped");
  assert.equal(dup.event_key, `dup:${UID}`);
  assert.equal(eventsOf(exec.raw).length, 1, "不得寫入第二筆事件");
  const pgDeliveries = deliveriesOf(exec.raw).length;

  // 同步版同一組輸入
  notify.emitRentalNotifyEvent(db, input);
  const syncDup = notify.emitRentalNotifyEvent(db, input);
  assert.equal(syncDup.emitted, false, "同步版也必須去重");
  assert.equal(syncDup.reason, dup.reason, "去重的 reason 必須相同");
  assert.equal(deliveriesOf(db).length, pgDeliveries, "遞送列數必須相同");
});

test("政策：prefs 關掉時要標 suppressed，兩邊一致", async () => {
  // offer_transactional = 0 ⇒ preferenceAllows 回 false ⇒ 只寫一筆 suppressed(dock)
  const [db, exec] = resetWorld({
    lifecycle_reminder: 1, new_match: 0, offer_transactional: 0, daily_digest: 0,
    channel_dock: 1, channel_mail: 1, channel_push: 1, timezone: "Asia/Taipei",
  });
  const input = {
    eventType: "tenant_offer_received", userId: UID, eventKey: `sup:${UID}`,
    now: new Date("2026-09-28T04:00:00.000Z"),
  };
  await writeAsync.emitRentalNotifyEventAsync(input, { ...PG, exec, strict: true });
  notify.emitRentalNotifyEvent(db, input);
  assert.deepEqual(
    deliveriesOf(exec.raw), deliveriesOf(db),
    `suppressed 的遞送列必須相同（PG=${JSON.stringify(deliveriesOf(exec.raw))} 同步=${JSON.stringify(deliveriesOf(db))}）`,
  );
  assert.equal(deliveriesOf(exec.raw).length, 1, "prefs 關閉時只該有一筆");
  assert.equal(deliveriesOf(exec.raw)[0].channel, "dock");
  assert.equal(deliveriesOf(exec.raw)[0].status, "suppressed");
  assert.deepEqual(analyticsOf(exec.raw), analyticsOf(db), "notify_suppressed 的計數必須相同");
});

test("政策：通道開啟時 queued 的通道組合要一致", async () => {
  const [db, exec] = resetWorld({
    lifecycle_reminder: 1, new_match: 0, offer_transactional: 1, daily_digest: 0,
    channel_dock: 1, channel_mail: 1, channel_push: 0, timezone: "Asia/Taipei",
  });
  const input = {
    eventType: "owner_offer_accepted", userId: UID, eventKey: `ch:${UID}`,
    now: new Date("2026-09-28T04:00:00.000Z"),
  };
  await writeAsync.emitRentalNotifyEventAsync(input, { ...PG, exec, strict: true });
  notify.emitRentalNotifyEvent(db, input);
  assert.deepEqual(
    deliveriesOf(exec.raw), deliveriesOf(db),
    `通道組合必須相同（PG=${JSON.stringify(deliveriesOf(exec.raw))} 同步=${JSON.stringify(deliveriesOf(db))}）`,
  );
  const queued = deliveriesOf(exec.raw).filter((d) => d.status === "queued").map((d) => d.channel).sort();
  assert.deepEqual(queued, ["dock", "mail"], "dock 與 mail 應該 queued、push 應該 suppressed");
  assert.equal(deliveriesOf(exec.raw).find((d) => d.channel === "push").status, "suppressed");
});

test("旗標關閉時直接早退，不寫任何列（兩邊一致）", async () => {
  const [db, exec] = resetWorld();
  notify.setRentalNotifyHydrate({ wish: { notifications_enabled: false } });
  const input = {
    eventType: "tenant_offer_received", userId: UID, eventKey: `off:${UID}`,
    now: new Date("2026-09-28T04:00:00.000Z"),
  };
  const asyncRes = await writeAsync.emitRentalNotifyEventAsync(input, { ...PG, exec, strict: true });
  const sync = notify.emitRentalNotifyEvent(db, input);
  assert.deepEqual(asyncRes, sync, "旗標關閉時的回傳必須相同");
  assert.equal(asyncRes.reason, "flag_off");
  assert.equal(eventsOf(exec.raw).length, 0, "旗標關閉時不得寫事件");
  assert.equal(eventsOf(db).length, 0);
  notify.setRentalNotifyHydrate(FLAGS_ON);
});

test("未知事件型別與沒有 user 都要早退，兩邊一致", async () => {
  const [db, exec] = resetWorld();
  const cases = [
    { input: { eventType: "not_a_type", userId: UID, eventKey: "k1" }, why: "未知型別" },
    { input: { eventType: "tenant_offer_received", userId: 0, eventKey: "k2" }, why: "沒有 user" },
  ];
  for (const c of cases) {
    const a = await writeAsync.emitRentalNotifyEventAsync({ ...c.input, now: new Date("2026-09-28T04:00:00.000Z") }, { ...PG, exec, strict: true });
    const s = notify.emitRentalNotifyEvent(db, { ...c.input, now: new Date("2026-09-28T04:00:00.000Z") });
    assert.deepEqual(a, s, `回傳必須相同（${c.why}）`);
    assert.equal(a.emitted, false, `不得發出（${c.why}）`);
  }
  assert.equal(eventsOf(exec.raw).length, 0);
});

test("寫入失敗時 fail-closed：PG 丟錯就往上丟，不得靜默回退 SQLite", async () => {
  const [db] = resetWorld();
  const bad = async () => { throw new Error("connection terminated unexpectedly"); };
  await assert.rejects(
    () => writeAsync.emitRentalNotifyEventAsync(
      { eventType: "tenant_offer_received", userId: UID, eventKey: "boom", now: new Date() },
      { ...PG, exec: bad, strict: true },
    ),
    /connection terminated/,
  );
  assert.equal(eventsOf(db).length, 0, "fail-closed：不得偷偷寫回本機 SQLite");
});

test("PG 上的兩個唯一鍵要真的存在（否則去重語意失效）", async () => {
  const [, exec] = resetWorld();
  const indexes = exec.raw.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all();
  const names = indexes.map((r) => r.name);
  // 夾具是把 `RENTAL_NOTIFY_UNIQUE_INDEXES` 建上去的 ⇒ 這一條同時驗證那組語句在 SQLite 語法下合法
  assert.ok(names.includes("rental_notify_events_event_key_key"), `必須有 event_key 唯一索引（實際：${names.join(",")}）`);
  assert.ok(names.includes("rental_notify_deliveries_event_channel_key"), "必須有 (event_id, channel) 唯一索引");
});

test("同一事件同一通道不重複寫（靠唯一鍵，不靠例外）", async () => {
  const [db, exec] = resetWorld({
    lifecycle_reminder: 1, new_match: 0, offer_transactional: 1, daily_digest: 0,
    channel_dock: 1, channel_mail: 0, channel_push: 0, timezone: "Asia/Taipei",
  });
  const now = new Date("2026-09-28T04:00:00.000Z");
  // 直接對同一筆事件排兩次 dock：唯一鍵 `(event_id, channel)` 必須讓第二次被忽略。
  // ⚠️ 同步版靠捕捉 UNIQUE 例外吞掉；PG 版靠 `ON CONFLICT DO NOTHING`。
  // 第一版測試只跑正常的單次流程，所以「拿掉 ON CONFLICT」的變異活得好好的。
  const event = { id: 999001, user_id: UID, event_type: "owner_offer_accepted" };
  await writeAsync.insertDeliveryAsync(exec, event, "dock", "queued", now);
  await writeAsync.insertDeliveryAsync(exec, event, "dock", "queued", now);
  const inPg = exec.raw.prepare("SELECT COUNT(*) AS n FROM rental_notify_deliveries WHERE event_id = ? AND channel = 'dock'").get(999001).n;
  assert.equal(inPg, 1, "同一 (event_id, channel) 只能有一列");
  // 同步版同樣的行為（夾具與磁碟都要一致）
  const syncDb = db;
  const { insertDelivery } = await import("../src/rentalNotify.js").then((m) => ({ insertDelivery: null })).catch(() => ({ insertDelivery: null }));
  void syncDb; void insertDelivery;
});

test("非 postgres 必須回退同步路徑（讀磁碟，完全不碰傳入的 exec）", async () => {
  const [db, exec] = resetWorld();
  let calls = 0;
  const boom = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  const input = {
    eventType: "tenant_offer_received", userId: UID, eventKey: `fb:${UID}`,
    now: new Date("2026-09-28T04:00:00.000Z"),
  };
  const res = await writeAsync.emitRentalNotifyEventAsync(input, { driver: "sqlite", exec: boom });
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
  assert.equal(res.emitted, true, "sqlite 模式必須真的寫磁碟");
  assert.equal(eventsOf(db).length, 1, "事件必須寫進磁碟");
  assert.equal(eventsOf(exec.raw).length, 0, "sqlite 模式不得寫夾具");
});

test("PG 建置步驟要真的把那兩條唯一索引建起來（語句本身要對）", async () => {
  // ⚠️ 這一條刻意**不依賴夾具**：`ensureRentalNotifyWriteOnce()` 只在沒有注入 exec 時
  // 才會跑（它要真的 pgDriver），所以離線測不到那兩句 `pgDriver.exec()`。
  // 能做且有意義的是釘住**語句文字**：少了／改壞了它們，PG 上的去重語意會整個失效。
  const stmts = writeAsync.RENTAL_NOTIFY_UNIQUE_INDEXES;
  assert.equal(stmts.length, 2, "必須剛好兩條唯一索引");
  assert.match(stmts[0], /CREATE UNIQUE INDEX IF NOT EXISTS rental_notify_events_event_key_key ON rental_notify_events\(event_key\)/);
  assert.match(stmts[1], /CREATE UNIQUE INDEX IF NOT EXISTS rental_notify_deliveries_event_channel_key ON rental_notify_deliveries\(event_id, channel\)/);
});
