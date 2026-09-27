// 租屋目錄 PG 分支的 parity（2026-09-27）。
//
// 這個模組的儲存層是 `settings` 表裡的 JSON blob，所以夾具就是那張表（KV），
// 語句用 `repository/memberSettings.js` 的同一組文字——與 `settingsKvAsync` 共用。
//
// ⚠️ 這一檔最關鍵的一條是**行程內快取的一致性**：db.js 的同步版除了寫 settings，還會呼叫
// 六個 setter 更新行程內快取（selfListings／wishOffers／rentalMatch／rentalNotify… 的同步路徑
// 讀的就是那些快取）。PG 分支若只寫 DB 不更新快取，**同一台節點**會立刻出現
// 「後台改完、前台沒變」。所以這裡不只比對回傳值與**落地的 settings 列**，
// 還會直接讀快取（`currentRentalCatalogCache()` 等）確認它跟上了。
//
// 第二個重點是**每個動作都要與同步版逐欄相同**：這個模組幾乎沒有 SQL，邏輯都在
// `rentalCatalog.js` 的純函式裡，所以真正的風險是「async 版漏抄了某一段」——
// 那正是 parity 測試要抓的。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-rentalcatalog-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const db = (await import("../src/db.js")).sqliteHandle();
const syncDb = await import("../src/db.js");
const lib = await import("../src/rentalCatalog.js");
const { defaultCatalog } = lib;
const asyncMod = await import("../src/rentalCatalogAsync.js");
const demand = await import("../src/demand.js");

const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown) does not exist"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  [/COLLATE\s+NOCASE/i, 'collation "nocase" for encoding "UTF8" does not exist'],
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
];

// PG 替身：只有 `settings` 一張表（這個模組的儲存層就是 KV）。
function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  for (const table of ["settings", "listings", "demand_posts"]) {
    const ddl = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
    assert.ok(ddl?.sql, `必須抓到 ${table} 的 DDL`);
    mem.exec(ddl.sql);
  }
  disk.close();
  const calls = [];
  const exec = async (sql, params = []) => {
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    // `settings` 的複合主鍵是 (user_id, key) 嗎？先確認 upsert 的衝突目標可用。
    if (/ON CONFLICT\(key\) DO UPDATE/.test(sql)) {
      calls.push({ sql, params });
      mem.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(...params);
      return [];
    }
    calls.push({ sql, params });
    return mem.prepare(sql).all(...params);
  };
  exec.raw = mem;
  exec.calls = calls;
  return exec;
}

function resetBoth() {
  db.prepare("DELETE FROM settings").run();
  const exec = pgFixture();
  exec.raw.prepare("DELETE FROM settings").run();
  // 快取也要歸零，否則前一條測試的目錄會影響後一條。
  asyncMod.hydrateCaches(lib.defaultCatalog(), {});
  return exec;
}

const settingsRows = (handle) =>
  handle.prepare("SELECT key, value FROM settings WHERE key LIKE 'rental%' ORDER BY key").all()
    .map((r) => ({ key: r.key, value: r.value }));

function assertSameSettings(exec, why) {
  const a = settingsRows(db);
  const b = settingsRows(exec.raw);
  assert.deepEqual(b, a, `${why}：PG 分支落地的 settings 列必須與同步版完全相同`);
  assert.ok(a.length > 0 || why.includes("空"), `${why}：兩邊都沒有列時這個比對沒有鑑別力`);
}

const reasonOf = (error) => `${error.status || "-"}/${error.message}`;

// 欄位清單從 PRAGMA 推導，只補 NOT NULL 且沒有 DEFAULT 的——`listings` 有一堆這種欄位
// （`source_key`、`first_seen_at`…），憑印象寫就會一路撞 NOT NULL。
function seedListing(handle, traitId, postId = 9001) {
  const info = handle.prepare("PRAGMA table_info(listings)").all();
  const provided = {
    post_id: postId, source: "self", title: "t", url: `/go/${postId}`,
    self_traits: JSON.stringify([traitId]),
  };
  const required = info.filter((c) => c.notnull === 1 && c.dflt_value === null && c.pk === 0);
  const names = info.map((c) => c.name).filter((n) => n in provided || required.some((c) => c.name === n));
  handle.prepare(`INSERT INTO listings(${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
    .run(...names.map((n) => {
      if (n in provided) return provided[n];
      const col = info.find((c) => c.name === n);
      return /INT|REAL|NUM/i.test(col.type) ? 0 : "";
    }));
}
const CACHE = () => ({
  catalog: demand.currentRentalCatalogCache(),
  flags: demand.currentRentalMarketplaceFlags(),
});

// ---------------------------------------------------------------------------

test("讀取：沒有 stored 值時回預設目錄，而且會把行程內快取收斂到 PG", async (t) => {
  const exec = resetBoth();
  const lite = syncDb.getRentalCatalog(); // 先取同步版（它也會 hydrate 快取）
  // 🚨 關鍵：**只**把目錄寫進 PG 的夾具（不經過 async 寫入），所以行程內快取此時仍是舊的。
  // 這樣才驗得到「讀取路徑會不會把快取收斂到 PG」。
  // 第一版是「PG 讀 → 再呼叫同步版 → 比對」，但同步版本本身就會 hydrate，
  // 把 PG 分支漏掉 hydrate 的缺陷整個蓋掉（變異測試顯示殺不死）。
  const remote = lib.normalizeCatalog(defaultCatalog());
  remote.categories[0].label = "PG 上的新標籤";
  exec.raw.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run("rentalCatalog", JSON.stringify(remote));
  assert.notDeepEqual(demand.currentRentalCatalogCache(), remote, "前置條件：快取必須還是舊的");

  const pg = await asyncMod.getRentalCatalogAsync({ ...PG, exec });
  assert.deepEqual(pg, remote, "讀回來的必須是 PG 那一份");
  assert.equal(demand.currentRentalCatalogCache().categories[0].label, "PG 上的新標籤",
    "讀取後行程內快取必須收斂到 PG 的內容");
  assert.equal(lite.categories[0].label === "PG 上的新標籤", false, "前置條件：同步版那一份是舊的");
  t.diagnostic(`預設目錄分類數 ${pg.categories.length}`);
  // 這一條刻意**不用** `assertSameSettings`：兩邊都是 0 列時那個比對沒有鑑別力
  //（守衛會直接擋下來）。「讀不寫」要驗的就是「兩邊都沒有列」。
  // 這裡的夾具已經有**一列**（上面為了驗快取收斂而直接種進去的），所以驗的是「沒有增加」。
  assert.equal(settingsRows(exec.raw).length, 1, "PG 分支的純讀取不得寫入 settings");
  assert.equal(settingsRows(db).length, 0, "同步版的純讀取也不得寫入 settings");
});

test("寫入目錄：落地列、回傳值與**快取**都與同步版相同", async () => {
  const exec = resetBoth();
  // ⚠️ 用 `defaultCatalog()` 當底，不要手寫 `{categories:[{conditions:[…]}]}`：
  // 正規化後 conditions 是**頂層陣列**，而且標籤會被對應到既有 domain（`條件一` → 不是新條件），
  // 手寫的目錄會被正規化吃掉 ⇒ diff 永遠是空的（第一版就是這樣，測試等於沒驗）。
  const next = lib.normalizeCatalog(defaultCatalog());
  next.categories[0].label = "改過的分類";
  const pg = await asyncMod.saveRentalCatalogAsync(next, { ...PG, exec });
  // 🚨 先在**只走過 PG** 的狀態下讀快取：同步版本本身也會 hydrate，先跑同步版就會掩蓋缺陷。
  const cachedAfterPg = demand.currentRentalCatalogCache();
  const lite = syncDb.saveRentalCatalog(next);
  assert.deepEqual(pg, lite, "回傳值必須相同");
  assert.ok(pg.categories.length > 1, "預設目錄本來就有多個分類（這裡只是確認不是空的）");
  assert.equal(pg.categories[0].label, "改過的分類", "改動必須反映在回傳值上");
  assertSameSettings(exec, "寫入目錄");

  // 🚨 這一條是這個模組的關鍵：PG 寫完之後，**行程內快取必須是新目錄**。
  // 少了 hydrateCaches，同步路徑（selfListings／wishOffers）會繼續用舊目錄。
  assert.deepEqual(cachedAfterPg, next, "PG 寫入後行程內快取必須換成新目錄");
  assert.equal(cachedAfterPg.categories[0].label, "改過的分類", "快取必須是**新的**那一份，不是舊的");
});

test("草稿：儲存／讀回／發布，落地列與 diff 都與同步版相同", async () => {
  const exec = resetBoth();
  const base = lib.normalizeCatalog(defaultCatalog());
  syncDb.saveRentalCatalog(base);
  await asyncMod.saveRentalCatalogAsync(base, { ...PG, exec });
  // 真的改變一個條件（停用它）＋ 改一個分類標籤，diff 才不會是空的。
  const draft = JSON.parse(JSON.stringify(base));
  draft.conditions[0].enabled = false;

  const pgSaved = await asyncMod.saveRentalCatalogDraftAsync(draft, { ...PG, exec });
  const liteSaved = syncDb.saveRentalCatalogDraft(draft);
  assert.deepEqual(pgSaved, liteSaved, "存草稿的回傳（含 diff）必須相同");
  assert.ok(pgSaved.diff.changed > 0 || pgSaved.diff.disabled > 0,
    `diff 不得是空的（否則這條測試沒有鑑別力）。實際：${JSON.stringify(pgSaved.diff)}`);
  assertSameSettings(exec, "存草稿");

  assert.deepEqual(await asyncMod.getRentalCatalogDraftAsync({ ...PG, exec }), syncDb.getRentalCatalogDraft());
  assert.equal((await asyncMod.getRentalCatalogDraftAsync({ ...PG, exec })).conditions[0].enabled, false,
    "讀回來的草稿必須帶著那個改動");

  const pgPublished = await asyncMod.publishRentalCatalogDraftAsync({ ...PG, exec });
  const cachedAfterPublish = demand.currentRentalCatalogCache();
  const litePublished = syncDb.publishRentalCatalogDraft();
  assert.deepEqual(pgPublished, litePublished);
  assert.equal(cachedAfterPublish.conditions[0].enabled, false,
    "發布後快取必須換成草稿的內容（只走過 PG 的那個時間點）");
  assert.equal(await asyncMod.getRentalCatalogDraftAsync({ ...PG, exec }), null, "發布後草稿要清掉");
  assertSameSettings(exec, "發布草稿");
});

test("發布沒有草稿時 → 400，兩邊訊息相同", async () => {
  const exec = resetBoth();
  let syncErr = null;
  try { syncDb.publishRentalCatalogDraft(); } catch (e) { syncErr = e; }
  assert.ok(syncErr, "同步版應該丟 400");
  assert.equal(syncErr.status, 400);
  await assert.rejects(() => asyncMod.publishRentalCatalogDraftAsync({ ...PG, exec }),
    (e) => reasonOf(e) === reasonOf(syncErr));
});

test("mutate：upsert／move／delete 三種動作的落地結果都與同步版相同", async () => {
  const exec = resetBoth();
  const base = lib.normalizeCatalog(defaultCatalog());
  syncDb.saveRentalCatalog(base);
  await asyncMod.saveRentalCatalogAsync(base, { ...PG, exec });

  const catA = base.categories[0];
  const catB = base.categories[1];
  const cond = base.conditions[0];
  // 🚨 `delete_condition` 的關鍵是**引用數**：沒有引用時「硬刪」與「停用」結果一樣，
  // 變異（不看引用數）就殺不死。種一筆引用到該條件的 listing，兩邊的 storage 都要種。
  for (const h of [db, exec.raw]) {
    seedListing(h, cond.id);
  }
  const actions = [
    // `upsertCategory` 只更新**既有**分類（找不到會丟「找不到這個分類」），所以要帶既有 id。
    ["upsert_category", { id: catA.id, label: "改過的分類" }],
    ["upsert_condition", { ...cond, label: cond.label }],
    ["move_condition", { id: cond.id, category_id: catB.id }],
    ["delete_condition", { id: cond.id }],
  ];
  for (const [action, payload] of actions) {
    // 兩邊各自從同一個起點跑一次完整序列（PG 與 SQLite 的操作是交錯的，但都作用在自己的儲存）。
    const pgResult = await asyncMod.mutateRentalCatalogAsync(action, payload, { ...PG, exec });
    const liteResult = syncDb.mutateRentalCatalog(action, payload);
    assert.equal(pgResult.draft, true, `${action} 應該產生草稿`);
    assert.equal(pgResult.draft, liteResult.draft);
    assert.deepEqual(pgResult.diff, liteResult.diff, `${action} 的 diff 必須相同`);
  }
  assertSameSettings(exec, "mutate 序列");
  assert.deepEqual(await asyncMod.getRentalCatalogDraftAsync({ ...PG, exec }), syncDb.getRentalCatalogDraft());
});

test("mutate：不支援的動作 → 400，兩邊訊息相同且不得寫入", async () => {
  const exec = resetBoth();
  let syncErr = null;
  try { syncDb.mutateRentalCatalog("nope", {}); } catch (e) { syncErr = e; }
  assert.ok(syncErr, "同步版應該擋下");
  await assert.rejects(() => asyncMod.mutateRentalCatalogAsync("nope", {}, { ...PG, exec }),
    (e) => reasonOf(e) === reasonOf(syncErr));
  assert.equal(settingsRows(exec.raw).length, 0, "被擋下就不得落地");
});

test("範本：列表、新增、改名、刪除都與同步版相同（含系統範本的保護）", async () => {
  const exec = resetBoth();
  assert.deepEqual(await asyncMod.getRentalCatalogTemplatesAsync({ ...PG, exec }), syncDb.getRentalCatalogTemplates());
  const initial = await asyncMod.getRentalCatalogTemplatesAsync({ ...PG, exec });
  assert.ok(initial.length > 0, "預設範本不得是空的");

  // 新增一個自訂範本（用系統範本當底，改 id／label）。
  const base = initial[0];
  const created = await asyncMod.saveRentalCatalogTemplateAsync({ ...base, id: "custom-1", label: "自訂範本" }, { ...PG, exec });
  const liteCreated = syncDb.saveRentalCatalogTemplate({ ...base, id: "custom-1", label: "自訂範本" });
  assert.deepEqual(created, liteCreated);
  assert.equal(created.system, false);
  assertSameSettings(exec, "新增範本");

  // ⚠️ 用回傳的 `created.id`，不要用我傳進去的 "custom-1"：`normalizeTemplate()` 會依 label
  // 重新產生 id（與條件對應 domain 是同一類行為），傳進去的 id 不一定會被保留。
  const customId = created.id;
  const renamed = await asyncMod.renameRentalCatalogTemplateAsync(customId, "改名後", { ...PG, exec });
  const liteRenamed = syncDb.renameRentalCatalogTemplate(customId, "改名後");
  assert.deepEqual(renamed, liteRenamed);
  assert.equal(renamed.label, "改名後");
  assert.equal((await asyncMod.getRentalCatalogTemplatesAsync({ ...PG, exec })).length, initial.length + 1,
    "改名不得增加或減少範本數");

  const deleted = await asyncMod.deleteRentalCatalogTemplateAsync(customId, { ...PG, exec });
  const liteDeleted = syncDb.deleteRentalCatalogTemplate(customId);
  assert.deepEqual(deleted, liteDeleted);
  assert.equal(deleted.ok, true);
  assert.equal((await asyncMod.getRentalCatalogTemplatesAsync({ ...PG, exec })).length, initial.length);
  assertSameSettings(exec, "刪除範本");

  // 系統範本不能覆寫／改名／刪除（兩邊同訊息）。三條都要驗——
  // 只驗改名與刪除的話，「save 不再保護系統範本」的變異殺不死。
  const systemRow = initial.find((row) => lib.isSystemCatalogTemplate(row.id));
  assert.ok(systemRow, "預設範本裡必須有系統範本，否則這條守衛是空的");
  const systemId = systemRow.id;
  for (const [label, run, syncRun] of [
    ["save", () => asyncMod.saveRentalCatalogTemplateAsync({ ...systemRow, label: "覆寫" }, { ...PG, exec }),
      () => syncDb.saveRentalCatalogTemplate({ ...systemRow, label: "覆寫" })],
    ["rename", () => asyncMod.renameRentalCatalogTemplateAsync(systemId, "x", { ...PG, exec }),
      () => syncDb.renameRentalCatalogTemplate(systemId, "x")],
    ["delete", () => asyncMod.deleteRentalCatalogTemplateAsync(systemId, { ...PG, exec }),
      () => syncDb.deleteRentalCatalogTemplate(systemId)],
  ]) {
    let syncErr = null;
    try { syncRun(); } catch (e) { syncErr = e; }
    assert.ok(syncErr, `同步版應該保護系統範本（${label}）`);
    await assert.rejects(run, (e) => reasonOf(e) === reasonOf(syncErr), `${label} 的錯誤必須相同`);
  }
});

test("範本：套用到草稿，落地結果與同步版相同", async () => {
  const exec = resetBoth();
  const base = lib.normalizeCatalog(defaultCatalog());
  syncDb.saveRentalCatalog(base);
  await asyncMod.saveRentalCatalogAsync(base, { ...PG, exec });
  const template = syncDb.getRentalCatalogTemplates()[0];
  assert.ok(template, "必須有範本可以套用");

  const pg = await asyncMod.applyRentalCatalogTemplateAsync(template.id, { ...PG, exec });
  const lite = syncDb.applyRentalCatalogTemplate(template.id);
  assert.deepEqual(pg, lite);
  assert.ok(pg.draft, "套用範本應該產生草稿");
  assertSameSettings(exec, "套用範本");
});

test("找不到範本時 → 404，兩邊訊息相同", async () => {
  const exec = resetBoth();
  let syncErr = null;
  try { syncDb.applyRentalCatalogTemplate("no-such-template"); } catch (e) { syncErr = e; }
  assert.ok(syncErr, "同步版應該丟 404");
  assert.equal(syncErr.status, 404);
  await assert.rejects(() => asyncMod.applyRentalCatalogTemplateAsync("no-such-template", { ...PG, exec }),
    (e) => reasonOf(e) === reasonOf(syncErr));
  // 改名／刪除不存在的範本也一樣。
  await assert.rejects(() => asyncMod.renameRentalCatalogTemplateAsync("no-such", "x", { ...PG, exec }),
    (e) => e.status === 404);
  await assert.rejects(() => asyncMod.deleteRentalCatalogTemplateAsync("no-such", { ...PG, exec }),
    (e) => e.status === 404);
});

test("安全檢查：帶禁用字詞的目錄要擋下，且不得落地", async () => {
  const exec = resetBoth();
  // 用真實目錄當底，再把一個條件的標籤換成受保護的個人特徵字詞——
  // 手寫的目錄會被正規化吃掉，根本到不了 `assertCatalogSafe`。
  const unsafe = JSON.parse(JSON.stringify(lib.normalizeCatalog(defaultCatalog())));
  unsafe.conditions[0].label = "限女性";
  let syncErr = null;
  try { syncDb.saveRentalCatalog(unsafe); } catch (e) { syncErr = e; }
  assert.ok(syncErr, "同步版應該擋下受保護的個人特徵");
  await assert.rejects(() => asyncMod.saveRentalCatalogAsync(unsafe, { ...PG, exec }),
    (e) => reasonOf(e) === reasonOf(syncErr));
  // **草稿路徑也要驗**：只驗 saveRentalCatalog 的話，「草稿沒過安全檢查」的變異殺不死。
  let syncDraftErr = null;
  try { syncDb.saveRentalCatalogDraft(unsafe); } catch (e) { syncDraftErr = e; }
  assert.ok(syncDraftErr, "同步版的草稿路徑也應該擋下");
  await assert.rejects(() => asyncMod.saveRentalCatalogDraftAsync(unsafe, { ...PG, exec }),
    (e) => reasonOf(e) === reasonOf(syncDraftErr));
  assert.equal(settingsRows(exec.raw).length, 0, "被擋下就不得落地");
});

test("開關（rental-marketplace-flags）：PG 的設定值要與同步版逐欄相同", async () => {
  const exec = resetBoth();
  const flags = { rental_catalog_v2: { enabled: true }, wish_owner_matching: { enabled: true } };
  db.prepare("INSERT INTO settings(key, value) VALUES('rentalMarketplaceFlags', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify(flags));
  exec.raw.prepare("INSERT INTO settings(key, value) VALUES('rentalMarketplaceFlags', ?)").run(JSON.stringify(flags));

  const pg = await asyncMod.getRentalMarketplaceFlagsAsync({ ...PG, exec });
  const lite = syncDb.getRentalMarketplaceFlags();
  assert.deepEqual(pg, syncDb.getRentalMarketplaceFlags() === undefined ? null : pg, "不該是 undefined");
  assert.deepEqual(Object.keys(pg).sort(), Object.keys(lite).sort(), "鍵集合必須相同");
  // 逐欄比對（`normalizeRentalMarketplaceFlags` 會補一堆預設旗標）。
  for (const key of Object.keys(lite)) assert.deepEqual(pg[key], lite[key], `${key} 必須相同`);
  assert.ok(Object.keys(pg).length > 0, "旗標不得是空物件，否則比對沒有鑑別力");
});

test("開關：非 postgres 模式讀磁碟那一份", async () => {
  const exec = resetBoth();
  db.prepare("INSERT INTO settings(key, value) VALUES('rentalMarketplaceFlags', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify({ rental_catalog_v2: { enabled: true } }));
  const lite = await asyncMod.getRentalMarketplaceFlagsAsync({ driver: "sqlite", exec });
  assert.deepEqual(lite, syncDb.getRentalMarketplaceFlags());
});

test("rentalMatchAdminRules：與同步版逐欄相同（且會先 hydrate）", async () => {
  const exec = resetBoth();
  const pg = await asyncMod.rentalMatchAdminRulesAsync({ ...PG, exec });
  const lite = syncDb.rentalMatchAdminRules();
  assert.deepEqual(pg, lite);
  assert.ok(Object.keys(pg).length > 0, "規則不得是空物件");
  assert.equal(typeof pg.catalog_on, "boolean", "catalog_on 必須是布林（否則比對會變成兩個 undefined 相等）");
});

test("非 postgres 模式必須回退同步路徑（讀寫磁碟，不碰傳入的 exec）", async () => {
  const exec = resetBoth();
  const next = lib.normalizeCatalog(defaultCatalog());
  next.categories[0].label = "夾具版";
  await asyncMod.saveRentalCatalogAsync(next, { ...PG, exec });
  // 同樣是兩列（目錄 ＋ 被清成 null 的草稿）。
  assert.deepEqual(settingsRows(exec.raw).map((r) => r.key), ["rentalCatalog", "rentalCatalogDraft"]);

  const disk = lib.normalizeCatalog(defaultCatalog());
  disk.categories[0].label = "磁碟版";
  const lite = await asyncMod.saveRentalCatalogAsync(disk, { driver: "sqlite", exec });
  assert.equal(lite.categories[0].label, "磁碟版");
  // `saveRentalCatalog()` 會寫**兩列**：`rentalCatalog` 與被清成 null 的 `rentalCatalogDraft`
  //（同步版同義）。第一版斷言 1 列，是把「寫目錄」想成只寫一個鍵。
  assert.deepEqual(settingsRows(db).map((r) => r.key), ["rentalCatalog", "rentalCatalogDraft"],
    "sqlite 模式必須寫磁碟（目錄 ＋ 清掉的草稿）");
  assert.equal(settingsRows(exec.raw)[0].value.includes("夾具版"), true, "sqlite 模式不得改動 PG 夾具");
  assert.deepEqual(await asyncMod.getRentalCatalogAsync({ driver: "sqlite", exec }),
    syncDb.getRentalCatalog(), "sqlite 模式讀的必須是磁碟那一份");
});

test("strict：PG 失敗時必須往上丟，不得無聲寫進沒人讀的 SQLite", async () => {
  const exec = resetBoth();
  const broken = async () => { throw new Error("connection terminated unexpectedly"); };
  const next = lib.normalizeCatalog(defaultCatalog());
  await assert.rejects(() => asyncMod.saveRentalCatalogAsync(next, { ...PG, exec: broken, strict: true }), /connection terminated/);
  await assert.rejects(() => asyncMod.saveRentalCatalogAsync(next, { ...PG, exec: broken }), /connection terminated/);
  assert.equal(settingsRows(db).length, 0, "寫入失敗不得回退寫 SQLite");
});

test("夾具本身要真的拒絕 IFNULL／COLLATE NOCASE（否則方言守衛是空的）", async () => {
  const exec = pgFixture();
  await assert.rejects(() => exec("SELECT IFNULL(value,'') FROM settings"), /function ifnull/);
  await assert.rejects(() => exec("SELECT key FROM settings ORDER BY key COLLATE NOCASE"), /collation "nocase"/);
  await assert.doesNotReject(() => exec("SELECT key FROM settings"), "普通查詢要放行");
});
