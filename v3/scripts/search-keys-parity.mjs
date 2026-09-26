// PG 版 searchKeys builder 的真實鏡像實跑 ＋ 與 SQLite currentSearchKeys() 對比（唯讀）。
//
// 用法（**必須**用 REMOTE_DIR=/app/tmpkk，讓 bare specifier `pg` 可由 /app/node_modules 解析）：
//   REMOTE_DIR=/app/tmpkk bash v3/scripts/run-in-container.sh v3/scripts/search-keys-parity.mjs
//
// 判讀：onlySqlite 必須為 0（PG builder 不得漏掉 SQLite 會產生的任何 key）。
//       onlyPg > 0 通常是因為容器內 SQLite 是較舊／較小的副本，而 PG 鏡像是正式資料（需看來源明細解釋）。
import { createPostgresDriver } from "./src/dbDriverPostgres.js";
import { buildSearchKeysFromPg, currentSearchKeys } from "./src/db.js";

const drv = await createPostgresDriver({ env: process.env });
// builder 內一律使用 `?` 佔位符，這裡在本地轉成 PG 的 `$n`。
const toPg = (sql) => {
  let i = 0;
  return String(sql).replace(/\?/g, () => `$${++i}`);
};
const exec = async (sql, params = []) => {
  const res = await drv.query(toPg(sql), params);
  return res?.rows ?? res ?? [];
};

const keys = await buildSearchKeysFromPg(exec);
let sqliteKeys = null;
let sqliteErr = "";
try {
  sqliteKeys = currentSearchKeys();
} catch (err) {
  sqliteErr = String(err?.message || err).slice(0, 160);
}

// 來源明細（解釋 onlyPg 的來源）
const users = await exec("SELECT id, role, plan FROM users WHERE deleted_at IS NULL OR deleted_at = '' ORDER BY id");
const userRows = await exec("SELECT user_id, key, value FROM user_settings");
const covers = await exec("SELECT id FROM crawl_covers");
const globalRows = await exec("SELECT key, value FROM settings");
const withSearchUrls = userRows.filter((r) => r.key === "searchUrls" && String(r.value || "").includes("rent.591.com.tw")).length;

const norm = (list) => [...new Set((list || []).map((u) => String(u || "").trim()).filter(Boolean))].sort();
const pg = norm(keys);
const lite = sqliteKeys === null ? null : norm(sqliteKeys);
const diff = lite
  ? {
    onlyPg: pg.filter((k) => !lite.includes(k)).length,
    onlySqlite: lite.filter((k) => !pg.includes(k)).length,
    same: pg.filter((k) => lite.includes(k)).length,
  }
  : null;

console.log(`KEYS-SOURCES ${JSON.stringify({
  users: users.length, userSettingsRows: userRows.length, userSettingsWithUrls: withSearchUrls,
  covers: covers.length, globalSettingsRows: globalRows.length,
})}`);
console.log(`KEYS-PG ${JSON.stringify({ total: pg.length, sample: pg.slice(0, 3) })}`);
console.log(`KEYS-SQLITE ${JSON.stringify({ total: lite ? lite.length : null, sample: lite ? lite.slice(0, 3) : [], err: sqliteErr })}`);
console.log(`KEYS-DIFF ${JSON.stringify(diff)}`);
await drv.pool.end();
