// PostgreSQL 呼叫端歸因探針（preload；唯讀觀測）。
//
// 目的：把「某條 SQL 是誰在什麼頻率發的」量出來，而不是靠指紋猜。
// 做法沿用 L-0709：#707/#720 的經驗證明——
//   * `pool.query()` 與 repo 呼叫端在同一個同步堆疊上 ⇒ 在那裡抓 `new Error().stack` 才有檔案:行號；
//   * `client.query()` 被呼叫時已經跨過 pg 內部的 async 邊界 ⇒ 在那裡抓堆疊只會得到 `(non-repo)`。
// 所以這裡：
//   1. patch `pg.Pool.prototype.query`：把（SQL → 呼叫端 callsite）依 SQL 文字推入 FIFO；
//   2. patch `pg.Client.prototype.query`：記下 SQL／耗時，並從同一條 SQL 的 FIFO 取出配對到的呼叫端；
//      若 client 層的同步堆疊剛好還有 repo frame（`withTransaction` 直呼 client 的情形），優先採用它。
//   3. 行程結束（SIGTERM/SIGINT/exit）把聚合結果寫成 JSON。
//
// 用法：
//   set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
//   export PG_URL="$PG_LIVE_REPRO_URL" DB_DRIVER=postgres
//   export PG_TRACE_OUT=/tmp/trace.json PG_TRACE_WINDOW_MS=120000
//   node --import /abs/path/v3/scripts/pg-callsite-trace.mjs v3/src/server.js
//
// 環境變數：
//   PG_TRACE_OUT        輸出 JSON 路徑（預設 /tmp/pg-callsite-trace.json）
//   PG_TRACE_BLOCK_NET  =1 ⇒ 讓所有對外 HTTP(S) 立刻失敗（fail-soft 逐頁 try/catch 會照常跑完一頁）
//   PG_TRACE_MAX_SITES  每個 SQL 最多保留幾個 callsite（預設 40）
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

Error.stackTraceLimit = 80;

const OUT = process.env.PG_TRACE_OUT || "/tmp/pg-callsite-trace.json";
const MAX_SITES = Number(process.env.PG_TRACE_MAX_SITES || 40);
const startedAt = new Date();
const t0 = performance.now();

const repoFrame = /(v3\/(?:src|scripts)\/[^:()\s]+):(\d+):\d+/;
const SELF = /(?:pg-callsite-trace|bg-aux-sql-count)\.mjs/;
const IGNORE = /\/node_modules\//;
// 驅動層自己的 frame 會佔滿預算、把真正的呼叫端擠掉（async 堆疊會重複它們）。
const PLUMBING = /v3\/src\/(?:dbDriverPostgres|pgSharedDriver|sqlDialect|pgReadSnapshot)\.js/;

function callsiteOf() {
  const stack = String(new Error().stack || "").split("\n").slice(2);
  const frames = [];
  const seen = new Set();
  for (const line of stack) {
    if (IGNORE.test(line)) continue;
    const m = line.match(repoFrame);
    if (!m) continue;
    if (SELF.test(m[1]) || PLUMBING.test(m[1])) continue;
    const frame = `${m[1]}:${m[2]}`;
    if (seen.has(frame)) continue;
    seen.add(frame);
    frames.push(frame);
    if (frames.length >= 8) break; // 第 1 個＝直接呼叫端，其後是它自己的呼叫鏈
  }
  return frames.length ? frames.join(" <- ") : "(non-repo)";
}

const pg = (await import("pg")).default;

// ── 第一層：驅動物件本身（`dbDriverPostgres.createPostgresDriver()` 回傳的那個）──
// 這是唯一能在**同步堆疊**上看到 repo 呼叫端的地方：`settingsAsync.js:88` 這種行號
// 會在 `driver.query()` 被呼叫的當下就在堆疊裡。晚一層（pool／client）就已經跨過
// async 邊界，只剩 pg 自己的 frame。
const { sharedPgDriver } = await import(new URL("../src/pgSharedDriver.js", import.meta.url).href);
const driverEntry = new Map(); // sql -> [callsite] FIFO（driver 層寫入）
const driverCalls = [];       // {site, kind, sql}
const driver = await sharedPgDriver();
for (const name of ["query", "queryOne", "exec", "withTransaction"]) {
  const original = driver[name];
  if (typeof original !== "function") continue;
  driver[name] = function tracedDriverCall(...args) {
    const sql = typeof args[0] === "string" ? args[0] : "";
    const site = callsiteOf();
    driverCalls.push({ kind: name, sql, site, at: Math.round(performance.now() - t0) });
    if (sql) pushSite(sql, site);
    return original.apply(this, args);
  };
}

const siteQueue = new Map(); // sql -> [callsite] FIFO（pool 層寫入）
const rows = [];             // 每一條完成查詢

function pushSite(sql, site) {
  let q = siteQueue.get(sql);
  if (!q) { q = []; siteQueue.set(sql, q); }
  q.push(site);
  // 防止無配對的紀錄無限長（例如同一條 SQL 在某路徑不經 pool 層直呼 client）。
  if (q.length > 5000) q.shift();
}

function takeSite(sql) {
  const q = siteQueue.get(sql);
  return q && q.length ? q.shift() : null;
}

const originalPoolQuery = pg.Pool.prototype.query;
pg.Pool.prototype.query = function patchedPoolQuery(config, ...rest) {
  const sql = typeof config === "string" ? config : (config && config.text) || "";
  pushSite(sql, callsiteOf());
  return originalPoolQuery.call(this, config, ...rest);
};

const originalClientQuery = pg.Client.prototype.query;
const RAW_MATCH = process.env.PG_TRACE_RAW_MATCH ? new RegExp(process.env.PG_TRACE_RAW_MATCH) : null;
const RAW_LIMIT = Number(process.env.PG_TRACE_RAW_LIMIT || 5);
const rawStacks = [];
pg.Client.prototype.query = function patchedClientQuery(config, ...rest) {
  const sql = typeof config === "string" ? config : (config && config.text) || "";
  if (RAW_MATCH && RAW_MATCH.test(sql) && rawStacks.length < RAW_LIMIT) {
    rawStacks.push({ sql, stack: String(new Error().stack || "") });
  }
  const started = performance.now();
  // 交易內的直呼（`withTransaction`）同步堆疊仍在 repo 內；抓得到就用它，抓不到再吃 pool 的 FIFO。
  const syncSite = callsiteOf();
  // 優先用 pool 層配對到的呼叫端（那才是真正發話的人）；FIFO 空的時候（`withTransaction`
  // 直呼 client）才用同步堆疊。
  const site = takeSite(sql) || syncSite;
  const finish = (ok) => {
    rows.push({
      at: Math.round(performance.now() - t0),
      sql,
      ms: Math.round((performance.now() - started) * 100) / 100,
      site,
      ok: ok !== false,
    });
  };
  // ⚠️ `pg-pool/index.js:467` 走的是**callback 形式**（`client.query(text, values, cb)`），
  // 這種呼叫回傳的不是 promise ⇒ 只綁 promise 會整批漏記（只剩交易內直呼的那些）。
  // 12 小時前的第一版就是這樣：driver 層 607 條、client 層只記到 109 條。
  const args = [config, ...rest];
  const last = args[args.length - 1];
  if (typeof last === "function") {
    args[args.length - 1] = (...cbArgs) => {
      finish(!cbArgs[0]);
      return last(...cbArgs);
    };
    return originalClientQuery.apply(this, args);
  }
  const result = originalClientQuery.apply(this, args);
  if (result && typeof result.then === "function") {
    result.then(() => finish(true), () => finish(false));
  }
  return result;
};

// 可選：把對外網路全部打成「立刻失敗」。爬蟲的逐頁 try/catch（AGENTS.md 第一線 fail-soft）
// 會照常跑完那一頁、記一筆 errors[]，所以「每頁一次」的守衛迴圈仍然會被走過一遍。
if (process.env.PG_TRACE_BLOCK_NET === "1") {
  const blocked = async () => { throw new Error("PG_TRACE_BLOCK_NET: outbound network disabled"); };
  globalThis.fetch = blocked;
  const { default: http } = await import("node:http");
  const { default: https } = await import("node:https");
  for (const mod of [http, https]) {
    const orig = mod.request;
    mod.request = function blockedRequest(...args) {
      const req = orig.apply(this, args);
      process.nextTick(() => req.destroy(new Error("PG_TRACE_BLOCK_NET: outbound network disabled")));
      return req;
    };
  }
}

function fingerprint(sql) {
  return String(sql).replace(/'[^']*'/g, "?").replace(/\b\d+\b/g, "?").replace(/\s+/g, " ").trim().slice(0, 120);
}

function dump(reason) {
  const bySql = {};
  const byFingerprint = {};
  let ms = 0;
  for (const r of rows) {
    ms += r.ms;
    const s = bySql[r.sql] || (bySql[r.sql] = { count: 0, ms: 0, sites: {} });
    s.count += 1; s.ms += r.ms;
    s.sites[r.site] = (s.sites[r.site] || 0) + 1;
    const f = byFingerprint[fingerprint(r.sql)] || (byFingerprint[fingerprint(r.sql)] = { count: 0, ms: 0, sites: {} });
    f.count += 1; f.ms += r.ms;
    f.sites[r.site] = (f.sites[r.site] || 0) + 1;
  }
  const trim = (entry) => ({
    count: entry.count,
    ms: Math.round(entry.ms * 100) / 100,
    sites: Object.fromEntries(
      Object.entries(entry.sites).sort((a, b) => b[1] - a[1]).slice(0, 40),
    ),
  });
  const windowMs = Math.round(performance.now() - t0);
  // driver 層：不看 SQL，直接看「哪一行在什麼頻率要 driver 做事」。
  const driverSites = {};
  for (const c of driverCalls) {
    const key = `${c.kind} ${c.site}`;
    driverSites[key] = (driverSites[key] || 0) + 1;
  }
  const driverSettingsSites = {};
  const driverSqls = {};
  for (const c of driverCalls) {
    const sqlKey = String(c.sql).replace(/\s+/g, " ").slice(0, 100);
    driverSqls[sqlKey] = (driverSqls[sqlKey] || 0) + 1;
    if (!/settings/i.test(c.sql) || /user_settings/i.test(c.sql)) continue;
    const key = `${c.kind} ${c.site}`;
    driverSettingsSites[key] = (driverSettingsSites[key] || 0) + 1;
  }
  const payload = {
    reason,
    startedAt: startedAt.toISOString(),
    windowMs,
    totalQueries: rows.length,
    totalMs: Math.round(ms * 100) / 100,
    bySql: Object.fromEntries(Object.entries(bySql).sort((a, b) => b[1].count - a[1].count).slice(0, MAX_SITES).map(([k, v]) => [k, trim(v)])),
    byFingerprint: Object.fromEntries(Object.entries(byFingerprint).sort((a, b) => b[1].count - a[1].count).slice(0, 80).map(([k, v]) => [k, trim(v)])),
    rawStacks,
    driverSites: Object.fromEntries(Object.entries(driverSites).sort((a, b) => b[1] - a[1]).slice(0, 60)),
    driverCallsTotal: driverCalls.length,
    driverSqls: Object.fromEntries(Object.entries(driverSqls).sort((a, b) => b[1] - a[1]).slice(0, 40)),
    driverSettingsSites: Object.fromEntries(Object.entries(driverSettingsSites).sort((a, b) => b[1] - a[1]).slice(0, 60)),
  };
  try { writeFileSync(OUT, JSON.stringify(payload, null, 1)); } catch (e) { console.warn("[pg-trace] write failed:", e.message); }
  console.log(`[pg-trace] ${reason} window=${windowMs}ms queries=${rows.length} -> ${OUT}`);
}

let dumped = false;
const once = (reason) => { if (!dumped) { dumped = true; dump(reason); } };
process.on("SIGTERM", () => { once("SIGTERM"); process.exit(0); });
process.on("SIGINT", () => { once("SIGINT"); process.exit(0); });
process.on("exit", () => once("exit"));
