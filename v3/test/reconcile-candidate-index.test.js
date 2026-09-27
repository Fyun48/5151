// 迴歸鎖：same-house reconcile 候選查詢必須保持「PostgreSQL 可用索引」的形狀。
//
// 為什麼要有這個檔（2026-09-26 上線失敗）：
//   該查詢位於 crawler 逐筆熱路徑（watcher 明細增強後呼叫）。原版的 geo 分支寫成
//   `ABS(lat - ?) < 0.002`，是對欄位做運算，PG 無法使用 btree 索引；而 PostgreSQL 只有在
//   **每一個 OR 分支都可索引** 時才會用 BitmapOr，只要一個分支不可索引就退回全表掃描。
//   結果：127k 筆全表掃描、每次約 300ms、5 分鐘被執行 993 次，crawl 週期永遠跑不完。
//
//   當時沒有任何測試抓得到「查詢很慢」這件事。這個檔把「查詢形狀」釘住，
//   讓它不能被改回不可索引的形式；真正的端到端防護是對真 PG 的 EXPLAIN 與 crawl 週期測試。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { blockMatchCandidatesQuery, GEO_TOLERANCE } from "../src/sameHouseReconcile.js";
import { toPostgresSql } from "../src/sqlDialect.js";

const incoming = {
  post_id: 12345,
  address: "台中市西屯區台灣大道三段100號",
  community_name: "市政香榭",
  lat: 24.1652,
  lng: 120.6401,
};

// fixtureColumn: true → 不需要 db，這是純函式路徑。
function pgSql(overrides = {}) {
  const { sql, params } = blockMatchCandidatesQuery(null, { ...incoming, ...overrides }, { fixtureColumn: true });
  assert.ok(sql, "查詢應被產生");
  return { sql: toPostgresSql(sql), params };
}

// 把 SQL 正規化成「PG 剖析樹等價」的代理形式：
//   - 字串常數**外面**的空白收斂成單一空格、並去掉 ( , ) 旁的空白（PG 不在意這些）；
//   - 字串常數**裡面**的內容逐字保留（' ' 與 '  ' 是不同常數，運算式就不相等，索引不會被使用）。
// 若不區分這兩者，改動 migration 裡的字串常數時測試不會失敗，守衛就是空的。
function normalizeSql(sql) {
  let out = "";
  let inLiteral = false;
  const pushSpace = () => {
    if (!out) return;
    const last = out[out.length - 1];
    if (last === " " || last === "(" || last === ",") return;
    out += " ";
  };
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'") {
      if (inLiteral && sql[i + 1] === "'") { out += "''"; i += 1; continue; }
      inLiteral = !inLiteral;
      out += ch;
      continue;
    }
    if (!inLiteral) {
      if (/\s/.test(ch)) { pushSpace(); continue; }
      if (ch === ")" || ch === ",") {
        while (out.endsWith(" ")) out = out.slice(0, -1);
      }
    }
    out += ch;
  }
  return out.toLowerCase();
}

test("geo 分支不得對欄位做運算（ABS 會讓索引失效）", () => {
  const { sql } = pgSql();
  assert.doesNotMatch(sql, /ABS\s*\(/i, "ABS(欄位) 會使 btree 索引無法使用，造成全表掃描");
});

test("geo 分支必須是嚴格的範圍條件，可走 (lat, lng) 索引", () => {
  const { sql, params } = pgSql();
  assert.match(sql, /lat\s*>\s*\$\d+\s+AND\s+lat\s*<\s*\$\d+/i);
  assert.match(sql, /lng\s*>\s*\$\d+\s+AND\s+lng\s*<\s*\$\d+/i);

  // 參數必須成對出現為 L±T（下界、上界相鄰），且維持原本 0.002 的容差
  // （改到這個值會改變塊配對結果）。
  const latLo = params.indexOf(incoming.lat - GEO_TOLERANCE);
  const lngLo = params.indexOf(incoming.lng - GEO_TOLERANCE);
  assert.ok(latLo >= 0, `params 應含 lat 下界 ${incoming.lat - GEO_TOLERANCE}`);
  assert.equal(params[latLo + 1], incoming.lat + GEO_TOLERANCE, "lat 上界必須緊接在下界之後");
  assert.ok(lngLo >= 0, `params 應含 lng 下界 ${incoming.lng - GEO_TOLERANCE}`);
  assert.equal(params[lngLo + 1], incoming.lng + GEO_TOLERANCE, "lng 上界必須緊接在下界之後");
  assert.equal(GEO_TOLERANCE, 0.002, "容差不得變動，否則同屋配對結果會改變");
});

test("三個 OR 分支都必須存在，否則 PG 會放棄 BitmapOr", () => {
  const { sql } = pgSql();
  // (a) 正規化地址 LIKE、(b) 正規化社區等號、(c) 座標範圍
  assert.match(sql, /replace\(replace\(COALESCE\(address,\s*''\),\s*' ',\s*''\),\s*'-',\s*''\)\s*LIKE/i);
  assert.match(sql, /replace\(COALESCE\(community_name,\s*''\),\s*' ',\s*''\)\s*=/i);
  assert.match(sql, /lat\s*>/i);
});

test("正規化本身必須分辨字串常數內外的空白（否則這個守衛是空的）", () => {
  assert.notEqual(normalizeSql("f(a, ' ')"), normalizeSql("f(a, '  ')"));
  assert.equal(normalizeSql("f(\n  a,\n  b )"), normalizeSql("f(a,b)"));
});

test("地址與社區的比對運算式必須與 002_pg_reconcile_indexes.sql 的索引運算式逐字相同", () => {
  // 索引運算式與查詢運算式只要差一個字元，PG 就不會使用該索引，而且**不會報錯**，
  // 只會安靜地退回全表掃描 —— 那正是 2026-09-26 停擺的形狀。
  // 這裡真的去讀 migration 檔，所以改了 .sql 而沒改查詢（或反之）就會失敗。
  const migration = readFileSync(
    new URL("../migrations/002_pg_reconcile_indexes.sql", import.meta.url),
    "utf8",
  );
  // 一定要先去掉註解：該檔的註解裡也寫了同樣的運算式（當說明用），
  // 若直接比對整個檔案，就算真正的索引定義被改壞，也會在註解裡找到而誤判通過。
  const executable = migration
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
  const { sql } = pgSql();

  const expressions = [
    "replace(replace(COALESCE(address, ''), ' ', ''), '-', '')",
    "replace(COALESCE(community_name, ''), ' ', '')",
  ];
  for (const expression of expressions) {
    assert.ok(
      normalizeSql(executable).includes(normalizeSql(expression)),
      `migration 檔的可執行語句缺少索引運算式：${expression}`,
    );
    assert.ok(
      normalizeSql(sql).includes(normalizeSql(expression)),
      `查詢缺少索引運算式：${expression}`,
    );
  }

  // geo 分支的範圍條件必須對應 (lat, lng) 索引，且索引必須存在。
  assert.match(migration, /CREATE INDEX[^;]*ON listings \(lat, lng\)/i, "(lat, lng) 索引必須存在");
  assert.match(migration, /USING gin/i, "地址的前導萬用字元比對需要 trigram GIN 索引");
  assert.match(migration, /CREATE EXTENSION IF NOT EXISTS pg_trgm/i, "trigram GIN 需要 pg_trgm");
});

test("沒有可用的阻塞條件時不得產生查詢", () => {
  const { sql } = blockMatchCandidatesQuery(
    null,
    { post_id: 1, address: "", community_name: "", lat: 0, lng: 0 },
    { fixtureColumn: true },
  );
  assert.equal(sql, null);
});
