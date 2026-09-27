// 後台設定（郵件／OAuth／贊助／品牌）PG 分支的 parity（2026-09-27）。
//
// 這一組的形狀幾乎都一樣：「讀一個 settings 鍵 ＋ 一個純函式」，所以 port 很短——
// 但也正因為短，很容易在改寫時漏掉細節。這支測試專門釘住那些細節：
//
//   1. `getStoredSmtp()` 的**環境變數 fallback**：只有在存的值有 `host` 時才用它，
//      否則回 `smtpFromEnv()`。漏掉這個 fallback，會讓「還沒在後台設定 SMTP」的站台
//      整個寄不出信——而且不會有任何錯誤訊息。
//   2. `saveBrandMascot()` 存的是**公開形狀**（先 `publicBrandMascot` 再 `normalizeBrandMascot`），
//      不是原始形狀。改錯會直接改變落地資料。
//   3. 寫入要比對**實際落地的位元組**（`settings` 的 key/value），不是只比回傳值。
//
// 測試形狀沿用 `reject-match-async.test.js`：夾具的 DDL 從真實 `sqlite_master` 複製、
// 夾具主動拒絕 PostgreSQL 會拋錯的 SQLite 專屬語法、比對落地資料列。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-adminsettings-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const db = await import("../src/db.js");
const sync = {
  getMailTemplates: db.getMailTemplates,
  getStoredSmtp: db.getStoredSmtp,
  getAdminMailSettings: db.getAdminMailSettings,
  getStoredOauth: db.getStoredOauth,
  getAdminOauthSettings: db.getAdminOauthSettings,
  getSponsorConfig: db.getSponsorConfig,
  getAdminSponsorSettings: db.getAdminSponsorSettings,
  saveAdminSponsorSettings: db.saveAdminSponsorSettings,
  getAdminAdsSettings: db.getAdminAdsSettings,
  getAdminBroadcastsSettings: db.getAdminBroadcastsSettings,
  getBrandMascot: db.getBrandMascot,
  saveBrandMascot: db.saveBrandMascot,
  publicSponsorSettings: db.publicSponsorSettings,
};
const asyncMod = await import("../src/adminSettingsAsync.js");

const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");
const KEYS = ["smtp", "mailTemplates", "oauth", "sponsorLinks", "brandMascot"];

// 夾具主動拒絕 PostgreSQL 會拋錯的 SQLite 專屬語法（與 reject-match 的夾具同一組理由）。
const PG_ILLEGAL = [
  [/MIN\s*\(\s*[^()]*,[^()]*\)/i, "function min(integer, integer) does not exist"],
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
  [/\bIFNULL\s*\(/i, "function ifnull(text, unknown) does not exist"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  [/\binstr\s*\(/i, "function instr(text, text) does not exist"],
];

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  const rows = disk.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name IN ('settings')",
  ).all();
  disk.close();
  for (const row of rows) if (row.sql) mem.exec(row.sql);
  assert.ok(rows.length, "夾具必須抓到 settings 的 DDL（否則這個測試是空的）");
  const exec = async (sql, params = []) => {
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    return mem.prepare(sql).all(...params);
  };
  exec.raw = mem;
  return exec;
}

// 只清這一組會用到的鍵——整表刪掉會動到 db.js 內部的設定快取。
function resetKeys(h) {
  for (const k of KEYS) h.prepare("DELETE FROM settings WHERE key = ?").run(k);
}
function seed(h, key, value) {
  h.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
}
const rowsOf = (h) => h.prepare("SELECT key, value FROM settings WHERE key IN ('smtp','mailTemplates','oauth','sponsorLinks','brandMascot','siteAds','broadcasts') ORDER BY key").all();

// 兩邊都放同一組底料。
function resetBoth(seedFn) {
  const disk = new DatabaseSync(diskPath());
  resetKeys(disk);
  const exec = pgFixture();
  resetKeys(exec.raw);
  if (seedFn) { seedFn(disk); seedFn(exec.raw); }
  return [disk, exec];
}

// ---------------------------------------------------------------------------
// 唯讀：回傳值必須逐欄相同

test("getMailTemplatesAsync：沒有存值時回預設、有存值時逐欄相同", async () => {
  {
    const [disk, exec] = resetBoth();
    assert.deepEqual(await asyncMod.getMailTemplatesAsync({ ...PG, exec }), sync.getMailTemplates(),
      "兩邊都應該是預設值");
    disk.close();
  }
  {
    // 鍵名用**真實**的（welcome／verify_expired／…）。第一版我憑印象寫成 `verify`，
    // 結果兩邊都回預設 ⇒ 斷言失敗。這與交接文件列的「資料形狀猜錯」同一類。
    const [disk, exec] = resetBoth((h) => seed(h, "mailTemplates", { welcome: { subject: "自訂主旨" } }));
    const a = await asyncMod.getMailTemplatesAsync({ ...PG, exec });
    assert.deepEqual(a, sync.getMailTemplates());
    assert.equal(a.welcome.subject, "自訂主旨", "必須真的讀到存的值（否則這條測試沒鑑別力）");
    disk.close();
  }
});

test("getStoredSmtpAsync：存的 smtp 有 host 時要用存的", async () => {
  const [disk, exec] = resetBoth((h) => seed(h, "smtp", { host: "smtp.example.com", user: "u", from: "a@b.c" }));
  const a = await asyncMod.getStoredSmtpAsync({ ...PG, exec });
  assert.deepEqual(a, sync.getStoredSmtp());
  assert.equal(a.host, "smtp.example.com", "必須用存的值");
  disk.close();
});

test("getStoredSmtpAsync：存的 smtp **沒有 host** 時必須回環境變數的 fallback", async () => {
  // 這是本檔最重要的一項：漏掉 fallback 會讓未設定 SMTP 的站台寄不出信，而且沒有任何錯誤。
  const [disk, exec] = resetBoth((h) => seed(h, "smtp", { host: "", user: "只有 user 沒有 host" }));
  const a = await asyncMod.getStoredSmtpAsync({ ...PG, exec });
  const s = sync.getStoredSmtp();
  assert.deepEqual(a, s, "沒有 host ⇒ 兩邊都必須回 smtpFromEnv()");
  assert.notEqual(a.user, "只有 user 沒有 host",
    "不可以把沒有 host 的存值當成有效設定——那就是 fallback 被漏掉的樣子");
  disk.close();
});

test("getAdminMailSettingsAsync：smtp／templates／configured 三個欄位都相同", async () => {
  const [disk, exec] = resetBoth((h) => {
    seed(h, "smtp", { host: "smtp.example.com", from: "a@b.c" });
    seed(h, "mailTemplates", { verify: { subject: "S" } });
  });
  const a = await asyncMod.getAdminMailSettingsAsync({ ...PG, exec });
  assert.deepEqual(a, sync.getAdminMailSettings());
  assert.equal(a.configured, true, "有 host 且有 from ⇒ configured 必須是 true");
  disk.close();
});

test("getAdminOauthSettingsAsync / getStoredOauthAsync：逐欄相同", async () => {
  const [disk, exec] = resetBoth((h) => seed(h, "oauth", { google: { clientId: "cid" } }));
  assert.deepEqual(await asyncMod.getStoredOauthAsync({ ...PG, exec }), sync.getStoredOauth());
  assert.deepEqual(await asyncMod.getAdminOauthSettingsAsync({ ...PG, exec }), sync.getAdminOauthSettings());
  disk.close();
});

test("getSponsorConfigAsync / getAdminSponsorSettingsAsync：逐欄相同（含純函式 catalog）", async () => {
  const [disk, exec] = resetBoth((h) => seed(h, "sponsorLinks", { intro: "斗內一下", thanks: "謝謝" }));
  const cfg = await asyncMod.getSponsorConfigAsync({ ...PG, exec });
  assert.deepEqual(cfg, sync.getSponsorConfig());
  assert.equal(cfg.intro, "斗內一下", "必須真的讀到存的值");
  assert.deepEqual(await asyncMod.getAdminSponsorSettingsAsync({ ...PG, exec }), sync.getAdminSponsorSettings());
  disk.close();
});

// ---------------------------------------------------------------------------
// 寫入：比對**實際落地的位元組**

test("saveAdminSponsorSettingsAsync：settings 落地的 key/value 必須與同步版逐列相同", async () => {
  const [disk, exec] = resetBoth((h) => seed(h, "sponsorLinks", { intro: "舊的", thanks: "舊謝", extras: [] }));
  const partial = { intro: "新的", providers: { ecpay: { enabled: true } } };

  const s = sync.saveAdminSponsorSettings(partial);
  const a = await asyncMod.saveAdminSponsorSettingsAsync(partial, { ...PG, exec });

  assert.deepEqual(a, s, "回傳值必須相同");
  assert.deepEqual(rowsOf(exec.raw), rowsOf(disk), "settings 的落地位元組必須逐列相同");
  const landed = JSON.parse(rowsOf(disk).find((r) => r.key === "sponsorLinks").value);
  assert.equal(landed.intro, "新的", "必須真的改到值（否則這條測試沒鑑別力）");
  assert.equal(landed.thanks, "舊謝", "沒給的欄位要沿用現值");
  disk.close();
});

test("getBrandMascotAsync：**讀**回來的形狀必須與同步版相同（含 productName）", async () => {
  // 這一條是被變異測試逼出來的：我原本只測了 saveBrandMascotAsync（落地位元組），
  // 而「拿掉 publicBrandMascot」那個變異在**儲存**路徑上是等價的
  // （normalize 會再正規化一次，落地結果不變）——所以那個變異活了下來。
  // 但它會改變**讀取**路徑的回傳形狀（少了 productName），因此必須有這一條。
  const [disk, exec] = resetBoth();
  const a = await asyncMod.getBrandMascotAsync({ ...PG, exec });
  assert.deepEqual(a, sync.getBrandMascot());
  assert.ok("productName" in a, "publicBrandMascot 會補上 productName；少了它就代表沒套公開形狀");
  disk.close();
});

test("saveBrandMascotAsync：存的是**公開形狀**，落地位元組必須與同步版相同", async () => {
  // 同步版是「讀公開形狀 → 合併 → normalize → 存回去」，所以落地的是公開形狀。
  // 若有人「順手」改成存原始形狀，這條會失敗。
  const [disk, exec] = resetBoth();
  const partial = { clips: { welcome: { title: "歡迎來坐" } } };

  const s = sync.saveBrandMascot(partial);
  const a = await asyncMod.saveBrandMascotAsync(partial, { ...PG, exec });

  assert.deepEqual(a, s, "回傳值必須相同");
  assert.deepEqual(rowsOf(exec.raw), rowsOf(disk), "settings 的落地位元組必須逐列相同");
  const raw = rowsOf(disk).find((r) => r.key === "brandMascot");
  assert.ok(raw, "必須有寫入 brandMascot");
  // clip 的欄位是 title／body（不是 text）——同樣是先用探針問出真實形狀才寫對的。
  assert.equal(JSON.parse(raw.value).clips.welcome.title, "歡迎來坐");
  disk.close();
});

// ---------------------------------------------------------------------------
// 公開贊助資訊

test("publicSponsorSettingsAsync：訪客與會員都要與同步版相同", async () => {
  const [disk, exec] = resetBoth((h) => seed(h, "sponsorLinks", { intro: "贊助我們" }));
  for (const user of [{}, { role: "member", plan: "pro" }, { role: "admin", plan: "free" }]) {
    assert.deepEqual(
      await asyncMod.publicSponsorSettingsAsync(user, { ...PG, exec }),
      sync.publicSponsorSettings(user),
      `user=${JSON.stringify(user)} 必須相同`,
    );
  }
  disk.close();
});

// ---------------------------------------------------------------------------
// 回退與夾具

test("非 postgres 必須回退同步路徑，且不碰傳入的 exec", async () => {
  // 兩邊刻意種**不同**的值：若實作忘了回退、真的去讀 exec，就會讀到 fixture 的值而被抓到。
  // （第一版兩邊種一樣的值 ⇒ 這條測試對「回退壞掉」毫無鑑別力。）
  const disk = new DatabaseSync(diskPath());
  resetKeys(disk);
  seed(disk, "sponsorLinks", { intro: "來自磁碟" });
  const exec = pgFixture();
  resetKeys(exec.raw);
  seed(exec.raw, "sponsorLinks", { intro: "來自夾具" });

  const a = await asyncMod.getSponsorConfigAsync({ driver: "sqlite", exec });
  assert.deepEqual(a, sync.getSponsorConfig());
  assert.equal(a.intro, "來自磁碟", "sqlite 模式必須讀磁碟，不可以讀傳入的 exec");
  // 夾具必須**完全沒被動過**（還留著它自己的值）。
  const fixtureRows = rowsOf(exec.raw);
  assert.equal(fixtureRows.length, 1);
  assert.equal(JSON.parse(fixtureRows[0].value).intro, "來自夾具",
    "sqlite 模式不得寫入 PG 夾具");
  disk.close();
});

test("夾具本身要真的拒絕 SQLite 專屬語法（否則上面的方言守衛是空的）", async () => {
  const exec = pgFixture();
  assert.doesNotThrow(() => exec.raw.prepare("SELECT MIN(1, 2) AS x").get(), "SQLite 的 MIN(a,b) 是純量，必須被接受");
  await assert.rejects(() => exec("SELECT 1 LIMIT -1 OFFSET 0"), /LIMIT must not be negative/);
  await assert.rejects(() => exec("SELECT IFNULL(key,'') FROM settings"), /function ifnull/);
  await assert.doesNotReject(() => exec("SELECT MIN(key) AS x FROM settings"), "單引數聚合 MIN 必須放行");
});

// ---- 站台廣告／廣播（唯讀）----
//
// 這兩個是「讀一個 settings 鍵 ＋ 一個純函式 ＋ 後台視圖」，形狀與前面的都一樣；
// 風險在於 `normalizeSiteAds`／`normalizeBroadcasts` 會補一堆預設欄位——
// 所以斷言要**逐欄**比對，不能只比「不是 null」。

test("getAdminAdsSettingsAsync：沒有存值時回預設，且逐欄與同步版相同", async () => {
  const [disk, exec] = resetBoth();
  const a = await asyncMod.getAdminAdsSettingsAsync({ ...PG, exec });
  const b = sync.getAdminAdsSettings();
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), "鍵集合必須相同");
  for (const key of Object.keys(b)) assert.deepEqual(a[key], b[key], `${key} 必須相同`);
  assert.ok(Object.keys(a).length > 0, "後台視圖不得是空物件，否則比對沒有鑑別力");
  disk.close();
});

test("getAdminAdsSettingsAsync：有存值時要用存的那一份（不是預設）", async () => {
  // ⚠️ seed 一定要**踩到真正的巢狀路徑**：`normalizeSiteAds` 的形狀是
  // `{slots:{listings:{enabled,title,url,…}, …}}`，給一個頂層 `{enabled:true}` 會被忽略，
  // 於是「有沒有查 PG」算出來一樣 ⇒ 變異殺不死（第一版就是這樣）。
  const [disk, exec] = resetBoth((h) => seed(h, "siteAds", {
    slots: { listings: { enabled: true, title: "版位標題", text: "說明", url: "https://ad.example.test/x" } },
  }));
  const a = await asyncMod.getAdminAdsSettingsAsync({ ...PG, exec });
  const b = sync.getAdminAdsSettings();
  for (const key of Object.keys(b)) assert.deepEqual(a[key], b[key], `${key} 必須相同`);
  disk.close();
});

test("getAdminBroadcastsSettingsAsync：逐欄與同步版相同（有存值與沒存值都驗）", async () => {
  const [disk, exec] = resetBoth();
  // 同上：廣播的形狀是 `{items:{announcement:{…},news:{…},sponsor:{…}}}`。
  const storedBroadcasts = {
    items: { news: { enabled: true, title: "快訊標題", body: "快訊內容", url: "https://news.example.test/y", hops: 5 } },
  };
  // ⚠️ 分成兩段，不要寫成迴圈裡再 `resetBoth()`：那會建出**新的**夾具卻忘了重新綁定 `exec`，
  // 斷言就變成拿舊夾具比新磁碟（第一版就是這樣紅的）。
  for (const [label, seedFn, seedable] of [["沒有存值", null, false], ["有存值", (h) => seed(h, "broadcasts", storedBroadcasts), true]]) {
    const [d, e] = seedable ? resetBoth(seedFn) : resetBoth();
    const a = await asyncMod.getAdminBroadcastsSettingsAsync({ ...PG, exec: e });
    const b = sync.getAdminBroadcastsSettings();
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${label}：鍵集合必須相同`);
    for (const key of Object.keys(b)) assert.deepEqual(a[key], b[key], `${label}：${key} 必須相同`);
    d.close();
  }
  // 反向：非 postgres 模式讀磁碟那一份。
  const [d2, e2] = resetBoth();
  assert.deepEqual(await asyncMod.getAdminBroadcastsSettingsAsync({ driver: "sqlite", exec: e2 }), sync.getAdminBroadcastsSettings());
  assert.deepEqual(await asyncMod.getAdminAdsSettingsAsync({ driver: "sqlite", exec: e2 }), sync.getAdminAdsSettings());
  d2.close();
  disk.close();
});
