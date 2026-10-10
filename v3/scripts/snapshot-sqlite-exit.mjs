#!/usr/bin/env node
// SQLite 退場「刪檔前最終證據固化」唯讀快照（P4）。
//
// 用途：在摘除三台節點的 `/data/v3.db*` **之前**，把「刪掉之後就再也拿不到」的證據固化成一份
// markdown：三邊列數對照、逐欄（欄名＋型別）SQLite ↔ PG 對照、檔案 size／mtime、關鍵時間戳、
// 零資料缺口複核、刪除前置條件。
//
// 逐欄對照（§二）是**刪檔門禁**的一部分：涵蓋 P2 宣稱「無欄位缺口」的 7 張表
// （`listings`／`listing_groups`／`listing_group_members`／`listing_import`／
// `system_announcements`／`settings`／`maps_usage_daily`），SQLite 側用 `PRAGMA table_info`、
// PG 側用 `information_schema.columns`，輸出「欄名集合差 ＋ 型別族對照」，
// 結尾固定印一行 `逐欄差異＝N 項`（門禁要 0）。
//
// 家族（連線／開關／防呆一律照抄既有腳本，不自己發明）：
//   - 連線與唯讀 SQLite：`v3/scripts/sqlite-consistency-snapshot.mjs:35`
//     （`new DatabaseSync(SOURCE, { readOnly: true })`）。
//   - PG 連線與 target 守衛：`v3/scripts/projection-freshness-check.mjs:13-17`
//     （`createPostgresDriver({ env })` ＋ `assertPgTargetAllowed()`）。
//   - 參數解析：`v3/scripts/cutover-backfill.mjs:50-63`（`--key value` 與 `--key=value` 皆可）。
//   - 型別族判定沿用 `v3/src/pgSchema.js:8-34` 的 `TYPE_MAP`／`pgTypeFor()` 語意。
//
// 安全性（fail-closed，這一支不寫任何東西）：
//   - 只做 `SELECT`／`PRAGMA`；每個語句進 DB 前先過 `assertReadOnlyStatement()`（結構性阻擋，
//     不是靠自律）。SQLite 一律 `readOnly: true`。
//   - 預設**拒絕**打正式 PG（`5151_shadow`）：要對正式庫快照必須明確設
//     `ALLOW_PRODUCTION_PG_TARGET=1`（`v3/src/domainToolGuards.js:26,65-76`，repo 現行做法）。
//     ⚠️ 守衛的錯誤訊息沿用共用文案（寫「這個工具會直接寫入目標庫」）；本工具其實**只讀**，
//     這句話是 `assertPgTargetAllowed()` 的既有字串，其他唯讀腳本（`projection-freshness-check.mjs`）也一樣。
//   - PG 連線字串**只從環境變數讀**（`--pg-url=<環境變數名稱>`，預設 `PG_URL`），
//     **不接受**把值寫在命令列，也**不列印**值（輸出只寫資料庫名稱）。
//
// 用法：
//   node v3/scripts/snapshot-sqlite-exit.mjs --sqlite=/data/v3.db --pg-url=PG_URL [--out=snapshot.md]
//                                            [--baseline=<既有快照.json>] [--label=<標記>]
//   node v3/scripts/snapshot-sqlite-exit.mjs --help
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { assertPgTargetAllowed, databaseNameFromUrl } from "../src/domainToolGuards.js";

export const TOOL = "snapshot-sqlite-exit";
export const DEFAULT_SQLITE = "/data/v3.db";
export const DEFAULT_PG_ENV = "PG_URL";
// 與同族腳本同一組允許清單（`v3/scripts/projection-freshness-check.mjs:17`）。
export const ALLOWED_PG_DBS = ["repro", "crawl_sandbox", "tracker_test", "repro2"];

/** 三邊對照表要看的關鍵表（與 `docs/handoffs/20261008-sqlite-exit-gap.md` §一.4 同一組，才對得上既有基線）。 */
export const KEY_TABLES = [
  "listings",
  "user_listing_flags",
  "listing_groups",
  "settings",
  "crawl_covers",
  "demand_posts",
];

/** 預期「全為 0」的三張表（migration v11 建立，正式 PG 尚未有資料 ⇒ 不補）。 */
export const ZERO_ROW_TABLES = ["member_support_code", "sponsor_entitlement_grant", "support_poll_cursor"];

/**
 * 逐欄（欄名＋型別）SQLite ↔ PG 對照的目標表。
 * 這是 P2 宣稱「無欄位缺口」的那 7 張（刪檔門禁要求「逐欄差異＝0 項」）。
 */
export const COLUMN_TABLES = [
  "listings",
  "listing_groups",
  "listing_group_members",
  "listing_import",
  "system_announcements",
  "settings",
  "maps_usage_daily",
];

/**
 * 型別「族」：SQLite 的宣告型別與 PG 的 `data_type` 字面本來就會不同
 * （`TEXT` vs `character varying`、`INTEGER` vs `bigint`），要判的是**同不同族**。
 * 族判定沿用 `v3/src/pgSchema.js:8-34` 的 `TYPE_MAP`／`pgTypeFor()` 那套語意（不另外發明）。
 */
export function typeFamily(declared) {
  const t = String(declared || "").trim().toUpperCase().replace(/^_/, "");
  if (!t) return "TEXT"; // SQLite 的「無型別」欄位存什麼都可以（同 pgTypeFor 的註解）
  if (/^(BIGINT|BIGSERIAL|INT|INTEGER|SMALLINT|SERIAL)$/.test(t)) return "INTEGER";
  if (/^(TEXT|VARCHAR|CHARACTER VARYING|CHAR|CHARACTER|CLOB|UUID|JSON|JSONB)$/.test(t)) return "TEXT";
  if (/^(TIMESTAMP.*|DATE|DATETIME)$/.test(t)) return "TIMESTAMP";
  if (/^(REAL|FLOAT|DOUBLE|DOUBLE PRECISION|NUMERIC|DECIMAL)$/.test(t)) return "FLOAT";
  if (/^(BLOB|BYTEA)$/.test(t)) return "BLOB";
  if (/^(BOOL|BOOLEAN)$/.test(t)) return "BOOLEAN";
  return t;
}

/** SQLite 側欄位內省（`PRAGMA table_info`，唯讀）。 */
export function sqliteColumnFacts(sqlitePath, tables = COLUMN_TABLES) {
  const out = {};
  if (!existsSync(sqlitePath)) return out;
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    for (const table of tables) {
      try {
        const rows = db.prepare(assertReadOnlyStatement(`PRAGMA table_info("${table}")`)).all();
        // ⚠️ 表不存在時 `PRAGMA table_info` 回**空陣列**而不是丟錯 ⇒ 要自己轉成 null，
        // 否則「PG 有、SQLite 沒有」會被誤判成「兩邊都沒有欄位」（等於漏掉整個缺口）。
        out[table] = rows.length
          ? rows.map((row) => ({ name: String(row.name), type: String(row.type || ""), pk: Number(row.pk) || 0 }))
          : null;
      } catch {
        out[table] = null;
      }
    }
  } finally {
    db.close();
  }
  return out;
}

/** PG 側欄位內省（`information_schema.columns`，唯讀）。 */
export async function pgColumnFacts(exec, tables = COLUMN_TABLES) {
  const out = {};
  for (const table of tables) {
    const res = await exec(assertReadOnlyStatement(
      "SELECT column_name, data_type, udt_name FROM information_schema.columns"
      + " WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
    ), [table]);
    const rows = res?.rows || [];
    out[table] = rows.length
      ? rows.map((row) => ({
        name: String(row.column_name),
        type: String(row.data_type === "ARRAY" ? row.udt_name : row.data_type),
      }))
      : null; // 表不存在（或沒有任何欄位）
  }
  return out;
}

/** 兩邊欄名集合差＋型別族比對；回傳每張表的差異與總數（門禁要 0）。 */
export function compareColumns(sqliteColumns, pgColumns, tables = COLUMN_TABLES) {
  const perTable = [];
  let diffTotal = 0;
  let rawTypeDiffs = 0;
  for (const table of tables) {
    const s = sqliteColumns?.[table];
    const p = pgColumns?.[table];
    const entry = {
      table,
      sqliteColumns: Array.isArray(s) ? s.length : null,
      pgColumns: Array.isArray(p) ? p.length : null,
      onlySqlite: [],
      onlyPg: [],
      typeDiffs: [],
      rawTypeDiffs: [],
      absentBoth: !Array.isArray(s) && !Array.isArray(p),
    };
    if (Array.isArray(s) && Array.isArray(p)) {
      const sMap = new Map(s.map((c) => [c.name, c.type]));
      const pMap = new Map(p.map((c) => [c.name, c.type]));
      entry.onlySqlite = [...sMap.keys()].filter((name) => !pMap.has(name));
      entry.onlyPg = [...pMap.keys()].filter((name) => !sMap.has(name));
      for (const [name, sType] of sMap) {
        if (!pMap.has(name)) continue;
        const pType = pMap.get(name);
        if (typeFamily(sType) !== typeFamily(pType)) entry.typeDiffs.push({ name, sqlite: sType, pg: pType });
        else if (String(sType).toUpperCase() !== String(pType).toUpperCase()) entry.rawTypeDiffs.push({ name, sqlite: sType, pg: pType });
      }
    } else if (Array.isArray(s)) {
      // PG 端整張表不存在 ⇒ 每一個 SQLite 欄位都是一個缺口（不能只算 1 項）。
      entry.onlySqlite = s.map((c) => c.name);
    } else if (Array.isArray(p)) {
      entry.onlyPg = p.map((c) => c.name);
    }
    // 兩邊都沒有這張表 ⇒ **不算差異**（不是缺口），但在報告裡標出來，免得被靜默忽略。
    entry.diff = entry.onlySqlite.length + entry.onlyPg.length + entry.typeDiffs.length;
    diffTotal += entry.diff;
    rawTypeDiffs += entry.rawTypeDiffs.length;
    perTable.push(entry);
  }
  return { tables: perTable, diffTotal, rawTypeDiffs };
}


/** 站內刊登的 6 個 `self_mrt_*` 查證欄位（見 `v3/src/selfListingsAsync.js:374-383`）。 */
export const SELF_MRT_COLUMNS = [
  "self_mrt_state",
  "self_mrt_station",
  "self_mrt_walk_m",
  "self_mrt_nearest_m",
  "self_mrt_source",
  "self_mrt_checked_at",
];

/** 唯讀語句白名單：任何不是 SELECT／WITH／PRAGMA 的語句一律拒絕。 */
const READ_ONLY_SQL = /^\s*(?:SELECT|WITH|PRAGMA)\b/i;

/**
 * 結構性唯讀防呆：把「不寫入」變成程式碼保證，而不是註解上的承諾。
 * @param {string} sql
 * @returns {string} 原語句（方便直接串進呼叫）
 */
export function assertReadOnlyStatement(sql) {
  const text = String(sql || "");
  if (!READ_ONLY_SQL.test(text)) {
    throw new Error(`${TOOL}：只允許 SELECT／WITH／PRAGMA 語句，拒絕執行：${text.slice(0, 80)}`);
  }
  return sql;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      if (token !== "-h") out._.push(token);
      else out.help = true;
      continue;
    }
    const eq = token.indexOf("=");
    let name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    let value;
    if (eq !== -1) {
      value = token.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      value = next && !next.startsWith("--") ? next : true;
      if (value !== true) i += 1;
    }
    if (name === "help" || name === "h") out.help = true;
    else out[name] = value;
  }
  return out;
}

export const USAGE = [
  `usage: node v3/scripts/${TOOL}.mjs [--sqlite=<path>] [--pg-url=<ENV_NAME>] [--out=<file.md>] [--baseline=<file.json>] [--sample-seconds=<n>] [--label=<text>]`,
  "",
  "  --sqlite=<path>      節點 SQLite 檔（預設 /data/v3.db）。唯讀開啟。",
  "  --pg-url=<ENV_NAME>  **PG 連線字串所在的環境變數名稱**（預設 PG_URL）。不接受連線字串本身。",
  "  --out=<file.md>      把 markdown 寫檔（預設只印 stdout）。",
  "  --baseline=<file>    既有凍結快照 JSON（可選，第三欄）。",
  "  --label=<text>       這份快照的標記（例如 p4-pre-removal）。",
  "  --sample-seconds=<n> 做雙取樣（建議 61）：間隔 n 秒再取一次 size／mtime，證明 -wal 逐 byte 不動。",
  "  --help               印出本說明。",
  "",
  `  正式 PG 目標預設被拒；要對正式庫快照需明確設 ALLOW_PRODUCTION_PG_TARGET=1。`,
].join("\n");

// ---------------------------------------------------------------------------
// 既有基線（可選）：容忍幾種既有快照形狀（manifest／{tables}／{counts}／扁平淡）。
// ---------------------------------------------------------------------------
export function normalizeBaseline(value) {
  const out = {};
  if (!value || typeof value !== "object") return out;
  for (const source of [value, value.tables, value.counts]) {
    if (!source || typeof source !== "object") continue;
    for (const [key, raw] of Object.entries(source)) {
      if (raw && typeof raw === "object") continue;
      const name = String(key).startsWith("count_") ? String(key).slice("count_".length) : String(key);
      const n = Number(raw);
      if (Number.isFinite(n)) out[name] = n;
    }
  }
  return out;
}

function readBaseline(file) {
  if (!file || file === true) return { path: null, counts: {} };
  const parsed = JSON.parse(readFileSync(String(file), "utf8"));
  return { path: String(file), counts: normalizeBaseline(parsed) };
}

// ---------------------------------------------------------------------------
// SQLite 端（唯讀）
// ---------------------------------------------------------------------------
function fileFacts(file) {
  if (!existsSync(file)) return { path: file, exists: false, bytes: null, mtime: null };
  const st = statSync(file);
  return { path: file, exists: true, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString() };
}

/** 三個檔案的 size／mtime（雙取樣用，不開 DB）。 */
export function statSqliteFiles(sqlitePath) {
  return {
    db: fileFacts(sqlitePath),
    wal: fileFacts(`${sqlitePath}-wal`),
    shm: fileFacts(`${sqlitePath}-shm`),
  };
}

/** 雙取樣逐欄比對：回傳「是否完全不動」（size 與 mtime 都要一致才算不動）。 */
export function compareSamples(before, after) {
  const same = (a, b) => Boolean(a && b) && a.exists === b.exists && a.bytes === b.bytes && a.mtime === b.mtime;
  return { db: same(before?.db, after?.db), wal: same(before?.wal, after?.wal), shm: same(before?.shm, after?.shm) };
}

function tryCount(query) {
  try {
    const row = query();
    const n = Number(row?.n);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function collectSqliteFacts(sqlitePath) {
  const files = statSqliteFiles(sqlitePath);
  const facts = { path: sqlitePath, files, counts: {}, timestamps: {}, gap: {}, missingTables: [] };
  if (!files.db.exists) return facts;

  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    for (const table of KEY_TABLES) {
      facts.counts[table] = tryCount(() =>
        db.prepare(assertReadOnlyStatement(`SELECT COUNT(*) AS n FROM "${table}"`)).get());
      if (facts.counts[table] === null) facts.missingTables.push(table);
    }
    facts.timestamps.schemaMigrations = (() => {
      try {
        const row = db.prepare(assertReadOnlyStatement(
          "SELECT COUNT(*) AS n, MAX(applied_at) AS last_applied FROM schema_migrations",
        )).get();
        return { rows: Number(row?.n) || 0, lastAppliedAt: row?.last_applied ?? null };
      } catch {
        return { rows: null, lastAppliedAt: null };
      }
    })();

    // 零資料缺口複核（刪檔前必須再次確認）
    facts.gap.feeIncludesNonEmpty = tryCount(() => db.prepare(assertReadOnlyStatement(
      "SELECT COUNT(*) AS n FROM listings WHERE fee_includes IS NOT NULL AND TRIM(fee_includes) <> ''",
    )).get());
    facts.gap.selfMrt = {};
    for (const column of SELF_MRT_COLUMNS) {
      facts.gap.selfMrt[column] = tryCount(() => db.prepare(assertReadOnlyStatement(
        `SELECT COUNT(*) AS n FROM listings WHERE "${column}" IS NOT NULL`,
      )).get());
    }
    facts.gap.zeroRowTables = {};
    for (const table of ZERO_ROW_TABLES) {
      facts.gap.zeroRowTables[table] = tryCount(() =>
        db.prepare(assertReadOnlyStatement(`SELECT COUNT(*) AS n FROM "${table}"`)).get());
      if (facts.gap.zeroRowTables[table] === null) facts.missingTables.push(table);
    }

    facts.journalMode = (() => {
      try {
        return db.prepare(assertReadOnlyStatement("PRAGMA journal_mode")).get()?.journal_mode ?? null;
      } catch {
        return null;
      }
    })();
  } finally {
    db.close();
  }
  return facts;
}

// ---------------------------------------------------------------------------
// PG 端（唯讀；`exec(sql, params) => Promise<{ rows }>`，測試可注入 stub）
// ---------------------------------------------------------------------------
export async function collectPgFacts(exec, { tables = KEY_TABLES } = {}) {
  const exists = async (name) => {
    const res = await exec(assertReadOnlyStatement("SELECT to_regclass($1) IS NOT NULL AS present"), [`public.${name}`]);
    return res?.rows?.[0]?.present === true;
  };

  const facts = { counts: {}, timestamps: {}, gap: {}, missingTables: [] };
  for (const table of tables) {
    if (!(await exists(table))) {
      facts.counts[table] = null;
      facts.missingTables.push(table);
      continue;
    }
    const res = await exec(assertReadOnlyStatement(`SELECT COUNT(*)::bigint AS n FROM "${table}"`));
    facts.counts[table] = Number(res?.rows?.[0]?.n) || 0;
  }

  facts.timestamps.schemaMigrations = { rows: null, lastAppliedAt: null };
  if (await exists("schema_migrations")) {
    const res = await exec(assertReadOnlyStatement(
      "SELECT COUNT(*)::bigint AS n, MAX(applied_at) AS last_applied FROM schema_migrations",
    ));
    const row = res?.rows?.[0] || {};
    facts.timestamps.schemaMigrations = {
      rows: Number(row.n) || 0,
      lastAppliedAt: row.last_applied ? new Date(row.last_applied).toISOString() : null,
    };
  }

  facts.timestamps.coversMaxLastRunAt = null;
  if (await exists("crawl_covers")) {
    const res = await exec(assertReadOnlyStatement("SELECT MAX(last_run_at) AS max_last_run_at FROM crawl_covers"));
    const value = res?.rows?.[0]?.max_last_run_at ?? null;
    facts.timestamps.coversMaxLastRunAt = value == null ? null : String(value);
  }

  facts.gap.feeIncludesNonEmpty = null;
  facts.gap.selfMrt = {};
  facts.gap.zeroRowTables = {};
  if (await exists("listings")) {
    const columnPresent = async (column) => {
      const res = await exec(assertReadOnlyStatement(
        "SELECT COUNT(*)::bigint AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'listings' AND column_name = $1",
      ), [column]);
      return Number(res?.rows?.[0]?.n) > 0;
    };
    if (await columnPresent("fee_includes")) {
      const res = await exec(assertReadOnlyStatement(
        "SELECT COUNT(*)::bigint AS n FROM listings WHERE fee_includes IS NOT NULL AND BTRIM(fee_includes) <> ''",
      ));
      facts.gap.feeIncludesNonEmpty = Number(res?.rows?.[0]?.n) || 0;
    }
    for (const column of SELF_MRT_COLUMNS) {
      if (!(await columnPresent(column))) {
        facts.gap.selfMrt[column] = null;
        continue;
      }
      const res = await exec(assertReadOnlyStatement(
        `SELECT COUNT(*)::bigint AS n FROM listings WHERE "${column}" IS NOT NULL`,
      ));
      facts.gap.selfMrt[column] = Number(res?.rows?.[0]?.n) || 0;
    }
  }
  for (const table of ZERO_ROW_TABLES) {
    if (!(await exists(table))) {
      facts.gap.zeroRowTables[table] = null;
      facts.missingTables.push(table);
      continue;
    }
    const res = await exec(assertReadOnlyStatement(`SELECT COUNT(*)::bigint AS n FROM "${table}"`));
    facts.gap.zeroRowTables[table] = Number(res?.rows?.[0]?.n) || 0;
  }

  return facts;
}

// ---------------------------------------------------------------------------
// 判讀
// ---------------------------------------------------------------------------
/** `-wal` mtime 是「最後一次 SQLite 寫入」的判準；`-shm` 不可用（唯讀開啟就會推前）。 */
export function interpretSqliteWrite(files, { now = new Date() } = {}) {
  if (!files?.db?.exists) {
    return { lastWriteAt: null, basis: "none", text: "`-db` 不存在 ⇒ 這個節點已經沒有業務 SQLite 檔。" };
  }
  if (!files.wal?.exists) {
    return {
      lastWriteAt: files.db.mtime,
      basis: "db",
      text: `\`-wal\` 不存在（已 checkpoint 且無殘留 WAL）⇒ 以 \`-db\` mtime \`${files.db.mtime}\` 為「最後一次寫入」的上界；`
        + "判定本節點是否仍在被寫，仍要看 `-wal` 有沒有重新出現。",
    };
  }
  if (!files.wal.bytes) {
    return {
      lastWriteAt: null,
      basis: "wal-empty",
      text: `\`-wal\` 存在但 **0 B** ⇒ 沒有「已提交但未 checkpoint」的資料。`
        + `0 B 的 \`-wal\`／\`-shm\` 可能只是**唯讀開啟時建立**的，其 mtime \`${files.wal.mtime}\` **不可當寫入證據**；`
        + `此情況以 \`-db\` mtime \`${files.db.mtime}\` 為最後寫入的上界，並用 \`--sample-seconds=61\` 做雙取樣`
        + "（`-wal` 逐 byte 不動才代表不再被寫）。",
    };
  }
  const minutes = Math.round((now.getTime() - new Date(files.wal.mtime).getTime()) / 60000);
  return {
    lastWriteAt: files.wal.mtime,
    basis: "wal",
    text: `最後一次 SQLite 寫入＝\`-wal\` mtime \`${files.wal.mtime}\`（${files.wal.bytes.toLocaleString("en-US")} B，距今回報時 ${minutes} 分鐘）。`
      + "判準用 `-db`／`-wal`；**`-shm` mtime 不可當寫入證據**（唯讀開啟就會推前）。"
      + "要主張「已不再被寫」，請用 `--sample-seconds=61` 做雙取樣（逐 byte 不動）。",
  };
}

// ---------------------------------------------------------------------------
// 組報告與 markdown
// ---------------------------------------------------------------------------
export function buildSnapshot({ sqlite, pg = null, baseline = { path: null, counts: {} }, sample = null, columns = null, meta = {} }) {
  const write = interpretSqliteWrite(sqlite?.files, { now: meta.now instanceof Date ? meta.now : new Date() });
  return { tool: TOOL, sqlite, pg, baseline, sample, columns, write, meta };
}

function cell(value) {
  if (value === null || value === undefined) return "n/a";
  if (typeof value === "number") return value.toLocaleString("en-US");
  return String(value);
}

function bytesCell(facts) {
  if (!facts.exists) return "不存在";
  const mb = facts.bytes / (1024 * 1024);
  return `${facts.bytes.toLocaleString("en-US")} B（${mb.toFixed(1)} MiB）`;
}

export function renderMarkdown(snapshot) {
  const { sqlite, pg, baseline, write, meta } = snapshot;
  const pgDb = meta.pgDatabase || null;
  const pgColumnTitle = pgDb ? `PG \`${pgDb}\`` : "PG";
  const pgMissing = new Set(pg?.missingTables || []);
  const sqliteMissing = new Set(sqlite.missingTables || []);
  /** 表不存在（「不存在」）與「沒查」（n/a）要分得出來，否則會被誤讀成缺資料。 */
  const cellOf = (value, missing, table) => {
    if (value === null || value === undefined) {
      return missing.has(table) ? "不存在（無此表）" : "n/a";
    }
    return cell(value);
  };
  const lines = [];

  lines.push("# SQLite 退場最終快照（唯讀）");
  lines.push("");
  lines.push(`- 產生時間（UTC）：\`${new Date(meta.now instanceof Date ? meta.now : Date.now()).toISOString()}\``);
  lines.push(`- 標記：${meta.label ? `\`${meta.label}\`` : "（未指定）"}`);
  lines.push(`- 工具：\`v3/scripts/${TOOL}.mjs\``);
  lines.push(`- 節點 SQLite：\`${sqlite.path}\``);
  lines.push(`- PG 連線來源：環境變數 \`${meta.pgEnvName || DEFAULT_PG_ENV}\``
    + (pgDb ? `（資料庫 \`${pgDb}\`；**不列印連線字串值**）` : "（未提供 ⇒ PG 欄位皆 n/a）"));
  lines.push(`- 既有基線：${baseline.path ? `\`${baseline.path}\`` : "未提供"}`);
  lines.push("- 唯讀宣告：本工具只執行 `SELECT`／`PRAGMA`（每個語句都先過 `assertReadOnlyStatement()`），"
    + "SQLite 一律以 `{ readOnly: true }` 開啟。");
  lines.push("");

  // 一、三邊對照表
  lines.push("## 一、三邊對照表（列數）");
  lines.push("");
  lines.push(`| 表 | 節點 SQLite | ${pgColumnTitle} | 既有基線 | SQLite−PG |`);
  lines.push("|---|---|---|---|---|");
  for (const table of KEY_TABLES) {
    const s = sqlite.counts?.[table] ?? null;
    const p = pg?.counts?.[table] ?? null;
    const b = Object.prototype.hasOwnProperty.call(baseline.counts || {}, table) ? baseline.counts[table] : null;
    const diff = s !== null && p !== null ? s - p : null;
    lines.push(`| \`${table}\` | ${cellOf(s, sqliteMissing, table)} | ${pg ? cellOf(p, pgMissing, table) : "n/a"} | ${cell(b)} | ${diff === null ? "n/a" : diff.toLocaleString("en-US")} |`);
  }
  lines.push("");
  if (pgDb && pgDb !== "5151_shadow") {
    lines.push(`> ⚠️ 這一輪的 PG 欄位是隔離庫 \`${pgDb}\`（排練）。**刪檔前的最終快照必須對正式 PG \`5151_shadow\` 執行**，`
      + "屆時需明確設 `ALLOW_PRODUCTION_PG_TARGET=1`（預設拒絕打正式庫）。");
    lines.push("");
  }

  // 二、逐欄（欄名＋型別）對照
  lines.push("## 二、逐欄（欄名＋型別）SQLite ↔ PG 對照");
  lines.push("");
  lines.push(`涵蓋 P2 宣稱「無欄位缺口」的 ${COLUMN_TABLES.length} 張表：`
    + COLUMN_TABLES.map((t) => `\`${t}\``).join("、") + "。");
  lines.push("");
  if (!snapshot.columns || !pg) {
    lines.push("> PG 未提供 ⇒ 逐欄對照 **n/a**（刪檔門禁不成立，請對正式 PG `5151_shadow` 再跑一次）。");
    lines.push("");
  } else {
    const { tables: rows, diffTotal, rawTypeDiffs } = snapshot.columns;
    lines.push("| 表 | SQLite 欄數 | PG 欄數 | 只在 SQLite | 只在 PG | 型別不同族 | 逐欄差異 |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const row of rows) {
      lines.push(`| \`${row.table}\` | ${cell(row.sqliteColumns)} | ${cell(row.pgColumns)} | `
        + `${row.onlySqlite.length} | ${row.onlyPg.length} | ${row.typeDiffs.length} | ${row.diff} |`);
    }
    lines.push("");
    const absentBoth = rows.filter((r) => r.absentBoth);
    if (absentBoth.length) {
      lines.push(`> ⚠️ 兩邊都沒有這張表（**不算差異**，但要有人看一眼是不是表名寫錯）：`
        + `${absentBoth.map((r) => `\`${r.table}\``).join("、")}`);
      lines.push("");
    }
    const details = rows.filter((r) => r.onlySqlite.length || r.onlyPg.length || r.typeDiffs.length);
    lines.push("**差異明細**");
    lines.push("");
    if (!details.length) {
      lines.push("- （無：7 張表的欄名集合與型別族完全一致）");
    } else {
      for (const row of details) {
        if (row.onlySqlite.length) lines.push(`- \`${row.table}\` 只在 SQLite 有：${row.onlySqlite.map((c) => `\`${c}\``).join("、")}`);
        if (row.onlyPg.length) lines.push(`- \`${row.table}\` 只在 PG 有：${row.onlyPg.map((c) => `\`${c}\``).join("、")}`);
        for (const d of row.typeDiffs) lines.push(`- \`${row.table}.${d.name}\` 型別不同族：SQLite \`${d.sqlite}\` vs PG \`${d.pg}\``);
      }
    }
    lines.push("");
    lines.push(`**逐欄差異＝${diffTotal} 項**（刪檔門禁要 **0**；>0 就不准刪）。`
      + `另註：型別「同族但字面不同」共 ${rawTypeDiffs} 項（例如 SQLite \`INTEGER\` vs PG \`bigint\`），`
      + "那是兩邊型別體系本來就不同，**不列入門禁**。");
    lines.push("");
    lines.push("逐欄全表（`欄名: SQLite 宣告型別 → PG data_type`）：");
    lines.push("");
    lines.push("```text");
    for (const table of COLUMN_TABLES) {
      const s = snapshot.columns.raw?.sqlite?.[table];
      const p = snapshot.columns.raw?.pg?.[table];
      lines.push(`[${table}]`);
      if (!Array.isArray(s) || !Array.isArray(p)) {
        lines.push(`  SQLite=${Array.isArray(s) ? "有" : "不存在"}／PG=${Array.isArray(p) ? "有" : "不存在"} ⇒ 無法逐欄比對`);
        lines.push("");
        continue;
      }
      const pMap = new Map(p.map((c) => [c.name, c.type]));
      for (const column of s) {
        const pgType = pMap.has(column.name) ? pMap.get(column.name) : "（PG 沒有這一欄）";
        lines.push(`  ${column.name}: ${column.type || "(無宣告型別)"} → ${pgType}`);
      }
      lines.push("");
    }
    lines.push("```");
    lines.push("");
  }

  // 三、檔案 size／mtime
  lines.push("## 三、`v3.db` / `-wal` / `-shm` 的 size 與 mtime");
  lines.push("");
  lines.push("| 檔案 | size | mtime | 用途／判讀 |");
  lines.push("|---|---|---|---|");
  const rows = [
    [`${sqlite.path}`, sqlite.files?.db, "主檔。mtime 可能停在最後一次 checkpoint，**不代表沒在寫**。"],
    [`${sqlite.path}-wal`, sqlite.files?.wal, "WAL。**這是「最後一次寫入」的判準**（與 `-db` 併用）。"],
    [`${sqlite.path}-shm`, sqlite.files?.shm, "共享記憶體索引。**`-shm` mtime 不可當寫入證據**（唯讀開啟就會推前）。"],
  ];
  for (const [label, facts, note] of rows) {
    if (!facts || !facts.exists) {
      lines.push(`| \`${label}\` | 不存在 | 不存在 | ${note} |`);
      continue;
    }
    lines.push(`| \`${label}\` | ${bytesCell(facts)} | \`${facts.mtime}\` | ${note} |`);
  }
  lines.push("");
  lines.push("> **判準**：`-shm` mtime 不可當寫入證據（唯讀開啟就會推前）；判準用 `-db`／`-wal`。");
  if (snapshot.sample) {
    const { seconds, unchanged, before, after } = snapshot.sample;
    const mark = (ok) => (ok ? "不動 ✅" : "**有變動 ❌**");
    lines.push("");
    lines.push(`### 雙取樣（間隔 ${seconds} 秒；比較 size＋mtime）`);
    lines.push("");
    lines.push(`- \`${sqlite.path}\`（-db）：${mark(unchanged.db)}`
      + `（前 \`${before.db.mtime}\`／後 \`${after.db.mtime}\`）`);
    lines.push(`- \`${sqlite.path}-wal\`：${mark(unchanged.wal)}`
      + `（前 \`${before.wal.mtime}\`／後 \`${after.wal.mtime}\`）`);
    lines.push(`- \`${sqlite.path}-shm\`：${unchanged.shm ? "不動" : "有變動"}`
      + "（唯讀開啟就會推前，**僅供參考、不作判準**）");
    lines.push("");
    lines.push("> 雙取樣若 `-db`／`-wal` 都不動，搭配 `/proc/*/fd` 無人持有，才能主張「SQLite 已不再被寫」。");
  }
  lines.push("");

  // 四、關鍵時間戳
  lines.push("## 四、關鍵時間戳");
  lines.push("");
  const sm = sqlite.timestamps?.schemaMigrations || {};
  const pgSm = pg?.timestamps?.schemaMigrations || {};
  lines.push(`- **SQLite \`schema_migrations\` 最後套用時間**：${sm.lastAppliedAt ? `\`${sm.lastAppliedAt}\`` : "n/a"}` +
    `（共 ${cell(sm.rows)} 版）。`);
  lines.push(`- **PG \`schema_migrations\` 最後套用時間**：${pgSm.lastAppliedAt ? `\`${pgSm.lastAppliedAt}\`` : "n/a"}` +
    `（共 ${cell(pgSm.rows)} 版）。注意 SQLite 走 \`migrate.js\` 編號 runner、PG 走 \`pgSchema.ensurePgSchema()\` 鏡射`
    + "＋各模組 lazy `CREATE/ALTER IF NOT EXISTS`，兩套體系本來不同，編號不需對齊。");
  lines.push(`- **PG \`covers_max_last_run_at\`**（\`MAX(last_run_at) FROM crawl_covers\`）：`
    + `${pg?.timestamps?.coversMaxLastRunAt ? `\`${pg.timestamps.coversMaxLastRunAt}\`` : "n/a"}`);
  lines.push(`- **最後一次 SQLite 寫入的解讀**：${write.text}`);
  lines.push("");

  // 五、零資料缺口複核
  lines.push("## 五、零資料缺口複核（刪檔前必須再次確認）");
  lines.push("");
  lines.push("| 檢查項 | 節點 SQLite | PG | 預期 | 判定 |");
  lines.push("|---|---|---|---|---|");
  const judgement = (value, expected) => {
    if (value === null || value === undefined) return "n/a";
    return value === expected ? "✅" : "❌";
  };
  // 欄位級檢查：null 代表「這一端的表沒有這個欄位」，與「沒查」分開講。
  const gapCell = (value) => (value === null || value === undefined ? "n/a（無此欄）" : cell(value));
  lines.push(`| \`listings.fee_includes\` 非空筆數 | ${gapCell(sqlite.gap?.feeIncludesNonEmpty)} | ${gapCell(pg?.gap?.feeIncludesNonEmpty ?? null)} | 0 | ${judgement(sqlite.gap?.feeIncludesNonEmpty, 0)} |`);
  for (const column of SELF_MRT_COLUMNS) {
    const s = sqlite.gap?.selfMrt?.[column] ?? null;
    const p = pg?.gap?.selfMrt?.[column] ?? null;
    lines.push(`| \`listings.${column}\` 非 NULL 筆數 | ${gapCell(s)} | ${gapCell(p)} | 0 | ${judgement(s, 0)} |`);
  }
  for (const table of ZERO_ROW_TABLES) {
    const s = sqlite.gap?.zeroRowTables?.[table] ?? null;
    const p = pg?.gap?.zeroRowTables?.[table] ?? null;
    lines.push(`| \`${table}\` 列數 | ${cellOf(s, sqliteMissing, table)} | ${pg ? cellOf(p, pgMissing, table) : "n/a"} | 0 | ${judgement(s, 0)} |`);
  }
  lines.push("");
  lines.push("> 全為 0 ⇒ 沒有「只存在於節點 SQLite、PG 沒有」的資料缺口，可以進入刪檔前置條件。"
    + "任一項非 0 就先回到補遷（不補的裁決只涵蓋這三張零列的表與 7 個零值欄位）。");
  lines.push("");

  // 六、刪除前置條件
  const archived = Boolean(meta.outPath);
  lines.push("## 六、刪除前置條件（checklist）");
  lines.push("");
  lines.push(`- [${archived ? "x" : " "}] **快照已存檔**${archived ? `（\`${meta.outPath}\`）` : "（本輪只印 stdout；正式固化請加 `--out=<file>`）"}`);
  const columnGate = snapshot.columns && pg ? snapshot.columns.diffTotal : null;
  lines.push(`- [${columnGate === 0 ? "x" : " "}] **逐欄差異＝0 項**（§二；`
    + `${columnGate === null ? "本輪沒有 PG ⇒ 未驗證" : `實際 ${columnGate} 項`}，`
    + "刪檔前必須對正式 PG `5151_shadow` 再確認一次）");
  lines.push("- [ ] **`docker logs` 的 `business SQLite is closed` 已歸 0**"
    + "（三台節點：`591-tracker-v3`／`5151-web-A`／`5151-web-B`；`PG_NO_SQLITE_OPEN=1` 生效後應不再出現）。");
  lines.push("- [ ] **Owner 已核准**摘除 `/data/v3.db*`（`/data` 掛載本身保留：`auth.env`／`vapid.json`／media 在裡面）。");
  lines.push("");
  lines.push("> **每一項**都打勾之前**不得**刪除任何 `v3.db*`；本工具不執行也無法執行刪除。");
  lines.push("");
  return `${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
/** 把連線字串從任何訊息裡拿掉（錯誤訊息也不准漏值）。 */
export function redact(target, url) {
  const value = String(url || "");
  if (!value) return String(target);
  return String(target).split(value).join("<redacted-pg-url>");
}

/** 粗篩清洗：任何看起來帶帳密的連線字串（`scheme://user:pass@…`）都不得出現在輸出。 */
export function redactSecrets(text, env = process.env) {
  let out = String(text);
  for (const value of Object.values(env || {})) {
    const raw = String(value || "");
    if (raw.length >= 12 && /:\/\/[^@/\s]*@/.test(raw)) out = out.split(raw).join("<redacted>");
  }
  return out;
}

export async function main(argv = process.argv.slice(2), { env = process.env, now = new Date() } = {}) {
  const args = parseArgs(argv);
  if (args.help) return { help: true, markdown: USAGE, exitCode: 0 };

  const sqlitePath = String(args.sqlite && args.sqlite !== true ? args.sqlite : DEFAULT_SQLITE);
  const pgEnvName = String(args["pg-url"] && args["pg-url"] !== true ? args["pg-url"] : DEFAULT_PG_ENV);
  const outPath = args.out && args.out !== true ? String(args.out) : null;
  const label = args.label && args.label !== true ? String(args.label) : null;

  const pgUrl = String(env[pgEnvName] || "").trim();
  // 正式庫預設拒絕（要明示 ALLOW_PRODUCTION_PG_TARGET=1）。連線字串本身不進 argv、不進輸出。
  const pgDatabase = pgUrl ? assertPgTargetAllowed(TOOL, pgUrl, { env, allow: ALLOWED_PG_DBS }) : null;
  if (pgUrl && !databaseNameFromUrl(pgUrl)) {
    throw new Error(`${TOOL}：環境變數 ${pgEnvName} 看不出資料庫名稱，拒絕執行（不猜目標）`);
  }

  const baseline = readBaseline(args.baseline);
  const sqlite = collectSqliteFacts(sqlitePath);

  // 可選：雙取樣（例如 --sample-seconds=61）——證明「-wal 逐 byte 不動」的最直接證據。
  let sample = null;
  const sampleSeconds = Math.max(0, Number(args["sample-seconds"] && args["sample-seconds"] !== true ? args["sample-seconds"] : 0) || 0);
  if (sampleSeconds > 0) {
    const before = statSqliteFiles(sqlitePath);
    await new Promise((resolve) => setTimeout(resolve, sampleSeconds * 1000));
    const after = statSqliteFiles(sqlitePath);
    sample = { seconds: sampleSeconds, before, after, unchanged: compareSamples(before, after) };
  }

  let pg = null;
  let columns = null;
  if (pgUrl) {
    const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
    const driver = await createPostgresDriver({ env: { ...env, PG_URL: pgUrl, DATABASE_URL: "", POSTGRES_URL: "" } });
    const exec = (sql, params) => driver.pool.query(sql, params);
    try {
      pg = await collectPgFacts(exec);
      // 逐欄（欄名＋型別）對照：SQLite `PRAGMA table_info` ↔ PG `information_schema.columns`。
      const sqliteColumns = sqliteColumnFacts(sqlitePath);
      const pgColumns = await pgColumnFacts(exec);
      columns = { ...compareColumns(sqliteColumns, pgColumns), raw: { sqlite: sqliteColumns, pg: pgColumns } };
    } catch (error) {
      throw new Error(`${TOOL}：PG 唯讀查詢失敗：${redact(error?.message || error, pgUrl)}`);
    } finally {
      await driver.pool.end();
    }
  }

  const snapshot = buildSnapshot({
    sqlite,
    pg,
    baseline,
    sample,
    columns,
    meta: { now, label, outPath, pgDatabase, pgEnvName },
  });
  const markdown = renderMarkdown(snapshot);
  if (outPath) writeFileSync(outPath, markdown);
  return { help: false, snapshot, markdown, exitCode: 0 };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main()
    .then((result) => {
      process.stdout.write(result.markdown.endsWith("\n") ? result.markdown : `${result.markdown}\n`);
      process.exit(result.exitCode);
    })
    .catch((error) => {
      process.stderr.write(`${redactSecrets(error?.message || error)}\n`);
      process.exit(1);
    });
}
