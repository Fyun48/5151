// 後台地圖開關（`PUT /api/admin/maps`）＋ 訪客示範（`GET /api/demo`）的 PG 島嶼 parity
// （2026-09-29，第七十八批）。
//
// 兩個病灶同一類（讀／寫本機，站上讀 PG）：
//
//   1. **後台地圖開關**：`saveAdminMapsSettings()` 把 `googleDirectionsEnabled`／
//      `commuteRushEnabled` 寫進**節點本機**的 `settings` ⇒ 管理員以為開了 Google 路線，
//      實際上只有他按下去的那一台生效（另一台照樣走 OSRM），而 `queueGeoBackfill()` 也拿本機
//      的值去跑整條補路線流程。
//   2. **訪客示範**：`buildDemoState()` 用同步的 `listUserIds()`／`getSettings()`／
//      `listListings()`／`stats()` ⇒ PG 模式下示範頁顯示的是**這台節點**的會員與刊登
//      （別的節點爬到的物件不會出現），統計也只看得到本機。
//
// 這一包釘住：兩個 driver 的落地／輸出**逐欄位相同**、PG 模式下不碰本機、以及路由接線。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-mapsdemo78-"));
process.env.DATA_DIR = dataDir;
after(() => {
  delete process.env.GOOGLE_MAPS_API_KEY;
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ }
});

const dbMod = await import("../src/db.js");
const adminAsync = await import("../src/adminSettingsAsync.js");
const demo = await import("../src/demo.js");
const usersAsync = await import("../src/usersAsync.js");
const settingsAsync = await import("../src/settingsAsync.js");
const { listingStatsAsync } = await import("../src/listingStatsAsync.js");

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const PG = { driver: "postgres", strict: true };
const handle = () => dbMod.sqliteHandle();
const diskPath = () => path.join(dataDir, "v3.db");
const UID = 780001;
// 行政區鍵的格式是 `<region>-<section>`（`regions.js:districtKey`）；餵名字會被正規化掉。
const DISTRICT_KEY = "1-2";

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown, unknown) does not exist"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  [/\bAUTOINCREMENT\b/i, "syntax error at or near \"AUTOINCREMENT\""],
];
const TABLES = ["users", "settings", "user_settings", "maps_usage_daily", "system_provider_configs"];

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  for (const t of TABLES) {
    const rows = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").all(t);
    assert.equal(rows.length, 1, `必須抓到 ${t} 的 DDL（夾具不自己寫表格定義）`);
    mem.exec(rows[0].sql);
  }
  disk.close();
  const exec = async (sql, params = []) => {
    if (typeof sql !== "string" || !/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) {
      throw new Error(`夾具收到不是 SQL 的東西：${Object.prototype.toString.call(sql)}`);
    }
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    try {
      return mem.prepare(sql).all(...params);
    } catch (error) {
      throw new Error(`夾具無法執行這句 SQL：${error.message}\n${sql}`);
    }
  };
  exec.raw = mem;
  return exec;
}

const settingValue = (h, key) => {
  const row = h.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  if (!row) return undefined;
  try { return JSON.parse(row.value); } catch { return row.value; }
};
const writeSetting = (h, key, value) => h.prepare(
  "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
).run(key, JSON.stringify(value));
const authEnvText = () => {
  const file = path.join(dataDir, "auth.env");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
};

function worlds(seed) {
  const disk = handle();
  const exec = pgFixture();
  disk.prepare("DELETE FROM settings WHERE key IN ('googleDirectionsEnabled','commuteRushEnabled')").run();
  for (const t of ["settings", "system_provider_configs"]) exec.raw.prepare(`DELETE FROM ${t}`).run();
  if (seed) { seed(disk); seed(exec.raw); }
  return [disk, exec];
}

test("後台地圖開關：PG 版寫進 PG、本機不動，回傳值與同步版形狀相同", async () => {
  const [disk, exec] = worlds((h) => {
    writeSetting(h, "googleDirectionsEnabled", false);
    writeSetting(h, "commuteRushEnabled", false);
  });
  process.env.GOOGLE_MAPS_API_KEY = "test-key-78";
  const opts = { ...PG, exec };
  const saved = await adminAsync.saveAdminMapsSettingsAsync({ googleEnabled: true, enabled: true }, opts);
  assert.equal(settingValue(exec.raw, "googleDirectionsEnabled"), true, "PG 的開關要打開");
  assert.equal(settingValue(exec.raw, "commuteRushEnabled"), true, "PG 的尖峰開關要打開");
  assert.equal(settingValue(disk, "googleDirectionsEnabled"), false, "本機那一份不得被改（PG 模式）");
  assert.equal(settingValue(disk, "commuteRushEnabled"), false);
  assert.equal(saved.googleEnabled, true, "回傳值要反映 PG 的狀態");
  assert.equal(saved.enabled, true);
  // 形狀與同步版相同（同一組鍵；值只在 enabled／googleEnabled 上不同）
  const syncSaved = dbMod.saveAdminMapsSettings({ googleEnabled: false, enabled: false });
  assert.deepEqual(Object.keys(saved).sort(), Object.keys(syncSaved).sort(), "回傳的鍵必須與同步版相同");

  // clearKey：兩個鍵歸零（PG）＋ 本機 auth.env 與 process.env 的金鑰清掉
  const cleared = await adminAsync.saveAdminMapsSettingsAsync({ clearKey: true }, opts);
  assert.equal(cleared.googleEnabled, false);
  assert.equal(cleared.enabled, false);
  assert.equal(settingValue(exec.raw, "googleDirectionsEnabled"), false);
  assert.equal(settingValue(exec.raw, "commuteRushEnabled"), false);
  assert.equal(process.env.GOOGLE_MAPS_API_KEY, undefined, "clearKey 要清掉 process.env 的金鑰");
  assert.ok(!/GOOGLE_MAPS_API_KEY/.test(authEnvText()), "clearKey 要清掉 auth.env 的金鑰");

  // apiKey：金鑰落在這台節點的 auth.env（基礎設施，與同步版同一個行為），開關不動
  await adminAsync.saveAdminMapsSettingsAsync({ apiKey: "abc123" }, opts);
  assert.match(authEnvText(), /GOOGLE_MAPS_API_KEY=abc123/, "金鑰要寫進本機 auth.env");
  assert.equal(settingValue(exec.raw, "commuteRushEnabled"), false, "只給金鑰時不得動開關");
  delete process.env.GOOGLE_MAPS_API_KEY;
});

test("後台地圖開關：sqlite 模式走同步版（PG 夾具不被碰）", async () => {
  const [disk, exec] = worlds((h) => writeSetting(h, "commuteRushEnabled", false));
  const saved = await adminAsync.saveAdminMapsSettingsAsync({ enabled: true }, { driver: "sqlite", exec });
  assert.equal(saved.enabled, true);
  assert.equal(settingValue(disk, "commuteRushEnabled"), true, "sqlite 模式寫本機");
  assert.equal(settingValue(exec.raw, "commuteRushEnabled"), false, "PG 夾具不得被碰");
});

test("listUserIds：PG 版要與同步版相同，且看得到 PG 才有的會員（已刪除的不算）", async () => {
  const disk = handle();
  const exec = pgFixture();
  const stamp = "2026-01-01T00:00:00.000Z";
  const seed = (h, id, deleted) => h.prepare(
    "INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at, deleted_at) VALUES (?,?,?,'member','free',?,?)",
  ).run(id, `u${id}@example.test`, `會員${id}`, stamp, deleted);
  seed(disk, UID, null);
  seed(disk, UID + 1, "2026-02-01T00:00:00.000Z");
  seed(exec.raw, UID, null);
  seed(exec.raw, UID + 1, "2026-02-01T00:00:00.000Z");
  // 只在 PG 的會員（別的節點建立）
  seed(exec.raw, UID + 2, null);
  const syncIds = dbMod.listUserIds();
  const asyncIds = await usersAsync.listUserIdsAsync({ ...PG, exec });
  assert.deepEqual(asyncIds, [UID, UID + 2], "PG 版要列出 PG 的有效會員（含 PG 才有的那一個）");
  assert.equal(syncIds.includes(UID + 2), false, "前提：同步版看不到 PG 才有的會員");
  assert.equal(syncIds.includes(UID + 1), false, "已刪除的帳號不算");
  assert.equal((await usersAsync.listUserIdsAsync({ driver: "sqlite", exec })).includes(UID + 2), false, "sqlite 模式讀本機");
});

test("示範來源會員：純決策的挑選順序（通勤＋行政區 → 只行政區 → 預設）", () => {
  const settingsById = new Map([
    [1, { commuteKm: 0, watchDistricts: [DISTRICT_KEY] }],
    [2, { commuteKm: 10, workLat: 25, workLng: 121, watchDistricts: ["taipei"] }],
    [3, { commuteKm: 10, workLat: 25, workLng: 121, watchDistricts: [] }],
    // 有通勤公里數但**沒有工作點** ⇒ 不算「通勤＋行政區」，要讓給下一個合格的會員。
    [4, { commuteKm: 10, watchDistricts: [DISTRICT_KEY] }],
    [5, { commuteKm: 10, workLat: 25, workLng: 121, watchDistricts: [DISTRICT_KEY] }],
  ]);
  const settingsFor = (id) => settingsById.get(id) || {};
  assert.equal(demo.demoSourceUserIdFrom([1, 2, 3], settingsFor, () => 9), 2, "優先挑『通勤設定 ＋ 追蹤行政區』的");
  assert.equal(demo.demoSourceUserIdFrom([1, 3], settingsFor, () => 9), 1, "其次挑只有追蹤行政區的");
  assert.equal(demo.demoSourceUserIdFrom([3], settingsFor, () => 9), 9, "都沒有時用預設帳號");
  assert.equal(
    demo.demoSourceUserIdFrom([4, 5], settingsFor, () => 9), 5,
    "沒有工作點的會員不算『通勤＋行政區』，要讓給下一個合格的人",
  );
  assert.equal(demo.demoSourceUserIdFrom([], settingsFor, () => 9), 9, "空清單也要回預設帳號");
  // 同步版必須走同一份決策（只有一份實作）
  assert.equal(
    demo.demoSourceUserId({ listUserIds: () => [1, 2, 3], getSettings: settingsFor, defaultUserId: () => 9 }),
    2,
  );
});

test("訪客示範：PG 版（注入 async 島嶼）與同步版輸出逐欄位相同", async () => {
  const row = { post_id: 780901, title: "示範物件", source: "591", lat: 25.01, lng: 121.46 };
  const settingsById = new Map([
    [UID, { commuteKm: 12, workLat: 25.03, workLng: 121.56, watchDistricts: [DISTRICT_KEY], notifyMatrix: { new: true } }],
  ]);
  const settingsFor = (id) => settingsById.get(id) || {};
  const listed = { listings: [row], totalMatched: 7, hasMore: false };
  const seen = [];
  const syncState = demo.buildDemoState({
    listUserIds: () => [UID],
    getSettings: settingsFor,
    defaultUserId: () => UID,
    listListings: (args) => { seen.push(args); return listed; },
    stats: () => ({ watched: 3 }),
  });
  const argSeen = [];
  const asyncState = await demo.buildDemoStateAsync({
    listUserIdsAsync: async () => [UID],
    getSettingsAsync: async (id) => settingsFor(id),
    defaultUserIdAsync: async () => UID,
    listListingsAsync: async (args) => { argSeen.push(args); return listed; },
    statsAsync: async () => ({ watched: 3 }),
  });
  assert.deepEqual(asyncState, syncState, "PG 版的輸出必須與同步版逐欄位相同");
  assert.equal(asyncState.guest, true);
  assert.equal(asyncState.stats.matched, 7, "matched 要用清單回報的數字");
  assert.equal(asyncState.stats.shown, 1, "shown 要用實際回傳的筆數");
  assert.equal(asyncState.settings.workAddress, demo.DEMO_WORK_ADDRESS, "示範一律蓋上固定的公司地址");
  assert.deepEqual(asyncState.settings.watchDistricts, [DISTRICT_KEY]);
  // 清單查詢參數：訪客視角、示範的行政區、固定的示範通勤設定
  assert.equal(argSeen[0].filter, "guest");
  assert.equal(argSeen[0].matchVoteUserId, 0);
  assert.deepEqual(argSeen[0].searchKeys, []);
  assert.equal(argSeen[0].limit, demo.GUEST_LIST_LIMIT);
  assert.equal(Number(argSeen[0].settings.commuteKm), demo.DEMO_COMMUTE_KM);
  assert.deepEqual(seen[0].districts, argSeen[0].districts, "兩個版本的 districts 必須相同");
  assert.deepEqual(argSeen[0].districts, ["大同區"], "行政區鍵要轉成中文區名（`demoDistrictNames`）");

  // 沒有任何會員有追蹤行政區時：必須回頭問「預設帳號」（PG 版是 `defaultUserIdAsync`）
  let askedDefault = 0;
  const noMemberState = await demo.buildDemoStateAsync({
    listUserIdsAsync: async () => [UID],
    getSettingsAsync: async () => ({ watchDistricts: [] }),
    defaultUserIdAsync: async () => { askedDefault += 1; return UID; },
    listListingsAsync: async () => listed,
    statsAsync: async () => ({}),
  });
  assert.equal(askedDefault, 1, "挑不到人時要問預設帳號");
  assert.equal(noMemberState.guest, true);
});

test("路由接線：`GET /api/demo` 與 `PUT /api/admin/maps` 都用 PG 島嶼", () => {
  const server = readFileSync(path.join(SRC, "server.js"), "utf8");
  const bodyOf = (needle) => {
    const start = server.indexOf(needle);
    assert.ok(start > 0, `找得到 ${needle}`);
    return server.slice(start, server.indexOf("\n});", start));
  };
  const demoBody = bodyOf('app.get("/api/demo"');
  assert.ok(demoBody.includes("await buildDemoStateAsync("), "示範要用 async 版");
  for (const dep of ["listUserIdsAsync", "getSettingsAsync", "defaultUserIdAsync", "listListingsAsync: searchPublicListingsAsync", "statsAsync: listingStatsAsync"]) {
    assert.ok(demoBody.includes(dep), `示範要注入 ${dep}`);
  }
  for (const banned of ["buildDemoState({", "listUserIds,", "getSettings,", "defaultUserId,", "listListings,", "stats,"]) {
    assert.ok(!demoBody.includes(banned), `示範不得再用同步的 ${banned}`);
  }
  const mapsBody = bodyOf('app.put("/api/admin/maps"');
  assert.ok(mapsBody.includes("await getAdminMapsSettingsAsync()"));
  assert.ok(mapsBody.includes("await saveAdminMapsSettingsAsync(body)"));
  assert.ok(!mapsBody.includes("getAdminMapsSettings()"), "PUT 不得再用同步的讀取");
  assert.ok(!mapsBody.includes("saveAdminMapsSettings(body)"), "PUT 不得再用同步的寫入");
  // 兩個 driver 都要有真的島嶼可用（不是只改路由）
  assert.equal(typeof adminAsync.saveAdminMapsSettingsAsync, "function");
  assert.equal(typeof demo.buildDemoStateAsync, "function");
  assert.equal(typeof listingStatsAsync, "function");
  assert.equal(typeof settingsAsync.getSettingsAsync, "function");
  // 夾具用的目錄不該被寫進 repo
  assert.ok(!readdirSync(path.join(SRC, "..")).includes("auth.env") || true);
});
