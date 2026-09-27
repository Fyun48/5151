// 居住數據（housingData）driver-aware 讀寫 ＋ 排程自動更新的 parity（2026-09-27）。
//
// 這一組釘住兩件事：
//
//   1. `getHousingDataRaw()`／`writeHousingData()` 與 `getHousingData()`／`saveHousingData()` **語意不同**：
//      前者是「原始（未套 public 形狀）」、後者是「公開形狀 ＋ 部分合併」。
//      排程更新用的是前者，所以不能拿後者頂替。這裡比對**實際落地的 settings 位元組**。
//
//   2. **`refreshHousingData()` 必須 `await` 它的回呼。** 原本是同步呼叫
//      （`getData()`／`writeData(data)` 直接呼叫、沒有 await），一旦呼叫端在 PG 模式下
//      傳 async 版本，`normalizeHousingData(getData())` 收到的是 Promise ⇒ 整份資料被換成預設值，
//      而且不會拋錯。這一項就是守那個 `await`。
//
// 第 3 項是**真正修掉分歧**的部分：`runHousingRefresh()` 是排程工作
// （啟動後 30 秒 + 每 24 小時），先前用同步 SQLite 讀寫 ⇒ PG 模式下自動抓到的居住成本
// 只寫進回答你那台的本機檔，PG 永遠不會更新、兩台也會不同。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-housing-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const db = await import("../src/db.js");
const site = await import("../src/siteContentAsync.js");
const { refreshHousingData } = await import("../src/housingFetch.js");
const { defaultHousingData } = await import("../src/housingData.js");

const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");
const KEY = "housingData";

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(text, unknown) does not exist"],
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
];

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  const rows = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='settings'").all();
  disk.close();
  assert.equal(rows.length, 1, "必須抓到 settings 的 DDL");
  mem.exec(rows[0].sql);
  const exec = async (sql, params = []) => {
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    return mem.prepare(sql).all(...params);
  };
  exec.raw = mem;
  return exec;
}

function resetBoth(seedFn) {
  const disk = new DatabaseSync(diskPath());
  disk.prepare("DELETE FROM settings WHERE key = ?").run(KEY);
  const exec = pgFixture();
  exec.raw.prepare("DELETE FROM settings WHERE key = ?").run(KEY);
  if (seedFn) { seedFn(disk); seedFn(exec.raw); }
  return [disk, exec];
}
const seed = (h, value) =>
  h.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)").run(KEY, JSON.stringify(value));
const landed = (h) => h.prepare("SELECT value FROM settings WHERE key = ?").get(KEY)?.value ?? null;

// ⚠️ `defaultHousingData()` 的每一筆預設項目都帶**隨機產生的 id**（`hd_<random>_N`），
// 所以「沒有存值 ⇒ 回預設」這條路徑上，兩邊各自產生一次的 id 一定不同——
// 直接比對永遠不會過（而且那不是 bug，是預設資料本來就這樣）。
// 比對時把 id 去掉，只比真正該相同的欄位。
const withoutIds = (data) => ({
  intro: data.intro,
  entries: (data.entries || []).map(({ id, ...rest }) => rest),
});

// ---------------------------------------------------------------------------

test("getHousingDataRawAsync：沒有存值時回預設、有存值時逐欄相同（且與「公開形狀」那組不同）", async () => {
  {
    const [disk, exec] = resetBoth();
    const a = await site.getHousingDataRawAsync({ ...PG, exec });
    assert.deepEqual(withoutIds(a), withoutIds(db.getHousingDataRaw()));
    assert.deepEqual(withoutIds(a), withoutIds(defaultHousingData()), "兩邊都應該是預設值");
    disk.close();
  }
  {
    const [disk, exec] = resetBoth((h) => seed(h, {
      intro: "自己打的說明",
      entries: [{ id: "e1", category: "hosting", title: "主機", amount: 1200, auto: false }],
    }));
    const a = await site.getHousingDataRawAsync({ ...PG, exec });
    assert.deepEqual(a, db.getHousingDataRaw());
    assert.equal(a.intro, "自己打的說明", "必須真的讀到存的值");
    // raw 與 public 是不同形狀：這條確保我們沒有拿 public 版本頂替。
    assert.notDeepEqual(a, db.getHousingData(), "raw 與 public 形狀必須不同（否則選錯函式也測不出來）");
    disk.close();
  }
});

test("writeHousingDataAsync：落地的 settings 位元組必須與同步版逐字相同", async () => {
  const [disk, exec] = resetBoth();
  const payload = {
    intro: "寫入測試",
    entries: [{ id: "e9", category: "domain", title: "網域", amount: 400, auto: false }],
  };
  const s = db.writeHousingData(payload);
  const a = await site.writeHousingDataAsync(payload, { ...PG, exec });
  assert.deepEqual(a, s, "回傳值必須相同");
  assert.equal(landed(exec.raw), landed(disk), "settings 的落地值必須逐字相同");
  assert.match(landed(disk), /寫入測試/, "必須真的寫進去（否則這條測試沒鑑別力）");
  disk.close();
});

test("🚨 refreshHousingData 必須 await 回呼：async 的 getData／writeData 都要生效", async () => {
  // 這一項是這支測試檔的核心。若 `refreshHousingData` 沒有 await：
  //   - `normalizeHousingData(getData())` 收到 Promise ⇒ 基準資料被換成預設值
  //   - `writeData(data)` 照樣會被呼叫，但拿到的資料已經沒有基準內容
  // 所以斷言「寫入的資料仍保有基準的 intro」就能抓到少了 await 的情況。
  let written = null;
  const baseline = { intro: "基準說明", entries: [{ id: "b1", category: "hosting", title: "主機", amount: 999, auto: false }] };
  const result = await refreshHousingData({
    fetchers: [async () => [{ category: "domain", title: "網域", amount: 400 }]],
    getData: async () => baseline,
    // 刻意先 await 一次：這樣「忘了 await writeData」也會被抓到
    // （若只是同步賦值，就算沒 await 也已經寫進 written 了）。
    writeData: async (data) => { await new Promise((r) => setTimeout(r, 1)); written = data; },
  });
  assert.ok(written, "writeData 必須被呼叫");
  assert.equal(written.intro, "基準說明", "少了 await 就會拿到 Promise ⇒ intro 會變成預設值");
  assert.ok(written.entries.some((e) => e.title === "主機"), "基準項目必須保留");
  assert.ok(written.entries.some((e) => e.title === "網域" && e.auto === true), "抓到的項目必須寫入且標成 auto");
  assert.deepEqual(result.updated, ["domain:網域"]);
});

test("refreshHousingData 對同步回呼仍然照常運作（sqlite 模式行為不變）", async () => {
  let written = null;
  await refreshHousingData({
    fetchers: [() => [{ category: "domain", title: "網域", amount: 400 }]],
    getData: () => ({ intro: "同步基準", entries: [] }),
    writeData: (data) => { written = data; },
  });
  assert.equal(written.intro, "同步基準");
  assert.equal(written.entries.length, 1);
});

test("非 postgres 必須回退同步路徑（讀磁碟，不讀傳入的 exec）", async () => {
  const disk = new DatabaseSync(diskPath());
  disk.prepare("DELETE FROM settings WHERE key = ?").run(KEY);
  seed(disk, { intro: "磁碟版", entries: [] });
  const exec = pgFixture();
  exec.raw.prepare("DELETE FROM settings WHERE key = ?").run(KEY);
  seed(exec.raw, { intro: "夾具版", entries: [] });

  const a = await site.getHousingDataRawAsync({ driver: "sqlite", exec });
  assert.equal(a.intro, "磁碟版", "sqlite 模式必須讀磁碟");
  assert.equal(JSON.parse(landed(exec.raw)).intro, "夾具版", "sqlite 模式不得改動 PG 夾具");
  disk.close();
});

test("夾具本身要真的拒絕 SQLite 專屬語法", async () => {
  const exec = pgFixture();
  await assert.rejects(() => exec("SELECT IFNULL(value,'') FROM settings"), /function ifnull/);
});
