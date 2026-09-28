// `getRentalNotifyPrefsAsync()` 的 parity（2026-09-28）。
//
// 這一支是通知寫入端的前置零件（`queueDeliveries()` 的第一步就是讀它）。
// 最可能的移植錯誤是**布林轉換漏一個欄位**或**沒有列時忘了回預設**——
// 兩者都會讓「通知被靜默關掉或靜默打開」，而不會有任何錯誤，所以斷言要逐鍵比對。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-nprefs-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const dbMod = await import("../src/db.js");
const notify = await import("../src/rentalNotify.js");
const asyncMod = await import("../src/rentalNotifyReadsAsync.js");

const PG = { driver: "postgres" };
const handle = () => dbMod.sqliteHandle();
const TABLE = "rental_notify_prefs";
const UID = 900000000901;

function fixture() {
  const mem = new DatabaseSync(":memory:");
  const ddl = handle().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(TABLE);
  assert.ok(ddl?.sql, "必須抓到 rental_notify_prefs 的 DDL");
  mem.exec(ddl.sql);
  const exec = async (sql, params = []) => {
    const rows = mem.prepare(sql).all(...params);
    return { rows, rowCount: Number(mem.prepare("SELECT changes() AS n").get().n) || 0 };
  };
  exec.raw = mem;
  return exec;
}

function resetBoth(row = null) {
  const db = handle();
  db.prepare(`DELETE FROM ${TABLE}`).run();
  const exec = fixture();
  if (row) {
    const cols = Object.keys(row);
    for (const h of [db, exec.raw]) {
      h.prepare(`INSERT INTO ${TABLE}(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
        .run(...cols.map((c) => row[c]));
    }
  }
  return [db, exec];
}

// ---------------------------------------------------------------------------

test("沒有設定列時回預設，兩邊逐鍵相同（且確實是預設值）", async () => {
  const [db, exec] = resetBoth();
  const sync = notify.getRentalNotifyPrefs(db, UID);
  const asyncPrefs = await asyncMod.getRentalNotifyPrefsAsync(UID, { ...PG, exec, strict: true });
  assert.deepEqual(asyncPrefs, sync, "沒有列時必須與同步版相同");
  assert.deepEqual(asyncPrefs, notify.defaultRentalNotifyPrefs(), "而且必須就是預設值");
  assert.equal(asyncPrefs.channel_dock, true, "預設 dock 開啟（否則通知會靜默消失）");
  assert.equal(asyncPrefs.channel_mail, false, "預設 mail 關閉（否則會靜默寄信）");
});

test("有設定列時逐鍵相同（含每個布林欄位都要對）", async () => {
  const [db, exec] = resetBoth({
    user_id: UID,
    lifecycle_reminder: 0,
    new_match: 1,
    offer_transactional: 0,
    daily_digest: 1,
    channel_dock: 0,
    channel_mail: 1,
    channel_push: 1,
    timezone: "Asia/Tokyo",
    updated_at: "2026-09-28T00:00:00.000Z",
  });
  const sync = notify.getRentalNotifyPrefs(db, UID);
  const asyncPrefs = await asyncMod.getRentalNotifyPrefsAsync(UID, { ...PG, exec, strict: true });
  assert.deepEqual(asyncPrefs, sync, "有設定列時必須與同步版相同");
  // 逐鍵斷言（避免「兩邊都錯」也算相等）：刻意用**與預設相反**的值
  assert.deepEqual(asyncPrefs, {
    lifecycle_reminder: false,
    new_match: true,
    offer_transactional: false,
    daily_digest: true,
    channel_dock: false,
    channel_mail: true,
    channel_push: true,
    timezone: "Asia/Tokyo",
  });
});

test("timezone 空字串要落回站台時區，兩邊一致", async () => {
  const [db, exec] = resetBoth({
    user_id: UID, lifecycle_reminder: 1, new_match: 0, offer_transactional: 1,
    daily_digest: 0, channel_dock: 1, channel_mail: 0, channel_push: 0,
    timezone: "", updated_at: "2026-09-28T00:00:00.000Z",
  });
  const sync = notify.getRentalNotifyPrefs(db, UID);
  const asyncPrefs = await asyncMod.getRentalNotifyPrefsAsync(UID, { ...PG, exec, strict: true });
  assert.deepEqual(asyncPrefs, sync, "空 timezone 必須一致");
  assert.equal(asyncPrefs.timezone, notify.RENTAL_SITE_TZ, "必須落回站台時區");
});

test("uid 0 與不存在的使用者都回預設，兩邊一致", async () => {
  const [db, exec] = resetBoth();
  for (const uid of [0, 123456789]) {
    const sync = notify.getRentalNotifyPrefs(db, uid);
    const asyncPrefs = await asyncMod.getRentalNotifyPrefsAsync(uid, { ...PG, exec, strict: true });
    assert.deepEqual(asyncPrefs, sync, `uid=${uid} 必須一致`);
  }
});

test("寫入失敗時 fail-closed：PG 丟錯就往上丟，不得靜默回退 SQLite", async () => {
  resetBoth();
  const bad = async () => { throw new Error("connection terminated unexpectedly"); };
  await assert.rejects(
    () => asyncMod.getRentalNotifyPrefsAsync(UID, { ...PG, exec: bad, strict: true }),
    /connection terminated/,
  );
});

test("非 postgres 必須回退同步路徑（讀磁碟，不碰傳入的 exec）", async () => {
  const [db, exec] = resetBoth({
    user_id: UID, lifecycle_reminder: 1, new_match: 1, offer_transactional: 1,
    daily_digest: 1, channel_dock: 1, channel_mail: 1, channel_push: 1,
    timezone: "Asia/Taipei", updated_at: "2026-09-28T00:00:00.000Z",
  });
  let calls = 0;
  const boom = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  const prefs = await asyncMod.getRentalNotifyPrefsAsync(UID, { driver: "sqlite", exec: boom });
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
  assert.equal(prefs.new_match, true, "sqlite 模式必須讀磁碟");
  assert.deepEqual(prefs, notify.getRentalNotifyPrefs(db, UID));
});

test("布林轉換：PG 回傳字串 '0'／'1' 時也要正確（驅動差異）", async () => {
  // ⚠️ 這一條是變異測試逼出來的：memory SQLite 對 INTEGER 欄位回的是**數字**，
  // 所以 `Boolean(row.x)` 與 `Number(row.x) === 1` 在夾具上結果相同 ⇒ 殺不死變異。
  // 但真 PG 的驅動在某些路徑（聚合、client 設定）可能回字串，而 `Boolean("0")` 是 **true**，
  // 那會讓「關閉的通知」變成開啟。所以直接用字串列餵 `prefsFromRow()`（純函式）來釘住。
  const fromStrings = asyncMod.prefsFromRow({
    user_id: UID,
    lifecycle_reminder: "0", new_match: "1", offer_transactional: "0", daily_digest: "1",
    channel_dock: "0", channel_mail: "1", channel_push: "0", timezone: "Asia/Taipei",
  });
  assert.deepEqual(fromStrings, {
    lifecycle_reminder: false, new_match: true, offer_transactional: false, daily_digest: true,
    channel_dock: false, channel_mail: true, channel_push: false, timezone: "Asia/Taipei",
  });
  // 數字列也要一樣（兩種驅動形狀都必須收斂到同一個結果）
  const fromNumbers = asyncMod.prefsFromRow({
    user_id: UID,
    lifecycle_reminder: 0, new_match: 1, offer_transactional: 0, daily_digest: 1,
    channel_dock: 0, channel_mail: 1, channel_push: 0, timezone: "Asia/Taipei",
  });
  assert.deepEqual(fromStrings, fromNumbers, "字串與數字列必須收斂到同一組 prefs");
});
