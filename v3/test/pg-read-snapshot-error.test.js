// 2026-09-27：pgReadSnapshot 的未處理 'error' 事件（崩潰級）。
//
// 背景：pg 的 Client 是 EventEmitter，**沒有監聽者的 'error' 事件會直接讓行程崩潰**。
// 實測（隔離重現環境、走真正的 HAProxy 30 秒閒置逾時）：
//   修正前 → `throw er; // Unhandled 'error' event`、exit code 1（行程死亡）
//   修正後 → 下一次查詢正常 reject，exit code 0
//
// crawlOwnership.js 早就有 `client.on('error', …)` 的同款防護，pgReadSnapshot.js 漏了。
//
// ⚠️ 這個檔的第一版是**空的**：假 client 在 run 回呼裡「同步」發出 'error'，
// 那個 throw 會沿著 promise 鏈被 .catch 接住，所以就算把修正移除也全部通過。
// 真實的崩潰是**非同步**從 socket 發出、沒有任何 promise 包住它。
// 因此第 4 項改用子行程驗證：移除修正會讓子行程以 exit 1 死亡。這點已用變異測試確認。
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";

import { withPgReadSnapshot } from "../src/pgReadSnapshot.js";

const DEAD = "Client has encountered a connection error and is not queryable";
const MODULE_URL = new URL("../src/pgReadSnapshot.js", import.meta.url).href;

function fakeClient() {
  const client = new EventEmitter();
  client.dead = false;
  client.released = [];
  client.query = async (sql) => {
    const text = typeof sql === "string" ? sql : sql?.text;
    if (client.dead) throw new Error(DEAD);
    if (/^ROLLBACK/i.test(text)) return { rows: [], rowCount: 0, fields: [] };
    return { rows: [], rowCount: 0, fields: [] };
  };
  client.release = (error) => { client.released.push(error); };
  return client;
}

function driverFor(client) {
  return { pool: { connect: async () => client }, candidateContent: null };
}

test("快照進行中必須掛上 error 監聽（這正是防止崩潰的機制）", async () => {
  const client = fakeClient();
  let countDuring = -1;
  await withPgReadSnapshot(driverFor(client), async () => {
    countDuring = client.listenerCount("error");
  });
  assert.ok(countDuring >= 1, `快照期間必須有 error 監聽，實際 ${countDuring} 個`);
});

test("離開快照後必須移除 error 監聽（同一條連線重用時不可累積）", async () => {
  const client = fakeClient();
  await withPgReadSnapshot(driverFor(client), async () => {});
  assert.equal(client.listenerCount("error"), 0, "監聽器必須在 finally 移除");
});

test("正常完成時不得帶錯誤釋放（連線要能回到池中重複使用）", async () => {
  const client = fakeClient();
  await withPgReadSnapshot(driverFor(client), async () => {});
  assert.equal(client.released.length, 1);
  assert.equal(client.released[0], undefined, "正常路徑不得把連線標成壞掉");
});

test("連線在快照期間死亡時，必須帶錯誤釋放（銷毀而非回收）", async () => {
  const client = fakeClient();
  client.query = async (sql) => {
    const text = typeof sql === "string" ? sql : sql?.text;
    if (!client.dead && /^ROLLBACK/i.test(text)) {
      // 模擬「ROLLBACK 時才發現連線已死」：ROLLBACK 失敗 → broken 被設定
      throw new Error(DEAD);
    }
    return { rows: [], rowCount: 0, fields: [] };
  };
  await withPgReadSnapshot(driverFor(client), async () => {});
  assert.ok(client.released[0], "ROLLBACK 失敗時必須帶錯誤釋放");
});

// 這一項才是真正的崩潰迴歸鎖：非同步發出 'error'，沒有任何 promise 包住它。
// 修正前子行程會以 exit 1 死亡並印出 "Unhandled 'error' event"。
test("非同步的連線錯誤不得讓行程崩潰（實測修正前 exit=1）", () => {
  const script = `
    import { EventEmitter } from "node:events";
    import { withPgReadSnapshot } from ${JSON.stringify(MODULE_URL)};
    const client = new EventEmitter();
    client.query = async () => ({ rows: [], rowCount: 0, fields: [] });
    client.release = () => {};
    const driver = { pool: { connect: async () => client }, candidateContent: null };
    // 關鍵：從「計時器」發出 error —— 沒有 promise 鏈可以接住它，等同 socket 中斷的真實情況。
    setTimeout(() => { client.dead = true; client.emit("error", new Error("Connection terminated unexpectedly")); }, 10);
    await withPgReadSnapshot(driver, async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
    console.log("SURVIVED");
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `行程不得因未處理的 'error' 事件而死亡（exit=${result.status}）。stderr=${(result.stderr || "").slice(0, 400)}`,
  );
  assert.match(result.stdout, /SURVIVED/);
  assert.doesNotMatch(result.stderr || "", /Unhandled 'error' event/);
});

test("沒有 pool.connect 的輕量替身仍走原本的直接路徑", async () => {
  const calls = [];
  const result = await withPgReadSnapshot({ query: async () => ({ rows: [] }) }, async (d) => {
    calls.push(d);
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls.length, 1);
});
