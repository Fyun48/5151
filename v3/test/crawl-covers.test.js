import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensurePersonalSchema } from "../src/personalSchema.js";
import { coveringJobsFromMembers } from "../src/covering.js";
import { listCrawlCovers, replaceCrawlCovers, touchCrawlCoversRun } from "../src/crawlCovers.js";

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  ensurePersonalSchema(db);
  return db;
}

test("merged covering jobs are persisted in crawl_covers", () => {
  const db = memoryDb();
  const jobs = coveringJobsFromMembers([
    { regionId: 1, sectionIds: [8], priceMin: 0, priceMax: 20000 },
    { regionId: 1, sectionIds: [9], priceMin: 0, priceMax: 40000 },
    { regionId: 3, sectionIds: [26], priceMin: 0, priceMax: 30000 },
  ]);
  replaceCrawlCovers(db, jobs, "2026-09-01T00:00:00.000Z");
  const rows = listCrawlCovers(db);
  assert.equal(rows.length, 2);
  const taipei = rows.find((row) => row.regionId === 1);
  const newTaipei = rows.find((row) => row.regionId === 3);
  assert.deepEqual(taipei.sectionIds, [8, 9]);
  assert.equal(taipei.priceMax, 40000);
  assert.deepEqual(newTaipei.sectionIds, [26]);
  assert.equal(newTaipei.createdAt, "2026-09-01T00:00:00.000Z");
});

test("replacing the same cover keeps last_run_at", () => {
  const db = memoryDb();
  const jobs = coveringJobsFromMembers([
    { regionId: 1, sectionIds: [8, 9], priceMin: 0, priceMax: 40000 },
  ]);
  replaceCrawlCovers(db, jobs, "2026-09-01T00:00:00.000Z");
  touchCrawlCoversRun(db, "2026-09-01T03:00:00.000Z");
  replaceCrawlCovers(db, jobs, "2026-09-01T04:00:00.000Z");
  const [row] = listCrawlCovers(db);
  assert.equal(row.lastRunAt, "2026-09-01T03:00:00.000Z");
  assert.equal(row.createdAt, "2026-09-01T00:00:00.000Z");
});
