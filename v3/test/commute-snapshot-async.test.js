// 通勤快照（`GET /api/commute/snapshot`）的 PG 島嶼 parity（2026-09-29，第七十六批）。
//
// `db.js:listingCommutePatch()` 是同步的 SQLite 讀取：列本身、可見性關卡、觀看者旗標，再跑共用的
// 裝飾器。PG 模式下列表已經是 PG 在服務，這一條卻還在讀**節點本機** ⇒
//   - PG 才有的刊登（別的節點爬到的、匯入的）在這裡是 `null`：地圖卡片**沒有通勤資訊**，
//     而且看起來就像「這台節點沒有這筆」，不會有人發現是讀錯 store；
//   - 觀看者旗標與個人同戶群組也讀本機 ⇒ 同一張卡片在兩台節點可能不一樣。
//
// 這一包釘住四件事：
//   1. **逐欄位相同**：同一份資料列，PG 版（預載裝飾資料 ＋ 共用投影）與同步版產出**完全相同**的
//      patch，而且欄位清單一個都不能少（`commutePatchFields()` 是兩邊共用點）。
//   2. **可見性關卡照抄**：查不到的 id 與 Stage 1 夾具列都要被濾掉（不是回一筆空的）。
//   3. **順序照呼叫端給的 ids**（前端靠這個順序對應卡片），重複 id 會去重。
//   4. **fail-closed**：PG 讀取失敗時，`strict` 要往上丟（不得靜默改讀本機）；`fallback: "open"`
//      才回退同步版；sqlite 模式完全不碰注入的 exec。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-commute76-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ } });

const dbMod = await import("../src/db.js");
const commuteAsync = await import("../src/listingCommuteAsync.js");

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const PG = { driver: "postgres", strict: true };
const handle = () => dbMod.sqliteHandle();
const diskPath = () => path.join(dataDir, "v3.db");
const UID = 760001;
const OTHER = 760002;
const NOW = Date.parse("2026-09-29T00:00:00.000Z");

// 裝飾器會讀到的每一張表（`repository/decorationData.js` 的載入清單）。
const TABLES = [
  "users", "settings", "user_settings", "listings", "listing_prep", "listing_groups",
  "listing_group_members", "route_cache", "route_jobs", "mrt_cache", "user_listing_flags",
  "user_match_votes", "user_same_house_members",
];
// 這幾張表在 PG 上不存在、或 SQLite 的 DDL 有 PG 沒有的函式（`instr()` 之類）⇒ 只鏡射需要的。
const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown, unknown) does not exist"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
];

const POSTS = [761001, 761002, 761003];

function seedWorld() {
  const h = handle();
  h.prepare("DELETE FROM listings WHERE post_id IN (?,?,?)").run(...POSTS);
  h.prepare("DELETE FROM user_listing_flags WHERE user_id IN (?,?)").run(UID, OTHER);
  h.prepare("DELETE FROM user_same_house_members WHERE user_id IN (?,?)").run(UID, OTHER);
  for (const uid of [UID, OTHER]) {
    h.prepare("INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?,'member','free',?)")
      .run(uid, `commute${uid}@example.test`, `會員${uid}`, "2026-01-01T00:00:00.000Z");
    // 有工作點與通勤設定，通勤欄位才會被算出來（不然 patch 會是一組空值，測不出差異）。
    dbMod.saveSettings({
      workAddress: "台北市信義區市府路1號", workLat: 25.0375, workLng: 121.5637,
      commuteKm: 15, commuteMode: "scooter", homeAddress: "新北市板橋區文化路1段",
    }, uid);
  }
  // ⚠️ `listings` 沒有 `district`／`city`／`commute_*` 欄：行政區是從地址推的，通勤欄位是
  // 讀取時用 `route_cache` ＋ settings 算出來的（所以這張表只種「原料」）。
  const insert = h.prepare(
    `INSERT INTO listings(post_id, title, url, source, source_key, address, area_name, layout, floor_name,
       lat, lng, geo_source, price, price_num, offline, hidden, first_seen_at, last_seen_at, fixture_namespace)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,?,?,?)`,
  );
  const stamp = "2026-09-29T00:00:00.000Z";
  // `geo_source` 必須是**受信任**的來源（`location.isTrustedGeoSource()`），
  // `location_class = address` 才過得了 `canUseForRoadDistance()` ⇒ 通勤欄位真的會去讀 route_cache。
  // （第一版寫 `geo_source = "address"`：兩邊都拿到 `wait_geo`，parity 雖然過但什麼都沒驗到。）
  const row = (post, title, key, address, area, layout, floor, lat, lng, price, fixture) => {
    insert.run(post, title, `https://example.test/${post}`, "591", key, address, area, layout, floor,
      lat, lng, "geocode", price, price, stamp, stamp, fixture);
    h.prepare("UPDATE listings SET location_class = 'address', address_norm = ? WHERE post_id = ?").run(address, post);
  };
  row(POSTS[0], "通勤測試A", "591|a1", "新北市板橋區文化路1段1號", "文化路", "3房2廳", "5F", 25.0131, 121.4627, 25000, "");
  row(POSTS[1], "通勤測試B", "591|a2", "台北市大安區信義路4段1號", "信義路", "2房1廳", "3F", 25.0330, 121.5434, 31000, "");
  // 第三筆是 Stage 1 夾具列（`fixture_namespace` 有值）⇒ 必須被可見性關卡濾掉。
  row(POSTS[2], "通勤測試C-夾具", "591|a3", "台北市信義區市府路1號", "市府路", "4房2廳", "8F", 25.0375, 121.5637, 99000, "fixture76");
  // 觀看者旗標（同步版靠 `withPersonal()` 疊上去；PG 版靠預載的 personalFlags）。
  h.prepare("INSERT INTO user_listing_flags(user_id, post_id, viewed, watched, hidden) VALUES (?,?,1,1,0)").run(UID, POSTS[0]);
  h.prepare("INSERT INTO user_listing_flags(user_id, post_id, viewed, watched, hidden) VALUES (?,?,0,0,1)").run(UID, POSTS[1]);
  // 個人同戶群組（PG 版的 personalIndex／agrees 來源）。
  const sameHouse = h.prepare(
    "INSERT INTO user_same_house_members(user_id, post_id, group_key, system_agrees, created_at) VALUES (?,?,?,1,?)",
  );
  sameHouse.run(UID, POSTS[0], "g76a", "2026-09-29T00:00:00.000Z");
  sameHouse.run(UID, POSTS[1], "g76a", "2026-09-29T00:00:00.000Z");
  // 路線快取：鍵要用應用自己的 `setCachedRoute()` 產生，兩邊才會落在同一把鍵上。
  // ⚠️ 距離是**公里數的陣列**（`[8.4]`），不是 `[{km,min}]`：後者會被 `parseRouteCacheRow()`
  // 的 `map(Number)` 濾成空陣列 ⇒ 讀不到（第一版就是這樣，兩邊都變 `wait_geo`）。
  dbMod.setCachedRoute(25.0131, 121.4627, 25.0375, 121.5637, [8.4], null, "scooter", "to_work");
  dbMod.setCachedRoute(25.0375, 121.5637, 25.0131, 121.4627, [8.9], null, "scooter", "from_work");
  dbMod.setCachedRoute(25.0330, 121.5434, 25.0375, 121.5637, [2.1], null, "scooter", "to_work");
  return h;
}

/** PG 替身：鏡射 DDL ＋ 把磁碟上的**所有列**原樣複製（兩個 store 的起點必須一模一樣）。 */
function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  for (const t of TABLES) {
    const rows = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").all(t);
    assert.equal(rows.length, 1, `必須抓到 ${t} 的 DDL（夾具不自己寫表格定義）`);
    mem.exec(rows[0].sql);
    const cols = disk.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    const data = disk.prepare(`SELECT * FROM ${t}`).all();
    const insert = mem.prepare(`INSERT INTO ${t}(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
    for (const row of data) insert.run(...cols.map((c) => row[c]));
  }
  disk.close();
  const seen = [];
  // ⚠️ 兩個一定要照抄的夾具形狀：
  //   1. 裝飾資料的載入器（`repository/decorationData.js`）吃的是**純陣列**，不是 `{rows}`
  //      （`listingDetailAsync.js` 也是這樣傳），所以夾具要回陣列。
  //   2. 那些載入器在 driver=postgres 時自己產生 **`$n`** 佔位符（`inList()`），而注入式執行器
  //      是 node:sqlite ⇒ 夾具要把 `$n` 換回 `?`（同一句裡不會混用兩種寫法，所以照出現順序換即可）。
  const exec = async (sql, params = []) => {
    if (typeof sql !== "string" || !/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) {
      throw new Error(`夾具收到不是 SQL 的東西：${Object.prototype.toString.call(sql)}`);
    }
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    seen.push(sql);
    //   3. 大型清單的載入器用 PG 的**陣列綁定**（`= ANY(?::bigint[])`／`= ANY(?::text[])`），
    //      node:sqlite 沒有這種語法
    //      ⇒ 夾具把它展開成 `IN (?,?,…)`（`loadPeerRows` 有兩個 ANY，照出現順序各自展開）。
    const arrays = [];
    let converted = sql.replace(/(\w+)\s*=\s*ANY\(\?::(\w+)\[\]\)/g, (match, column) => {
      const list = Array.isArray(params[arrays.length]) ? params[arrays.length] : [];
      arrays.push(list);
      return `${column} IN (${list.map(() => "?").join(",")})`;
    });
    const values = arrays.length
      ? [...arrays.flat(), ...params.slice(arrays.length)]
      : (/\$\d+/.test(sql)
        ? (sql.match(/\$(\d+)/g) || []).map((token) => params[Number(token.slice(1)) - 1])
        : params);
    if (!arrays.length) converted = sql.replace(/\$(\d+)/g, "?");
    try {
      return mem.prepare(converted).all(...values);
    } catch (error) {
      throw new Error(`夾具無法執行這句 SQL：${error.message}\n${converted}`);
    }
  };
  exec.raw = mem;
  exec.seen = seen;
  return exec;
}

const syncPatches = (ids) => ids.map((id) => dbMod.listingCommutePatch(id, UID)).filter(Boolean);
const plain = (value) => JSON.parse(JSON.stringify(value));

test("逐欄位相同：PG 版與同步版的通勤 patch 一模一樣，而且欄位一個都不少", async () => {
  seedWorld();
  const exec = pgFixture();
  const settings = dbMod.getSettings(UID);
  const ids = [POSTS[0], POSTS[1], 769999];
  const sync = syncPatches(ids);
  const async = plain(await commuteAsync.listingCommutePatchesAsync(ids, UID, { ...PG, exec, settings }));
  assert.deepEqual(async, plain(sync), "PG 版與同步版的 patch 必須逐欄位相同");
  assert.equal(async.length, 2, "查不到的 id 要被濾掉，不是回一筆空的");

  const keys = [
    "post_id", "lat", "lng", "geo_source", "commute_km", "commute_return_km", "commute_state",
    "commute_state_label", "commute_mode", "commute_hint", "commute_routes", "commute_min_am",
    "commute_min_pm", "location_class", "commute_precision", "commute_approx", "route_min_m",
    "mrt_station", "mrt_walk_km", "fingerprint",
  ];
  assert.deepEqual(Object.keys(async[0]).sort(), [...keys].sort(), "投影欄位清單與同步版相同（少一個前端就是空白）");
  assert.ok(String(async[0].fingerprint || "").trim(), "fingerprint 必須有值（前端靠它決定要不要刷新）");
  // 非空洞的斷言：路線快取真的被讀到（PG 版是透過**預載的 provider**，不是本機查詢）
  assert.equal(async[0].commute_km, 8.4, "去程公里數要從 route_cache 算出來");
  assert.equal(async[0].commute_return_km, 8.9, "回程公里數要從 route_cache 算出來");
  assert.equal(async[0].commute_state, "done", "有路線就要是 done");
  assert.deepEqual(async[0].commute_routes, [8.4], "route_kms 要帶出來");
  assert.equal(async[1].commute_km, 2.1, "第二筆也要各自命中自己的路線");

  // 單筆版本（`listingCommutePatchAsync`）語意相同
  const one = plain(await commuteAsync.listingCommutePatchAsync(POSTS[0], UID, { ...PG, exec, settings }));
  assert.deepEqual(one, plain(dbMod.listingCommutePatch(POSTS[0], UID)));
  assert.equal(await commuteAsync.listingCommutePatchAsync(769999, UID, { ...PG, exec, settings }), null);
});

test("可見性關卡與順序：夾具列被濾掉、順序照呼叫端、重複 id 去重", async () => {
  seedWorld();
  const exec = pgFixture();
  const settings = dbMod.getSettings(UID);
  // 夾具列（第 3 筆）在兩個 driver 都必須是 null
  assert.equal(dbMod.listingCommutePatch(POSTS[2], UID), null, "前提：同步版濾掉夾具列");
  const out = plain(await commuteAsync.listingCommutePatchesAsync(
    [POSTS[2], POSTS[1], POSTS[0], POSTS[1]], UID, { ...PG, exec, settings },
  ));
  assert.deepEqual(out.map((row) => row.post_id), [POSTS[1], POSTS[0], POSTS[1]], "順序照呼叫端給的 ids（重複不去重，與同步版一致）");
  assert.deepEqual(out, plain(syncPatches([POSTS[2], POSTS[1], POSTS[0], POSTS[1]])), "同一組 ids 的結果必須與同步版相同");
  assert.deepEqual(await commuteAsync.listingCommutePatchesAsync([], UID, { ...PG, exec, settings }), [], "空清單不查任何東西");
});

test("fail-closed：PG 讀取失敗時 strict 要往上丟；fallback: open 才回退；sqlite 模式不碰 exec", async () => {
  seedWorld();
  const settings = dbMod.getSettings(UID);
  const boom = async () => { throw new Error("ECONNREFUSED 127.0.0.1:5432"); };
  await assert.rejects(
    () => commuteAsync.listingCommutePatchesAsync([POSTS[0]], UID, { ...PG, exec: boom, settings }),
    /ECONNREFUSED/, "strict 時 PG 失敗必須往上丟（不得靜默改讀本機）",
  );
  const open = plain(await commuteAsync.listingCommutePatchesAsync(
    [POSTS[0]], UID, { driver: "postgres", exec: boom, settings, fallback: "open" },
  ));
  assert.deepEqual(open, plain(syncPatches([POSTS[0]])), "fallback: open 時才回退同步版");

  // settings 是 PG 版的必要輸入：沒有就丟，而且不得先去讀本機
  let called = 0;
  const spy = async (sql, params) => { called += 1; return pgFixture()(sql, params); };
  await assert.rejects(
    () => commuteAsync.listingCommutePatchesAsync([POSTS[0]], UID, { ...PG, exec: spy }),
    /需要 settings/, "缺 settings 必須丟錯",
  );
  assert.equal(called, 0, "缺 settings 時不得先跑任何查詢（更不能回退本機設定）");

  // sqlite 模式：完全不碰注入的 exec
  const noCall = async () => { throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  const lite = plain(await commuteAsync.listingCommutePatchesAsync([POSTS[0]], UID, { driver: "sqlite", exec: noCall }));
  assert.deepEqual(lite, plain(syncPatches([POSTS[0]])), "sqlite 模式走同步路徑");
});

test("`userId: null` 要用 PG 的預設帳號（不是本機的）", async () => {
  seedWorld();
  const exec = pgFixture();
  const settings = dbMod.getSettings(UID);
  await commuteAsync.listingCommutePatchesAsync([POSTS[0]], null, { ...PG, exec, settings });
  assert.ok(
    exec.seen.some((sql) => /FROM users WHERE email/i.test(sql)),
    "userId 為 null 時必須向 PG 問預設帳號（同步版會讀本機）",
  );
});

test("路由接線：`GET /api/commute/snapshot` 用 PG 島嶼（不得再用同步的）", () => {
  const server = readFileSync(path.join(SRC, "server.js"), "utf8");
  const start = server.indexOf('app.get("/api/commute/snapshot"');
  assert.ok(start > 0, "找得到通勤快照路由");
  const body = server.slice(start, server.indexOf("\n});", start));
  assert.ok(body.includes("await listingCommutePatchesAsync(ids, uid, { settings })"), "必須用 PG 島嶼並帶入已讀到的 settings");
  assert.ok(!/listingCommutePatch\(id, uid\)/.test(body), "不得再用同步的 listingCommutePatch");
});
