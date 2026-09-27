// 2026-09-27：crawl owner 持有連線的心跳。
//
// 背景（正式站停擺的真正根因）：
//   withPgCrawlOwner() 為了持有 session 級 advisory lock，借出一條 PG 連線並持有
//   「整個 crawl」——包含前段完全不碰 DB 的網路抓取。正式站 App 經由 HAProxy 連 PG，
//   HAProxy 設 `timeout client 30s`；應用端 30 秒沒送資料就切斷（實測終止代碼 `cD`）。
//   該連線是「已借出」而非池中閒置，`idleTimeoutMillis` 不會回收它。
//   於是抓取階段一超過 30 秒，連線被切斷，crawl 之後第一次寫入就
//   `Connection terminated unexpectedly`，每輪重複，crawler 永遠跑不完。
//
// 心跳間隔必須先設好再載入模組（模組載入時就讀 env），所以本檔用動態 import。
process.env.PG_CRAWL_HEARTBEAT_MS = "30";

import test from "node:test";
import assert from "node:assert/strict";

const { withPgCrawlOwner, currentCrawlOwner, CRAWL_HEARTBEAT_MS } = await import("../src/crawlOwnership.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 假的 driver／client：記錄每一次 query，並在「交易進行中」時標記，
// 用來驗證心跳不會插進交易中間。
function fakeDriver() {
  const calls = [];
  let inTransaction = false;
  const overlaps = [];
  const client = {
    async query(sql) {
      const text = typeof sql === "string" ? sql : sql?.text;
      calls.push(text);
      if (text === "SELECT 1" && inTransaction) overlaps.push(text);
      if (text.startsWith("SELECT pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      return { rows: [] };
    },
    on() {}, removeListener() {}, release() {},
  };
  const driver = { pool: { connect: async () => client } };
  return {
    driver,
    calls,
    overlaps,
    heartbeats: () => calls.filter((c) => c === "SELECT 1").length,
    beginTransaction: () => { inTransaction = true; },
    endTransaction: () => { inTransaction = false; },
  };
}

test("抓取期間閒置超過心跳間隔時，必須持續送出心跳", async () => {
  const fake = fakeDriver();
  assert.equal(CRAWL_HEARTBEAT_MS, 30, "測試需要 30ms 的心跳間隔");

  await withPgCrawlOwner(fake.driver, async () => {
    // 模擬前段網路抓取：完全不碰 DB，且遠超過心跳間隔。
    await sleep(200);
  });

  assert.ok(
    fake.heartbeats() >= 3,
    `閒置 200ms、心跳 30ms，應至少送出 3 次心跳，實際 ${fake.heartbeats()} 次：${JSON.stringify(fake.calls)}`,
  );
});

test("心跳不得插進交易中間（必須排在同一條序列化佇列上）", async () => {
  const fake = fakeDriver();

  await withPgCrawlOwner(fake.driver, async () => {
    const owner = currentCrawlOwner();
    for (let i = 0; i < 4; i += 1) {
      await owner.transact(async (client) => {
        fake.beginTransaction();
        await sleep(20);
        await client.query("SELECT tx");
        await sleep(20);
        fake.endTransaction();
      });
      await sleep(90); // 交易之間的閒置，足以觸發心跳
    }
  });

  assert.ok(fake.heartbeats() >= 1, "交易之間的閒置應該要產生心跳");
  assert.deepEqual(fake.overlaps, [], "心跳不得在交易進行中送出");
});

test("交易完成後才輪到心跳，次序不可顛倒", async () => {
  const fake = fakeDriver();

  await withPgCrawlOwner(fake.driver, async () => {
    const owner = currentCrawlOwner();
    await owner.transact(async (client) => { await client.query("SELECT tx-1"); });
    await sleep(90);
    await owner.transact(async (client) => { await client.query("SELECT tx-2"); });
  });

  const tx1 = fake.calls.indexOf("SELECT tx-1");
  const tx2 = fake.calls.indexOf("SELECT tx-2");
  const firstBeat = fake.calls.indexOf("SELECT 1");
  assert.ok(tx1 >= 0 && tx2 >= 0 && firstBeat >= 0, JSON.stringify(fake.calls));
  assert.ok(tx1 < firstBeat, "第一次交易必須早於第一次心跳");
  assert.ok(firstBeat < tx2, "心跳必須早於第二次交易（排在同一條 tail 上）");
});

test("擁有權結束後必須停止心跳（計時器要清掉）", async () => {
  const fake = fakeDriver();
  await withPgCrawlOwner(fake.driver, async () => { await sleep(90); });

  const after = fake.heartbeats();
  await sleep(120);
  assert.equal(fake.heartbeats(), after, "離開 withPgCrawlOwner 後不得再送心跳");
});

test("重複進入多輪 crawl 不得累積計時器", async () => {
  const fake = fakeDriver();
  for (let i = 0; i < 3; i += 1) {
    await withPgCrawlOwner(fake.driver, async () => { await sleep(60); });
  }
  const after = fake.heartbeats();
  await sleep(120);
  assert.equal(fake.heartbeats(), after, "三輪之後仍不得有殘留計時器");
});

test("PG_CRAWL_HEARTBEAT_MS=0 可停用（直連 PG、無 Proxy 的環境）", async () => {
  // 這個模組已經以 30ms 載入過，所以改用子行程驗證 0 的行為。
  const { spawnSync } = await import("node:child_process");
  // 用絕對 URL，避免子行程 cwd 不同造成解析錯誤。
  const moduleUrl = new URL("../src/crawlOwnership.js", import.meta.url).href;
  const script = `
    process.env.PG_CRAWL_HEARTBEAT_MS = "0";
    const { withPgCrawlOwner, CRAWL_HEARTBEAT_MS } = await import(${JSON.stringify(moduleUrl)});
    const calls = [];
    const client = {
      async query(sql) { const t = typeof sql === "string" ? sql : sql?.text; calls.push(t);
        if (t.startsWith("SELECT pg_try_advisory_lock")) return { rows: [{ acquired: true }] }; return { rows: [] }; },
      on() {}, removeListener() {}, release() {},
    };
    await withPgCrawlOwner({ pool: { connect: async () => client } }, async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    console.log(JSON.stringify({ interval: CRAWL_HEARTBEAT_MS, beats: calls.filter((c) => c === "SELECT 1").length }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout.trim().split("\n").pop());
  assert.equal(parsed.interval, 0);
  assert.equal(parsed.beats, 0, "設 0 時不得送出任何心跳");
});
