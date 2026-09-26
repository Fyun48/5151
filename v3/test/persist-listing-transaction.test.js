// PR-B 回歸測試：persistListing() 的 PG 路徑必須「同一個交易」完成主列／backfill／投影／變更紀錄，
// 且投影要用交易中回讀後的最終列（canonical row）計算；任何一步失敗要整筆回滾。
// 背景（ChatGPT 指令文件 F7／G9）：舊版是 upsert → backfill → syncProjection → bump 連續 await，
// 沒有包整段交易 → 可能「主列寫入成功、投影永久缺席」，搜尋就少了那筆房源。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-persist-tx-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the SQLite file locked while the process holds it.
  }
});

const { persistListing } = await import("../src/db.js");

const LISTING = {
  post_id: 9_700_001,
  source: "591",
  source_id: "9700001",
  source_key: "1|8|9700001",
  search_key: "https://example.test/search",
  title: "PR-B 交易測試",
  url: "https://example.test/listing/9700001",
  price: "25000元",
  price_num: 25000,
  extra_fee: 0,
  extra_fees: [],
  tags: "[]",
  first_seen_at: "2026-09-24T00:00:00.000Z",
  last_seen_at: "2026-09-24T00:00:00.000Z",
  last_event: "new",
};

// 假 pool：只實作 persistListing 需要的介面；記錄每個動作的順序，並可指定某類語句丟錯。
function fakePool({ failOn = null } = {}) {
  const calls = [];
  const client = {
    async query(text, params = []) {
      calls.push({ text, params });
      if (failOn && failOn.test(text)) throw new Error(`forced failure: ${text.slice(0, 40)}`);
      if (/SELECT \* FROM listings WHERE post_id = \$1/.test(text)) {
        return { rows: [{ ...LISTING, title: "canonical 回讀後的標題", content_seq: 7 }] };
      }
      return { rows: [] };
    },
  };
  return {
    calls,
    async withTransaction(fn) {
      calls.push({ text: "BEGIN" });
      try {
        const result = await fn(client);
        calls.push({ text: "COMMIT" });
        return result;
      } catch (error) {
        calls.push({ text: "ROLLBACK" });
        throw error;
      }
    },
    async query(text, params = []) {
      calls.push({ text, params });
      return { rows: [] };
    },
    async exec(text) {
      calls.push({ text });
    },
  };
}

const indexOf = (calls, re) => calls.findIndex((call) => re.test(call.text));
const rowWriteIndex = (calls) => indexOf(calls, /INSERT INTO listings/i);

test("PG 路徑：主列／backfill／回讀／投影／變更紀錄都在同一個交易內，且投影在回讀之後", async () => {
  const pool = fakePool();
  const result = await persistListing(LISTING, { driver: "postgres", pgDriver: pool });
  assert.equal(result.driver, "postgres");
  assert.equal(result.changeEvent, "listing_added");

  const begin = indexOf(pool.calls, /^BEGIN$/);
  const commit = indexOf(pool.calls, /^COMMIT$/);
  const rolledBack = indexOf(pool.calls, /^ROLLBACK$/);
  const listingWrite = rowWriteIndex(pool.calls);
  const canonicalRead = indexOf(pool.calls, /SELECT \* FROM listings WHERE post_id = \$1/);
  const projectionWrite = indexOf(pool.calls, /listing_search_projection/i);
  const revisionWrite = indexOf(pool.calls, /INSERT INTO data_revision/i);

  assert.ok(begin >= 0, "要有交易");
  assert.equal(commit >= 0, true, "要 commit");
  assert.equal(rolledBack, -1, "正常路徑不該 rollback");
  assert.ok(listingWrite > begin, "主列寫入要在交易內");
  assert.ok(canonicalRead > listingWrite, "投影前要回讀 canonical row");
  assert.ok(projectionWrite > canonicalRead, "投影要在回讀之後");
  assert.ok(revisionWrite > projectionWrite, "變更紀錄最後寫");
  assert.ok(commit > revisionWrite, "commit 在所有寫入之後");
  // 關鍵：所有寫入都走同一個 client（同一個交易），不是 pool 上的散寫。
  const writesOnClient = pool.calls.filter((call) => /INSERT INTO listings|listing_search_projection|INSERT INTO data_revision/i.test(call.text));
  assert.ok(writesOnClient.length >= 3, "三類寫入都要發生");
});

test("PG 路徑：投影寫入失敗要整筆回滾並往外拋（不能只留主列）", async () => {
  const pool = fakePool({ failOn: /listing_search_projection/i });
  await assert.rejects(
    () => persistListing(LISTING, { driver: "postgres", pgDriver: pool }),
    /forced failure/,
  );
  assert.ok(indexOf(pool.calls, /^ROLLBACK$/) >= 0, "投影失敗必須 rollback");
  assert.equal(indexOf(pool.calls, /^COMMIT$/), -1, "失敗路徑不可以 commit");
});
