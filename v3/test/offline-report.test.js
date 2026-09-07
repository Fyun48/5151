import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listingMatchesListFilter } from "../src/personalFlags.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(dir, "..", rel), "utf8");

test("pending offline stays in the main list; only confirmed offline is removed", () => {
  const base = { hidden: 0, watched: 0, viewed: 0, match_verdict: "", last_event: "seen" };
  const pending = { ...base, offline: 1, offline_confirmed: 0 };
  const confirmed = { ...base, offline: 1, offline_confirmed: 1 };
  const live = { ...base, offline: 0, offline_confirmed: 0 };
  assert.equal(listingMatchesListFilter(live, "all"), true);
  assert.equal(listingMatchesListFilter(pending, "all"), true, "下架確認中要留在列表");
  assert.equal(listingMatchesListFilter(confirmed, "all"), false, "確認已下架要移除");
  assert.equal(listingMatchesListFilter(pending, "unseen"), true);
  // 專屬 offline 檢視仍可用（API 相容），但只含 pending
  assert.equal(listingMatchesListFilter(pending, "offline"), true);
  assert.equal(listingMatchesListFilter(confirmed, "offline"), false);
});

test("server exposes report-gone with a 30-min site-wide lock and uses the all-platform probe", () => {
  const server = read("src/server.js");
  assert.match(server, /app\.post\("\/api\/listings\/:id\/report-gone"/);
  assert.match(server, /REPORT_GONE_LOCK_MS\s*=\s*30 \* 60 \* 1000/);
  assert.match(server, /alive_checked_at/);
  assert.match(server, /probeListingAliveBySource/);
  // recheck 也改用統一探測器
  const recheck = server.slice(server.indexOf('"/api/listings/:id/recheck"'), server.indexOf('"/api/listings/:id/report-gone"'));
  assert.match(recheck, /probeListingAliveBySource/);
  assert.match(recheck, /markListingAlive/);
});

test("all-platform conservative probe dispatcher exists and offline sweep uses it", () => {
  const probe = read("src/probe.js");
  assert.match(probe, /export async function probeListingAliveBySource/);
  for (const s of ["houseprice", "housefun", "hbhousing", "sinyi", "ddroom"]) assert.match(probe, new RegExp(s));
  const watcher = read("src/watcher.js");
  assert.match(watcher, /probeListingAliveBySource/);
});

test("db has alive_checked_at column and markListingAlive helper", () => {
  const db = read("src/db.js");
  assert.match(db, /ADD COLUMN alive_checked_at TEXT/);
  assert.match(db, /export function markListingAlive/);
});

test("frontend: report-gone button + handler; logout under account; offline zone removed", () => {
  const html = read("public/index.html");
  assert.match(html, /data-report-gone="\$\{id\}"/);
  assert.match(html, /dataset\.reportGone/);
  assert.match(html, /report-gone`/);
  assert.match(html, /id="meLogoutBtn"/);
  assert.match(html, /\$\("meLogoutBtn"\)\?\.addEventListener/);
  // 「正在確認中的下架」瀏覽分頁已移除
  assert.doesNotMatch(html, /data-filter="offline"/);
});
