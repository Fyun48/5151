// F3／kind 等價性探針（唯讀）。
//
// 目的：在動工之前，用**真實資料**證明「投影 kind_keys + SQL 述詞」與 Node 路徑的
// matchesHousingKind() 完全一致。不一致就不該實作（會靜默漏列／多列）。
//
// 用法（容器內）：
//   node --input-type=module < src/../scripts/kind-parity-probe.mjs            # 自動找 SQLite
//   DB=/app/data/5151.db node ... < kind-parity-probe.mjs --limit 3000
//
// 設計已由本探針的依據決定：
//   - 投影現有 kind 欄位是 housingTypeLabel()（顯示標籤）≠ kind 篩選用的 key。
//   - 正確語意來源是 matchesHousingKind(listing, kindArg)（floors.js:305）。
//   - 因此計畫新增 kind_keys（由 listingMatchesKindKey 逐 key 產生，逗號包裹），
//     SQL 以 LIKE '%,key,%' 表達「集合包含」，OR 群組（外觀／商用）直接對應。
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { listingMatchesKindKey, matchesHousingKind, normalizeListQuery } from "./src/floors.js";

const KIND_KEYS = [
  "elevator", "apartment", "building", "suite", "yafang", "share",
  "coliving", "suite_shared", "whole", "shop", "warehouse",
];

// 與 SQL 述詞完全對應的 JS 版本：kindKeys = ",elevator,building," 這種字串。
export function kindKeysFor(listing) {
  const keys = KIND_KEYS.filter((key) => listingMatchesKindKey(listing, key) === true);
  return keys.length ? `,${keys.join(",")},` : ",";
}

export function sqlPredicateMatches(kindKeys, requestedKeys) {
  // 每個請求 key 都要在集合內（Node 端 appearance/commercial 是 some()，已由 resolveHousingKinds 收斂）
  return requestedKeys.every((key) => kindKeys.includes(`,${key},`));
}

function findDb() {
  if (process.env.DB && existsSync(process.env.DB)) return process.env.DB;
  for (const dir of ["/app/data", "/app", "/data"]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (/\.(db|sqlite|sqlite3)$/i.test(name)) return join(dir, name);
    }
  }
  return "";
}

function main() {
  const limit = Number(process.argv[process.argv.indexOf("--limit") + 1]) || 2000;
  const dbPath = findDb();
  if (!dbPath) {
    console.log(JSON.stringify({ ok: false, reason: "sqlite_not_found", hint: "pass DB=<path>" }));
    return;
  }
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });

  const queries = ["", "elevator", "apartment", "building", "suite", "whole", "shop",
    "apartment,building", "suite,yafang", "coliving,share"];
  const resolved = queries.map((arg) => ({
    arg,
    keys: normalizeListQuery("all", arg, "").kinds,
  }));

  const rows = db.prepare(`SELECT * FROM listings LIMIT ?`).all(limit);

  const stats = { scanned: rows.length, dbPath, queries: {}, mismatches: [] };
  for (const item of resolved) {
    let match = 0;
    let mismatch = 0;
    for (const row of rows) {
      const node = matchesHousingKind(row, item.arg) === true;
      const sql = item.keys.length ? sqlPredicateMatches(kindKeysFor(row), item.keys) : true;
      if (node === sql) { if (node) match += 1; continue; }
      mismatch += 1;
      if (stats.mismatches.length < 5) {
        stats.mismatches.push({
          kind: item.arg, post_id: row.post_id, node, sql,
          nodeTrueSqlFalse: node && !sql, nodeFalseSqlTrue: !node && sql,
          kind_name: String(row.kind_name || "").slice(0, 40),
          keys: kindKeysFor(row),
        });
      }
    }
    stats.queries[item.arg || "(empty)"] = { nodeMatched: match, mismatch };
  }
  stats.ok = Object.values(stats.queries).every((q) => q.mismatch === 0);
  console.log(JSON.stringify(stats));
}

main();
