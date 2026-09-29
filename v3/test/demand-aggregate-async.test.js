// 需求統計（`GET /api/demand/aggregate`）與首頁需求曝險（`GET /api/demand/exposure`）的 PG 島嶼 parity
// （2026-09-29，第七十九批）。
//
// 這兩條是純讀取，但同步版整條讀的是節點本機的 `demand_posts`：PG 模式下許願房早就寫在 PG
// （第六十五批起），統計卻從本機撈 ⇒
//
//   - 訪客看到的「需求熱區」是**這台節點**的樣本（別的節點收到的心願完全不算）；
//   - 樣本數不足時還會誤判成「需求樣本不足」（`suppressed`）。
//
// 這一包釘住：兩個 driver 的輸出**逐欄位相同**、把列只放進 PG 時 PG 版照樣算得出來（同步版是
// 「樣本不足」）、錯誤形狀（400 `aggregate_filter`／404 `owner_matching_disabled`）一致、
// 以及路由接線。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-demandagg79-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ } });

const dbMod = await import("../src/db.js");
const aggAsync = await import("../src/demandAggregateAsync.js");
const matchQ = await import("../src/rentalMatchQuery.js");
const matchCore = await import("../src/rentalMatch.js");
const demand = await import("../src/demand.js");

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const PG = { driver: "postgres", strict: true };
const handle = () => dbMod.sqliteHandle();
const diskPath = () => path.join(dataDir, "v3.db");
const CITY = "1";           // 台北市（`regions.js` 的 region id）
const DISTRICTS = ["1-2", "1-8", "1-9"];
// ⚠️ 同步的 `createDemandPost()` 限制「一個人同時只能有一則公開許願房」⇒ 一則樣本一個帳號
// （五筆樣本才過得了 `AGGREGATE_PRIVACY_THRESHOLD = 3`，也才測得到分組）。
const USERS = [790001, 790002, 790003, 790004, 790005];

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown, unknown) does not exist"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  [/\bAUTOINCREMENT\b/i, "syntax error at or near \"AUTOINCREMENT\""],
];
// `demand_match_districts` 是 `expireOpenPostsAsync()`（PG 分支）會清的表；
// `demand_replies` 是島嶼回讀整則許願房時會拉的（`hydrateForRows`）⇒ 夾具都要有。
const TABLES = ["users", "settings", "demand_posts", "demand_match_districts", "demand_replies", "user_listing_flags"];

function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  for (const t of TABLES) {
    const rows = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").all(t);
    assert.equal(rows.length, 1, `必須抓到 ${t} 的 DDL（夾具不自己寫表格定義）`);
    mem.exec(rows[0].sql);
  }
  const copy = (table) => {
    const cols = disk.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const rows = disk.prepare(`SELECT * FROM ${table}`).all();
    const insert = mem.prepare(`INSERT INTO ${table}(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
    for (const row of rows) insert.run(...cols.map((c) => row[c]));
    return rows.length;
  };
  // ⚠️ 順序有意義：`demand_posts` 有 FK 到 `users`（先複製 parent，不然夾具會 FK 失敗）。
  for (const t of ["users", "settings", "demand_posts", "demand_match_districts", "demand_replies", "user_listing_flags"]) copy(t);
  disk.close();
  const exec = async (sql, params = []) => {
    if (typeof sql !== "string" || !/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) {
      throw new Error(`夾具收到不是 SQL 的東西：${Object.prototype.toString.call(sql)}`);
    }
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    // ⚠️ 這一組島嶼（`rentalCatalogAsync`／`settingsKvAsync`／`demandAsync`）的注入式 exec 吃**純陣列**。
    try {
      return mem.prepare(sql).all(...params);
    } catch (error) {
      throw new Error(`夾具無法執行這句 SQL：${error.message}\n${sql}`);
    }
  };
  exec.raw = mem;
  return exec;
}

const errorShape = async (fn) => {
  try { await fn(); return null; } catch (error) { return { status: error.status, code: error.code || "", message: error.message }; }
};
const syncErrorShape = (fn) => {
  try { fn(); return null; } catch (error) { return { status: error.status, code: error.code || "", message: error.message }; }
};
const plain = (value) => JSON.parse(JSON.stringify(value));

/** 用應用自己的寫入路徑種許願房（列一定合法），再把列複製進 PG 替身。 */
function seedWishes() {
  const h = handle();
  h.prepare("DELETE FROM demand_posts").run();
  for (const uid of USERS) {
    h.prepare("INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?,'member','free',?)")
      .run(uid, `agg${uid}@example.test`, `會員${uid}`, "2026-01-01T00:00:00.000Z");
  }
  // 屋主配對要開，否則 `assertMatchingEnabled()` 會丟 404。
  dbMod.saveRentalMarketplaceFlags({ wish: { owner_matching_enabled: true } });
  const specs = [
    { districts: [DISTRICTS[0]], rent_max: 25000, layout: 2, housing_type: "apartment" },
    { districts: [DISTRICTS[0]], rent_max: 28000, layout: 2, housing_type: "apartment" },
    { districts: [DISTRICTS[1]], rent_max: 32000, layout: 3, housing_type: "suite" },
    { districts: [DISTRICTS[1], DISTRICTS[2]], rent_max: 45000, layout: 4, housing_type: "apartment" },
    { districts: [DISTRICTS[2]], rent_max: 18000, layout: 1, housing_type: "suite" },
  ];
  specs.forEach((spec, index) => {
    // 用 `demand.js` 的同步寫入（`db.js` 沒有再匯出這一支）：列一定合法。
    demand.createDemandPost(h, USERS[index % USERS.length], { ...spec, body: `需求內容 ${index}` }, new Date(), { maturity: true });
  });
  return h.prepare("SELECT COUNT(*) AS n FROM demand_posts WHERE status = 'open'").get().n;
}

test("需求統計：兩個 driver 逐欄位相同；列只在 PG 時同步版是「樣本不足」", async () => {
  const open = seedWishes();
  assert.ok(open >= 5, `前提：要種出足夠的樣本（實際 ${open}）`);
  const exec = pgFixture();
  const opts = { ...PG, exec };
  // 先讓兩個 store 的設定一致（本機的 flags 已由 saveRentalMarketplaceFlags 寫好，複製進 PG）
  assert.ok(
    exec.raw.prepare("SELECT COUNT(*) AS n FROM settings").get().n >= 1,
    "前提：PG 夾具要有站台設定（含 marketplace flags）",
  );
  // 本機的同步基準需要先補水（正式路徑由啟動時的 hydrate 負責）
  dbMod.getWishConditions();
  const sync = plain(dbMod.aggregateDemand({}));
  const async_ = plain(await aggAsync.aggregateDemandAsync({}, opts));
  assert.deepEqual(async_, sync, "兩個 driver 的統計必須逐欄位相同");
  assert.equal(async_.enabled, true);
  assert.equal(async_.suppressed, false, "五筆樣本應該過得了隱私門檻");
  assert.ok(async_.districts.length >= 1, "要有行政區分組");
  assert.ok(async_.budget_bands.length >= 1, "要有預算分組");

  // 把列**只留在 PG**：同步版看不到 → 樣本不足；PG 版照樣算得出來（這就是被修掉的行為）
  handle().prepare("DELETE FROM demand_posts").run();
  const syncAfter = plain(dbMod.aggregateDemand({}));
  const asyncAfter = plain(await aggAsync.aggregateDemandAsync({}, opts));
  assert.equal(syncAfter.suppressed, true, "前提：同步版讀本機 ⇒ 樣本不足");
  assert.equal(syncAfter.total, 0);
  assert.equal(asyncAfter.suppressed, false, "PG 版要看得到 PG 的樣本");
  assert.deepEqual(asyncAfter, async_, "PG 版在列只存在 PG 時必須與先前完全相同");
});

test("需求統計：篩選與錯誤形狀都與同步版相同", async () => {
  seedWishes();
  const exec = pgFixture();
  const opts = { ...PG, exec };
  dbMod.getWishConditions();
  const cases = [
    [{ districts: [DISTRICTS[0]] }, "行政區"],
    [{ city: CITY }, "城市"],
    [{ rent_min: 20000, rent_max: 30000 }, "租金區間"],
    [{ layout: "2" }, "格局"],
    [{ housing_type: "apartment" }, "類型"],
  ];
  for (const [query, why] of cases) {
    const sync = plain(dbMod.aggregateDemand(query));
    const async_ = plain(await aggAsync.aggregateDemandAsync(query, opts));
    assert.deepEqual(async_, sync, `${why} 篩選的結果必須相同`);
  }
  // 不可用的條件 → 400 aggregate_filter（訊息與 code 都要一樣）
  const bad = { conditions: ["no-such-condition"] };
  const syncErr = syncErrorShape(() => dbMod.aggregateDemand(bad));
  const asyncErr = await errorShape(() => aggAsync.aggregateDemandAsync(bad, opts));
  assert.equal(syncErr?.status, 400, "前提：同步版擋下不可用的條件");
  assert.deepEqual(asyncErr, syncErr, "錯誤形狀必須與同步版相同");
  assert.equal(asyncErr?.code, "aggregate_filter");
});

test("需求統計：屋主配對關閉時，兩個 driver 都是 404 owner_matching_disabled", async () => {
  seedWishes();
  const exec = pgFixture();
  // 兩邊都把開關關掉（PG 那一份走島嶼自己的寫入，模擬別的節點關掉）
  dbMod.saveRentalMarketplaceFlags({ wish: { owner_matching_enabled: false } });
  const catalogAsync = await import("../src/rentalCatalogAsync.js");
  await catalogAsync.saveRentalMarketplaceFlagsAsync({ wish: { owner_matching_enabled: false } }, { ...PG, exec });
  const syncErr = syncErrorShape(() => dbMod.aggregateDemand({}));
  const asyncErr = await errorShape(() => aggAsync.aggregateDemandAsync({}, { ...PG, exec }));
  assert.equal(syncErr?.status, 404, "前提：同步版在配對關閉時是 404");
  assert.equal(syncErr?.code, "owner_matching_disabled");
  assert.equal(asyncErr?.status, 404, "PG 版也要是 404（不是回一筆空統計）");
  assert.equal(asyncErr?.code, "owner_matching_disabled");
  assert.equal(asyncErr?.message, syncErr?.message, "訊息要逐字相同");

  // (b) **只有 PG 關**（直接改 PG 的設定列，不動行程內快取）：PG 版必須自己去向 PG 補水才會看到；
  //     本機仍開著 ⇒ 同步版照樣算得出來。這一格是「有沒有補水」的鑑別力來源。
  dbMod.saveRentalMarketplaceFlags({ wish: { owner_matching_enabled: true } });
  exec.raw.prepare(
    "UPDATE settings SET value = ? WHERE key = 'rentalMarketplaceFlags'",
  ).run(JSON.stringify({ wish: { owner_matching_enabled: false } }));
  assert.ok(dbMod.aggregateDemand({}).enabled === true, "前提：本機還開著 ⇒ 同步版算得出來");
  const pgOnlyErr = await errorShape(() => aggAsync.aggregateDemandAsync({}, { ...PG, exec }));
  assert.equal(pgOnlyErr?.status, 404, "PG 版要讀 PG 的開關（別台節點關掉就該 404）");
  assert.equal(pgOnlyErr?.code, "owner_matching_disabled");
});

test("首頁需求曝險：兩個 driver 相同；列只在 PG 時同步版是空的", async () => {
  seedWishes();
  const exec = pgFixture();
  const opts = { ...PG, exec };
  dbMod.getWishConditions();
  const sync = plain(dbMod.homepageDemandExposure());
  const async_ = plain(await aggAsync.homepageDemandExposureAsync(opts));
  assert.deepEqual(async_, sync, "首頁曝險必須逐欄位相同");
  assert.equal(async_.enabled, true);
  assert.ok(async_.districts.length >= 1, "要有曝險的行政區");
  assert.ok(async_.districts.length <= 6, "最多六個行政區（與同步版相同）");
  // 列只留在 PG
  handle().prepare("DELETE FROM demand_posts").run();
  const syncAfter = plain(dbMod.homepageDemandExposure());
  const asyncAfter = plain(await aggAsync.homepageDemandExposureAsync(opts));
  assert.equal(syncAfter.suppressed, true, "前提：同步版讀本機 ⇒ 樣本不足");
  assert.deepEqual(asyncAfter, async_, "PG 版不受本機有沒有列影響");

  // 配對關閉時：兩個 driver 都是 `{ enabled: false, districts: [] }`
  dbMod.saveRentalMarketplaceFlags({ wish: { owner_matching_enabled: false } });
  const catalogAsync = await import("../src/rentalCatalogAsync.js");
  await catalogAsync.saveRentalMarketplaceFlagsAsync({ wish: { owner_matching_enabled: false } }, opts);
  assert.deepEqual(
    plain(await aggAsync.homepageDemandExposureAsync(opts)),
    plain(dbMod.homepageDemandExposure()),
    "配對關閉時的曝險回應必須與同步版相同",
  );
  assert.equal((await aggAsync.homepageDemandExposureAsync(opts)).enabled, false);
});

test("fail-open／sqlite 模式：讀取失敗才回退，sqlite 模式不碰注入的 exec", async () => {
  seedWishes();
  dbMod.getWishConditions();
  const boom = async () => { throw new Error("ECONNREFUSED 127.0.0.1:5432"); };
  await assert.rejects(
    () => aggAsync.aggregateDemandAsync({}, { ...PG, exec: boom }),
    /ECONNREFUSED/, "strict 時要往上丟",
  );
  const fallen = plain(await aggAsync.aggregateDemandAsync({}, { driver: "postgres", exec: boom }));
  assert.deepEqual(fallen, plain(dbMod.aggregateDemand({})), "預設模式（讀取）允許回退同步版");

  let calls = 0;
  const spy = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  const lite = plain(await aggAsync.aggregateDemandAsync({}, { driver: "sqlite", exec: spy }));
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
  assert.deepEqual(lite, plain(dbMod.aggregateDemand({})), "sqlite 模式走同步路徑");
});

test("新建許願房要維護 PG 的行政區索引（帶行政區的統計才查得到它）", async () => {
  seedWishes();
  const NEW_UID = 790006;
  handle().prepare("INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?,'member','free',?)")
    .run(NEW_UID, `agg${NEW_UID}@example.test`, "索引測試", "2026-01-01T00:00:00.000Z");
  const exec = pgFixture();
  const opts = { ...PG, exec };
  const demandAsyncMod = await import("../src/demandAsync.js");

  // 1) 寫入路徑要維護索引：新建一則公開許願房 → PG 的索引要立刻有它
  const created = await demandAsyncMod.createDemandAsync(
    NEW_UID,
    { districts: [DISTRICTS[0]], rent_max: 26000, layout: 2, housing_type: "apartment", body: "索引測試用的需求內容" },
    opts,
  );
  assert.ok(created?.id, "前提：島嶼的建立路徑要成功");
  assert.deepEqual(
    exec.raw.prepare("SELECT district FROM demand_match_districts WHERE wish_id = ?").all(created.id).map((row) => row.district),
    [DISTRICTS[0]],
    "寫入路徑必須維護 PG 的行政區索引",
  );
  // 種子（2 筆在 DISTRICTS[0]）＋ 新建的 1 筆 = 3 筆 ⇒ 過得了隱私門檻
  const agg = plain(await aggAsync.aggregateDemandAsync({ districts: [DISTRICTS[0]] }, opts));
  assert.equal(agg.total, 3, `帶行政區的統計要查得到那三筆（實際 ${agg.total}）`);
  assert.ok(
    agg.districts.some((row) => row.id === DISTRICTS[0] && row.count === 3),
    "分組也要算得出來（不是被隱私門檻收進『其他』）",
  );

  // 2) 索引為空（舊資料沒有索引列）⇒ 讀取路徑要懶重建，統計不能回 0
  exec.raw.prepare("DELETE FROM demand_match_districts").run();
  const rebuilt = plain(await aggAsync.aggregateDemandAsync({ districts: [DISTRICTS[0]] }, opts));
  assert.equal(rebuilt.total, 3, "索引為空時要懶重建（否則 PG 的行政區統計會回 0）");
  assert.equal(
    exec.raw.prepare("SELECT COUNT(DISTINCT wish_id) AS n FROM demand_match_districts").get().n, 6,
    "懶重建要把全部 open 許願房（5 筆種子 ＋ 1 筆新建）都寫回索引",
  );
  assert.deepEqual(rebuilt, agg, "懶重建之後的統計必須與索引正常時相同");

  // 3) 修改許願房（換行政區）⇒ 索引要跟著搬（不然舊行政區的統計會多一筆、新行政區少一筆）
  await demandAsyncMod.updateWishRoomAsync(
    NEW_UID,
    created.id,
    { districts: [DISTRICTS[1]], rent_max: 26000, layout: 2, housing_type: "apartment", body: "索引測試用的需求內容" },
    opts,
  );
  assert.deepEqual(
    exec.raw.prepare("SELECT district FROM demand_match_districts WHERE wish_id = ?").all(created.id).map((row) => row.district),
    [DISTRICTS[1]],
    "改行政區之後索引要跟著搬",
  );
  // ⚠️ 不要用 `total` 比「剩下的兩筆」：`AGGREGATE_PRIVACY_THRESHOLD = 3` ⇒ 兩筆會被整批抑制成 0。
  // 用原始列（`aggregateWishRowsAsync`，同一句 SQL、沒有隱私門檻）比對才準。
  const oldRows = await aggAsync.aggregateWishRowsAsync({ districts: [DISTRICTS[0]] }, opts);
  assert.equal(oldRows.some((row) => Number(row.id) === Number(created.id)), false, "舊行政區不該再有它");
  const newRows = await aggAsync.aggregateWishRowsAsync({ districts: [DISTRICTS[1]] }, opts);
  assert.equal(newRows.some((row) => Number(row.id) === Number(created.id)), true, "新行政區要有它");
  const moved = plain(await aggAsync.aggregateDemandAsync({ districts: [DISTRICTS[1]] }, opts));
  assert.equal(moved.total, 3, "新行政區（種子 2 ＋ 搬過來 1）要過得了隱私門檻");
});

test("路由接線：兩條需求統計路由都用 PG 島嶼", () => {
  const server = readFileSync(path.join(SRC, "server.js"), "utf8");
  const bodyOf = (needle) => {
    const start = server.indexOf(needle);
    assert.ok(start > 0, `找得到 ${needle}`);
    return server.slice(start, server.indexOf("\n});", start));
  };
  const agg = bodyOf('app.get("/api/demand/aggregate"');
  assert.ok(agg.includes("await aggregateDemandAsync({"), "統計要用島嶼");
  assert.ok(!/\baggregateDemand\(\{/.test(agg), "不得再用同步的 aggregateDemand()");
  const exposure = bodyOf('app.get("/api/demand/exposure"');
  assert.ok(exposure.includes("await homepageDemandExposureAsync()"), "曝險要用島嶼");
  assert.ok(!/homepageDemandExposure\(\)/.test(exposure), "不得再用同步的 homepageDemandExposure()");
  // 島嶼本身要能拿到同一組純函式（不是自己重寫一份彙總）
  assert.equal(typeof matchQ.aggregateDemandRows, "function");
  assert.equal(typeof matchQ.homepageExposureFromAggregate, "function");
  assert.equal(typeof matchQ.aggregateSql, "function");
  assert.ok(matchCore.AGGREGATE_SCAN_CHUNK > 0);
});
