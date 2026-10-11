// 背景迴圈輔助查詢瘦身（2026-10-12，第二包）：把「每一輪的呼叫次數」釘住。
//
// 正式站 180 秒窗口的四條高頻指紋裡，有三條來自背景迴圈：
//   • `SELECT * FROM listing_enrich_jobs WHERE post_id = $1`（補欄位 seed：一輪 40 筆 × 先讀＋回讀）
//   • `SELECT detail FROM user_events WHERE user_id = $1 AND post_id = $2 AND type = $3 …`（通知入列：每位會員一條）
//   • `SELECT key, value FROM settings`（同一輪被每位會員／每個事件各讀一次）
//
// 這一檔不驗「結果對不對」（那是 notify-enqueue-parity／listing-enrich-parity 的責任），
// 只驗**次數**與**去重輸入**：把集合式查詢換回逐列版、或把同輪 settings 讀取換回逐筆版，
// 這裡就會紅。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-bgaux-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

// ── A. 補欄位 seed：一輪的 `listing_enrich_jobs WHERE post_id = $1` 次數 ──────────────
const CANDIDATES = [70001, 70002, 70003];

function seedExec({ failPostId = null } = {}) {
  const calls = [];
  const perPostSelects = [];
  const insertParams = [];
  const exec = async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, " ").trim();
    calls.push({ sql: text, params });
    if (/information_schema\.columns/i.test(text)) return { rows: [], rowCount: 0 };
    if (/^SELECT l\.post_id, l\.source/i.test(text)) {
      return {
        rows: CANDIDATES.map((postId) => ({
          post_id: postId, source: "houseprice", source_id: String(postId), url: `https://example.test/${postId}`,
          title: `合成 ${postId}`, price_num: 20000, address: "", floor_name: "", lat: null, lng: null, tags: "[]",
        })),
        rowCount: CANDIDATES.length,
      };
    }
    // 集合式讀取（新路徑）
    if (/FROM listing_enrich_jobs WHERE post_id = ANY\(/i.test(text)) {
      return { rows: [{ id: 1, post_id: CANDIDATES[1], source: "houseprice", status: "queued", priority: 10, requested_via: "scheduler", missing_fields: "[]" }], rowCount: 1 };
    }
    // 逐列讀取（改動前那一條）——出現就代表有人把它改回去了。
    if (/FROM listing_enrich_jobs WHERE post_id = \$1/i.test(text) || /FROM listing_enrich_jobs WHERE post_id = \?/i.test(text)) {
      perPostSelects.push(Number(params[0]));
      return { rows: [], rowCount: 0 };
    }
    if (/^INSERT INTO listing_enrich_jobs/i.test(text)) {
      if (failPostId != null && Number(params[0]) === failPostId) {
        const error = new Error(`boom for ${failPostId}`);
        error.code = "23505";
        throw error;
      }
      insertParams.push(Number(params[0]));
      return { rows: [], rowCount: 1 };
    }
    if (/^UPDATE listing_enrich_jobs/i.test(text)) {
      if (failPostId != null && Number(params[params.length - 1]) === failPostId) {
        const error = new Error(`boom for ${failPostId}`);
        error.code = "23505";
        throw error;
      }
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  exec.calls = calls;
  exec.perPostSelects = perPostSelects;
  exec.insertParams = insertParams;
  return exec;
}

test("補欄位 seed：40 筆候選只發一條集合式查詢，不再逐列查（會紅的變異：改回逐列版）", async () => {
  const { seedHousepriceEnrichJobsDetailedAsync } = await import("../src/listingEnrichQueueAsync.js");
  const exec = seedExec();
  const result = await seedHousepriceEnrichJobsDetailedAsync({}, { limit: 40, isEnabled: () => true }, { driver: "postgres", exec, strict: true });

  assert.equal(result.seeded, CANDIDATES.length);
  assert.deepEqual(result.errors, []);
  const batch = exec.calls.filter((row) => /FROM listing_enrich_jobs WHERE post_id = ANY\(/i.test(row.sql));
  assert.equal(batch.length, 1, `整批既有列只准查一次，實際 ${batch.length}`);
  assert.deepEqual(batch[0].params[0], CANDIDATES, "集合式查詢要帶整批 post_id");
  assert.deepEqual(exec.perPostSelects, [], "不得再逐列 `WHERE post_id = $1`");
  // 回讀也不見了：三筆候選 → 一個既有列（UPDATE）＋兩個新列（INSERT）。
  assert.deepEqual(exec.insertParams, [CANDIDATES[0], CANDIDATES[2]]);
});

test("補欄位 seed：一筆壞掉只損失那一筆，其他照樣入列且記進 errors[]", async () => {
  const { seedHousepriceEnrichJobsDetailedAsync } = await import("../src/listingEnrichQueueAsync.js");
  const exec = seedExec({ failPostId: CANDIDATES[1] });
  const result = await seedHousepriceEnrichJobsDetailedAsync({}, { limit: 40, isEnabled: () => true }, { driver: "postgres", exec, strict: true });

  assert.equal(result.seeded, 2, "壞掉一筆不能讓整輪歸零");
  assert.deepEqual(result.errors.map((row) => row.post_id), [CANDIDATES[1]]);
  assert.equal(result.errors[0].code, "23505");
  assert.deepEqual(exec.insertParams, [CANDIDATES[0], CANDIDATES[2]], "已成功的照樣落地");
});

test("補欄位 seed：對外入口仍回「筆數」（呼叫端契約不變）", async () => {
  const { seedHousepriceEnrichJobsAsync } = await import("../src/listingEnrichQueueAsync.js");
  const exec = seedExec();
  const n = await seedHousepriceEnrichJobsAsync({}, { limit: 40, isEnabled: () => true }, { driver: "postgres", exec, strict: true });
  assert.equal(n, CANDIDATES.length);
});

// ── B. 通知入列：批次去重與每輪 settings ─────────────────────────────────────────────
const MEMBER_IDS = [81001, 81002, 81003];
const POST_ID = 82001;
const DUPLICATE_DETAIL = "價格 25000元 → 24000元";

function enqueueExec({ groupId = "", duplicateFor = "one", newExistsFor = [] } = {}) {
  const calls = [];
  const inserts = [];
  const exec = async (sql, params = []) => {
    const text = String(sql).replace(/\s+/g, " ").trim();
    calls.push({ sql: text, params });
    if (/^\s*SELECT key, value FROM settings/i.test(text)) {
      return [{ key: "settings", value: JSON.stringify({ notifyMatrix: { price_drop: { dock: true } } }) }];
    }
    if (/^\s*SELECT id FROM users/i.test(text)) return MEMBER_IDS.map((id) => ({ id }));
    if (/FROM user_settings/i.test(text)) return [];
    if (/^\s*SELECT \* FROM users/i.test(text)) return [{ id: Number(params[0]), email: `u${params[0]}@example.test`, role: "member", plan: "free" }];
    if (/FROM user_search_profiles/i.test(text)) return [];
    if (/FROM user_listing_flags/i.test(text)) return [];
    if (/FROM listing_group_members/i.test(text)) return groupId ? [{ group_id: groupId }] : [];
    // `newEventExists` 的集合式版（`type = 'new'`）
    if (/FROM user_events WHERE user_id = ANY\(/i.test(text) && /type = 'new'/i.test(text)) {
      return newExistsFor.map((user_id) => ({ user_id }));
    }
    // 批次去重（新路徑）：依情境回答「誰已經有一筆同 detail 的舊事件」。
    if (/FROM user_events WHERE user_id = ANY\(/i.test(text) && /post_id = /.test(text)) {
      const seen = duplicateFor === "all" ? MEMBER_IDS : duplicateFor === "none" ? [] : [MEMBER_IDS[1]];
      return seen.map((user_id) => ({ user_id, detail: DUPLICATE_DETAIL }));
    }
    if (/FROM user_events WHERE user_id = ANY\(/i.test(text)) return [];
    if (/^INSERT INTO user_events/i.test(text)) {
      inserts.push(Number(params[0]));
      return [{ id: 900 + inserts.length }];
    }
    if (/^UPDATE user_events/i.test(text)) return [];
    return [];
  };
  exec.calls = calls;
  exec.inserts = inserts;
  return exec;
}

async function runEnqueue(exec, event, { deps: override } = {}) {
  const base = (await import("../src/db.js")).notifyEnqueueBuildContext();
  const decisions = [];
  const deps = {
    ...base,
    // 重裝飾換成假的：查詢文字與決策鏈都還是正式碼（裝飾本身由 decoration 的測試顧）。
    // ⚠️ 這個替身要逐字模仿 `preloadDecorationProviderAsync()`（db.js:3371）唯一的接線行為：
    // **沒有 `requestContext` 就自己再讀一次全域 settings**。少了這一行，「入列時把當輪
    // settings 傳下去」就沒有觀測點，變異會活下來。
    preloadDecorationProviderAsync: async ({ exec: run, requestContext }) => {
      if (!requestContext) await run("SELECT key, value FROM settings");
      return {};
    },
    decorateRowsWithProvider: (rows) => rows.map((row) => ({ ...row, watched: 1 })),
    notifyEnqueueDecision: (args) => {
      decisions.push(args);
      return base.notifyEnqueueDecision(args);
    },
    ...override,
  };
  const { enqueueListingEvent } = await import("../src/repository/notifyEnqueue.js");
  const ids = await enqueueListingEvent(exec, {
    deps,
    listing: { post_id: POST_ID, source: "houseprice", title: "合成物件", price: "25000元" },
    event,
  });
  return { ids, decisions };
}

test("通知入列：整批會員只發一條 user_events 去重查詢（會紅的變異：改回每位會員一條）", async () => {
  const exec = enqueueExec();
  const { ids } = await runEnqueue(exec, { type: "price_drop", detail: DUPLICATE_DETAIL, created_at: "2026-10-12T00:00:00.000Z" });

  const single = exec.calls.filter((row) => /user_events/i.test(row.sql)
    && /user_id = \$1/i.test(row.sql) && /ORDER BY id DESC LIMIT 1/i.test(row.sql));
  assert.deepEqual(single, [], "不得再逐會員讀 `lastEventDetail`");
  const batch = exec.calls.filter((row) => /FROM user_events WHERE user_id = ANY\(/i.test(row.sql));
  assert.equal(batch.length, 1, `整批去重只准查一次，實際 ${batch.length}`);
  assert.deepEqual(batch[0].params[0], MEMBER_IDS);
  // 第二位會員已有同 detail ⇒ 只有第一位與第三位入列（去重結果逐字不變）。
  assert.deepEqual(exec.inserts, [MEMBER_IDS[0], MEMBER_IDS[2]]);
  assert.equal(ids.length, 2);
  // 全域 settings 整輪只讀一次（裝飾資料吃同一批列）。
  const settingsReads = exec.calls.filter((row) => /^\s*SELECT key, value FROM settings/i.test(row.sql));
  assert.equal(settingsReads.length, 1, `一輪只准讀一次 settings，實際 ${settingsReads.length}`);
});

test("通知入列：批次去重給決策鏈的 lastDetail / newExists 必須逐會員正確", async () => {
  const exec = enqueueExec();
  const { decisions } = await runEnqueue(exec, { type: "price_drop", detail: DUPLICATE_DETAIL, created_at: "2026-10-12T00:00:00.000Z" });
  assert.deepEqual(decisions.map((row) => row.lastDetail), [null, DUPLICATE_DETAIL, null],
    "只有第二位會員拿得到自己那一筆 detail（不能取到別人的、也不能取到最舊的）");
  assert.deepEqual(decisions.map((row) => row.newExists), [null, null, null], "非 new 事件不查 new 去重");

  const execNew = enqueueExec({ newExistsFor: [MEMBER_IDS[2]] });
  const newCase = await runEnqueue(execNew, { type: "new", detail: "全新物件", created_at: "2026-10-12T00:00:00.000Z" });
  assert.deepEqual(newCase.decisions.map((row) => row.newExists), [false, false, true],
    "new 去重只看自己那一列（集合式版不能把別人的算進來）");
  const batchNew = execNew.calls.filter((row) => /type = 'new'/i.test(row.sql));
  assert.equal(batchNew.length, 1, "new 去重也只准一條集合式查詢");
});

test("通知入列：群組去重仍逐會員判，且只查一次", async () => {
  const GROUP = "g-bgaux-1";
  const exec = enqueueExec({ groupId: GROUP });
  const { decisions } = await runEnqueue(exec, { type: "price_drop", detail: "群組細節", created_at: "2026-10-12T00:00:00.000Z" });
  const groupReads = exec.calls.filter((row) => /user_events WHERE user_id = ANY\(/i.test(row.sql) && /group_id = /i.test(row.sql));
  assert.equal(groupReads.length, 1, "群組去重只准一條集合式查詢");
  assert.deepEqual(decisions.map((row) => row.alreadyNotified), [false, false, false]);
  // 同一個 post 的群組只查一次（原本每位會員一次）。
  const groupIdReads = exec.calls.filter((row) => /FROM listing_group_members/i.test(row.sql));
  assert.equal(groupIdReads.length, 1, `groupIdForPost 只准查一次，實際 ${groupIdReads.length}`);
});

test("通知入列：同一 user+post+type 已存在就不重複入列（去重條件逐字保持）", async () => {
  const exec = enqueueExec({ duplicateFor: "all" });
  const { ids, decisions } = await runEnqueue(exec, { type: "price_drop", detail: DUPLICATE_DETAIL, created_at: "2026-10-12T00:00:00.000Z" });
  assert.deepEqual(decisions.map((row) => row.lastDetail), [DUPLICATE_DETAIL, DUPLICATE_DETAIL, DUPLICATE_DETAIL]);
  assert.deepEqual(ids, [], "全員都已存在同 detail ⇒ 一位都不能再入列");
  assert.deepEqual(exec.inserts, []);
});

// ── C. flush：一輪 settings 只讀一次 ────────────────────────────────────────────────
function flushExec() {
  const calls = [];
  const events = [
    { id: 880001, user_id: 900001, post_id: 880002, type: "new", title: "A", created_at: "2026-10-12T00:00:00.000Z", notified: 0 },
    { id: 880003, user_id: 900004, post_id: 880005, type: "new", title: "B", created_at: "2026-10-12T00:00:00.000Z", notified: 0 },
  ];
  const exec = async (sql, params = []) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (/user_events/i.test(text) && !/^\s*UPDATE/i.test(text)) return events;
    if (/FROM users/i.test(text)) return [{ id: Number(params[0]) || 0, email: "m@example.test", role: "member", plan: "free", created_at: "2026-01-01T00:00:00.000Z" }];
    if (/FROM settings/i.test(text)) return [{ key: "settings", value: JSON.stringify({}) }, { key: "systemCrawl", value: JSON.stringify({}) }];
    if (/FROM user_settings/i.test(text)) return [{ user_id: Number(params[0]) || 0, key: "notificationsPaused", value: JSON.stringify(true) }];
    if (/FROM listings/i.test(text)) {
      return [{ post_id: 880002, source: "591", title: "A", url: "https://example.test/a", price: "20000", price_num: 20000, lat: 25.11, lng: 121.52, geo_source: "geocode", location_class: "street", coord_version: 1, offline: 0, content_seq: 1 }];
    }
    if (/UPDATE user_events/i.test(text)) return [];
    return [];
  };
  exec.calls = calls;
  const pgDriver = {
    query: async (sql, params = []) => ({ rows: await exec(sql, params), rowCount: 0 }),
    exec: async () => undefined,
    withTransaction: (fn) => fn(pgDriver),
  };
  return { exec, pgDriver };
}

test("flush：一輪（多個事件）全域 settings 只讀一次（會紅的變異：改回逐會員／逐事件讀）", async () => {
  const { flushPendingNotifications } = await import("../src/watcher.js");
  const { exec, pgDriver } = flushExec();
  await flushPendingNotifications(null, { silent: true, driver: "postgres", exec, pgDriver, strict: true });

  const settingsReads = exec.calls.filter((row) => /^\s*SELECT key, value FROM settings/i.test(row.sql));
  assert.equal(settingsReads.length, 1, `一輪只准讀一次 settings，實際 ${settingsReads.length}`);
  // 兩個事件都要真的處理過（否則「只讀一次」可以靠什麼都不做達成）。
  const updates = exec.calls.filter((row) => /^\s*UPDATE user_events/i.test(row.sql));
  assert.ok(updates.length >= 2, `兩個事件都要寫回狀態，實際 ${updates.length}`);
});
