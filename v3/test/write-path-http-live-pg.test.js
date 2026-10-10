// 寫入路徑的 **HTTP 層** 刷新斷言（2026-10-10，#696／#697 之後缺的那一層）。
//
// 背景：`refreshListingProjection(Sync)`（#696）與 `refreshFoldColumns(Sync)`（#697）把「寫完
// 之後要刷新」收斂成單一漏斗，10 支寫入檔都接上了——但**驗證只到 repository 函式層**。
// 兩次線上事故（投影 1,067/5,000 過時、fold 37 列過時）都是人工抽樣才發現的。
//
// 這一支把「打真實 HTTP 寫入端點 ⇒ 立刻讀回該列 ⇒ 與 `computeFoldColumns()`／
// `computeListingProjection()` 的重算結果逐欄比對」變成 CI 每次都會跑的斷言。
//
// ⛔ PG-COLLECT-KEEP｜這一行是 CI 收檔的**唯一**依據（因為行內有環境變數 PG_TEST_URL 的字面值）：
//    刪掉這一行、或改掉行內那個字串 ⇒ `v3/scripts/run-pg-integration.sh` 的
//    `grep -rl <那個字串> v3/test/*.test.js` 就收不到本檔 ⇒ **CI 不再執行這支測試，
//    而且會靜默全綠**（沒有紅燈、沒有 skip 訊息）。本檔刻意**只留下這一個**字面值
//    （其他敘述一律不寫出它），所以「刪掉標記」與「收檔失敗」是同一件事；
//    `v3/scripts/check-pg-collection.mjs` 會離線斷言標記還在（`run-pg-integration.sh`
//    每次啟動都先跑那一支，失敗就直接 exit 1）。
//
// ⚠️ 安全設計照抄 `self-listing-publish-live-pg.test.js`：**不吃開發機那條影子站變數**
// （＝上面 KEEP 行裡的那個字串），只認 `PG_LIVE_REPRO_URL`，且資料庫名必須在
// `domainToolGuards.ALLOWED_PG_TARGET_DBS` 的允許清單內（repro／tracker_test／repro2）。
// CI 的 PG job 把 `PG_LIVE_REPRO_URL` 指到**拋棄式** service container（見
// `.github/workflows/test.yml`），所以同一支測試在 CI 與本機都成立。
//
// ⚠️ 本檔**只寫自己種的夾具列**（post_id 在保留區間，見 ID_BASE），結束時一律刪除；
// 不改 schema、不動別人的列。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(dir, "../..");

const RAW = String(process.env.PG_LIVE_REPRO_URL || "").trim();
const ALLOWED_DB = new Set(["repro", "tracker_test", "repro2"]);
const DB = (() => { try { return new URL(RAW).pathname.replace(/^\//, ""); } catch { return ""; } })();
const REFUSED = RAW && !ALLOWED_DB.has(DB);
const skip = !RAW ? "PG_LIVE_REPRO_URL 未設定（HTTP 層寫入路徑驗證需要隔離 PG）"
  : REFUSED ? `拒絕執行：資料庫 "${DB}" 不在允許清單 ${[...ALLOWED_DB].join("/")}（正式庫一律拒絕）`
    : false;

// 保留的夾具 post_id 區間：遠離 591 爬蟲的序號區與站內刊登的 2.1e9 區。
const ID_BASE = 9_100_000_000;
const MARK = `wrtest-${Date.now()}`;
const STAMP = "2026-01-02T03:04:05.000Z";
const ADMIN_EMAIL = `${MARK}-admin@example.test`;
const ADMIN_PASS = "wrtest-admin-pass-9";
const MEMBER_EMAIL = `${MARK}-member@example.test`;
const MEMBER_PASS = "wrtest-member-pass-9";

let base = "";
let child = null;
let logs = "";
let dataDir = "";
let pool = null;
let seq = 0;
const createdPostIds = new Set();
const createdUserIds = new Set();
const createdImportIds = new Set();   // listing_import.id
const createdDocIds = new Set();      // content_documents.id（只有真的需要自建聲明時才會有）
const createdGeoKeys = new Set();     // geo_cache.address（＝addressVersion 鍵）
const createdMrtKeys = new Set();     // mrt_cache.geo_key

// ── 外部查證（geo／MRT）**完全離線**的夾具座標 ─────────────────────────────────────────
// 為什麼要這一組：`POST /api/self-listings`（create／publish）在 route 就會呼叫
// `resolveSelfListingGeo()`，它會依序打「地址定位服務」與「步行捷運路線服務」。CI／本機都不准連外，
// 所以這裡用**站上本來就有的快取**（`geo_cache`）把定位結果先塞好，並刻意挑一個
// 「1 公里內沒有任何捷運站」的座標（24.6,121.9＝宜蘭平原；`nearbyWalkMrtStations()` 實測回 0 個候選）
// ⇒ MRT 查證走「已查證沒有」的分支，**一次外部請求都不會發**。
// 已離線驗證（注入式 exec ＋ 把 `globalThis.fetch` 換成丟錯的函式）：快取命中、external attempts = 0。
const GEO_LAT = 24.6;
const GEO_LNG = 121.9;
const GEO_DISTRICT = "1-8";           // 台北市士林區（`lookupDistrict` 的鍵＝`${region}-${id}`）
const GEO_STREET = "寫入測試路417號";
const GEO_ADDRESS = "台北市士林區寫入測試路417號"; // ＝ composeSelfAddress(lookupDistrict(GEO_DISTRICT), GEO_STREET)

// 同房源重掃的游標與狀態是**站設定**；夾具刻意放在 9.1e9，寫下去會讓隔離庫的游標跳到夾具位置 ⇒ 測完還原。
const BACKFILL_CURSOR_KEY = "sameHouseBackfillCursor";
const BACKFILL_STATUS_KEY = "sameHouseBackfillStatus";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function waitForHealth(target, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${target}/api/health`);
      if (res.ok) return true;
    } catch { /* 還沒起來 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("伺服器沒有在時限內起來");
}

async function pg(sql, params = []) {
  return (await pool.query(sql, params)).rows;
}

async function login(email, password) {
  const cap = await fetch(`${base}/api/captcha`).then((r) => r.json());
  const answer = [...String(cap.svg || "").matchAll(/>([0-9A-Za-z])<\/text>/g)].map((m) => m[1]).join("");
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, captchaId: cap.id, captchaAnswer: answer }),
  });
  assert.ok(res.ok, `登入失敗（${email}）：${await res.text()}`);
  return (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map((c) => c.split(";")[0]).join("; ");
}

async function call(method, apiPath, { body, cookie } = {}) {
  const res = await fetch(`${base}${apiPath}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（例如 500 的 HTML） */ }
  return { status: res.status, json, text };
}

/** 夾具：只寫本檔保留的 post_id，`source` 由呼叫端決定（`self` 給站內刊登路徑）。 */
async function seedListing(extra = {}) {
  const postId = ID_BASE + (seq += 1);
  const cols = {
    post_id: postId,
    source_key: `${MARK}|${postId}`,
    title: `${MARK} #${postId}`,
    url: `https://example.test/${postId}`,
    first_seen_at: STAMP,
    last_seen_at: STAMP,
    source: "591",
    price: "32000",
    price_num: 32000,
    refresh_time: "2026-10-01 12:00:00",
    address: "台北市士林區中正路100號",
    floor_name: "5/12",
    area_name: "28.5坪",
    ...extra,
  };
  const keys = Object.keys(cols);
  const rows = await pg(
    `INSERT INTO listings (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING post_id`,
    keys.map((k) => cols[k]),
  );
  const id = Number(rows[0].post_id);
  createdPostIds.add(id);
  return id;
}


/**
 * 「這支端點**故意不寫 listings**」的明示斷言。
 *
 * 為什麼需要它：只斷言「fold/投影等於重算」的話，遇到一支根本沒動 listings 的端點會**空轉通過**
 * （值是種子種進去的，當然等於重算）。實測確認（本檔第 3／4／5 條）：
 *   會員 `confirm-match`／`reject-match`／`merge-same-house` 走的是**個人化**路徑——
 *   `user_same_house_members`（`userSameHouseAsync.js` 的 `UPSERT_SQL`）與
 *   `listing_match_votes`／`listing_match_signals`／`listing_match_splits`，
 *   不寫 `listings.match_post_id`，所以 fold_*／投影**不需要**刷新。
 *   （`reject-match` 的晉升分支 `PROMOTE_SPLIT_SQL` 只改 `match_verdict`／`match_rejected`／`hidden`，
 *     這三欄都不是投影／fold 的輸入，故同樣不需要刷新。）
 */
async function assertListingsInputsUnchanged(postIds, before) {
  const after = (await pg(
    `SELECT post_id, match_post_id, price, price_num, extra_fee, extra_fees, extra_fee_text, tags,
            refresh_time, last_seen_at, offline, floor_name
     FROM listings WHERE post_id = ANY($1::bigint[]) ORDER BY post_id`, [postIds],
  ));
  assert.equal(after.length, postIds.length, "列數不變");
  for (const row of after) {
    const b = before.get(Number(row.post_id));
    assert.ok(b, `缺少 post_id=${row.post_id} 的前置快照`);
    for (const key of Object.keys(b)) {
      assert.ok(eq(row[key], b[key]), `${key} 不應該被這支端點改到（前=${b[key]} 後=${row[key]}）`);
    }
  }
}

async function snapshotInputs(postIds) {
  const rows = await pg(
    `SELECT post_id, match_post_id, price, price_num, extra_fee, extra_fees, extra_fee_text, tags,
            refresh_time, last_seen_at, offline, floor_name
     FROM listings WHERE post_id = ANY($1::bigint[]) ORDER BY post_id`, [postIds],
  );
  return new Map(rows.map((r) => [Number(r.post_id), r]));
}

/**
 * 讓夾具「出生時就是同步的」：用**應用程式自己的 SQL 產生器**（`foldColumnsUpdateSql()`／
 * `listingProjectionUpsertSql()`）把 fold_* 與投影寫成與重算相同的值。
 * 這樣測試紅掉只可能是「端點寫完沒有刷新」，而不是夾具本來就過時。
 */
async function seedInSync(postId) {
  const { computeFoldColumns, foldColumnsUpdateSql, bindFoldColumnValues } = await import("../src/match.js");
  const { computeListingProjection, listingProjectionUpsertSql, bindProjectionValues } = await import("../src/listingSearchProjection.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const row = (await pg("SELECT * FROM listings WHERE post_id = $1", [postId]))[0];
  assert.ok(row, `seedInSync：找不到 post_id=${postId}`);
  await pg(toPostgresSql(foldColumnsUpdateSql()), bindFoldColumnValues(computeFoldColumns(row), postId));
  await pg(toPostgresSql(listingProjectionUpsertSql()), bindProjectionValues(computeListingProjection(row)));
}

async function seedUser(email, password, extra = {}) {
  const { hashPassword } = await import("../src/password.js");
  const cols = {
    email,
    password_hash: hashPassword(password),
    role: "member",
    plan: "free",
    created_at: "2026-01-01T00:00:00.000Z",
    email_verified: 1,
    ...extra,
  };
  const keys = Object.keys(cols);
  const rows = await pg(
    `INSERT INTO users (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
    keys.map((k) => cols[k]),
  );
  const id = Number(rows[0].id);
  createdUserIds.add(id);
  return id;
}

function eq(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return String(a) === String(b);
}

/**
 * 只比對 `fold_*` 四欄。
 * 用在「投影列本來就不存在」的既知缺口上（見第 13 條）：缺口要被明確記錄下來，
 * 但不可以因此讓 fold 那一半的斷言一起消失。
 */
async function assertFoldRefreshed(postId, label) {
  const { computeFoldColumns } = await import("../src/match.js");
  const row = (await pg("SELECT * FROM listings WHERE post_id = $1", [postId]))[0];
  assert.ok(row, `${label}：找不到 post_id=${postId}`);
  const expected = computeFoldColumns(row);
  for (const key of ["fold_rent_num", "fold_refresh_kind", "fold_refresh_rel_ms", "fold_refresh_abs_ms"]) {
    assert.ok(eq(row[key], expected[key]), `${label}：${key} 過時（DB=${row[key]} 重算=${expected[key]}）`);
  }
  return row;
}

/**
 * 核心斷言：寫完之後 **立刻從 DB 讀回該列**，fold_* 與投影逐欄必須等於重算結果。
 * 這正是 CI 缺的那一步——不看程式碼有沒有呼叫刷新，只看資料庫裡的值對不對。
 */
async function assertRowRefreshed(postId, label) {
  const { computeListingProjection } = await import("../src/listingSearchProjection.js");

  const row = await assertFoldRefreshed(postId, label);
  const expectedFold = (await import("../src/match.js")).computeFoldColumns(row);

  const projection = (await pg("SELECT * FROM listing_search_projection WHERE post_id = $1", [postId]))[0];
  assert.ok(projection, `${label}：listing_search_projection 沒有 post_id=${postId} 這一列`);
  const expected = computeListingProjection(row);
  for (const key of Object.keys(expected)) {
    // updated_at 由「重算當下的 now」決定；相對時間（fold_refresh_kind=1）來源本來就會漂移，
    // 因此絕對來源要求完全相同，相對來源只容忍寫入與重算之間的時間差。
    if (key === "updated_at") continue;
    assert.ok(eq(projection[key], expected[key]), `${label}：投影欄 ${key} 過時（DB=${projection[key]} 重算=${expected[key]}）`);
  }
  if (expectedFold.fold_refresh_kind === 1) {
    const drift = Math.abs(Number(projection.updated_at) - Number(expected.updated_at));
    assert.ok(drift < 60_000, `${label}：投影 updated_at 漂移過大（${drift}ms）`);
  } else {
    assert.ok(
      eq(projection.updated_at, expected.updated_at),
      `${label}：投影 updated_at 過時（DB=${projection.updated_at} 重算=${expected.updated_at}）`,
    );
  }
  return row;
}

async function assertNotRefreshedFail() {
  await assert.rejects(async () => {
    const rows = await pg("SELECT 1 FROM listings LIMIT 0");
    if (rows) throw new Error("boom");
  }, /boom/);
}

// ── 離線外部查證夾具 ─────────────────────────────────────────────────────────────────

/**
 * 把「地址定位結果」先寫進 `geo_cache`（用**應用程式自己的** `geoCacheRow()` ＋ `GEO_CACHE_UPSERT_SQL`，
// 鍵與欄位因此不可能跟站上漂移）。`geocodeAddress()` 會直接命中快取，不會連外。
 *
 * ⚠️ 這不是繞過測資：站上第二筆以後的位址也都是走這條快取。這裡只是把「離線可重跑」變成前提。
 * ⚠️ `location_class` 必須是 `address`／`street`：`acceptGeoHit()` 會把 `admin` 判成不合格
 *    （`resolveSelfListingGeo()` 傳 `allowAdmin: false`），那時就會真的連外。
 * ⚠️ `city`／`district` 要與 `parseTaiwanAddressParts()` 的正規化結果一致（臺北市／士林區），
 *    否則 `providerCityMatches()` 會退掉這一筆快取（實測：空字串會退、臺北市會過）。
 */
async function seedGeoCached(address = GEO_ADDRESS) {
  const { geoCacheRow } = await import("../src/geoQueue.js");
  const { GEO_CACHE_UPSERT_SQL } = await import("../src/geoCacheAsync.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const row = geoCacheRow(address, GEO_LAT, GEO_LNG, {
    quality: "house",
    location_class: "address",
    geo_source: "fixture",
    address_used: address,
    city: "臺北市",
    district: "士林區",
    provider: "fixture",
  }, new Date(STAMP));
  await pg(toPostgresSql(GEO_CACHE_UPSERT_SQL), [
    row.address, row.lat, row.lng, row.updated_at, row.quality, row.geo_source, row.address_used,
    row.address_version, row.location_class, row.city, row.district, row.cache_kind, row.provider,
  ]);
  createdGeoKeys.add(row.address);
  return row;
}

/**
 * route 傳給定位的是 `body.street || body.address`（**只有路名那一小段**，不是組合後的完整地址），
 * 所以兩個鍵都要先塞：`GEO_STREET`（route 真正查的）與 `GEO_ADDRESS`（組合後的完整地址，備而不用）。
 */
async function seedGeoCachedAll() {
  await seedGeoCached(GEO_STREET);
  await seedGeoCached(GEO_ADDRESS);
}

/** 記下「MRT 快取」會用到的鍵，收尾時刪掉（`makeMrtKey(24.6,121.9)`）。 */
async function trackMrtKey(lat = GEO_LAT, lng = GEO_LNG) {
  const { makeMrtKey } = await import("../src/mrt.js");
  createdMrtKeys.add(makeMrtKey(lat, lng));
}

// ── 匯入（listing_import）夾具 ────────────────────────────────────────────────────────

/**
 * 匯入列的夾具。**不走 `POST /api/listing-imports`**：那條路由會真的去抓外部網址
 * （`fetchParsedListing()`），違反「不准連外」。這裡只寫 `listing_import` 這一張表，
 * 狀態直接放在測試要驗的那一格；草稿列由呼叫端自己種。
 */
async function seedListingImport({ userId, listingId = null, status = "ready_for_review", title = "", text = "" }) {
  const rows = await pg(
    `INSERT INTO listing_import
       (user_id, provider, original_source_url, normalized_source_url, source_listing_id, status,
        imported_title, imported_text, listing_id, created_at)
     VALUES ($1, '591', $2, $3, '', $4, $5, $6, $7, $8) RETURNING id`,
    [userId, `https://example.test/${MARK}`, `https://example.test/${MARK}`,
      status, title, text, listingId, STAMP],
  );
  const id = Number(rows[0].id);
  createdImportIds.add(id);
  return id;
}

/** 目前有效的「外部匯入聲明」：`confirmListingImportAsync()` 要求送來的 id／version／hash 與它完全一致。 */
async function effectiveImportDeclaration() {
  const rows = await pg(
    `SELECT * FROM content_documents
      WHERE document_type = 'external_import_declaration' AND status = 'published' AND enabled = 1
      ORDER BY version DESC, id DESC`,
  );
  const nowIso = new Date().toISOString();
  const live = rows.find((doc) => (!doc.effective_from || String(doc.effective_from) <= nowIso)
    && (!doc.effective_until || String(doc.effective_until) > nowIso));
  if (live) return live;
  // 隔離庫沒有這一版聲明時才自建一份（收尾刪除），避免這一條變成「無聲跳過」。
  const doc = (await pg(
    `INSERT INTO content_documents
       (document_type, version, title, body, format, check_label, status, enabled,
        requires_reacceptance, content_hash, created_by, created_at)
     VALUES ('external_import_declaration', 9999, $1, $2, 'plain', '', 'published', 1, 0, $3, NULL, $4)
     RETURNING *`,
    [`${MARK} 匯入聲明夾具`, "夾具用文字。", `fixture-${MARK}`, STAMP],
  ))[0];
  createdDocIds.add(Number(doc.id));
  return doc;
}

/** 站設定的前後快照（重掃會寫游標；不還原會讓隔離庫的重掃從夾具位置開始）。 */
async function snapshotSettings(keys) {
  const rows = await pg("SELECT key, value FROM settings WHERE key = ANY($1::text[])", [keys]);
  return { keys, values: new Map(rows.map((r) => [r.key, r.value])) };
}

async function restoreSettings(snapshot) {
  for (const key of snapshot.keys) {
    const value = snapshot.values.get(key);
    if (value === undefined) await pg("DELETE FROM settings WHERE key = $1", [key]);
    else await pg("UPDATE settings SET value = $2 WHERE key = $1", [key, value]);
  }
}

/** 重掃／配對會在別的檔案留下評估列與群組成員：按夾具 post_id 清掉，並收掉變成空殼的群組。 */
async function cleanupDerivedRows(postIds) {
  const ids = [...postIds];
  await pg("DELETE FROM listing_match_evaluations WHERE post_id = ANY($1::bigint[]) OR candidate_post_id = ANY($1::bigint[])", [ids]);
  await pg("DELETE FROM listing_group_members WHERE post_id = ANY($1::bigint[])", [ids]);
  await pg("DELETE FROM listing_groups WHERE group_id NOT IN (SELECT DISTINCT group_id FROM listing_group_members)");
}

// ── 負對照的小工具 ───────────────────────────────────────────────────────────────────

/**
 * 負對照（「不該改 listings」版）：把快照裡的某一欄故意改掉，`assertListingsInputsUnchanged()` 必須抓到。
 * 沒有這一條，「輸入欄不變」的斷言等於沒斷言（怎麼寫都會過）。
 */
async function assertUnchangedCatches(postIds, snapshot, column, brokenValue) {
  const id = Number(postIds[0]);
  const original = snapshot.get(id)[column];
  await pg(`UPDATE listings SET ${column} = $2 WHERE post_id = $1`, [id, brokenValue]);
  try {
    await assert.rejects(
      () => assertListingsInputsUnchanged(postIds, snapshot),
      /不應該被這支端點改到/,
      `故意改壞 ${column} 時 assertListingsInputsUnchanged 必須抓到`,
    );
  } finally {
    await pg(`UPDATE listings SET ${column} = $2 WHERE post_id = $1`, [id, original]);
  }
}

/**
 * 負對照（「必須刷新」版）：把 fold_* 與投影故意改成錯的值。
 * 端點跑完之後仍必須等於重算 ⇒ 「跑完就正確」不可能只是「夾具本來就正確」。
 */
async function makeStale(postId) {
  await pg(
    `UPDATE listings SET fold_rent_num = -424242, fold_refresh_kind = 0,
            fold_refresh_rel_ms = -1, fold_refresh_abs_ms = -1
      WHERE post_id = $1`,
    [postId],
  );
  await pg(
    "UPDATE listing_search_projection SET rent = -424242, primary_listing_id = -1, updated_at = 0 WHERE post_id = $1",
    [postId],
  );
}

/** 負對照的「紅必須出現」那一半：值已經是錯的 ⇒ `assertRowRefreshed()` 一定要抓到。 */
async function assertStaleIsCaught(postId, label) {
  // 紅有兩種合理長相：值過時（/過時/），或該列根本不在投影表（/沒有 post_id=.*這一列/）。
  await assert.rejects(
    () => assertRowRefreshed(postId, `${label}（負對照：已改壞）`),
    /過時|沒有 post_id=\d+ 這一列/,
    `${label}：故意改壞的 fold_*／投影必須被 assertRowRefreshed 抓到`,
  );
}

before(async () => {
  if (skip) return;
  dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-write-http-"));
  const { default: pgMod } = await import("pg");
  pool = new pgMod.Pool({ connectionString: RAW, max: 4 });
  await pg("SELECT 1");

  // 管理員必須是**真的 users 列**：只靠 AUTH_EMAIL 的 env 管理員 session.userId=0，
  // `app.use(requireAuth)` 之後所有端點都會 401「請先登入」（實測）。
  await seedUser(ADMIN_EMAIL, ADMIN_PASS, { role: "admin" });

  const placeholder = createServer();
  const appPort = await listen(placeholder);
  await new Promise((resolve) => placeholder.close(resolve));

  child = spawn(process.execPath, ["v3/src/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(appPort),
      HOST: "127.0.0.1",
      DB_DRIVER: "postgres",
      PG_URL: RAW,
      APP_ROLE: "web",
      AUTH_EMAIL: ADMIN_EMAIL,
      AUTH_PASSWORD: ADMIN_PASS,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { logs += String(d); });
  child.stderr.on("data", (d) => { logs += String(d); });
  base = `http://127.0.0.1:${appPort}`;
  try {
    await waitForHealth(base);
  } catch (error) {
    throw new Error(`${error.message}\n--- server log ---\n${logs.slice(-2000)}`);
  }
});

after(async () => {
  try {
    if (child) child.kill("SIGKILL");
  } catch { /* 已結束 */ }
  // 順序：先收「衍生列」（會 FK／參照 listings 的），再收 listings 自己。
  if (pool && createdPostIds.size) {
    const ids = [...createdPostIds];
    try { await cleanupDerivedRows(ids); } catch { /* 盡力而為 */ }
    try {
      await pg("DELETE FROM listing_search_projection WHERE post_id = ANY($1::bigint[])", [ids]);
    } catch { /* 盡力而為 */ }
    try {
      await pg("DELETE FROM listings WHERE post_id = ANY($1::bigint[])", [ids]);
    } catch { /* 盡力而為 */ }
  }
  if (pool && createdImportIds.size) {
    try { await pg("DELETE FROM listing_import WHERE id = ANY($1::bigint[])", [[...createdImportIds]]); } catch { /* 盡力而為 */ }
  }
  if (pool && createdDocIds.size) {
    try { await pg("DELETE FROM content_documents WHERE id = ANY($1::bigint[])", [[...createdDocIds]]); } catch { /* 盡力而為 */ }
  }
  if (pool && createdUserIds.size) {
    const uids = [...createdUserIds];
    try { await pg("DELETE FROM member_consents WHERE user_id = ANY($1::bigint[])", [uids]); } catch { /* 盡力而為 */ }
    try { await pg("DELETE FROM users WHERE id = ANY($1::bigint[])", [uids]); } catch { /* 盡力而為 */ }
  }
  if (pool && createdGeoKeys.size) {
    try { await pg("DELETE FROM geo_cache WHERE address = ANY($1::text[])", [[...createdGeoKeys]]); } catch { /* 盡力而為 */ }
  }
  if (pool && createdMrtKeys.size) {
    try { await pg("DELETE FROM mrt_cache WHERE geo_key = ANY($1::text[])", [[...createdMrtKeys]]); } catch { /* 盡力而為 */ }
  }
  // 實查歸零（不是只有「刪過了」）：留下最後一組數字，讓重跑的人可以對照。
  if (pool) {
    try {
      const [left] = await pg(
        `SELECT
           (SELECT count(*) FROM listings WHERE post_id = ANY($1::bigint[])) AS listings,
           (SELECT count(*) FROM listing_search_projection WHERE post_id = ANY($1::bigint[])) AS projections,
           (SELECT count(*) FROM users WHERE id = ANY($2::bigint[])) AS users,
           (SELECT count(*) FROM listing_import WHERE id = ANY($3::bigint[])) AS imports,
           (SELECT count(*) FROM listing_match_evaluations WHERE post_id = ANY($1::bigint[]) OR candidate_post_id = ANY($1::bigint[])) AS evaluations,
           (SELECT count(*) FROM listing_group_members WHERE post_id = ANY($1::bigint[])) AS group_members,
           (SELECT count(*) FROM geo_cache WHERE address = ANY($4::text[])) AS geo_cache,
           (SELECT count(*) FROM mrt_cache WHERE geo_key = ANY($5::text[])) AS mrt_cache`,
        [[...createdPostIds], [...createdUserIds], [...createdImportIds], [...createdGeoKeys], [...createdMrtKeys]],
      );
      const dirty = Object.entries(left).filter(([, n]) => Number(n) !== 0);
      console.log(`[cleanup] 夾具殘留檢查：${JSON.stringify(left)}${dirty.length ? " ← 有殘留！" : "（全部為 0）"}`);
    } catch { /* 盡力而為 */ }
  }
  try { if (pool) await pool.end(); } catch { /* 已關 */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ }
});

// ===========================================================================
// 本檔**不覆蓋**的清單（誠實標邊界；下一包請從這裡接手）
//
// 本檔只量一件事：**打真實 HTTP 寫入端點 ⇒ 立刻讀回 DB ⇒ `fold_*` / `listing_search_projection`
// 逐欄等於重算值**。下面這些刻意不在本檔，每條都寫明「為什麼」與「要覆蓋還缺什麼」：
//
//  1. `POST /api/listings/:id/recheck`（server.js:5048）與 `POST /api/listings/:id/report-gone`
//     ⇒ 兩條都會**連外 probe 591**（重新抓那一則的頁面判斷是否下架）。
//        本包的紅線是「不准真的連外」⇒ 只能放掉。要覆蓋得先有可注入的 fetch／probe 夾具，
//        而且要有從 HTTP 端點傳進去的入口（目前沒有）。
//
//  2. `v3/src/listingFields.js` / `v3/src/listingSimilarityAsync.js` 的寫入
//     ⇒ 兩者都**不由 `server.js` 呼叫**（實查：`grep -rln listingFields|listingSimilarityAsync v3/src/*.js`
//        只命中 crawlerWrites／db.js／import5168／demand*／wishExample*）⇒ 它們的樓層／相似度寫入
//        在 HTTP 層不可達，只有 crawler／watcher（或匯入路徑）會觸發。
//        要覆蓋得走 watcher／crawler 的整合測試，不是端點測試。
//
//  3. `POST /api/admin/reset-listings` 與 `POST /api/admin/reset-all`
//     ⇒ 破壞性（清 listings／更大範圍）。`run-pg-integration.sh` 是**序列跑同一顆拋棄式 PG**
//        （本檔所在的這一輪是 70 支）⇒ 在這裡清表會讓**同一輪其他測試檔**跟著紅，
//        不是「不敢測」而是「測了會破壞別人的斷言」。要覆蓋請另開一次性資料庫。
//
//  4. `POST /api/listing-imports`（開始匯入）
//     ⇒ 會真的去抓來源網址（`fetchParsedListing()`）⇒ 不連外 ⇒ 不覆蓋。
//        本檔改用「直接種 `listing_import` 夾具」量它後面的 confirm／publish。
//
//  5. **已量測、且本包已修**的缺口（留下的斷言是 fail-fast，不是補救）：
//     a. `POST /api/self-listings`（建立即公開）原本**沒有刷新 `listing_search_projection`**
//        ⇒ 2026-10-10 由第 13 條量到：投影列 0 列、訪客搜尋的 INNER JOIN 命中 0，
//          但端點回 200（＝剛刊登成功的物件在搜尋裡看不到）。
//        ⇒ 已在 `v3/src/selfListingsAsync.js` 的 `insertOpenSelfListingAsync()` 補上
//          `refreshListingProjection()`（形狀照同檔 publish 路徑的 try/catch ＋ 失敗計數器）。
//          第 13 條現在是**嚴格口徑**：投影列必須已經存在、逐欄等於重算、搜尋來源查得到。
//     b. 尚未修（**這一輪明確不做**，planner 已排下一包）：`POST /api/listing-imports/:id/publish`
//        **沒有呼叫 `resolveSelfListingGeo()`** ⇒ 匯入發布的列不會有座標（第 12 條的 diagnostic）。
//        與 fold／投影無關，但「匯入發布的列能不能進地理配對」是另一題。
//
//  6. 已知**副作用**（不是本檔的斷言，但重跑的人要知道）：
//     `getSelfListingAsync()`（讀取路徑）與 `assertCanPublishAsync()` 都會呼叫
//     `expireOpenSelfListingsAsync()`——那是對**整張 listings** 的 UPDATE（把過期的
//     `self_status='open'` 標成 expired）。本檔夾具不會被標到（新建的有 `self_expires_at`、
//     草稿的狀態不是 open），但隔離庫裡**別人留下的**過期 open 列會被順手清掉；
//     那是站上本來就有的讀取行為，不是本檔多做的手術。
//
//  7. 投影 `updated_at` 的相對來源（`fold_refresh_kind=1`）本來就會隨「重算當下」漂移 ⇒
//     本檔容忍 60 秒內的差（見 `assertRowRefreshed()` 的註解）。
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. 站內刊登：關閉（selfListingsAsync.closeSelfListingAsync）
//    `last_seen_at` 是 fold_refresh_abs_ms 的 fallback 輸入 ⇒ 真的會改到 fold。
// ---------------------------------------------------------------------------
test("HTTP：POST /api/self-listings/:id/close 之後 fold_* 與投影等於重算", { skip, timeout: 180_000 }, async () => {
  const uid = await seedUser(MEMBER_EMAIL, MEMBER_PASS);
  const cookie = await login(MEMBER_EMAIL, MEMBER_PASS);
  const postId = await seedListing({ source: "self", listed_by_user_id: uid, self_status: "open" });
  await seedInSync(postId);

  const res = await call("POST", `/api/self-listings/${postId}/close`, { body: {}, cookie });
  assert.ok(res.status === 200, `close 回應 ${res.status}：${res.text.slice(0, 400)}`);

  const row = await assertRowRefreshed(postId, "close");
  assert.equal(String(row.self_status), "closed", "主寫入語意：self_status 應為 closed");
});

// ---------------------------------------------------------------------------
// 2. 後台隱藏（selfListingsAsync.hideSelfListingAsync）
//    這一支改的是 self_status／users.self_ban_until，**不是** fold／投影的輸入欄 ⇒
//    斷言仍要成立（值必須等於重算），藉此確認「沒有多餘的過時」。
// ---------------------------------------------------------------------------
test("HTTP：POST /api/admin/self-listings/:id/hide 之後 fold_* 與投影等於重算", { skip, timeout: 180_000 }, async () => {
  const adminCookie = await login(ADMIN_EMAIL, ADMIN_PASS);
  const ownerId = await seedUser(`${MARK}-owner2@example.test`, MEMBER_PASS);
  const postId = await seedListing({ source: "self", listed_by_user_id: ownerId, self_status: "open" });
  await seedInSync(postId);

  const res = await call("POST", `/api/admin/self-listings/${postId}/hide`, { body: {}, cookie: adminCookie });
  assert.ok(res.status === 200, `hide 回應 ${res.status}：${res.text.slice(0, 400)}`);

  await assertRowRefreshed(postId, "admin hide");
});

// ---------------------------------------------------------------------------
// 3. 同屋源 verdict：會員確認（listingMatchAsync → 兩列互指 + 兩列都刷新）
// ---------------------------------------------------------------------------
test("HTTP：POST /api/listings/:id/confirm-match 之後**兩列**的 fold_* 與投影等於重算", { skip, timeout: 180_000 }, async () => {
  const uid = await seedUser(`${MARK}-owner3@example.test`, MEMBER_PASS);
  const cookie = await login(`${MARK}-owner3@example.test`, MEMBER_PASS);
  const a = await seedListing({ match_post_id: 0 });
  await seedInSync(a);
  const b = await seedListing({ match_post_id: a });
  await seedInSync(b);

  const before = await snapshotInputs([a, b]);
  const res = await call("POST", `/api/listings/${b}/confirm-match`, { body: {}, cookie });
  assert.ok(res.status === 200, `confirm-match 回應 ${res.status}：${res.text.slice(0, 400)}`);
  void uid;

  // 兩列都要被刷新（match_post_id 是投影 primary_listing_id 的來源）。
  await assertRowRefreshed(a, "confirm-match A");
  await assertRowRefreshed(b, "confirm-match B");
  // 會員版 confirm-match = 個人化併入（不寫 listings）⇒ 輸入欄必須原封不動。
  await assertListingsInputsUnchanged([a, b], before);
  const after = await pg("SELECT post_id, match_post_id FROM listings WHERE post_id = ANY($1::bigint[]) ORDER BY post_id", [[a, b]]);
  assert.ok(after.length === 2, "兩列都要在");
});

// ---------------------------------------------------------------------------
// 4. 同屋源 verdict：拆開（listingMatchAsync via sameHouseAsync.rejectSuspectedMatchAsync）
// ---------------------------------------------------------------------------
test("HTTP：POST /api/listings/:id/reject-match 之後該列 fold_* 與投影等於重算", { skip, timeout: 180_000 }, async () => {
  const email = `${MARK}-owner4@example.test`;
  await seedUser(email, MEMBER_PASS);
  const cookie = await login(email, MEMBER_PASS);
  // ⚠️ 順序很重要：`seedInSync` 必須在**兩列互指完成之後**才跑，否則夾具一出生就是過時的，
  //    會把「夾具問題」誤判成「端點沒刷新」（前一輪就是這樣誤判的）。
  const a = await seedListing({ match_post_id: 0 });
  const b = await seedListing({ match_post_id: a });
  await pg("UPDATE listings SET match_post_id = $1 WHERE post_id = $2", [b, a]);
  await seedInSync(a);
  await seedInSync(b);

  const before = await snapshotInputs([a, b]);
  const res = await call("POST", `/api/listings/${a}/reject-match`, { body: { peer_id: b }, cookie });
  assert.ok(res.status === 200, `reject-match 回應 ${res.status}：${res.text.slice(0, 400)}`);

  await assertRowRefreshed(a, "reject-match A");
  await assertListingsInputsUnchanged([a, b], before);
});

// ---------------------------------------------------------------------------
// 5. 同屋源合併（sameHouseAsync.mergeSameHouseForUserAsync，會員）
// ---------------------------------------------------------------------------
test("HTTP：POST /api/listings/merge-same-house 之後每一列 fold_* 與投影等於重算", { skip, timeout: 180_000 }, async () => {
  const email = `${MARK}-owner5@example.test`;
  await seedUser(email, MEMBER_PASS);
  const cookie = await login(email, MEMBER_PASS);
  const a = await seedListing({});
  await seedInSync(a);
  const b = await seedListing({});
  await seedInSync(b);

  const before = await snapshotInputs([a, b]);
  const res = await call("POST", "/api/listings/merge-same-house", { body: { ids: [a, b] }, cookie });
  assert.ok(res.status === 200, `merge-same-house 回應 ${res.status}：${res.text.slice(0, 400)}`);

  await assertRowRefreshed(a, "merge-same-house A");
  await assertRowRefreshed(b, "merge-same-house B");
  await assertListingsInputsUnchanged([a, b], before);
});

// ---------------------------------------------------------------------------
// 6. 管理員確認同房源（sameHouseAsync.confirmSameHouseAsAdminAsync）
// ---------------------------------------------------------------------------
test("HTTP：POST /api/admin/same-house/confirm 之後每一列 fold_* 與投影等於重算", { skip, timeout: 180_000 }, async () => {
  const adminCookie = await login(ADMIN_EMAIL, ADMIN_PASS);
  const a = await seedListing({});
  await seedInSync(a);
  const b = await seedListing({});
  await seedInSync(b);

  const res = await call("POST", "/api/admin/same-house/confirm", { body: { ids: [a, b] }, cookie: adminCookie });
  assert.ok(res.status === 200, `admin same-house confirm 回應 ${res.status}：${res.text.slice(0, 400)}`);

  await assertRowRefreshed(a, "admin confirm A");
  await assertRowRefreshed(b, "admin confirm B");
});

// ---------------------------------------------------------------------------
// 9. 重新上架：`POST /api/self-listings/:id/copy`（selfListingsAsync.copyOwnListingAsync）
//    會**新增**一列 listings 草稿。這一條量的是「新列自己的 fold_*／投影狀態」——
//    草稿在公開前不進搜尋，所以這裡只斷言「有值就必須等於重算」，沒有值則明確記錄。
// ---------------------------------------------------------------------------
test("HTTP：POST /api/self-listings/:id/copy 之後新草稿列的 fold_*／投影若有值就必須等於重算", { skip, timeout: 180_000 }, async (t) => {
  const email = `${MARK}-owner9@example.test`;
  const uid = await seedUser(email, MEMBER_PASS);
  const cookie = await login(email, MEMBER_PASS);
  const sourceId = await seedListing({ source: "self", listed_by_user_id: uid, self_status: "open", self_expires_at: "" });
  await seedInSync(sourceId);

  const res = await call("POST", `/api/self-listings/${sourceId}/copy`, { body: {}, cookie });
  assert.ok(res.status === 200, `copy 回應 ${res.status}：${res.text.slice(0, 400)}`);
  const newId = Number(res.json?.post_id || res.json?.listing?.post_id || res.json?.draft?.post_id || 0);
  assert.ok(newId > 0, `copy 應該回新草稿的 post_id：${res.text.slice(0, 300)}`);
  createdPostIds.add(newId);

  const [draft] = await pg("SELECT * FROM listings WHERE post_id = $1", [newId]);
  assert.ok(draft, "新草稿列必須存在");
  const expectedFold = (await import("../src/match.js")).computeFoldColumns(draft);
  const stored = ["fold_rent_num", "fold_refresh_kind", "fold_refresh_rel_ms", "fold_refresh_abs_ms"].map((k) => draft[k]);
  const empty = stored.every((v) => v === null || v === undefined);
  t.diagnostic(`copy 新草稿 #${newId}：fold_* = ${JSON.stringify(stored)}（empty=${empty}）`);
  if (!empty) {
    await assertRowRefreshed(newId, "copy 新草稿");
  } else {
    // 已量測的既知事實（本輪不動）：新草稿列建立時不寫 fold_*；`publish` 才會刷新
    // （`selfListingsAsync.js` 的 L766/767）。因此這裡只要求「不是半套」：四欄全空或全部正確。
    assert.ok(
      eq(expectedFold.fold_rent_num, null) || stored[1] === null,
      "新草稿的 fold_* 必須四欄一致地為空，不可以是半套",
    );
  }
  // 來源列不受影響，且仍必須是同步的。
  await assertRowRefreshed(sourceId, "copy 來源列");
});

// ---------------------------------------------------------------------------
// 7. 刷新失敗要「看得見」：讓 fold 刷新在**同一筆交易內**丟錯，斷言
//    (a) 行程內計數器前進、(b) /api/health 的計數非零、(c) 主寫入不吞錯（該回滾就回滾）。
//
//    注入方式：只針對本檔夾具 post_id、且**只在 fold 刷新那句 UPDATE 上**觸發的暫時 trigger
//    （比暫時改名／缺欄安全：不影響任何真實列，`finally` 一律刪除；結束後另有實查確認）。
//    條件寫在 `WHEN`：fold 刷新的特徵是 fold_refresh_kind 被改寫，主寫入（self_status）不會。
// ---------------------------------------------------------------------------
test("HTTP：刷新失敗要看得到（計數器前進 + /api/health 非零 + 該回滾就回滾）", { skip, timeout: 180_000 }, async () => {
  const email = `${MARK}-owner7@example.test`;
  const uid = await seedUser(email, MEMBER_PASS);
  const cookie = await login(email, MEMBER_PASS);
  const postId = await seedListing({ source: "self", listed_by_user_id: uid, self_status: "open" });
  await seedInSync(postId);

  const before = await (await fetch(`${base}/api/health`)).json();
  const fn = `${MARK.replace(/-/g, "_")}_break_fold`;
  await pg(`
    CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'wrtest injected fold refresh failure';
    END $$ LANGUAGE plpgsql`);
  await pg(`CREATE TRIGGER ${fn}_trg BEFORE UPDATE ON listings
            FOR EACH ROW
            WHEN (NEW.post_id = ${Number(postId)} AND NEW.self_status IS NOT DISTINCT FROM OLD.self_status)
            EXECUTE FUNCTION ${fn}()`);
  let health = null;
  try {
    const res = await call("POST", `/api/self-listings/${postId}/close`, { body: {}, cookie });
    // 失敗被計數、不是 500：路徑的 catch 只計數並讓外層語意決定要不要回滾。
    assert.ok(res.status === 200, `注入失敗時 close 回應 ${res.status}：${res.text.slice(0, 400)}`);
    health = await (await fetch(`${base}/api/health`)).json();
    assert.ok(
      Number(health.fold_refresh_failures) > Number(before.fold_refresh_failures),
      `fold_refresh_failures 應前進（before=${before.fold_refresh_failures} after=${health.fold_refresh_failures}）`,
    );
    assert.ok(Number(health.fold_refresh_failures) > 0, "fold_refresh_failures 必須非零");
  } finally {
    await pg(`DROP TRIGGER IF EXISTS ${fn}_trg ON listings`);
    await pg(`DROP FUNCTION IF EXISTS ${fn}()`);
  }
  const [survivor] = await pg("SELECT count(*) AS n FROM pg_trigger WHERE tgname = $1", [`${fn}_trg`]);
  assert.equal(Number(survivor.n), 0, "注入的 trigger 必須被移除");

  // 主寫入語意：刷新在同交易內失敗 ⇒ PG 交易 aborted ⇒ **不可以**留下
  // 「self_status 已改但 fold 沒跟上」的半套狀態。
  const row = (await pg("SELECT self_status FROM listings WHERE post_id = $1", [postId]))[0];
  if (String(row.self_status) !== "closed") {
    assert.equal(String(row.self_status), "open", "回滾語意：self_status 應維持 open");
  } else {
    await assertRowRefreshed(postId, "注入後（主寫入有落地就必須完全同步）");
  }

  // 移除注入後恢復正常：再一次寫入必須成功且完全同步。
  const ok = await call("POST", `/api/self-listings/${postId}/close`, { body: {}, cookie });
  assert.equal(ok.status, 200, `恢復後 close 回應 ${ok.status}`);
  await assertRowRefreshed(postId, "恢復後");
});


// ---------------------------------------------------------------------------
// 10. 後台同房源重掃：`POST /api/admin/same-house/reconcile`
//     `sameHouseAsync.runSameHouseBackfillAsync()` → 逐列 `listingMatchAsync.reconcileListingByIdAsync()`。
//
//     ⚠️ 這一條**必須讓它真的配到**：`reconcileListingById()` 只有在 `best.hit` 成立時才會呼叫
//     `setListingMatch()`，而投影／fold 的刷新就在 `setListingMatch()` 裡面（listingMatchAsync.js:111-120）。
//     配不到時它一個字都不寫 ⇒ 只斷言「值等於重算」就變成空轉（夾具本來就同步）。
//     夾具用**同一組 `source_key`**（`scoreMatch()` 的第一步就是指紋相同 ⇒ level=high），
//     而且用一個不存在的路（寫入測試路）把候選限縮在自己的兩列，絕不碰隔離庫裡別人的房源。
// ---------------------------------------------------------------------------
test("HTTP：POST /api/admin/same-house/reconcile 之後配到的兩列 fold_* 與投影等於重算", { skip, timeout: 180_000 }, async () => {
  const adminCookie = await login(ADMIN_EMAIL, ADMIN_PASS);
  const dup = {
    source_key: `${MARK}|dup`,
    address: GEO_ADDRESS,
    floor_name: "7/12",
    area_name: "31.2坪",
  };
  const a = await seedListing(dup);
  const b = await seedListing(dup);
  await seedInSync(a);
  await seedInSync(b);

  const settingsBefore = await snapshotSettings([BACKFILL_CURSOR_KEY, BACKFILL_STATUS_KEY]);
  try {
    // 負對照：把 a 改壞 ⇒ 斷言必須紅（證明下面「跑完就正確」不是夾具自帶的）。
    await makeStale(a);
    await assertStaleIsCaught(a, "admin reconcile");

    // `cursor = a-1` ＋ `limit=1` ⇒ 批次只會挑到 a（`post_id > cursor ORDER BY post_id LIMIT 1`）。
    const res = await call("POST", "/api/admin/same-house/reconcile", { body: { limit: 1, cursor: a - 1 }, cookie: adminCookie });
    assert.ok(res.status === 200, `reconcile 回應 ${res.status}：${res.text.slice(0, 400)}`);
    const first = res.json?.results?.[0];
    assert.equal(Number(first?.post_id), a, `批次必須只掃到夾具 a：${res.text.slice(0, 300)}`);
    assert.equal(String(first?.level || ""), "high", `夾具必須真的配到（level=high），否則這條是空轉：${res.text.slice(0, 300)}`);
    assert.ok(Number(res.json?.auto_confirmed) >= 1, "摘要要記到自動確認");
    assert.equal(Number(res.json?.next_cursor), a, "游標要前進到 a");

    await assertRowRefreshed(a, "admin reconcile A");
    await assertRowRefreshed(b, "admin reconcile B");
    const [after] = await pg("SELECT match_post_id FROM listings WHERE post_id = $1", [a]);
    assert.equal(Number(after.match_post_id), b, "a 應配到 b（主寫入要真的落地）");
  } finally {
    await restoreSettings(settingsBefore);
    await cleanupDerivedRows([a, b]);
  }
});

// ---------------------------------------------------------------------------
// 11. 匯入聲明確認：`POST /api/listing-imports/:id/confirm`
//     這條端點**不該動 listings**（只寫 `member_consents`（idempotent）與 `listing_import`
//     的聲明三欄＋狀態）⇒ 用 `assertListingsInputsUnchanged()` 明示，避免「因為夾具本來就同步」
//     而空轉通過；負對照則證明那個斷言真的在看欄位。
// ---------------------------------------------------------------------------
test("HTTP：POST /api/listing-imports/:id/confirm 之後 listings 輸入欄完全不變", { skip, timeout: 180_000 }, async () => {
  const email = `${MARK}-importer11@example.test`;
  const uid = await seedUser(email, MEMBER_PASS);
  const cookie = await login(email, MEMBER_PASS);
  const draftId = await seedListing({ source: "self", listed_by_user_id: uid, self_status: "draft" });
  const importId = await seedListingImport({ userId: uid, listingId: draftId, status: "ready_for_review" });
  const doc = await effectiveImportDeclaration();

  const before = await snapshotInputs([draftId]);
  // 負對照：改壞一個輸入欄 ⇒ 同一個斷言必須紅。
  await assertUnchangedCatches([draftId], before, "price", "-999999");

  const res = await call("POST", `/api/listing-imports/${importId}/confirm`, {
    body: { document_id: Number(doc.id), version: Number(doc.version), content_hash: String(doc.content_hash), accept: true },
    cookie,
  });
  assert.ok(res.status === 200, `confirm 回應 ${res.status}：${res.text.slice(0, 400)}`);
  const [row] = await pg("SELECT status, terms_document_id, confirmed_at FROM listing_import WHERE id = $1", [importId]);
  assert.equal(String(row.status), "confirmed", "狀態要真的變成 confirmed（不是只有回應 200）");
  assert.equal(Number(row.terms_document_id), Number(doc.id), "要記下確認的是哪一版聲明");

  await assertListingsInputsUnchanged([draftId], before);
  const [consent] = await pg("SELECT count(*) AS n FROM member_consents WHERE user_id = $1 AND document_type = 'external_import_declaration'", [uid]);
  assert.equal(Number(consent.n), 1, "同意紀錄應該只有一列");
  const again = await call("POST", `/api/listing-imports/${importId}/confirm`, {
    body: { document_id: Number(doc.id), version: Number(doc.version), content_hash: String(doc.content_hash), accept: true },
    cookie,
  });
  assert.ok(again.status >= 400, `已確認的匯入不能再確認（實得 ${again.status}）`);
  await assertListingsInputsUnchanged([draftId], before);
});

// ---------------------------------------------------------------------------
// 12. 匯入草稿走一般刊登流程：`POST /api/listing-imports/:id/publish`
//     （`publishConfirmedImportAsync()` → `publishImportedDraftListingAsync()`，selfListingsAsync.js:766-767）
//     這一條會**公開**草稿 ⇒ 投影與 fold 都必須在回應之前刷新。
// ---------------------------------------------------------------------------
test("HTTP：POST /api/listing-imports/:id/publish 之後 fold_* 與投影等於重算", { skip, timeout: 180_000 }, async (t) => {
  const email = `${MARK}-importer12@example.test`;
  const uid = await seedUser(email, MEMBER_PASS);
  const cookie = await login(email, MEMBER_PASS);
  const draftId = await seedListing({ source: "self", listed_by_user_id: uid, self_status: "draft" });
  await seedInSync(draftId);
  const importId = await seedListingImport({ userId: uid, listingId: draftId, status: "confirmed", title: `${MARK} 匯入草稿` });

  // 負對照：草稿先改壞 ⇒ 斷言紅；端點跑完必須把它修成正確值。
  await makeStale(draftId);
  await assertStaleIsCaught(draftId, "listing-imports publish");

  const res = await call("POST", `/api/listing-imports/${importId}/publish`, {
    body: {
      district: GEO_DISTRICT,
      street: GEO_STREET,
      rent: 28000,
      ping: 25,
      accept_pledge: true,
      body: `${MARK} 匯入草稿刊登說明（離線夾具）。`,
      floor: 5,
      total_floors: 12,
      title: `${MARK} 匯入發布`,
      kind: "whole",
      role: "owner",
      photos: [],
    },
    cookie,
  });
  assert.ok(res.status === 200, `publish 回應 ${res.status}：${res.text.slice(0, 400)}`);

  const row = await assertRowRefreshed(draftId, "listing-imports publish");
  assert.equal(String(row.self_status), "open", "公開後 self_status 應為 open");
  // 觀察（不是本包的缺失清單，但下一包該知道）：**這條路由沒有呼叫 `resolveSelfListingGeo()`**
  //（只有 `POST /api/self-listings/:id/publish` 有）⇒ 匯入發布的列不會有座標，也就不會連外。
  t.diagnostic(`listing-imports publish 後的座標：lat=${row.lat} lng=${row.lng}（此路由不呼叫 resolveSelfListingGeo）`);
  assert.equal(row.lat, null, "此路由不定位（若哪天補上定位，這個斷言會紅，提醒一併補「不准連外」的快取夾具）");
});

// ---------------------------------------------------------------------------
// 13. 站內刊登建立：`POST /api/self-listings`（`createSelfListingAsync()` → `insertOpenSelfListingAsync()`）
//     這條是「建立＋公開」一次做完，而 selfListingsAsync.js:996-997 只明講刷新 **fold**
//     （註解：投影由 publish 路徑處理）⇒ 這一條就是在量「投影到底有沒有跟上」。
// ---------------------------------------------------------------------------
test("HTTP：POST /api/self-listings 之後新列的 fold_* 與投影等於重算", { skip, timeout: 180_000 }, async (t) => {
  const email = `${MARK}-creator13@example.test`;
  await seedUser(email, MEMBER_PASS);
  const cookie = await login(email, MEMBER_PASS);
  await seedGeoCachedAll();
  await trackMrtKey();

  const res = await call("POST", "/api/self-listings", {
    body: {
      district: GEO_DISTRICT,
      street: GEO_STREET,
      rent: 31000,
      ping: 22.5,
      accept_pledge: true,
      body: `${MARK} 站內刊登說明（離線夾具）。`,
      floor: 6,
      total_floors: 14,
      title: `${MARK} 站內刊登新建`,
      kind: "whole",
      role: "owner",
      photos: [],
    },
    cookie,
  });
  assert.ok(res.status === 200, `create 回應 ${res.status}：${res.text.slice(0, 400)}`);
  const newId = Number(res.json?.post_id || res.json?.listing?.post_id || res.json?.draft?.post_id || 0);
  assert.ok(newId > 0, `create 應該回新列的 post_id：${res.text.slice(0, 300)}`);
  createdPostIds.add(newId);

  const row = await assertFoldRefreshed(newId, "self-listings create");
  assert.equal(String(row.self_status), "open", "建立即公開：self_status 應為 open");
  assert.equal(Number(row.lat), GEO_LAT, `lat 應等於快取注入值（否則就是真的連外了）：${row.lat}`);

  // 嚴格口徑：建立即公開 ⇒ 投影列必須**已經存在**且逐欄等於重算。
  // （這一條在 2026-10-10 之前是紅的：端點只呼叫 `refreshFoldColumns()`，投影列 0 列、
  //   訪客搜尋的 INNER JOIN 命中 0；本包已在 `selfListingsAsync.js` 的
  //   `insertOpenSelfListingAsync()` 補上 `refreshListingProjection()`。這裡刻意保留
  //   **不補救**的嚴格斷言：再有人把那一次刷新拿掉，這一條就會紅在「沒有這一列」。）
  const [projection] = await pg("SELECT post_id FROM listing_search_projection WHERE post_id = $1", [newId]);
  assert.ok(
    projection,
    `建立即公開的列必須已經有投影（post_id=${newId}）；沒有 ⇒ 訪客搜尋看不到它`,
  );
  await assertRowRefreshed(newId, "self-listings create（嚴格口徑）");
  const [reach] = await pg(
    `SELECT count(*)::int AS n FROM listing_search_projection p
       JOIN listings l ON l.post_id = p.post_id WHERE p.post_id = $1`,
    [newId],
  );
  assert.equal(Number(reach.n), 1, "訪客搜尋的來源（投影 ⋈ listings）必須查得到剛刊登的這一列");

  // 負對照：新列改壞 ⇒ 斷言紅；再修回同步 ⇒ 綠（證明這一條的斷言真的在看值）。
  await makeStale(newId);
  await assertStaleIsCaught(newId, "self-listings create");
  await seedInSync(newId);
  await assertRowRefreshed(newId, "self-listings create（修回）");
});

// ---------------------------------------------------------------------------
// 14. 站內刊登草稿公開：`POST /api/self-listings/:id/publish`
//     （與第 12 條同一個底層函式，但走**另一條路由**、狀態機也不同：這裡沒有 listing_import）
// ---------------------------------------------------------------------------
test("HTTP：POST /api/self-listings/:id/publish 之後 fold_* 與投影等於重算", { skip, timeout: 180_000 }, async () => {
  const email = `${MARK}-publisher14@example.test`;
  const uid = await seedUser(email, MEMBER_PASS);
  const cookie = await login(email, MEMBER_PASS);
  await seedGeoCachedAll();
  await trackMrtKey();
  const draftId = await seedListing({ source: "self", listed_by_user_id: uid, self_status: "draft", title: `${MARK} 草稿14` });
  await seedInSync(draftId);

  await makeStale(draftId);
  await assertStaleIsCaught(draftId, "self-listings publish");

  const res = await call("POST", `/api/self-listings/${draftId}/publish`, {
    body: {
      district: GEO_DISTRICT,
      street: GEO_STREET,
      rent: 26000,
      ping: 30,
      accept_pledge: true,
      body: `${MARK} 草稿公開說明（離線夾具）。`,
      floor: 3,
      total_floors: 9,
      title: `${MARK} 草稿公開`,
      kind: "whole",
      role: "owner",
      photos: [],
    },
    cookie,
  });
  assert.ok(res.status === 200, `publish 回應 ${res.status}：${res.text.slice(0, 400)}`);

  const row = await assertRowRefreshed(draftId, "self-listings publish");
  assert.equal(String(row.self_status), "open", "公開後 self_status 應為 open");
  assert.equal(Number(row.lng), GEO_LNG, `lng 應等於快取注入值（否則就是真的連外了）：${row.lng}`);
});

// ---------------------------------------------------------------------------
// 8. 負對照（證明上面每一條不是「怎麼寫都會過」）：
//    把某列的 fold_* 與投影**故意改成錯的**，`assertRowRefreshed` 必須抓到。
//    這一條沒有它，前 7 條綠燈只能證明「沒有例外」，不能證明「有在比對」。
// ---------------------------------------------------------------------------
test("負對照：故意改壞 fold_*／投影時，assertRowRefreshed 必須失敗", { skip, timeout: 180_000 }, async () => {
  const postId = await seedListing({});
  await seedInSync(postId);
  // 先確認「同步狀態」時斷言是通過的（否則下面的紅沒有意義）。
  await assertRowRefreshed(postId, "負對照（同步）");
  await pg("UPDATE listings SET fold_rent_num = -12345, fold_refresh_kind = 0 WHERE post_id = $1", [postId]);
  await pg("UPDATE listing_search_projection SET rent = -12345, primary_listing_id = -1 WHERE post_id = $1", [postId]);
  await assert.rejects(
    () => assertRowRefreshed(postId, "負對照（改壞）"),
    /過時/,
    "故意改壞 fold_*／投影時必須被 assertRowRefreshed 抓到",
  );
  await seedInSync(postId);
  await assertRowRefreshed(postId, "負對照（修回）");
});

void assertNotRefreshedFail;
