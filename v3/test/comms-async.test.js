// 站內公告與贊助活動（comms）PG 分支的 parity（2026-09-27）。
//
// 這一批的方言陷阱比前幾批少（`ON CONFLICT … DO UPDATE SET excluded.x` 與
// `version=version+1` 兩邊都合法），所以重點放在**行為**：
//
//   1. **`announcement_member_state` 的 upsert 語意**最細：已讀 → `read_at` 覆蓋；
//      關閉 → `dismissed_at` 覆蓋但 `read_at` 用 `COALESCE(現值, 新值)` **保留原值**。
//      這兩條路寫錯都不會壞，但會讓「已讀時間」被關閉動作蓋掉。
//   2. **公告／活動的生效窗**（`isWithinWindow`）與 `enabled`／`status` 的組合。
//   3. **`recordSponsoredEvent`**：只有 `enabled=1 且 published` 的活動才計數，
//      而且「事件列」與「計數」必須一起成立（PG 這邊包在交易裡；同步版沒有交易）。
//   4. **`publicCommsBundleAsync`** 是 `/api/comms` 的整包，要與同步版逐欄相同。
//
// ⚠️ 這一輪真正要自己補的是**索引**：正式站那五張表只有 pkey，
// `idx_announcements_active`／`idx_campaigns_active`／`idx_sponsored_events_bucket`
// 都不存在（不是唯一約束，少了不會壞，但 `/api/announcements` 是每個訪客都會打的端點）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-comms-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const db = (await import("../src/db.js")).sqliteHandle();
const sync = await import("../src/comms.js");
const asyncMod = await import("../src/commsAsync.js");

const PG = { driver: "postgres" };
const NOW = new Date("2026-06-01T00:00:00.000Z");
const LATER = new Date("2026-06-02T00:00:00.000Z");
const TABLES = ["system_announcements", "announcement_member_state", "sponsored_campaigns", "sponsored_events", "comms_audit"];
const diskPath = () => path.join(dataDir, "v3.db");

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown) does not exist"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  [/COLLATE\s+NOCASE/i, 'collation "nocase" for encoding "UTF8" does not exist'],
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
];

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  for (const table of TABLES) {
    const ddl = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
    assert.ok(ddl?.sql, `必須抓到 ${table} 的 DDL`);
    mem.exec(ddl.sql);
  }
  for (const row of disk.prepare(
    `SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND tbl_name IN (?,?,?,?,?)`,
  ).all(...TABLES)) {
    if (/\bON\s+sqlite_/i.test(row.sql)) continue;
    mem.exec(row.sql);
  }
  disk.close();
  const calls = [];
  const exec = async (sql, params = []) => {
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    calls.push({ sql, params });
    return mem.prepare(sql).all(...params);
  };
  exec.raw = mem;
  exec.calls = calls;
  return exec;
}

function resetBoth() {
  const exec = pgFixture();
  for (const table of TABLES) {
    db.prepare(`DELETE FROM ${table}`).run();
    exec.raw.prepare(`DELETE FROM ${table}`).run();
  }
  try { db.prepare("DELETE FROM sqlite_sequence WHERE name IN (?,?,?,?,?)").run(...TABLES); } catch { /* 沒有 AUTOINCREMENT */ }
  return exec;
}

function seedRow(handle, table, fields) {
  const info = handle.prepare(`PRAGMA table_info(${table})`).all();
  const provided = { ...fields };
  const required = info.filter((c) => c.notnull === 1 && c.dflt_value === null && c.pk === 0);
  const names = info.map((c) => c.name).filter((n) => n in provided || required.some((c) => c.name === n));
  handle.prepare(`INSERT INTO ${table}(${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
    .run(...names.map((n) => {
      if (n in provided) return provided[n];
      const col = info.find((c) => c.name === n);
      return /INT|REAL|NUM/i.test(col.type) ? 0 : "";
    }));
}

const dump = (handle, table) => {
  const order = handle.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === "id") ? "id" : "rowid";
  return handle.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all().map((r) => ({ ...r }));
};

function assertSameRows(exec, table, why) {
  const a = dump(db, table);
  const b = dump(exec.raw, table);
  assert.deepEqual(b, a, `${why}：PG 分支落地的 ${table} 必須與同步版完全相同`);
  assert.ok(a.length > 0 || why.includes("空"), `${why}：兩邊都是 0 列時這個比對沒有鑑別力`);
}

const reasonOf = (error) => `${error.status}/${error.code || "-"}/${error.message}`;
const ANN = { title: "系統維護", body: "今晚 02:00 維護", severity: "warning", status: "published", enabled: true, banner: true };
const CAMP = { sponsor_name: "廠商", title: "活動", text: "說明", destination_url: "https://example.test/x", status: "published", enabled: true };

// ---------------------------------------------------------------------------
// 公告

test("注入式 exec 的形狀不影響結果（裸陣列 vs { rows, rowCount }）", async () => {
  // 🚨 這個模組的 PG runner 吃**裸陣列**；`{ rows, rowCount }`（crmOutboxAsync 慣例）若不經
  // `rowsOf()` 正規化，會被當成「沒有資料列」而**靜默少讀**——同一天在 `contentDocumentsAsync`
  // 中過一次（版本算成 1 撞唯一鍵，由 live PG 測試抓到）。
  const arrayExec = resetBoth();
  const viaArray = await asyncMod.createAnnouncementAsync(7, ANN, { now: NOW, ...PG, exec: arrayExec });

  const wrappedExec = resetBoth();
  const wrapped = async (sql, params = []) => {
    const rows = await wrappedExec(sql, params);
    return { rows, rowCount: Number(rows.rowCount) || 0 };
  };
  const viaWrapped = await asyncMod.createAnnouncementAsync(7, ANN, { now: NOW, ...PG, exec: wrapped });
  assert.deepEqual(viaWrapped, viaArray, "兩種形狀的結果必須逐欄相同");
  assert.equal(viaWrapped.version, 1, "版本必須從 0 往上算（少讀時會誤判成同一版）");
  // 落地的列也要一樣（`assertSameRows` 是「PG ↔ 本機」的比對，這裡要比的是「兩種 exec 形狀」）。
  assert.deepEqual(dump(wrappedExec.raw, "system_announcements"), dump(arrayExec.raw, "system_announcements"),
    "以兩種形狀建立的公告列必須逐欄相同");
  assert.deepEqual(dump(wrappedExec.raw, "comms_audit"), dump(arrayExec.raw, "comms_audit"),
    "稽核列也要一樣");
});

test("建立公告：形狀、版本、落地列與稽核事件都與同步版相同", async () => {
  const exec = resetBoth();
  const pg = await asyncMod.createAnnouncementAsync(7, ANN, { now: NOW, ...PG, exec });
  const lite = sync.createAnnouncement(db, 7, ANN, NOW);
  assert.equal(pg.id, lite.id);
  assert.equal(pg.version, 1);
  assert.equal(pg.enabled, true, "enabled 是布林 true（不是 1）");
  assert.equal(pg.pinned, false);
  assert.equal(pg.banner, true);
  assert.equal(pg.start_at, "", "沒帶的 start_at 要是空字串（同步版同義）");
  assert.equal(pg.created_at, NOW.toISOString());
  assert.equal(pg.type, lite.type, "type 標籤要相同");
  assertSameRows(exec, "system_announcements", "建立公告");
  assertSameRows(exec, "comms_audit", "建立公告的稽核");
  assert.equal(dump(exec.raw, "comms_audit")[0].action, "create");
});

test("更新公告：version 遞增、沒帶的欄位沿用舊值、稽核逐筆落地", async () => {
  const exec = resetBoth();
  const created = await asyncMod.createAnnouncementAsync(7, ANN, { now: NOW, ...PG, exec });
  sync.createAnnouncement(db, 7, ANN, NOW);
  const pg = await asyncMod.updateAnnouncementAsync(7, created.id, { body: "改過的內文" }, { now: LATER, ...PG, exec });
  const lite = sync.updateAnnouncement(db, 7, created.id, { body: "改過的內文" }, LATER);
  assert.equal(pg.version, 2, "version 必須 +1");
  assert.equal(pg.version, lite.version);
  assert.equal(pg.body, "改過的內文");
  assert.equal(pg.title, "系統維護", "沒帶的 title 要沿用舊值");
  assert.equal(pg.banner, true, "沒帶的 banner 要沿用舊值");
  assert.equal(pg.updated_at, LATER.toISOString());
  assertSameRows(exec, "system_announcements", "更新公告");
  assert.equal(dump(exec.raw, "comms_audit").length, 2, "create ＋ update 各一筆稽核");
  assertSameRows(exec, "comms_audit", "更新的稽核");
});

test("更新不存在的公告 → 404，兩邊訊息相同", async () => {
  const exec = resetBoth();
  let syncErr = null;
  try { sync.updateAnnouncement(db, 7, 999, { body: "x" }, NOW); } catch (e) { syncErr = e; }
  assert.ok(syncErr, "同步版應該丟 404");
  await assert.rejects(() => asyncMod.updateAnnouncementAsync(7, 999, { body: "x" }, { now: NOW, ...PG, exec }),
    (e) => reasonOf(e) === reasonOf(syncErr));
});

test("發布公告：status／enabled 一起設好，落地結果相同", async () => {
  const exec = resetBoth();
  const draft = await asyncMod.createAnnouncementAsync(7, { ...ANN, status: "draft", enabled: false }, { now: NOW, ...PG, exec });
  sync.createAnnouncement(db, 7, { ...ANN, status: "draft", enabled: false }, NOW);
  const pg = await asyncMod.publishAnnouncementAsync(7, draft.id, { now: LATER, ...PG, exec });
  const lite = sync.publishAnnouncement(db, 7, draft.id, LATER);
  assert.equal(pg.status, "published");
  assert.equal(pg.enabled, true);
  assert.equal(pg.version, 2);
  assert.deepEqual(pg, lite);
  assertSameRows(exec, "system_announcements", "發布公告");
});

test("生效窗：過期、還沒開始、停用、草稿都不出現在公開列表", async () => {
  const exec = resetBoth();
  const cases = [
    { key: "ok", fields: { enabled: 1, status: "published", start_at: null, end_at: null } },
    { key: "future", fields: { enabled: 1, status: "published", start_at: "2027-01-01", end_at: null } },
    { key: "expired", fields: { enabled: 1, status: "published", start_at: null, end_at: "2026-01-01" } },
    { key: "disabled", fields: { enabled: 0, status: "published", start_at: null, end_at: null } },
    { key: "draft", fields: { enabled: 1, status: "draft", start_at: null, end_at: null } },
  ];
  for (const [i, c] of cases.entries()) {
    for (const h of [db, exec.raw]) {
      seedRow(h, "system_announcements", {
        title: c.key, body: "", severity: "info", pinned: 0, banner: 0,
        cta_label: "", cta_url: "", document_type: "", created_by: null,
        created_at: `2026-01-0${i + 1}T00:00:00.000Z`, updated_at: `2026-01-0${i + 1}T00:00:00.000Z`,
        version: 1, ...c.fields,
      });
    }
  }
  const pg = await asyncMod.publicActiveAnnouncementsAsync({ now: NOW, ...PG, exec });
  const lite = sync.publicActiveAnnouncements(db, NOW);
  assert.deepEqual(pg, lite);
  assert.deepEqual(pg.map((r) => r.title), ["ok"], "只有「已發布＋啟用＋在窗內」那一筆該出現");
});

test("收件匣：已讀／已關閉的狀態要正確帶出，已關閉的不列", async () => {
  const exec = resetBoth();
  for (const h of [db, exec.raw]) {
    seedRow(h, "system_announcements", {
      title: "a1", body: "", severity: "info", status: "published", enabled: 1, pinned: 0, banner: 0,
      cta_label: "", cta_url: "", document_type: "", created_by: null,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", version: 1,
    });
    seedRow(h, "system_announcements", {
      title: "a2", body: "", severity: "info", status: "published", enabled: 1, pinned: 0, banner: 0,
      cta_label: "", cta_url: "", document_type: "", created_by: null,
      created_at: "2026-01-02T00:00:00.000Z", updated_at: "2026-01-02T00:00:00.000Z", version: 1,
    });
    seedRow(h, "system_announcements", {
      title: "a3", body: "", severity: "info", status: "published", enabled: 1, pinned: 0, banner: 0,
      cta_label: "", cta_url: "", document_type: "", created_by: null,
      created_at: "2026-01-03T00:00:00.000Z", updated_at: "2026-01-03T00:00:00.000Z", version: 1,
    });
  }
  await asyncMod.markAnnouncementReadAsync(42, 1, { now: NOW, ...PG, exec });
  sync.markAnnouncementRead(db, 42, 1, NOW);
  await asyncMod.dismissAnnouncementAsync(42, 2, { now: LATER, ...PG, exec });
  sync.dismissAnnouncement(db, 42, 2, LATER);

  const pg = await asyncMod.announcementInboxForUserAsync(42, { now: NOW, ...PG, exec });
  const lite = sync.announcementInboxForUser(db, 42, NOW);
  assert.deepEqual(pg, lite);
  // ⚠️ 順序是 `ORDER BY pinned DESC, updated_at DESC, id DESC`，所以是 **a3 在 a1 前面**
  //（updated_at：a1=01-01、a3=01-03）。第一版我照「id 由小到大」寫，紅了才知道是憑印象。
  assert.deepEqual(pg.map((r) => r.title), ["a3", "a1"], "已關閉的 a2 不得出現；其餘照 updated_at DESC");
  assert.equal(pg[1].read, true, "a1 已讀");
  assert.equal(pg[1].dismissed, false);
  assert.equal(pg[0].read, false, "a3 未讀");
  assertSameRows(exec, "announcement_member_state", "已讀／已關閉狀態");

  // 未登入：要回同樣的清單但狀態全 false，而且**不得寫任何狀態列**。
  const before = dump(exec.raw, "announcement_member_state").length;
  const anon = await asyncMod.announcementInboxForUserAsync(null, { now: NOW, ...PG, exec });
  assert.deepEqual(anon, sync.announcementInboxForUser(db, null, NOW));
  assert.equal(anon.length, 3);
  assert.equal(anon.every((r) => r.read === false && r.dismissed === false), true);
  assert.equal(dump(exec.raw, "announcement_member_state").length, before, "未登入不得寫狀態");
});

test("upsert 語意：先關閉再已讀不會蓋掉 dismissed；先已讀再關閉會保留 read_at", async () => {
  // 這是這一批最細的一條：同步版的 `ON CONFLICT … DO UPDATE SET dismissed_at=excluded.dismissed_at,
  // read_at=COALESCE(announcement_member_state.read_at, excluded.read_at)`——關閉時
  // **不得**把原本的已讀時間蓋成關閉時間。寫錯不會壞，但時間語意會失真。
  const exec = resetBoth();
  for (const h of [db, exec.raw]) {
    seedRow(h, "system_announcements", {
      title: "a1", body: "", severity: "info", status: "published", enabled: 1, pinned: 0, banner: 0,
      cta_label: "", cta_url: "", document_type: "", created_by: null,
      created_at: "2026-01-01T00:00:00.000Z", updated_at: "2026-01-01T00:00:00.000Z", version: 1,
    });
  }
  const THIRD = new Date("2026-06-03T00:00:00.000Z");
  // 先已讀（NOW）→ 再關閉（LATER）：read_at 必須留在 NOW。
  await asyncMod.markAnnouncementReadAsync(1, 1, { now: NOW, ...PG, exec });
  sync.markAnnouncementRead(db, 1, 1, NOW);
  await asyncMod.dismissAnnouncementAsync(1, 1, { now: LATER, ...PG, exec });
  sync.dismissAnnouncement(db, 1, 1, LATER);
  const pgRow = dump(exec.raw, "announcement_member_state")[0];
  const liteRow = dump(db, "announcement_member_state")[0];
  assert.deepEqual({ ...pgRow }, { ...liteRow });
  assert.equal(pgRow.read_at, NOW.toISOString(), "已讀時間不得被關閉動作蓋掉");
  assert.equal(pgRow.dismissed_at, LATER.toISOString());

  // 反向：先關閉（LATER）→ 再已讀（THIRD）：read_at 要被已讀覆蓋，dismissed_at 保留。
  // ⚠️ 簽名是 `(userId, id, …)`——第一版我把兩個參數寫反了（變成 user 2 / announcement 1），
  // 於是後面找不到 announcement_id=2 那一列。
  await asyncMod.dismissAnnouncementAsync(1, 2, { now: LATER, ...PG, exec });
  sync.dismissAnnouncement(db, 1, 2, LATER);
  await asyncMod.markAnnouncementReadAsync(1, 2, { now: THIRD, ...PG, exec });
  sync.markAnnouncementRead(db, 1, 2, THIRD);
  const rows = dump(exec.raw, "announcement_member_state");
  const liteRows = dump(db, "announcement_member_state");
  assert.deepEqual(rows.map((r) => ({ ...r })), liteRows.map((r) => ({ ...r })));
  const second = rows.find((r) => Number(r.announcement_id) === 2);
  assert.equal(second.read_at, THIRD.toISOString(), "已讀要覆蓋 read_at");
  assert.equal(second.dismissed_at, LATER.toISOString(), "已讀不得清掉 dismissed_at");
});

test("未登入的已讀／關閉：回 anonymous，且不寫任何列", async () => {
  const exec = resetBoth();
  assert.deepEqual(await asyncMod.markAnnouncementReadAsync(null, 1, { now: NOW, ...PG, exec }), { ok: true, anonymous: true });
  assert.deepEqual(await asyncMod.dismissAnnouncementAsync(0, 1, { now: NOW, ...PG, exec }), { ok: true, anonymous: true });
  assert.deepEqual(sync.markAnnouncementRead(db, null, 1, NOW), { ok: true, anonymous: true });
  assert.equal(dump(exec.raw, "announcement_member_state").length, 0);
});

// ---------------------------------------------------------------------------
// 贊助活動

test("建立／更新活動：頻道合併、落地列與稽核都與同步版相同", async () => {
  const exec = resetBoth();
  const created = await asyncMod.createCampaignAsync(9, CAMP, { now: NOW, ...PG, exec });
  const liteCreated = sync.createCampaign(db, 9, CAMP, NOW);
  assert.equal(created.id, liteCreated.id);
  assert.equal(created.impressions, 0);
  assert.equal(created.clicks, 0);
  assert.equal(created.listing_placement, true, "listing_placement 預設 true");
  assert.deepEqual(created.channels, { inapp: true, webhook: false, email: false, push: false });
  assert.equal(created.sponsor, undefined, "campaignRow 不是公開視圖，不該有 sponsor 欄位");

  // ⚠️ 「合併 vs 整包取代」只有在**現值與預設值不同**時才看得出來：
  // `normalizeCampaignInput` 對 inapp 的預設是 `channels.inapp !== false`（true）。
  // 第一版用預設（inapp=true）去測，整包取代算出來剛好一樣 ⇒ 變異測試顯示殺不死。
  // 這裡先把 inapp 關掉，再只更新 webhook：合併會得到 {inapp:false, webhook:true}，
  // 整包取代會得到 {inapp:true, webhook:true}。
  const off = await asyncMod.createCampaignAsync(9, { ...CAMP, channels: { inapp: false }, title: "頻道測試" }, { now: NOW, ...PG, exec });
  sync.createCampaign(db, 9, { ...CAMP, channels: { inapp: false }, title: "頻道測試" }, NOW);
  assert.equal(off.channels.inapp, false, "前置條件：這一筆的 inapp 必須是關的");
  const pgOff = await asyncMod.updateCampaignAsync(9, off.id, { channels: { webhook: true } }, { now: LATER, ...PG, exec });
  const liteOff = sync.updateCampaign(db, 9, off.id, { channels: { webhook: true } }, LATER);
  assert.deepEqual(pgOff.channels, { inapp: false, webhook: true, email: false, push: false },
    "頻道要合併：沒提到的 inapp 必須保留 false（整包取代會變回預設 true）");
  assert.deepEqual(pgOff, liteOff);

  const pg = await asyncMod.updateCampaignAsync(9, created.id, { channels: { webhook: true } }, { now: LATER, ...PG, exec });
  const lite = sync.updateCampaign(db, 9, created.id, { channels: { webhook: true } }, LATER);
  assert.deepEqual(pg.channels, { inapp: true, webhook: true, email: false, push: false }, "頻道要合併，不是整包取代");
  assert.equal(pg.title, "活動", "沒帶的欄位沿用舊值");
  assert.deepEqual(pg, lite);
  assertSameRows(exec, "sponsored_campaigns", "建立／更新活動");
  assertSameRows(exec, "comms_audit", "活動的稽核");
});

test("活動的生效窗與 master／listing 開關", async () => {
  const exec = resetBoth();
  const rows = [
    { title: "ok", enabled: 1, status: "published", start_at: null, end_at: null, listing_placement: 1 },
    { title: "expired", enabled: 1, status: "published", start_at: null, end_at: "2026-01-01", listing_placement: 1 },
    { title: "nolisting", enabled: 1, status: "published", start_at: null, end_at: null, listing_placement: 0 },
  ];
  for (const [i, r] of rows.entries()) {
    for (const h of [db, exec.raw]) {
      seedRow(h, "sponsored_campaigns", {
        sponsor_name: "s", title: r.title, text: "", image_url: "", cta_label: "", destination_url: "",
        content_type: "sponsored", created_by: null,
        created_at: `2026-01-0${i + 1}T00:00:00.000Z`, updated_at: `2026-01-0${i + 1}T00:00:00.000Z`,
        listing_interval: null, channel_inapp: 1, channel_webhook: 0, channel_email: 0, channel_push: 0,
        impressions: 0, clicks: 0, ...r,
      });
    }
  }
  const config = sync.normalizeCommsConfig({});
  assert.deepEqual(await asyncMod.publicActiveCampaignsAsync({ config, now: NOW, ...PG, exec }),
    sync.publicActiveCampaigns(db, config, NOW));
  const active = await asyncMod.publicActiveCampaignsAsync({ config, now: NOW, ...PG, exec });
  assert.deepEqual(active.map((r) => r.title).sort(), ["nolisting", "ok"], "過期的不該出現");

  const listing = await asyncMod.listingCampaignsAsync({ config, now: NOW, ...PG, exec });
  assert.deepEqual(listing, sync.listingCampaigns(db, config, NOW));
  assert.deepEqual(listing.map((r) => r.title), ["ok"], "listing_placement=0 的不該進列表版位");

  // master 關掉 ⇒ 什麼都不回（連 listing 也一樣）。
  const off = sync.normalizeCommsConfig({ sponsored_master_enabled: false });
  assert.deepEqual(await asyncMod.publicActiveCampaignsAsync({ config: off, now: NOW, ...PG, exec }), []);
  assert.deepEqual(await asyncMod.listingCampaignsAsync({ config: off, now: NOW, ...PG, exec }), []);
  assert.deepEqual(sync.publicActiveCampaigns(db, off, NOW), []);
});

test("曝光／點擊事件：事件列與計數一起成立，未發布的活動不計", async () => {
  const exec = resetBoth();
  const live = await asyncMod.createCampaignAsync(9, CAMP, { now: NOW, ...PG, exec });
  sync.createCampaign(db, 9, CAMP, NOW);
  const draft = await asyncMod.createCampaignAsync(9, { ...CAMP, status: "draft" }, { now: NOW, ...PG, exec });
  sync.createCampaign(db, 9, { ...CAMP, status: "draft" }, NOW);

  assert.deepEqual(await asyncMod.recordSponsoredEventAsync(live.id, "impression", "listing", { now: NOW, ...PG, exec }),
    sync.recordSponsoredEvent(db, live.id, "impression", "listing", NOW));
  assert.deepEqual(await asyncMod.recordSponsoredEventAsync(live.id, "click", "detail", { now: LATER, ...PG, exec }),
    sync.recordSponsoredEvent(db, live.id, "click", "detail", LATER));
  // 未發布的活動：兩個都要回 { ok: false } 且不寫任何東西。
  const beforeEvents = dump(exec.raw, "sponsored_events").length;
  assert.deepEqual(await asyncMod.recordSponsoredEventAsync(draft.id, "impression", "listing", { now: NOW, ...PG, exec }),
    sync.recordSponsoredEvent(db, draft.id, "impression", "listing", NOW));
  assert.deepEqual(await asyncMod.recordSponsoredEventAsync(draft.id, "impression", "listing", { now: NOW, ...PG, exec }), { ok: false });
  assert.equal(dump(exec.raw, "sponsored_events").length, beforeEvents, "未發布的活動不得寫事件列");

  const events = dump(exec.raw, "sponsored_events");
  assert.equal(events.length, 2);
  assert.equal(events[0].bucket, sync.hourBucket(NOW), "bucket 要用 hourBucket（前 13 個字元）");
  assert.equal(events[0].bucket.length, 13);
  assertSameRows(exec, "sponsored_events", "曝光／點擊事件");
  const counts = dump(exec.raw, "sponsored_campaigns").find((r) => Number(r.id) === Number(live.id));
  assert.equal(Number(counts.impressions), 1, "曝光計數要 +1");
  assert.equal(Number(counts.clicks), 1, "點擊計數要 +1");

  // 不合法的事件類型要擋下（兩邊同訊息）。
  let syncErr = null;
  try { sync.recordSponsoredEvent(db, live.id, "view", "listing", NOW); } catch (e) { syncErr = e; }
  assert.ok(syncErr, "同步版應該擋下不合法的事件類型");
  await assert.rejects(() => asyncMod.recordSponsoredEventAsync(live.id, "view", "listing", { now: NOW, ...PG, exec }),
    (e) => reasonOf(e) === reasonOf(syncErr));
});

test("publicCommsBundleAsync：整包（公告／橫幅／贊助卡／支持方式）與同步版逐欄相同", async () => {
  const exec = resetBoth();
  const ann = await asyncMod.createAnnouncementAsync(7, ANN, { now: NOW, ...PG, exec });
  sync.createAnnouncement(db, 7, ANN, NOW);
  await asyncMod.createCampaignAsync(9, { ...CAMP, channels: { inapp: true } }, { now: NOW, ...PG, exec });
  sync.createCampaign(db, 9, { ...CAMP, channels: { inapp: true } }, NOW);
  // 再一筆**沒有開站內通道**的活動：它要進 cards（版位照投）但**不得**進 notify。
  // 少了這一筆，「過濾 channel_inapp」拿掉也看不出差別（第一版就是這樣，變異測試殺不死）。
  await asyncMod.createCampaignAsync(9, { ...CAMP, title: "沒開站內", channels: { inapp: false } }, { now: NOW, ...PG, exec });
  sync.createCampaign(db, 9, { ...CAMP, title: "沒開站內", channels: { inapp: false } }, NOW);

  const config = sync.normalizeCommsConfig({});
  const user = { id: 5, plan: "sponsor", role: "member" };
  const pg = await asyncMod.publicCommsBundleAsync({ config, sponsorOffer: {}, sponsorLinks: [], user, now: NOW, ...PG, exec });
  const lite = sync.publicCommsBundle(db, { config, sponsorOffer: {}, sponsorLinks: [], user, now: NOW });
  assert.deepEqual(pg, lite, "整包必須相同");
  assert.equal(pg.announcements.length, 1);
  assert.equal(pg.announcements[0].created_by, undefined, "公開視圖要拿掉 created_by");
  assert.ok(pg.banner, "有橫幅公告時 banner 不得是 null（否則比對會變成兩個空值）");
  assert.equal(pg.banner.id, ann.id);
  assert.equal(pg.sponsored.cards.length, 2, "兩筆活動都有效，都要進版位");
  assert.equal(pg.sponsored.notify.length, 1, "只有 channel_inapp=1 那一筆進通知");
  assert.deepEqual(pg.sponsored.notify.map((r) => r.title), ["活動"], "進通知的必須是開站內通道那一筆");
  assert.equal(pg.sponsored.session_cap, 3);

  // 未登入：notify 必須是空的（同步版同義）。
  const anonPg = await asyncMod.publicCommsBundleAsync({ config, user: {}, now: NOW, ...PG, exec });
  const anonLite = sync.publicCommsBundle(db, { config, user: {}, now: NOW });
  assert.deepEqual(anonPg, anonLite);
  assert.deepEqual(anonPg.sponsored.notify, []);
});

// ---------------------------------------------------------------------------
// schema 與回退

function recordingDriver() {
  const statements = [];
  return {
    statements,
    async exec(sql) { statements.push(sql); },
    async query(sql, params = []) {
      if (sql.includes("?")) throw new Error(`PG driver 收到未翻譯的 SQL：${sql.slice(0, 60)}`);
      statements.push(sql);
      return { rows: [] };
    },
  };
}

test("ensureCommsStoreOnce：三個索引都要補建，且每個 driver 只做一次", async () => {
  const driver = recordingDriver();
  await asyncMod.ensureCommsStoreOnce(driver);
  const first = [...driver.statements];
  for (const name of ["idx_announcements_active", "idx_campaigns_active", "idx_sponsored_events_bucket"]) {
    assert.ok(first.some((s) => s.includes(name)), `${name} 必須補建（正式站只有 pkey）`);
  }
  assert.ok(first.some((s) => /PRIMARY KEY \(announcement_id, user_id\)/.test(s)),
    "複合主鍵要保留（它是 upsert 的衝突目標，少了 ON CONFLICT 會直接失敗）");
  await asyncMod.ensureCommsStoreOnce(driver);
  assert.equal(driver.statements.length, first.length, "第二次呼叫不得再跑一次 schema");
});

test("夾具本身要真的拒絕 IFNULL／COLLATE NOCASE／LIMIT -1（否則方言守衛是空的）", async () => {
  const exec = pgFixture();
  await assert.rejects(() => exec("SELECT IFNULL(title,'') FROM system_announcements"), /function ifnull/);
  await assert.rejects(() => exec("SELECT title FROM system_announcements ORDER BY title COLLATE NOCASE"), /collation "nocase"/);
  await assert.rejects(() => exec("SELECT title FROM system_announcements LIMIT -1"), /LIMIT must not be negative/);
  await assert.doesNotReject(() => exec("SELECT title FROM system_announcements"), "普通查詢要放行");
});

test("非 postgres 模式必須回退同步路徑（讀寫磁碟，不碰傳入的 exec）", async () => {
  const exec = resetBoth();
  const pgDoc = await asyncMod.createAnnouncementAsync(7, ANN, { now: NOW, ...PG, exec });
  assert.equal(pgDoc.title, "系統維護");
  const lite = await asyncMod.createAnnouncementAsync(7, { ...ANN, title: "磁碟版" }, { now: NOW, driver: "sqlite", exec });
  assert.equal(lite.title, "磁碟版");
  assert.deepEqual(dump(db, "system_announcements").map((r) => r.title), ["磁碟版"]);
  assert.deepEqual(dump(exec.raw, "system_announcements").map((r) => r.title), ["系統維護"], "sqlite 模式不得改動 PG 夾具");
});

test("strict：PG 寫入失敗時必須往上丟，不得無聲寫進沒人讀的 SQLite", async () => {
  const exec = resetBoth();
  const broken = async () => { throw new Error("connection terminated unexpectedly"); };
  await assert.rejects(() => asyncMod.createAnnouncementAsync(7, ANN, { now: NOW, ...PG, exec: broken, strict: true }), /connection terminated/);
  await assert.rejects(() => asyncMod.createAnnouncementAsync(7, ANN, { now: NOW, ...PG, exec: broken }), /connection terminated/);
  assert.equal(dump(db, "system_announcements").length, 0, "寫入失敗不得回退寫 SQLite");
});
