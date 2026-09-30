#!/usr/bin/env node
// 把「正式站的抓取相關設定」複製進沙盒庫（2026-09-30，第九十四批）。
//
// 為什麼需要：沙盒庫是用 `pg-integration-setup.mjs` 從 SQLite schema 鏡射出來的全新庫
// ⇒ `systemWatchDistricts`／`crawlSources` 都是預設值，第一輪會回 `idle`（沒有要抓的條件）。
// 要測「真實來源在真實條件下的行為」，就必須用**正式站同一組覆蓋條件**。
//
// 安全：
//   * 來源（`PROD_PG_URL`）只做 SELECT。
//   * 目標（`PG_URL`）必須是 `assertPgTargetAllowed()` 允許的沙盒庫；來源與目標同庫一律拒絕。
// 用法：
//   PROD_PG_URL=… PG_URL=… node v3/scripts/crawl-sandbox-seed.mjs
import { Client } from "pg";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";

const SOURCE_KEYS = [
  "crawlSources",
  "systemWatchDistricts",
  "systemCrawlIntervalMinutes",
  "systemOfflineConfirmDays",
  "systemShowMrt",
  "systemShowListRefreshBar",
];

export function databaseName(url) {
  try { return new URL(String(url)).pathname.replace(/^\//, ""); } catch { return ""; }
}

/** 只複製「抓取條件」這一組鍵；回傳 `{copied, skipped, source, target}`（純函式，可測）。 */
export function planSeed(rows, targetDb) {
  const copied = [];
  const skipped = [];
  for (const row of rows || []) {
    const key = String(row?.key || "");
    if (!SOURCE_KEYS.includes(key)) { skipped.push(key); continue; }
    copied.push({ key, value: String(row.value ?? "") });
  }
  return { copied, skipped, target: targetDb };
}

const PROD = String(process.env.PROD_PG_URL || "").trim();
const TARGET = String(process.env.PG_URL || "").trim();
const targetDb = assertPgTargetAllowed("crawl-sandbox-seed", TARGET);
if (!PROD) throw new Error("缺少 PROD_PG_URL（來源，只讀正式站設定）");
if (databaseName(PROD) === targetDb) throw new Error(`來源與目標是同一個資料庫（${targetDb}）：拒絕執行`);

const prod = new Client({ connectionString: PROD, application_name: "crawl-sandbox-seed-read" });
await prod.connect();
const rows = (await prod.query("SELECT key, value FROM settings WHERE key = ANY($1::text[])", [SOURCE_KEYS])).rows;
await prod.end();

const plan = planSeed(rows, targetDb);
const sandbox = new Client({ connectionString: TARGET, application_name: "crawl-sandbox-seed-write" });
await sandbox.connect();
for (const row of plan.copied) {
  await sandbox.query(
    "INSERT INTO settings(key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [row.key, row.value],
  );
}
// 沙盒不要揹著正式站的抓取進度與連續失敗紀錄：從乾淨的排程狀態開始。
await sandbox.query("DELETE FROM settings WHERE key IN ('crawlScheduleV1', 'lastCoveringAt', 'lastSystemCoveringAt')");
await sandbox.query("DELETE FROM crawl_covers");
await sandbox.end();
console.log(JSON.stringify({ target: plan.target, copied: plan.copied.map((row) => row.key), rows: plan.copied.length }));
