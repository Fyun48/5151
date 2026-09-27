// PostgreSQL identity 序列健檢／修復（2026-09-27）。
//
// 為什麼需要這支：資料從 SQLite 匯入 PG 時，資料列是**帶著明確 id** 進去的，
// 但 identity 序列沒有跟著前進（pg_dump／importStore 之後的典型狀態
// `last_value=<max> AND is_called=false`）。此時 `nextval()` 會回傳**已經存在的 max**，
// 於是任何「不指定 id 的 INSERT」都會撞主鍵：
//
//   duplicate key value violates unique constraint "<table>_pkey"
//
// 2026-09-27 在正式站實測到 **9 個** identity 欄位處於這個狀態，其中 `admin_audit.id`
// 讓 #521 之後的**每一筆**管理員稽核寫入都失敗——而且被 `auditReq()` 的
// fire-and-forget `.catch(() => {})` 完全吞掉，所以 12 天來沒有人發現
// （`admin_audit` 只有 1 列，日期 2026-09-15，就是匯入的那一列）。
//
// 用法：
//   # 唯讀檢查（任何 URL 都可以，預設）
//   PG_SEQ_URL='postgres://…' node v3/scripts/pg-identity-sequences.mjs --check
//
//   # 修復（**會寫入**：只動序列，不動任何資料列）
//   PG_SEQ_URL='postgres://…' node v3/scripts/pg-identity-sequences.mjs \
//     --repair --apply --database 5151_shadow
//
// 安全設計：
//   * `--check` 是唯讀，不做任何 setval。
//   * `--repair` 必須同時給 `--apply` 與 `--database <名稱>`，且名稱要與 URL 裡的資料庫相符。
//     這是刻意的摩擦：正式站修復應該看得出來是有意識的動作。
//   * 只執行 `setval()`；**不碰任何資料列**，可用 setval 回舊值完全回溯。
import { Client } from "pg";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? "" : String(args[i + 1] || "");
};

const URL_RAW = String(valueOf("--url") || process.env.PG_SEQ_URL || "").trim();
const MODE = has("--repair") ? "repair" : "check";
const APPLY = has("--apply");
const NAMED_DB = valueOf("--database");

if (!URL_RAW) {
  console.error("缺少連線字串：請設 PG_SEQ_URL 或給 --url <postgres://…>");
  process.exit(2);
}
let dbName = "";
try { dbName = new URL(URL_RAW).pathname.replace(/^\//, ""); } catch { /* 交給連線層報錯 */ }

if (MODE === "repair") {
  if (!APPLY) {
    console.error(`拒絕執行：--repair 必須同時給 --apply（目標資料庫：${dbName || "?"}）`);
    process.exit(2);
  }
  if (!NAMED_DB || NAMED_DB !== dbName) {
    console.error(`拒絕執行：--repair 必須用 --database <名稱> 明確指名目標，且要與 URL 相符`
      + `（URL 是 "${dbName || "?"}"，你給的是 "${NAMED_DB || "(未給)"}"）`);
    process.exit(2);
  }
}

const client = new Client({ connectionString: URL_RAW });
await client.connect();

const who = (await client.query("SELECT current_database() AS db, inet_server_addr() AS addr, version() AS v")).rows[0];
console.log(`[seq] 目標：db=${who.db} addr=${who.addr} ${String(who.v).split(",")[0]}`);
console.log(`[seq] 模式：${MODE}${MODE === "repair" ? "（會寫入序列）" : "（唯讀）"}`);

// 逐一比對每個 identity 欄位的「下一個值」與「目前的 max」。刻意不用單一 SQL 拼出來，
// 因為動態表名／欄名要安全地帶進查詢，逐表處理最不容易出錯。
const columns = (await client.query(
  `SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND is_identity = 'YES'
    ORDER BY table_name, column_name`,
)).rows;

const problems = [];
for (const { table_name: table, column_name: column } of columns) {
  const seq = (await client.query("SELECT pg_get_serial_sequence($1,$2) AS s", [table, column])).rows[0]?.s;
  if (!seq) continue;
  const { m, n } = (await client.query(
    `SELECT COALESCE(max("${column}"),0) AS m, count(*) AS n FROM "${table}"`,
  )).rows[0];
  const { lv, is_called: isCalled } = (await client.query(`SELECT last_value AS lv, is_called FROM ${seq}`)).rows[0];
  const max = Number(m);
  const last = Number(lv);
  const next = isCalled === true ? last + 1 : last;
  if (next <= max) problems.push({ table, column, seq, max, last, isCalled: isCalled === true, rows: Number(n), next });
}

if (!problems.length) {
  console.log(`[seq] OK：${columns.length} 個 identity 欄位全部健康（next > max）`);
  await client.end();
  process.exit(0);
}

console.log(`[seq] 發現 ${problems.length}／${columns.length} 個 identity 序列落後：`);
for (const p of problems) {
  console.log(`  ${p.table}.${p.column}  rows=${p.rows} max=${p.max} seq.last_value=${p.last} is_called=${p.isCalled} -> next=${p.next}`);
}

if (MODE !== "repair") {
  console.log("\n[seq] 這是唯讀檢查，沒有變更任何東西。要修復請加 --repair --apply --database "
    + `${dbName || "<名稱>"}`);
  await client.end();
  process.exit(1);
}

console.log("\n[seq] 開始修復（只動序列）：");
for (const p of problems) {
  // max>0 → setval(seq, max, true)   ⇒ 下一個 nextval 是 max+1
  // max=0 → setval(seq, 1, false)    ⇒ 下一個 nextval 是 1（空表）
  const to = p.max > 0 ? p.max : 1;
  const called = p.max > 0;
  await client.query("SELECT setval($1, $2::bigint, $3)", [p.seq, to, called]);
  const after = (await client.query(`SELECT last_value AS lv, is_called FROM ${p.seq}`)).rows[0];
  const nextAfter = after.is_called === true ? Number(after.lv) + 1 : Number(after.lv);
  const ok = nextAfter > p.max;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${p.table}.${p.column}: setval(${p.seq}, ${to}, ${called}) -> next=${nextAfter} (max=${p.max})`);
  if (!ok) {
    console.error("[seq] 修復後仍然落後，中止");
    await client.end();
    process.exit(1);
  }
}

console.log("\n[seq] 修復完成。請重跑 --check 確認全綠。");
await client.end();
