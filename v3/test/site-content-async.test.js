// 站台內容設定（housingData／spirit）PG 分支的 parity（2026-09-27）。
//
// 背景：`getHousingData`／`saveHousingData`／`getSpirit`／`saveSpirit` 原本只在 db.js（同步
// SQLite），所以後台改「居住數據」「站台精神」只寫進回答你那台節點的本機檔案。
// 實測 `settings.housingData` 在 PG／CasaOS／Synology **三個來源各一版**。
//
// 這個檔最強的一項是**比較實際存進去的位元組**：同樣的輸入，同步版寫進 SQLite 的字串
// 與 PG 分支寫進 PG 的字串必須完全相同。只比回傳值不夠——儲存格式漂了照樣會過。
//
// 另外刻意測兩者**語意不同**的地方（這是最容易寫錯的）：
//   housingData 儲存 = normalizeHousingData(src)                   ← 不與現值合併
//   spirit      儲存 = normalizeSpirit({ ...getSpirit(), ...src }) ← 與公開形狀合併
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-site-content-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const db = await import("../src/db.js");
const {
  getCommsConfigAsync, getCrawlSourcesAsync, getHelpQaAsync, getHousingDataAsync, getSpiritAsync,
  saveCommsConfigAsync, saveCrawlSourcesAsync, saveHelpQaAsync, saveHousingDataAsync, saveSpiritAsync,
} = await import("../src/siteContentAsync.js");

const PG = { driver: "postgres" };

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  mem.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const exec = async (sql, params = []) => mem.prepare(sql).all(...params);
  exec.raw = mem;
  return exec;
}

function storedInPg(exec, key) {
  const row = exec.raw.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : undefined;
}

// `defaultHousingData()` 的 entry id 是 `hd_<Date.now().toString(36)>_<seq>`——**時間基準**，
// 所以「reset 兩邊再比位元組」本質上不可能相同（那是兩次獨立產生的預設值，不是程式不一致）。
// 這一項因此比結構（把 id 拿掉），位元組相等則由下方用固定輸入的測試來保證。
function stripIds(value) {
  if (!value || !Array.isArray(value.entries)) return value;
  return { ...value, entries: value.entries.map(({ id, ...rest }) => rest) };
}

// 測試共用同一個 DATA_DIR 的 SQLite，前面的測試會把值寫進去；
// 要驗「沒有值時回預設」就必須先把鍵清掉，否則同步版讀到的是前一個測試留下的值。
// 把 SQLite 某個鍵的實際位元組搬進 PG 夾具（讀取 parity 用）。
function mirrorSqliteKey(exec, key) {
  const value = storedInSqlite(key);
  if (value === undefined) return;
  exec.raw.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

const asItems = (v) => (Array.isArray(v) ? v : (v?.items || []));

function clearSqliteKey(key) {
  const disk = new DatabaseSync(path.join(dataDir, "v3.db"));
  disk.prepare("DELETE FROM settings WHERE key = ?").run(key);
  disk.close();
}

function storedInSqlite(key) {
  const disk = new DatabaseSync(path.join(dataDir, "v3.db"), { readOnly: true });
  const row = disk.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  disk.close();
  return row ? row.value : undefined;
}

test("housingData：reset 後兩邊的內容結構必須相同（id 為時間基準，不比位元組）", async () => {
  const exec = pgFixture();
  db.saveHousingData({ reset: true });
  await saveHousingDataAsync({ reset: true }, { ...PG, exec });
  const a = JSON.parse(storedInSqlite("housingData"));
  const b = JSON.parse(storedInPg(exec, "housingData"));
  assert.deepEqual(stripIds(b), stripIds(a), "去掉自動產生的 id 之後必須完全相同");
  assert.equal(b.entries.length, a.entries.length, "entry 數量必須相同");
});

test("housingData：只改 intro 的區域更新，兩邊位元組必須相同（會踩到「不合併」的語意）", async () => {
  const exec = pgFixture();
  // ⚠️ patch 一定要**只改一部分**。第一版用 { entries:[...] } 直接覆蓋 entries，
  // 於是「與現值合併」和「不合併」結果一樣 → 把 housingData 改成 spirit 的合併寫法也照樣通過（空測試）。
  // 只改 intro 時：不合併 → entries 變空；合併 → 保留現有 entries。這樣才分得出來。
  const seed = { entries: [{ id: "x1", category: "population", title: "T", value: "V" }] };
  db.saveHousingData(seed);
  await saveHousingDataAsync(seed, { ...PG, exec });
  const patch = { intro: "只改這段" };
  db.saveHousingData(patch);
  await saveHousingDataAsync(patch, { ...PG, exec });
  assert.equal(storedInPg(exec, "housingData"), storedInSqlite("housingData"));
  // 註：housingData 的語意是**不合併**，所以只給 intro 時 entries 會變空——這是正確行為。
  // 判準是「兩邊位元組相同」；若 PG 分支誤用合併寫法，entries 會被保留而與同步版不同。
});

test("spirit：儲存時要與「公開形狀」合併——從非預設狀態才驗得出來", async () => {
  const exec = pgFixture();
  // ⚠️ normalizeSpirit() 缺的欄位會回預設，所以若現值本身就是預設值，
  // 「合併」與「不合併」結果相同 → 第一版就是這樣變成空測試的。
  // 必須先存一個**非預設**的 body，再只改 title，差異才會顯現。
  const seed = { title: "標題A", body: "內文B（非預設）" };
  db.saveSpirit(seed);
  await saveSpiritAsync(seed, { ...PG, exec });
  assert.equal(storedInPg(exec, "spirit"), storedInSqlite("spirit"), "seed 後必須一致");

  const patch = { title: "標題C" };
  db.saveSpirit(patch);
  await saveSpiritAsync(patch, { ...PG, exec });
  assert.equal(
    storedInPg(exec, "spirit"),
    storedInSqlite("spirit"),
    "只改 title 後必須一致——若 PG 分支沒有先合併公開形狀，body 會被打回預設，這裡就會抓到",
  );
  assert.equal(JSON.parse(storedInSqlite("spirit")).body, "內文B（非預設）", "未提到的欄位必須保留");
});

test("讀取：PG 沒有這個鍵時要回預設值（與同步版一致）", async () => {
  clearSqliteKey("housingData");
  clearSqliteKey("spirit");
  const exec = pgFixture();
  assert.deepEqual(
    stripIds(await getHousingDataAsync({ ...PG, exec })),
    stripIds(db.getHousingData()),
    "PG 沒有鍵時應回預設值；id 為時間基準，比結構",
  );
  assert.deepEqual(await getSpiritAsync({ ...PG, exec }), db.getSpirit());
});

test("非 postgres driver 走同步分支，不得動用注入的 PG exec", async () => {
  let used = 0;
  const exec = async () => { used += 1; return []; };
  await getHousingDataAsync({ driver: "sqlite", exec });
  await getSpiritAsync({ driver: "sqlite", exec });
  await saveHousingDataAsync({ reset: true }, { driver: "sqlite", exec });
  assert.equal(used, 0, "driver=sqlite 時不得碰 PG exec");
});

test("helpQa：寫入的位元組必須與同步版相同（含 item 正規化）", async () => {
  const exec = pgFixture();
  const patch = { items: [{ id: "q1", q: "問題？", a: "答案。" }] };
  db.saveHelpQa(patch);
  await saveHelpQaAsync(patch, { ...PG, exec });
  assert.equal(storedInPg(exec, "helpQa"), storedInSqlite("helpQa"));
});

test("helpQa：reset 後兩邊結構相同（id 可能由時間產生）", async () => {
  const exec = pgFixture();
  db.saveHelpQa({ reset: true });
  await saveHelpQaAsync({ reset: true }, { ...PG, exec });
  const a = JSON.parse(storedInSqlite("helpQa"));
  const b = JSON.parse(storedInPg(exec, "helpQa"));
  assert.equal(b.items.length, a.items.length, "預設題數必須相同");
});

test("crawlSources：只切換 enabled 時，不得洗掉其他欄位（同步版的合併語意）", async () => {
  const exec = pgFixture();
  // 先讓兩邊都有完整清單
  db.saveCrawlSources({ items: [] });
  await saveCrawlSourcesAsync({ items: [] }, { ...PG, exec });
  // 注意：saveCrawlSources 存進 settings 的是**陣列**（normalizeCrawlSources 的回傳），
  // 不是 { items }；{ items } 是 publicCrawlSources 對外的包裝。測試要兩種都容許。
  const beforeItems = asItems(JSON.parse(storedInSqlite("crawlSources")));
  const firstId = beforeItems[0]?.id;
  assert.ok(firstId, "預設清單應該有來源");

  // 只送「某一個 id 的 enabled」——這是後台切開關的形狀
  const patch = { items: [{ id: firstId, enabled: false }] };
  db.saveCrawlSources(patch);
  await saveCrawlSourcesAsync(patch, { ...PG, exec });
  assert.equal(storedInPg(exec, "crawlSources"), storedInSqlite("crawlSources"), "位元組必須相同");

  const afterItems = asItems(JSON.parse(storedInSqlite("crawlSources")));
  const row = afterItems.find((r) => r.id === firstId);
  assert.equal(row.enabled, false, "被指定的來源要關掉");
  assert.equal(afterItems.length, beforeItems.length, "其他來源不得被洗掉");
});

test("crawlSources：把 SQLite 的位元組鏡射進 PG 後，讀取結果必須相同", async () => {
  // ⚠️ 不能用「全新的 PG 夾具」比——SQLite 已經被前面的測試改過，
  // 兩邊起點不同，比出來一定不同（第一版就是這樣誤判）。
  // 正確做法：把 SQLite 實際存的位元組搬進 PG，再比讀取。
  const exec = pgFixture();
  mirrorSqliteKey(exec, "crawlSources");
  assert.deepEqual(await getCrawlSourcesAsync({ ...PG, exec }), db.getCrawlSources());
});

test("commsConfig：區域更新後兩邊位元組必須相同（儲存語意是與現值合併）", async () => {
  const exec = pgFixture();
  // ⚠️ 必須用**真實欄位名**。第一版用了 sponsor.intro／sponsor.outro——那兩個不是欄位，
  // normalizeCommsConfig() 會把它們丢掉、兩邊都變回預設值，於是「合併 vs 不合併」比不出差異（空測試）。
  // 真實欄位見 emptyCommsConfig()：support_copy、support_card_enabled 等。
  const seed = { support_copy: "這段是自訂的贊助說明（非預設）" };
  db.saveCommsConfig(seed);
  await saveCommsConfigAsync(seed, { ...PG, exec });
  assert.equal(storedInPg(exec, "commsConfig"), storedInSqlite("commsConfig"), "seed 後必須一致");

  const patch = { support_card_enabled: true };
  db.saveCommsConfig(patch);
  await saveCommsConfigAsync(patch, { ...PG, exec });
  assert.equal(storedInPg(exec, "commsConfig"), storedInSqlite("commsConfig"), "區域更新後必須一致");
  assert.equal(
    JSON.parse(storedInSqlite("commsConfig")).support_copy,
    "這段是自訂的贊助說明（非預設）",
    "patch 沒提到的欄位必須保留——若 PG 分支沒有先合併現值，這裡會抓到",
  );
});

test("commsConfig：PG 沒有這個鍵時要回預設（與同步版一致）", async () => {
  clearSqliteKey("commsConfig");
  const exec = pgFixture();
  assert.deepEqual(await getCommsConfigAsync({ ...PG, exec }), db.getCommsConfig());
});
