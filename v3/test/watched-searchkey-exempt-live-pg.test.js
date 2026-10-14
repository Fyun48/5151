// 特別關注豁免 search_key 子句之後，**一趟掃描退回路徑**的 live PG 驗證（Owner 2026-10-14）。
//
// 為什麼一定要 live：watched 的 listScope 少了 `searchWhere()` 那一條 ⇒ 與 statsScope 的共同前綴
// 變成 0 條 ⇒ `buildScopeScanQuery()` 回 `null` ⇒ `computeListingPage()` 必須**整條退回兩趟**
// （`!onePass` 分支自己載入 stats inputs）。這條「回 null 之後仍然拿到完整、正確的一頁」只有
// 在真 PG、真 schema、真管線上才證明得出來。
//
// ⚠️ 安全設計照 L-0863：自建資料庫 `sw1_wx_<pid>`（收尾 `DROP DATABASE … WITH (FORCE)`），
// 只認 `PG_LIVE_REPRO_URL` 且資料庫名在允許清單內（正式庫 5151_shadow 一律拒絕）。
// （本檔出現 `PG_TEST_URL` 字串是為了讓 `run-pg-integration.sh` 的收檔把它收進 PG 整合測試。）
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const RAW = String(process.env.PG_LIVE_REPRO_URL || "").trim();
const ALLOWED_DB = new Set(["repro", "tracker_test", "repro2", "crawl_sandbox"]);
const DB = (() => { try { return new URL(RAW).pathname.replace(/^\//, ""); } catch { return ""; } })();
const REFUSED = RAW && !ALLOWED_DB.has(DB);
const skip = !RAW ? "PG_LIVE_REPRO_URL 未設定（live PG 驗證需要隔離環境）"
  : REFUSED ? `拒絕執行：資料庫 "${DB}" 不在允許清單（正式庫一律拒絕）`
    : false;

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-watch-exempt-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;

const DB_NAME = `sw1_wx_${process.pid}`;
const withDatabase = (url, name) => { const u = new URL(url); u.pathname = `/${name}`; return u.toString(); };
if (RAW && !REFUSED) process.env.PG_URL = withDatabase(RAW, DB_NAME);

const IN_SCOPE = "https://rent.591.com.tw/list?region=1&section=8,9";
const OUT_SCOPE = "https://rent.591.com.tw/list?region=1&section=2,3,8,9";
const STAMP = "2026-09-06T00:00:00.000Z";

let driver = null;
let adminDriver = null;
let sqliteHandle = null;

after(async () => {
  try { if (driver) await driver.close(); } catch {}
  try { const { closeSharedPgDriver } = await import("../src/pgSharedDriver.js"); await closeSharedPgDriver(); } catch {}
  try { if (adminDriver) await adminDriver.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`); } catch {}
  try { if (adminDriver) await adminDriver.close(); } catch {}
  rmSync(dataDir, { recursive: true, force: true });
});

async function connect() {
  if (driver) return driver;
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const { ensurePgSchema } = await import("../src/pgSchema.js");
  const dbMod = await import("../src/db.js");
  sqliteHandle = dbMod.sqliteHandle;
  adminDriver = await createPostgresDriver({ connectionString: RAW });
  await adminDriver.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  await adminDriver.query(`CREATE DATABASE ${DB_NAME}`);
  driver = await createPostgresDriver({ connectionString: withDatabase(RAW, DB_NAME) });
  const mine = (await driver.query("SELECT current_database() AS db")).rows[0];
  assert.equal(mine.db, DB_NAME, "這一支必須跑在自己的資料庫（不動共用靶）");
  await ensurePgSchema(driver, sqliteHandle(), { schema: "", indexes: false });
  return driver;
}

test("live PG：watched 退回兩趟後仍拿到完整的一頁；其餘 filter 照舊走一趟", { skip }, async () => {
  await connect();
  const q = async (sql, params = []) => (await driver.query(sql, params)).rows;
  const filler = (type) => (/INT|REAL|NUM/i.test(String(type)) ? 0 : "");
  const required = (table) => sqliteHandle().prepare(`PRAGMA table_info(${table})`).all()
    .filter((c) => c.notnull === 1 && c.dflt_value === null && c.pk === 0);
  const insert = async (table, values) => {
    const cols = Object.keys(values);
    await q(`INSERT INTO ${table}(${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`, cols.map((c) => values[c]));
  };

  const uid = 970002;
  await insert("users", { id: uid, email: `wx-${uid}@example.test`, role: "member", plan: "free", created_at: STAMP });
  const rows = [
    [970001, IN_SCOPE, "範圍內／已特別關注"],
    [970002, OUT_SCOPE, "範圍外／已特別關注"],
    [970003, OUT_SCOPE, "範圍外／未特別關注"],
    [970004, IN_SCOPE, "範圍內／未特別關注"],
  ];
  for (const [postId, searchKey, title] of rows) {
    const values = { post_id: postId, search_key: searchKey, title, source: "591", source_key: "1|8|||台北市士林區中正路" };
    for (const c of required("listings")) if (!(c.name in values)) values[c.name] = filler(c.type);
    values.price_num = 20000;
    values.address = `台北市士林區中正路${postId}號`;
    values.kind_name = "整層住家";
    values.floor_name = "5/12";
    values.first_seen_at = STAMP;
    values.last_seen_at = STAMP;
    values.last_event = "new";
    await insert("listings", values);
  }
  for (const postId of [970001, 970002]) {
    const values = { user_id: uid, post_id: postId, watched: 1 };
    for (const c of required("user_listing_flags")) if (!(c.name in values)) values[c.name] = filler(c.type);
    await insert("user_listing_flags", values);
  }

  const { loadListingPage } = await import("../src/listingSearchPage.js");
  const args = (filter) => ({
    filter, kind: "", sources: "", q: "", sort: "newest", limit: 20, offset: 0,
    districts: [], userId: uid, matchVoteUserId: uid, sameHouse: true, searchKeys: [IN_SCOPE],
  });
  const ids = (page) => page.listings.map((item) => Number(item.post_id)).sort((a, b) => a - b);

  const watched = await loadListingPage(args("watched"), { driver: "postgres", pgDriver: driver });
  assert.deepEqual(ids(watched), [970001, 970002],
    "watched 在真 PG 上必須回兩筆（含 search_key 在範圍外的那一筆）");
  assert.equal(watched.stats.matched, 2, "matched 也要是 2（不是只改 list 側）");
  const watchedStages = watched.timing.stats_stages || {};
  assert.equal(watchedStages.scan_ms, undefined,
    "watched 的共同前綴斷了 ⇒ 不得走一趟掃描");
  // （`list_prepare_ms` 每個 PG 請求都會記，不是一趟路徑的指紋；真正的指紋是上面的 `scan_ms`。）
  assert.equal(typeof watchedStages.list_prepare_ms, "number",
    "兩趟路徑仍然有 list 側前置的計時（不是整個前置被跳過）");

  const all = await loadListingPage(args("all"), { driver: "postgres", pgDriver: driver });
  assert.deepEqual(ids(all), [970004],
    "「一般」不受影響：範圍外的列仍被 search_key 擋掉、已關注的仍被排除");
  const allStages = all.timing.stats_stages || {};
  assert.notEqual(allStages.scan_ms, undefined,
    "其餘 filter 的共同前綴仍在 ⇒ 照舊走一趟掃描（本包不得把它一起退化）");

  const who = (await q("SELECT current_database() AS db"))[0];
  assert.equal(who.db, DB_NAME);
});
