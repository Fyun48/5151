// geo_cache（地理編碼快取）PG 分支的 parity（2026-09-29 第六十四批）。
//
// 這個模組的儲存層只有 `geo_cache` 一張表（KV：`address` 主鍵），所以夾具就是那張表。
// 四個重點：
//   1. **落地值逐欄相同**：`quality`／`cache_kind`／`address_version` 的推導以前寫在
//      `db.js setCachedGeo()` 裡；現在抽成 `geoQueue.geoCacheRow()` 這個純函式，兩個 driver
//      逐欄重用 ⇒ 這一檔就是釘住「沒有第二份推導」。
//   2. **三層欄位 fallback**：舊庫（只有 address/lat/lng/updated_at）讀得到、也寫得進去。
//   3. **`geo.js` 的 lookup 可以是 async**：這是本批最容易漏的地方——`lookup?.(address)`
//      以前是同步呼叫，塞 Promise 進去會「永遠 truthy、lat/lng 是 undefined」，
//      症狀是「快取明明有、卻每次都當成沒命中」。
//   4. `ensureGeoCacheOnce()` 對 PG 送出的 DDL：建表 ＋ 九個 `ADD COLUMN IF NOT EXISTS`。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-geocache-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const db = (await import("../src/db.js")).sqliteHandle();
const syncDb = await import("../src/db.js");
const asyncMod = await import("../src/geoCacheAsync.js");
const geo = await import("../src/geo.js");
const { addressVersion } = await import("../src/geoQueue.js");

const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");

// PG 替身：只有 `geo_cache` 一張表。DDL 從磁碟鏡射（欄位與 SQLite 完全相同）。
function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  const ddl = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='geo_cache'").get();
  assert.ok(ddl?.sql, "必須抓到 geo_cache 的 DDL");
  mem.exec(ddl.sql);
  disk.close();
  const calls = [];
  const exec = async (sql, params = []) => {
    calls.push({ sql, params });
    const stmt = mem.prepare(sql);
    // SELECT 用 all()、其餘（INSERT／UPDATE／ALTER）用 run()——`ON CONFLICT ... DO UPDATE`
    // 用 all() 在某些版本會直接丟錯，所以照 `crawlScheduleAsync` 的既有寫法分開。
    return /^\s*SELECT/i.test(sql) ? stmt.all(...params) : (stmt.run(...params), []);
  };
  exec.raw = mem;
  exec.calls = calls;
  return exec;
}

function resetBoth() {
  db.prepare("DELETE FROM geo_cache").run();
  const exec = pgFixture();
  exec.raw.prepare("DELETE FROM geo_cache").run();
  return exec;
}

const rowOf = (handle, address) => {
  const row = handle.prepare("SELECT * FROM geo_cache WHERE address = ?").get(addressVersion(address));
  return row || null;
};
const allRows = (handle) => handle.prepare("SELECT * FROM geo_cache ORDER BY address").all()
  .map(({ address, lat, lng, quality, geo_source, address_used, address_version, location_class, city, district, cache_kind, provider }) =>
    ({ address, lat, lng, quality, geo_source, address_used, address_version, location_class, city, district, cache_kind, provider }));

// `updated_at` 由時鐘決定，兩邊不會是同一毫秒；其餘欄位必須逐欄相同。
function assertSameRow(exec, address, why) {
  const a = rowOf(db, address);
  const b = rowOf(exec.raw, address);
  assert.ok(a, `${why}：同步版應該有這一列`);
  assert.ok(b, `${why}：PG 分支應該有這一列`);
  const { updated_at: aStamp, ...aRest } = a;
  const { updated_at: bStamp, ...bRest } = b;
  assert.deepEqual(bRest, aRest, `${why}：除了 updated_at 之外必須逐欄相同`);
  assert.ok(Math.abs(Date.parse(aStamp) - Date.parse(bStamp)) < 5000,
    `${why}：updated_at 應該都是剛剛（${aStamp} vs ${bStamp}）`);
}

const META = {
  quality: "house",
  geo_source: "photon",
  address_used: "臺北市士林區中山北路六段77號",
  location_class: "address",
  city: "臺北市",
  district: "士林區",
  provider: "photon",
};
const ADDRESS = "臺北市士林區中山北路六段77號";

test("寫入：落地值與同步版逐欄相同（含 quality／cache_kind 的推導）", async () => {
  const exec = resetBoth();
  await asyncMod.setCachedGeoAsync(ADDRESS, 25.1, 121.52, META, { ...PG, exec });
  syncDb.setCachedGeo(ADDRESS, 25.1, 121.52, META);
  assertSameRow(exec, ADDRESS, "帶完整 meta");
  const row = rowOf(exec.raw, ADDRESS);
  assert.equal(row.address, addressVersion(ADDRESS), "鍵必須是 addressVersion()");
  assert.equal(row.quality, "house");
  assert.equal(row.cache_kind, "house", "location_class=address ⇒ cache_kind=house");
  assert.equal(row.provider, "photon");

  // 沒有 meta：quality／cache_kind 都要用推導的（兩邊一致）。
  const street = "臺北市士林區中山北路六段";
  await asyncMod.setCachedGeoAsync(street, 25.11, 121.53, {}, { ...PG, exec });
  syncDb.setCachedGeo(street, 25.11, 121.53, {});
  assertSameRow(exec, street, "沒有 meta");
  assert.equal(rowOf(exec.raw, street).quality, "street");
  assert.equal(rowOf(exec.raw, street).cache_kind, "street");
  const unknown = "附近";
  await asyncMod.setCachedGeoAsync(unknown, 25.0, 121.0, {}, { ...PG, exec });
  syncDb.setCachedGeo(unknown, 25.0, 121.0, {});
  assertSameRow(exec, unknown, "unknown 品質");
  assert.equal(rowOf(exec.raw, unknown).quality, "unknown");
});

test("讀取：正規化過的變體會命中同一列，與同步版相同", async () => {
  const exec = resetBoth();
  // 先寫「門牌級」的那一列，再用同一個地址（含多餘空白）讀。
  await asyncMod.setCachedGeoAsync(ADDRESS, 25.1, 121.52, META, { ...PG, exec });
  syncDb.setCachedGeo(ADDRESS, 25.1, 121.52, META);
  const spaced = " 臺北市士林區中山北路六段77號 ";
  const pg = await asyncMod.getCachedGeoAsync(spaced, { ...PG, exec });
  const lite = syncDb.getCachedGeo(spaced);
  assert.ok(pg && lite, "兩邊都要命中");
  assert.equal(Number(pg.lat), Number(lite.lat));
  assert.equal(Number(pg.lng), Number(lite.lng));
  assert.equal(pg.quality, lite.quality);
  assert.equal(pg.address_version, lite.address_version);
  // 沒有這一筆時兩邊都回 null（不是 undefined）。
  assert.strictEqual(await asyncMod.getCachedGeoAsync("高雄市鳳山區中山路12-1號", { ...PG, exec }), null);
  assert.strictEqual(syncDb.getCachedGeo("高雄市鳳山區中山路12-1號"), null);
});

test("舊形狀的表：少欄位時讀得到、也寫得進去（三層 fallback）", async () => {
  const exec = resetBoth();
  // 先把一列寫進去（完整形狀），再把 PG 那一邊的多餘欄位拿掉，模擬舊庫。
  await asyncMod.setCachedGeoAsync(ADDRESS, 25.1, 121.52, META, { ...PG, exec });
  const before = rowOf(exec.raw, ADDRESS);
  for (const column of ["provider", "cache_kind", "district", "city", "location_class"]) {
    exec.raw.exec(`ALTER TABLE geo_cache DROP COLUMN ${column}`);
  }
  const pg = await asyncMod.getCachedGeoAsync(ADDRESS, { ...PG, exec });
  assert.equal(Number(pg.lat), Number(before.lat), "舊形狀也要讀得到座標");
  assert.equal(pg.quality, "house", "第二層（legacy SELECT）要帶 quality");
  assert.equal(pg.city, undefined, "舊形狀沒有 city 這個欄位");

  // 寫入也要能走最小語句（不然舊庫的節點會整個壞掉）。
  const next = "臺北市士林區中山北路六段200號";
  await asyncMod.setCachedGeoAsync(next, 25.2, 121.6, META, { ...PG, exec });
  const written = rowOf(exec.raw, next);
  assert.equal(Number(written.lat), 25.2, "最小語句仍要寫進座標");
  assert.equal(written.updated_at.length > 0, true);
});

test("沒有可用的鍵或座標不是有限數 ⇒ 兩邊都不落地", async () => {
  const exec = resetBoth();
  await asyncMod.setCachedGeoAsync("", 25.1, 121.52, META, { ...PG, exec });
  await asyncMod.setCachedGeoAsync(ADDRESS, Number.NaN, 121.52, META, { ...PG, exec });
  await asyncMod.setCachedGeoAsync(ADDRESS, 25.1, "abc", META, { ...PG, exec });
  syncDb.setCachedGeo("", 25.1, 121.52, META);
  syncDb.setCachedGeo(ADDRESS, Number.NaN, 121.52, META);
  syncDb.setCachedGeo(ADDRESS, 25.1, "abc", META);
  assert.equal(allRows(exec.raw).length, 0, "PG 分支不得落地");
  assert.equal(allRows(db).length, 0, "同步版也不得落地");
  assert.strictEqual(await asyncMod.getCachedGeoAsync("", { ...PG, exec }), null, "空字串的鍵不查詢");
});

test("非 postgres 模式必須回退同步路徑（寫磁碟，不碰傳入的 exec）", async () => {
  const exec = resetBoth();
  await asyncMod.setCachedGeoAsync(ADDRESS, 25.1, 121.52, META, { driver: "sqlite", exec });
  assert.equal(allRows(exec.raw).length, 0, "sqlite 模式不得寫 PG 夾具");
  assert.ok(rowOf(db, ADDRESS), "sqlite 模式要寫磁碟那一份");
  const lite = await asyncMod.getCachedGeoAsync(ADDRESS, { driver: "sqlite", exec });
  assert.equal(Number(lite.lat), Number(syncDb.getCachedGeo(ADDRESS).lat));
});

test("strict：PG 失敗時必須往上丟，且寫入不得回退寫 SQLite", async () => {
  const exec = resetBoth();
  const broken = async () => { throw new Error("connection terminated unexpectedly"); };
  await assert.rejects(() => asyncMod.setCachedGeoAsync(ADDRESS, 25.1, 121.52, META, { ...PG, exec: broken, strict: true }),
    /connection terminated/);
  await assert.rejects(() => asyncMod.setCachedGeoAsync(ADDRESS, 25.1, 121.52, META, { ...PG, exec: broken }),
    /connection terminated/);
  assert.equal(allRows(db).length, 0, "寫入失敗不得回退寫 SQLite");
  // 讀取：strict 往上丟；不 strict 時讀取政策是 fail-open（回本機那一份）。
  await assert.rejects(() => asyncMod.getCachedGeoAsync(ADDRESS, { ...PG, exec: broken, strict: true }),
    /connection terminated/);
  assert.strictEqual(await asyncMod.getCachedGeoAsync(ADDRESS, { ...PG, exec: broken }), null,
    "讀取 fail-open：本機也沒有這一筆 ⇒ null");
});

test("ensureGeoCacheOnce：對 PG 送建表 ＋ 九個 ADD COLUMN IF NOT EXISTS", async () => {
  const statements = [];
  const fakeDriver = { exec: async (sql) => { statements.push(sql); } };
  await asyncMod.ensureGeoCacheOnce(fakeDriver);
  assert.equal(statements.filter((sql) => /CREATE TABLE IF NOT EXISTS geo_cache/i.test(sql)).length, 1,
    "必須建表（含 address 主鍵）");
  const altered = statements.filter((sql) => /ALTER TABLE geo_cache ADD COLUMN IF NOT EXISTS/i.test(sql));
  assert.equal(altered.length, 9, `九個額外欄位都要補，實際 ${altered.length}`);
  for (const column of ["quality", "geo_source", "address_used", "address_version", "location_class",
    "city", "district", "cache_kind", "provider"]) {
    assert.ok(altered.some((sql) => sql.includes(`ADD COLUMN IF NOT EXISTS ${column} `)),
      `缺了 ${column} 的 ADD COLUMN`);
  }
  // 第二次呼叫不得再送一次（WeakMap 記住同一個 driver）。
  const again = [];
  const sameDriver = { exec: async (sql) => { again.push(sql); } };
  await asyncMod.ensureGeoCacheOnce(sameDriver);
  await asyncMod.ensureGeoCacheOnce(sameDriver);
  assert.equal(again.length, statements.length, "同一個 driver 只做一次");
});

// ---- geo.js 的 lookup／save 必須支援 async ----

const photonFeature = (lng, lat, type = "street") => ({
  ok: true,
  status: 200,
  json: async () => ({ features: [{ geometry: { coordinates: [lng, lat] }, properties: { type, city: "Taipei", county: "Taipei", country: "Taiwan" } }] }),
});

test("geocodeAddress：非同步的 lookup 也要命中快取（同步版相容）", async () => {
  const hit = { lat: 25.18252, lng: 121.44921, location_class: "address", city: "新北市", district: "淡水區", quality: "house" };
  let fetches = 0;
  const fetchStub = async () => { fetches += 1; throw new Error("should not fetch"); };
  const asyncHit = await geo.geocodeAddress("新北市淡水區淡金路二段173號", async () => hit, { fetch: fetchStub, fast: true });
  assert.equal(asyncHit.from_cache, true, "非同步 lookup 命中時必須當成快取命中");
  assert.equal(Number(asyncHit.lat), 25.18252, "座標必須是解析後的值，不是 Promise");
  assert.equal(fetches, 0, "命中快取就不該發外部查詢");
  // 同步 lookup 仍然相容。
  const syncHit = await geo.geocodeAddress("新北市淡水區淡金路二段173號", () => hit, { fetch: fetchStub, fast: true });
  assert.equal(syncHit.from_cache, true);
  assert.equal(fetches, 0);
});

test("geocodeAddress：候選鍵的順序不變（門牌鍵 miss、路段鍵命中）", async () => {
  const seen = [];
  const lookup = async (key) => {
    seen.push(key);
    // 只有「路段鍵」（`street:`）有值；門牌鍵（`house:`）與原始地址都要 miss。
    if (!String(key).startsWith("street:")) return null;
    return { lat: 25.18, lng: 121.44, location_class: "street", city: "新北市", district: "淡水區", quality: "street" };
  };
  const hit = await geo.geocodeAddress("新北市淡水區淡金路二段173號", lookup, {
    fetch: async () => { throw new Error("should not fetch"); },
    fast: true,
    ignoreFailCache: true,
  });
  assert.equal(hit.from_cache, true, "路段鍵命中也要算命中");
  const streetAt = seen.findIndex((key) => String(key).startsWith("street:"));
  assert.ok(streetAt > 0, `路段鍵必須在原始地址之後才問到，實際 ${JSON.stringify(seen)}`);
  assert.ok(seen.some((key) => String(key).startsWith("house:")), `門牌鍵要先被問過，實際 ${JSON.stringify(seen)}`);
});

test("boxFromRoadDescription：非同步的 lookup／save 都要被 await", async () => {
  const saved = [];
  const lookup = async () => null; // 全部沒快取 ⇒ 走 geocodeAddress（外部查詢由下面的 fetch 假件回應）
  // ⚠️ `save` 一定要**真的非同步**（先 await 一次才 push）：否則「忘記 await」的變異會活下來，
  // 因為 async 函式被呼叫的那一瞬間就會同步執行到第一個 await 之前。
  const save = async (road, lat, lng) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    saved.push({ road, lat, lng });
  };
  const original = globalThis.fetch;
  // ⚠️ 兩個路名要回**不同**經度：同一個經度會讓「以東／以西」互相衝突（`west < east` 不成立），
  // 那是 `boundsFromConstraints()` 的正確行為，不是這裡要驗的東西。
  const lngs = [121.5, 121.56];
  globalThis.fetch = async () => photonFeature(lngs.shift() ?? 121.5, 25.05);
  try {
    // 路名刻意選沒被其他測試用過的（geo.js 有 15 分鐘的失敗快取，模組層共用）。
    const box = await geo.boxFromRoadDescription("芝玉路以東、至善路以西", { lookup, save });
    assert.ok(Number.isFinite(box.west) && Number.isFinite(box.east), `box 必須有東西界：${JSON.stringify(box)}`);
    assert.ok(box.west < box.east, `東西界必須有順序：${JSON.stringify(box)}`);
    assert.equal(saved.length, 2, `兩個路名都要被寫回快取，實際 ${JSON.stringify(saved)}`);
    assert.equal(saved[0].road, "芝玉路");
    assert.equal(Number(saved[0].lat), 25.05, "save 收到的是解析後的座標");
  } finally {
    globalThis.fetch = original;
  }
});
