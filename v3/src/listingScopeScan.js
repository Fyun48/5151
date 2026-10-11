// A 方案（2026-10-11 第二刀）：**一趟掃描**同時滿足 list 與 stats 兩個不同範圍的候選需求。
//
// 為什麼要做：現況是
//   ① stats 先掃一份「會員整體池」的寬候選（42 欄窄載體）
//   ② list 再下 `SELECT post_id FROM listings WHERE <list_where>` 把範圍縮到本請求的行政區／篩選
// ⇒ 同一個請求對 `listings` 掃兩次（正式站 `cand;dur` 0.27–0.60s、窗口內 FETCH 佔比可觀）。
//
// 一趟掃描的形狀：
//   SELECT <candidateColumns>, (S_list) AS in_list_scope, (S_stats) AS in_stats_scope
//     FROM listings
//    WHERE <COMMON> AND ((S_stats) OR (S_list))
// 其中 `stats_where = COMMON ∧ S_stats`、`list_where = COMMON ∧ S_list`
// （COMMON ＝ `searchWhere` ＋ `listingVisibilityClauses`，兩邊逐字相同、由 `assertSharedPrefix` 驗證）。
//
// 為什麼這樣**不會**少算或多算：
//   * `WHERE (S_stats OR S_list)` 是兩個範圍的聯集 ⇒ 任一邊完整的候選集合都在結果裡（紅線 1：
//     不准 LIMIT／不准抽樣；這裡沒有 LIMIT，`totalMatched` 仍由完整候選集合決定）。
//   * 每一列另外帶 `in_stats_scope`／`in_list_scope` 兩個布林，**取用端各自只取自己那一側**：
//     stats 用 `in_stats_scope` 的列（＝原本 `WHERE stats_where` 的列，逐列相同）、
//     list 用 `in_list_scope` 的列（＝原本 `WHERE list_where` 的列，逐列相同）。
//     所以「聯集」只是為了省一趟掃描，兩個範圍本身都沒有被放寬或糊掉。
//   * 沒有可取用的位置（述詞不共用前綴、非 PG、旗標讀不到）時回 `null`，呼叫端走原本的兩趟。
import { LIST_CANDIDATE_KEYS } from "./listingCandidateRow.js";
import { readPgRows } from "./pgReadSnapshot.js";
import { toPostgresSql, translateSqliteToPg } from "./sqlDialect.js";

/** 一條 clause 佔幾個 `?` 佔位符（builder 是 SQLite 風格，轉譯器同時能數）。 */
function placeholderCount(clause) {
  return translateSqliteToPg(String(clause)).placeholders;
}

/**
 * 兩個範圍的**共同前綴**：逐條比對 clause 字串與其對應的參數。
 * ⚠️ 一條 clause 可能吃掉多個參數（例如 `search_key IN (?,?,…)`），所以參數切點必須用
 * `?` 的數量算，不能一條 clause 配一個參數（實測踩過：163 個參數對 58 個佔位符）。
 */
function sharedPrefixLength(a, b) {
  const max = Math.min(a.clauses.length, b.clauses.length);
  let clauses = 0;
  let params = 0;
  while (clauses < max) {
    if (String(a.clauses[clauses]) !== String(b.clauses[clauses])) break;
    const need = placeholderCount(a.clauses[clauses]);
    if (params + need > a.params.length || params + need > b.params.length) break;
    let same = true;
    for (let i = 0; i < need; i += 1) {
      if (JSON.stringify(a.params[params + i]) !== JSON.stringify(b.params[params + i])) { same = false; break; }
    }
    if (!same) break;
    params += need;
    clauses += 1;
  }
  return { clauses, params };
}

/** 把範圍切成 `[共同前綴, 其餘]`（參數依同一個切點）。 */
function splitClauses(scope, prefix) {
  return {
    head: scope.clauses.slice(0, prefix.clauses),
    headParams: scope.params.slice(0, prefix.params),
    rest: scope.clauses.slice(prefix.clauses),
    restParams: scope.params.slice(prefix.params),
  };
}

const andOf = (clauses) => clauses.map((c) => `(${String(c).trim()})`).join(" AND ");

/**
 * 建「一趟掃描」的 SQL 與參數。`?` 佔位符交給驅動端翻譯，參數順序與 `?` 出現順序一致：
 *   [S_list(旗標), S_stats(旗標), COMMON, S_stats(WHERE), S_list(WHERE)]
 * （S_stats／S_list 各出現兩次：一次在 WHERE 的聯集、一次在旗標運算式。）
 *
 * 回傳 `null` 表示不能共用（沒有共同前綴）。
 */
export function buildScopeScanQuery({ candidateColumns, statsScope, listScope } = {}) {
  const prefix = sharedPrefixLength(statsScope, listScope);
  if (prefix.clauses < 1) return null;
  const stats = splitClauses(statsScope, prefix);
  const list = splitClauses(listScope, prefix);
  // 兩邊的「其餘述詞」都必須存在：只有 COMMON 的範圍是沒有限制的全表（不可能發生，但不要猜）。
  const statsRest = stats.rest.length ? andOf(stats.rest) : "TRUE";
  const listRest = list.rest.length ? andOf(list.rest) : "TRUE";
  const common = andOf(stats.head);
  // 主查詢**只帶 42 欄**（不多帶旗標）⇒ 與 `pgCandidateContent` 的 `PREFIX` 逐字相符、
  // 內容備忘照樣命中；旗標走「版本預讀」那一趟（`extraColumns`）。
  const unionWhere = `WHERE ${common} AND ((${statsRest}) OR (${listRest}))`;
  const sql = `SELECT ${candidateColumns} FROM listings ${unionWhere}`;
  // 參數順序＝`?` 在該段 SQL 裡出現的順序：COMMON → statsRest → listRest。
  const params = [...stats.headParams, ...stats.restParams, ...list.restParams];
  const expected = translateSqliteToPg(sql).placeholders;
  if (expected !== params.length) {
    throw new Error(`listingScopeScan: SQL 有 ${expected} 個佔位符，但參數有 ${params.length} 個`);
  }
  return {
    sql, params, unionWhere,
    // 版本預讀那一趟的旗標運算式（順序＝SELECT 內出現的順序：list 先、stats 後）。
    listFlagSql: listRest, listFlagParams: list.restParams,
    statsFlagSql: statsRest, statsFlagParams: stats.restParams,
    commonClauses: stats.head, statsRestClauses: stats.rest, listRestClauses: list.rest,
  };
}

/**
 * 跑這一趟掃描並把列分成兩側。
 *
 * 回傳 `{ statsRows, listRows, rows }`（`rows` 是全部列，順序＝SQL 回來的順序；
 * 兩側各自保留 SQL 的相對順序，呼叫端要排序時自己排——list 端本來就會 `orderCandidateRowsByPostId`）。
 * 回傳 `null` 表示不能共用（呼叫端走兩趟）。
 */
export async function runScopeScan(pgDriver, { candidateColumns, statsScope, listScope } = {}) {
  const query = buildScopeScanQuery({ candidateColumns, statsScope, listScope });
  if (!query) return null;
  const flags = [];
  const onRow = (values) => flags.push([values[0] === true, values[1] === true]);
  // 主查詢維持「以 42 欄開頭」⇒ 內容備忘（`pgCandidateContent` 的 store）照樣命中；
  // 兩個旗標掛在**版本預讀**那一趟（`extraColumns`），與列逐列對齊。
  //
  // ⚠️ 版本預讀那條 SQL 是 `SELECT <version 欄><旗標> FROM listings <主查詢的 WHERE>`：
  //    主查詢的 WHERE 已經翻譯成 `$1..$k`，旗標則是原始的 `?` ⇒ 必須把旗標翻成 `$k+1..`
  //    （PG 不在意 `$n` 在文字裡的順序，只看編號與參數陣列對不對得上）。
  const mainSql = toPostgresSql(query.sql);
  const k = translateSqliteToPg(query.sql).placeholders;
  const shift = (fragment, offset) => toPostgresSql(fragment).replace(/\$(\d+)/g, (_, d) => `$${Number(d) + offset}`);
  // ⚠️ 兩個旗標片段的編號必須**連續**（list 先、stats 後），各自從 $1 起算會撞號
  //    （實測踩過：`double precision <= bigint[]` ⇒ 數值參數收到陣列值）。
  const listFlagSql = shift(query.listFlagSql, k);
  const statsFlagSql = shift(query.statsFlagSql, k + query.listFlagParams.length);
  const rows = await readPgRows(pgDriver, mainSql, query.params, {
    arrayRows: true,
    extraColumns: {
      selectSql: `, (${listFlagSql}) AS in_list_scope, (${statsFlagSql}) AS in_stats_scope`,
      params: [...query.listFlagParams, ...query.statsFlagParams],
      onRow,
    },
  });
  if (flags.length !== rows.length) {
    // 備忘沒走到（缺 store／身分不符）時旗標會缺 ⇒ 單獨查一次旗標（仍然只有一趟額外掃描）。
    flags.length = 0;
    const flagRows = await readPgRows(pgDriver, toPostgresSql(
      `SELECT post_id, (${query.listFlagSql}) AS in_list_scope, (${query.statsFlagSql}) AS in_stats_scope FROM listings ${query.unionWhere}`,
    ), [...query.listFlagParams, ...query.statsFlagParams, ...query.params], { arrayRows: true });
    const byId = new Map(flagRows.map((r) => [Number(r.post_id), [r.in_list_scope === true, r.in_stats_scope === true]]));
    for (const row of rows) {
      const f = byId.get(Number(row.post_id));
      if (!f) throw new Error(`listingScopeScan: 列 ${row.post_id} 沒有旗標`);
      flags.push(f);
    }
  }
  if (flags.length !== rows.length) {
    throw new Error(`listingScopeScan: 旗標數（${flags.length}）與列數（${rows.length}）不一致`);
  }
  const statsRows = [];
  const listRows = [];
  for (let i = 0; i < rows.length; i += 1) {
    const [inList, inStats] = flags[i];
    if (inStats) statsRows.push(rows[i]);
    if (inList) listRows.push(rows[i]);
  }
  return { rows, statsRows, listRows, sql: query.sql };
}

/** 測試／診斷用：`candidateColumns` 是否就是標準窄載體欄位。 */
export function isCandidateColumns(candidateColumns) {
  return String(candidateColumns || "").split(",").map((p) => p.trim()).join(",")
    === LIST_CANDIDATE_KEYS.join(",");
}
