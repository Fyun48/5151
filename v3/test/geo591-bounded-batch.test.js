// 591 座標／社區補齊掃描：條件下推＋有界批次＋輪轉。
//
// 這一包要守的四件事（正式庫 2026-10-11 的實測：該指紋 `calls=1,173｜mean=2,637ms｜
// 每次回傳 160,648 列`，而且每次都把整批候選排序到 temp file 外洩 48 GB）：
//
//   1. 逐批等價：把 `pick591GeoRows()` 的述詞下推成 SQL 之後，同一個 `limit` 必須挑到
//      **完全相同的 post_id 序列**（順序也算）。舊路徑 = `geo591ScanQuery()` 全撈回 Node
//      再挑；新路徑 = `geo591BatchQuery()`（同一組 ORDER BY ＋ LIMIT）。
//   2. 不餓死：正式路徑用 `geo591RotationQuery()`（`post_id > cursor` ＋ `ORDER BY post_id`）。
//      一個循環內每一列都會被看到一次；補不到的列不會把 head 佔住（L-0249：舊版同一筆
//      每 15 分鐘重試、實測 386 次），補得動的列一定有機會被處理。
//   3. 併發合併：同一進程最多一條 in-flight（`rememberBackfillRequest()`），其餘只排一次
//      「再跑一輪」，不會變成 N 條同時掃全表。
//   4. PostgreSQL 與 SQLite 必須逐列相同（同一份 fixture、同一顆游標），而且 PG 端的
//      `instr`→`strpos`、反連接改寫都要真的跑得動（有 `PG_TEST_URL` 時才跑，CI 的 PG job 會跑）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { livePgTargetSkip } from "./helpers/livePgTarget.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-geo591-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file locked while the process holds it.
  }
});

const PG_TEST_URL = (process.env.PG_TEST_URL || "").trim();
// ⚠️ 安全：守衛必須在建立連線之前（見 v3/test/helpers/livePgTarget.js）。
const GUARD_SKIP = await livePgTargetSkip("geo591-bounded-batch");
const skipPg = GUARD_SKIP || (PG_TEST_URL ? false : "PG_TEST_URL is not set (live PostgreSQL 591 geo scan)");

const app = await import("../src/db.js");
const {
  geo591ScanQuery,
  geo591BatchQuery,
  geo591RotationQuery,
  pick591GeoRows,
  sql591GeoSourceKeyCommunityId,
  sql591GeoNeedyPredicate,
  listingsNeeding591Geo,
} = app;
const { parseCommunityIdFromSourceKey } = await import("../src/location.js");
const { finishBackfillRequest, rememberBackfillRequest } = await import("../src/commuteState.js");
const { needing591GeoAsync } = await import("../src/crawlerReads.js");

const handle = app.sqliteHandle();
const CACHED = 5001; // 已經有 community_cache
const UNCACHED = 5002; // 還沒有快取 ⇒ 需要補社區

// 每一列都對應 `pick591GeoRows()` 的某一條分支；`needy` 是「舊路徑會不會挑到它」的預期答案。
// ⚠️ SQLite 的鏡像 schema 是 `community_id INTEGER NOT NULL DEFAULT 0`、`source_key TEXT NOT NULL`，
//    所以「由 source_key 推社區 id」的分支用 0／空字串表示（`IFNULL(x, 0)`／`IFNULL(x, '')` 與 PG 的
//    NULL 走同一條路）；PG 端 fixture 也照同一組值寫入，兩邊才能逐列比對。
const FIXTURE = [
  { post_id: 930001, source_key: "1|8|c0", community_id: 0, lat: null, lng: 121.5, geo_source: "591", last_seen_at: "2026-01-01T00:00:00.000Z", needy: true, why: "缺 lat" },
  { post_id: 930002, source_key: "1|8|c0", community_id: 0, lat: 25.1, lng: null, geo_source: "591", last_seen_at: "2026-01-01T00:00:00.000Z", needy: true, why: "缺 lng" },
  { post_id: 930003, source_key: "1|8|c0", community_id: 0, lat: 25.1, lng: 121.5, geo_source: "", last_seen_at: "2026-01-01T00:00:00.000Z", needy: true, why: "geo_source 不可信" },
  { post_id: 930004, source_key: "1|8|c5002", community_id: UNCACHED, lat: 25.1, lng: 121.5, geo_source: "591", last_seen_at: "2026-01-01T00:00:00.000Z", needy: true, why: "社區還沒快取" },
  { post_id: 930005, source_key: "1|8|c5001", community_id: CACHED, lat: 25.1, lng: 121.5, geo_source: "591", last_seen_at: "2026-01-01T00:00:00.000Z", needy: false, why: "社區已有快取" },
  { post_id: 930006, source_key: "1|8|c5002", community_id: UNCACHED, lat: 25.1, lng: 121.5, geo_source: "community", last_seen_at: "2026-01-01T00:00:00.000Z", needy: false, why: "座標本來就是社區給的" },
  { post_id: 930007, source_key: "1|8|c0", community_id: 0, lat: null, lng: null, geo_source: "", hidden: 1, last_seen_at: "2026-01-01T00:00:00.000Z", needy: false, why: "已隱藏" },
  { post_id: 930008, source_key: "1|8|c0", community_id: 0, lat: null, lng: null, geo_source: "", offline: 1, last_seen_at: "2026-01-01T00:00:00.000Z", needy: false, why: "已下架" },
  { post_id: 930009, source_key: "1|8|c0", community_id: 0, lat: null, lng: null, geo_source: "", source: "self", last_seen_at: "2026-01-01T00:00:00.000Z", needy: false, why: "自刊物件" },
  { post_id: 930010, source_key: "1|8|c5002", community_id: 0, lat: 25.1, lng: 121.5, geo_source: "591", last_seen_at: "2026-01-01T00:00:00.000Z", needy: true, why: "community_id 空，由 source_key 推（未快取）" },
  { post_id: 930011, source_key: "1|8|c5001", community_id: 0, lat: 25.1, lng: 121.5, geo_source: "591", last_seen_at: "2026-01-01T00:00:00.000Z", needy: false, why: "community_id 空，由 source_key 推（已快取）" },
  { post_id: 930012, source_key: "1|8|C5002", community_id: 0, lat: 25.1, lng: 121.5, geo_source: "591", last_seen_at: "2026-01-01T00:00:00.000Z", needy: false, why: "大寫 C 不算（JS 的 \\d 與 SQL 的大小寫都要對齊）" },
  { post_id: 930013, source_key: "1|8|c12x", community_id: 0, lat: 25.1, lng: 121.5, geo_source: "591", last_seen_at: "2026-01-01T00:00:00.000Z", needy: false, why: "尾端不是數字" },
  { post_id: 930014, source_key: "1|8|c012", community_id: 0, lat: 25.1, lng: 121.5, geo_source: "591", last_seen_at: "2026-01-01T00:00:00.000Z", needy: false, why: "前導零＝12（未快取，但 12 已快取）" },
  { post_id: 930015, source_key: "1|8", community_id: 0, lat: 25.1, lng: 121.5, geo_source: "591", last_seen_at: "2026-01-01T00:00:00.000Z", needy: false, why: "只有兩段（JS split[2] 是 undefined）" },
  { post_id: 930016, source_key: "1|8|c5002|9", community_id: 0, lat: 25.1, lng: 121.5, geo_source: "591", last_seen_at: "2026-01-01T00:00:00.000Z", needy: true, why: "第 3 段是 c5002" },
  { post_id: 930017, source_key: "1||c5002", community_id: 0, lat: 25.1, lng: 121.5, geo_source: "591", last_seen_at: "2026-01-01T00:00:00.000Z", needy: true, why: "中間一段是空的" },
  { post_id: 930018, source_key: "1|8|", community_id: 0, lat: 25.1, lng: 121.5, geo_source: "591", last_seen_at: "2026-01-01T00:00:00.000Z", needy: false, why: "第 3 段是空的" },
  { post_id: 930019, source_key: "c5002|a|b", community_id: 0, lat: 25.1, lng: 121.5, geo_source: "591", last_seen_at: "2026-01-01T00:00:00.000Z", needy: false, why: "比對的是第 3 段，不是第 1 段" },
  { post_id: 930020, source_key: "", community_id: 0, lat: 25.1, lng: 121.5, geo_source: "591", last_seen_at: "2026-01-01T00:00:00.000Z", needy: false, why: "source_key 是空的（IFNULL 與 JS 的空字串同一條路）" },
  { post_id: 930021, source_key: "1|8|c99999999999999999999", community_id: 0, lat: 25.1, lng: 121.5, geo_source: "591", last_seen_at: "2026-01-01T00:00:00.000Z", needy: true, why: "20 位數字：PG 不能溢位" },
  { post_id: 930022, source_key: "1|8|c5002", community_id: 0, lat: 25.1, lng: 121.5, geo_source: "591", last_seen_at: "2026-01-01T00:00:00.000Z", needy: true, why: "community_id = 0 走 source_key" },
  { post_id: 930023, source_key: "1|8|c0", community_id: 0, lat: 25.1, lng: 121.5, geo_source: "sinyi", last_seen_at: "2026-01-01T00:00:00.000Z", needy: false, why: "可信來源清單裡的其他來源" },
];

function insertSqliteRows() {
  const insert = handle.prepare(
    `INSERT INTO listings(post_id, source_key, title, url, first_seen_at, last_seen_at,
                          lat, lng, geo_source, community_id, source, hidden, offline)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of FIXTURE) {
    insert.run(
      row.post_id,
      row.source_key ?? null,
      `fixture-${row.post_id}`,
      `https://example.test/${row.post_id}`,
      "2026-01-01T00:00:00.000Z",
      row.last_seen_at,
      row.lat ?? null,
      row.lng ?? null,
      row.geo_source ?? null,
      row.community_id ?? 0,
      row.source ?? "591",
      row.hidden ?? 0,
      row.offline ?? 0,
    );
  }
  for (const id of [CACHED, 12]) {
    handle.prepare(
      "INSERT INTO community_cache(community_id, name, address, lat, lng, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, `c${id}`, "台北市", 25.1, 121.5, "2026-01-01T00:00:00.000Z");
  }
  // 兩列 watched：讓 `sqlWatchedFirst()` 真的參與排序（等價測試才不是空的）。
  handle.prepare("INSERT INTO user_listing_flags(post_id, user_id, watched) VALUES (?, ?, 1)").run(930004, 1);
  handle.prepare("INSERT INTO user_listing_flags(post_id, user_id, watched) VALUES (?, ?, 1)").run(930022, 1);
}

insertSqliteRows();

function communityIdSet() {
  return new Set(handle.prepare("SELECT community_id FROM community_cache").all().map((row) => Number(row.community_id)));
}

const ids = (rows) => rows.map((row) => Number(row.post_id));

// 舊路徑：整張表撈回 Node，再由 `pick591GeoRows()` 挑（下面每一支等價測試的對照組）。
function legacyPick(limit) {
  const cached = communityIdSet();
  return ids(pick591GeoRows(handle.prepare(geo591ScanQuery().sql).all(), {
    limit,
    hasCommunity: (communityId) => cached.has(Number(communityId)),
  }));
}

test("fixture 每一列的 needy 判斷都與 pick591GeoRows() 一致（fixture 自己先自洽）", () => {
  const all = handle.prepare(geo591ScanQuery().sql).all();
  const cached = communityIdSet();
  const picked = new Set(ids(pick591GeoRows(all, { limit: 10_000, hasCommunity: (id) => cached.has(Number(id)) })));
  for (const row of FIXTURE) {
    assert.equal(
      picked.has(row.post_id),
      row.needy,
      `post_id=${row.post_id}（${row.why}）：舊路徑${row.needy ? "應該" : "不應該"}挑到`,
    );
  }
});

test("逐批等價：SQL 下推＋LIMIT 與「全撈回 Node 再挑」挑到完全相同的 post_id 序列", () => {
  const cached = communityIdSet();
  for (const limit of [1, 2, 3, 5, 7, 20, 50]) {
    const old = legacyPick(limit);
    const query = geo591BatchQuery({ limit });
    const raw = handle.prepare(query.sql).all(...query.params);
    assert.deepEqual(ids(raw), old, `limit=${limit}：下推後的 SQL 必須逐字等於舊路徑的挑選結果`);
    // 安全網（crawlerScans.js 的 `pick591GeoRows()`）不可以再濾掉任何一列——濾掉就代表 SQL 多挑。
    assert.deepEqual(
      ids(pick591GeoRows(raw, { limit, hasCommunity: (id) => cached.has(Number(id)) })),
      old,
      `limit=${limit}：JS 端的安全網不應該濾掉任何一列`,
    );
  }
  // 順序也要對（ORDER BY 完全相同：watched 優先、last_seen_at DESC、post_id ASC 當同分決勝）。
  assert.ok(legacyPick(20).length > 0, "fixture 必須有工作可挑");
});

test("逐批等價：輪轉版（ORDER BY post_id）在同一個游標下挑到的集合與舊路徑一致", () => {
  const all = legacyPick(10_000);
  const cached = communityIdSet();
  const seen = [];
  let cursor = 0;
  for (let round = 0; round < 50; round += 1) {
    const query = geo591RotationQuery({ limit: 4, cursor });
    const rows = handle.prepare(query.sql).all(...query.params);
    const picked = ids(pick591GeoRows(rows, { limit: 4, hasCommunity: (id) => cached.has(Number(id)) }));
    assert.deepEqual(ids(rows), picked, "SQL 的述詞必須與 pick591GeoRows() 等價（輪轉版也一樣）");
    if (!rows.length) break;
    seen.push(...picked);
    cursor = Number(rows[rows.length - 1].post_id);
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [...all].sort((a, b) => a - b), "一個循環要剛好走完所有需要補的列");
  assert.equal(new Set(seen).size, seen.length, "一個循環內不可以重複挑到同一列");
});

test("source_key 推社區 id：SQL 表達式與 parseCommunityIdFromSourceKey() 逐字一致", () => {
  // 述詞裡出現很多次 `?`，而 SQLite 的位置參數只能綁一次；所以直接把值當成 SQL 字面量塞進
  // `IFNULL(<literal>, '')`（正式路徑傳的是欄位名 `listings.source_key`，不經過這裡）。
  const exprFor = (key) => sql591GeoSourceKeyCommunityId(
    key === null ? "NULL" : `'${String(key).replace(/'/g, "''")}'`,
  );
  const cases = [
    ...FIXTURE.map((row) => row.source_key),
    "1|8|c5002", "1|8|c012", "1|8|c000", "1|8|C5002", "1|8| c5002", "1|8|c", "1|8|c-1", "1|8|5002",
    "1|8|c12.5", "1|8|c99999999999999999999", "a|b", "|c5", "||c5", "c5", "", null, "1|2|3|4",
  ];
  for (const key of cases) {
    const viaSql = handle.prepare(`SELECT ${exprFor(key)} AS id`).get();
    const viaJs = parseCommunityIdFromSourceKey(key);
    assert.equal(Number(viaSql.id), viaJs, `source_key=${JSON.stringify(key)}`);
  }
});

test("不餓死：輪轉讓補得動的列一定輪得到，補不到的列不會把 head 佔住（L-0249）", () => {
  // 20 列「永遠補不到」（缺座標、community_id = 0，來源查無）擺在最前面，後面才是補得動的列。
  const stuck = [];
  const fixable = [];
  const insert = handle.prepare(
    `INSERT INTO listings(post_id, source_key, title, url, first_seen_at, last_seen_at, lat, lng, geo_source, community_id)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, '', 0)`,
  );
  for (let i = 0; i < 20; i += 1) {
    const id = 940000 + i;
    insert.run(id, `9|9|c9${i}`, `stuck-${id}`, `https://example.test/${id}`, "2026-01-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z");
    stuck.push(id);
  }
  for (let i = 0; i < 40; i += 1) {
    const id = 941000 + i;
    insert.run(id, `9|9|c8${i}`, `fix-${id}`, `https://example.test/${id}`, "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    fixable.push(id);
  }
  const fix = handle.prepare("UPDATE listings SET lat = 25.033, lng = 121.5654, geo_source = '591' WHERE post_id = ?");

  // 舊行為：每次都以同一個 ORDER BY 從 head 挑 20 筆 ⇒ 前 20 筆卡住時，後面永遠輪不到。
  const legacyRounds = [];
  for (let round = 0; round < 40; round += 1) legacyRounds.push(legacyPick(20));
  assert.ok(
    legacyRounds.every((batch) => batch.length === 20 && batch.includes(940000)),
    "舊行為的 head 會一直是同一批卡住的列（這正是 L-0249 的形狀）",
  );
  assert.ok(
    !legacyRounds.some((batch) => batch.some((id) => id >= 941000)),
    "舊行為完全碰不到後面補得動的列",
  );

  // 新行為：輪轉。每一輪挑到就「補上座標」（＝真的被處理），下一輪從游標之後接著看。
  const attempts = new Map();
  const fixed = new Set();
  let cursor = 0;
  const uniquePerCycle = [];
  for (let round = 0; round < 10; round += 1) {
    const query = geo591RotationQuery({ limit: 20, cursor });
    const rows = handle.prepare(query.sql).all(...query.params);
    for (const row of rows) {
      const id = Number(row.post_id);
      attempts.set(id, (attempts.get(id) || 0) + 1);
      if (id >= 941000) {
        fix.run(id);
        fixed.add(id);
      }
    }
    uniquePerCycle.push(ids(rows));
    cursor = rows.length ? Number(rows[rows.length - 1].post_id) : 0;
    if (!rows.length) break;
  }
  assert.deepEqual(
    [...fixed].sort((a, b) => a - b),
    fixable,
    "十輪之內（40 列卡住 + 40 列可補）所有補得動的列都必須被處理到",
  );
  for (const id of stuck) {
    const seen = attempts.get(id) || 0;
    // 十輪 × 20 筆＝最多 200 個位置；一個循環是 60 列 ⇒ 每一列最多被看 4 次（不是每輪都被重試）。
    assert.ok(seen <= 4, `補不到的列 post_id=${id} 被重試 ${seen} 次，超過一個循環的比例上限`);
  }
  assert.equal(new Set(uniquePerCycle.flat()).size, uniquePerCycle.flat().length, "同一個循環內不重複");
  // 這一支會改動共用的 SQLite fixture；題庫清掉，後面的 PG 逐列比對才是同一份資料。
  handle.prepare("DELETE FROM listings WHERE post_id BETWEEN 940000 AND 941100").run();
});

test("併發合併：同一進程最多一條 in-flight，其餘只排一次再跑", () => {
  // `server.js:queueGeoBackfill()` 的守門就是用這一對函式（`geoBackfillState`）。
  const state = { busy: false, queued: false };
  const results = [rememberBackfillRequest(state), rememberBackfillRequest(state), rememberBackfillRequest(state)];
  assert.deepEqual(results, ["start", "queued", "queued"], "三個同時到的事件只會開一條");
  assert.equal(finishBackfillRequest(state), "restart", "busy 期間被合併的事件在收工後只補跑一次");
  assert.equal(finishBackfillRequest(state), "idle", "沒有新事件就不再排");
  assert.deepEqual(rememberBackfillRequest(state), "start", "合併後可以重新開始下一輪");
});

test("併發合併／輪轉的接線：server.js 的守門與 watcher 的游標都要在", () => {
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  const watcher = readFileSync(path.join(dir, "../src/watcher.js"), "utf8");
  const body = server.slice(server.indexOf("async function queueGeoBackfill"), server.indexOf("async function tick"));
  assert.ok(body.includes("rememberBackfillRequest(geoBackfillState)"), "queueGeoBackfill 要先過 in-flight 守門");
  assert.ok(
    body.indexOf("rememberBackfillRequest(geoBackfillState)") < body.indexOf("backfillIncompleteAddresses"),
    "守門必須在任何工作開始之前",
  );
  assert.match(body, /const geo = await backfillListingCoords\(settings, \{ limit: LIST_PAGE_SIZE \}\);/);
  assert.match(
    watcher,
    /const rows = await needing591GeoAsync\(\{ limit: cap, cursor: geo591ScanCursor \}\);/,
    "watcher 一定要把輪轉游標傳下去，否則會退回『每輪都在同一批 head 打轉』",
  );
  // 游標推進已抽成 `geo591Cursor.js`（起點隨機／GEO591_CURSOR_SEED 固定）：這裡只斷言 watcher
  // 用的是那一支；起點範圍與 bigint 安全由 geo591-cursor-start.test.js 釘住。
  assert.match(watcher, /geo591ScanCursor = nextGeo591Cursor\(rows\);/);
});

test("清單入口：listingsNeeding591Geo() 已經是有界批次（不再把整張表撈回 Node）", () => {
  const limited = listingsNeeding591Geo(3);
  assert.ok(limited.length <= 3, "有界批次不可以超過 limit");
  assert.deepEqual(limited, ids(pick591GeoRows(
    handle.prepare(geo591RotationQuery({ limit: 3, cursor: 0 }).sql).all(0, 3),
    { limit: 3, hasCommunity: (id) => communityIdSet().has(Number(id)) },
  )).map((id) => ({ post_id: id })));
  const sql = geo591ScanQuery().sql;
  assert.ok(!sql.includes("LIMIT"), "legacy 對照組必須維持『全撈回 Node』的形狀，否則等價測試會自己等於自己");
  assert.match(geo591BatchQuery({ limit: 20 }).sql, /LIMIT \?/);
  assert.match(geo591RotationQuery({ limit: 20, cursor: 5 }).sql, /post_id > \?/);
  // 述詞必須留在「可估價」的形狀（PG 對 COALESCE/CASE 比較一律套 0.5% 的預設選擇率，
  // 疊起來會讓 planner 放棄主鍵索引、改成Seq Scan + Sort；見 PR 的估價表）。
  const needy = sql591GeoNeedyPredicate({ dialect: "postgres" });
  assert.match(needy, /listings\.community_id > 0/);
  assert.match(needy, /NOT EXISTS \(SELECT 1 FROM community_cache cc WHERE cc\.community_id = listings\.community_id\)/);
  assert.ok(!/COALESCE\(listings\.community_id/.test(needy), "不要再用 COALESCE 包 community_id");
  // 前兩條腿（缺座標／community_id 欄位）必須是單純的欄位比較；`CASE` 只能留在最後那條
  // 「由 source_key 推」的腿裡（正式庫實測 0 列，幾乎不會被執行）。
  const head = needy.slice(0, needy.indexOf("listings.community_id <= 0"));
  assert.ok(!/CASE WHEN/.test(head), "前兩條腿不可以出現 CASE（估價與索引都會壞掉）");
  assert.match(needy, /split_part\(COALESCE\(listings\.source_key, ''\), '\|', 3\) ~ '\^c\[0-9\]\+\$'/);
  const sqliteNeedy = sql591GeoNeedyPredicate();
  assert.match(sqliteNeedy, /instr\(/, "SQLite 方言仍然走 instr/substr 鏈（node:sqlite 沒有 split_part）");
  assert.ok(!/split_part/.test(sqliteNeedy));
});

test("live PostgreSQL：同一份 fixture 下，PG 與 SQLite 的 591 掃描逐列相同", { skip: skipPg }, async () => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const schema = `geobatch_${Date.now().toString(36)}_${Math.floor(Math.random() * 100000)}`;
  const pgDriver = await createPostgresDriver({
    connectionString: PG_TEST_URL,
    poolOptions: { max: 2, options: `-c search_path=${schema}`, application_name: "5151-geo591-batch" },
  });
  try {
    await pgDriver.query(`CREATE SCHEMA ${schema}`);
    await pgDriver.query(`CREATE TABLE listings(
      post_id bigint PRIMARY KEY, source_key text, title text, url text,
      first_seen_at text NOT NULL, last_seen_at text NOT NULL,
      lat double precision, lng double precision, geo_source text,
      community_id bigint, source text, hidden bigint DEFAULT 0, offline bigint DEFAULT 0)`);
    await pgDriver.query("CREATE TABLE community_cache(community_id bigint PRIMARY KEY, name text, address text, lat double precision, lng double precision, updated_at text)");
    await pgDriver.query("CREATE TABLE user_listing_flags(post_id bigint, user_id bigint, watched bigint)");
    for (const row of FIXTURE) {
      await pgDriver.query(
        `INSERT INTO listings(post_id, source_key, title, url, first_seen_at, last_seen_at, lat, lng, geo_source, community_id, source, hidden, offline)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [row.post_id, row.source_key ?? null, `fixture-${row.post_id}`, `https://example.test/${row.post_id}`,
          "2026-01-01T00:00:00.000Z", row.last_seen_at, row.lat ?? null, row.lng ?? null,
          row.geo_source ?? null, row.community_id ?? 0, row.source ?? "591", row.hidden ?? 0, row.offline ?? 0],
      );
    }
    for (const id of [CACHED, 12]) {
      await pgDriver.query(
        "INSERT INTO community_cache(community_id, name, address, lat, lng, updated_at) VALUES ($1,$2,$3,$4,$5,$6)",
        [id, `c${id}`, "台北市", 25.1, 121.5, "2026-01-01T00:00:00.000Z"],
      );
    }
    for (const id of [930004, 930022]) {
      await pgDriver.query("INSERT INTO user_listing_flags(post_id, user_id, watched) VALUES ($1,$2,1)", [id, 1]);
    }

    // (a) 逐批等價：同一份資料、同一個 limit，PG 上「下推＋LIMIT」與「全撈回 Node 再挑」逐字相同。
    const cachedRows = await pgDriver.query("SELECT community_id FROM community_cache");
    const cached = new Set((cachedRows.rows || cachedRows).map((row) => Number(row.community_id)));
    for (const limit of [1, 3, 7, 20, 50]) {
      const oldRows = await pgDriver.query(toPostgresSql(geo591ScanQuery().sql));
      const oldIds = ids(pick591GeoRows(oldRows.rows || oldRows, { limit, hasCommunity: (id) => cached.has(Number(id)) }));
      const batch = geo591BatchQuery({ limit });
      const newRows = await pgDriver.query(toPostgresSql(batch.sql), batch.params);
      assert.deepEqual(ids(newRows.rows || newRows), oldIds, `PG limit=${limit}`);
    }

    // (b) PG 與 SQLite 逐列相同（含輪轉游標）：這一支才會抓到 instr→strpos、NUMERIC 轉型之類的翻譯差異。
    for (const cursor of [0, 930010, 930020]) {
      for (const limit of [3, 20]) {
        const pgRows = await needing591GeoAsync({ limit, cursor }, { driver: "postgres", pgDriver, strict: true });
        assert.deepEqual(pgRows, listingsNeeding591Geo(limit, { cursor }), `PG vs SQLite cursor=${cursor} limit=${limit}`);
      }
    }
    // (c) 反連接真的下推：PG 端一個循環內的結果必須等於「舊路徑全撈回 Node 再挑」的集合。
    const all = await pgDriver.query(toPostgresSql(geo591ScanQuery().sql));
    const allIds = ids(pick591GeoRows(all.rows || all, {
      limit: 10_000,
      hasCommunity: (id) => cached.has(Number(id)),
    }));
    const rotated = geo591RotationQuery({ limit: 100, cursor: 0 });
    const rotatedRows = await pgDriver.query(toPostgresSql(rotated.sql), rotated.params);
    assert.deepEqual(
      // 輪轉版是 `ORDER BY post_id`，與舊路徑的「watched 優先」順序不同 ⇒ 這裡比集合（順序由 (a) 的
      // 逐批等價測試負責）。
      [...ids(rotatedRows.rows || rotatedRows)].sort((a, b) => a - b),
      [...allIds].sort((a, b) => a - b),
      "PG 的輪轉述詞必須與舊路徑的 JS 述詞逐列等價（community_cache 的反連接不可以多濾或少濾）",
    );
  } finally {
    await pgDriver.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await pgDriver.close?.();
  }
});
