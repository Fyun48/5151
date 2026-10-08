// 「補抓失敗」有兩種完全不同的原因，這一包釘住它不會再被混在一起：
//   * 來源暫時出錯（403／timeout／challenge）→ 該走 60s→5m→15m 階梯，很快再試。
//   * 頁面抓到了、欄位就是缺（PREP_PENDING）→ 多跑幾次不會有差別，另給 6 小時退避。
// 後者寫錯的代價是實測過的：同一筆被重試 386 次（每 15 分鐘一次），
// 而整張 listing_prep 的 display_ready 仍是 0／2504（死鎖來自規則，不是網路）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-pending-missing-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows keeps the file locked */
  }
});

const app = await import("../src/db.js");
const enrich = await import("../src/listingEnrichQueue.js");
const prepMod = await import("../src/listingPrep.js");

const db = app.sqliteHandle();
enrich.ensureListingPrepSchema(db);

const HOUR = 60 * 60_000;
const SRC = readFileSync(new URL("../src/listingEnrichQueue.js", import.meta.url), "utf8");

// --- 1. 分派本身：五種 jobStatus 各歸各位 -----------------------------------
test("enrichErrorClass：PREP_PENDING 的 failed 不再算 transient", () => {
  assert.equal(enrich.enrichErrorClass("succeeded", { status: prepMod.PREP_READY }), "");
  assert.equal(enrich.enrichErrorClass("parse_failed", { status: prepMod.PREP_PARSE_FAILED }), "parse_failed");
  assert.equal(enrich.enrichErrorClass("source_limited", { status: prepMod.PREP_SOURCE_LIMITED }), "source_limited");
  // 這就是要修的那一條：拿到了頁面但欄位仍缺。
  assert.equal(enrich.enrichErrorClass("failed", { status: prepMod.PREP_PENDING, missing: ["facility"] }), "pending_missing");
  // 其他來源層級的失敗（不帶評估結果／評估不是 pending）仍要留給階梯。
  assert.equal(enrich.enrichErrorClass("failed", null), "transient");
  assert.equal(enrich.enrichErrorClass("failed", { status: "unexpected" }), "transient");
});

// --- 2. 退避時距：6 小時，而且永遠不會掉回階梯 -------------------------------
test("pending_missing 的 next_retry_at 固定 6 小時，不隨 attempt_count 掉回階梯", () => {
  const now = Date.parse("2026-10-07T12:00:00.000Z");
  for (const attempt of [1, 2, 3, 5, 9, 40]) {
    const job = { id: 1, post_id: 7, run_seq: 1, request_seq: 1, attempt_count: attempt };
    const plan = enrich.finishEnrichPlan(
      job,
      { status: "failed", error: "facility", errorClass: "pending_missing", missing: ["facility"] },
      null,
      now,
    );
    assert.equal(plan.stale, false);
    const waitMs = Date.parse(plan.retryAt) - now;
    assert.equal(waitMs, 6 * HOUR, `attempt_count=${attempt} 應該是 6 小時，實際 ${waitMs / 60000} 分鐘`);
  }
  // 對照組：transient 仍走階梯（第 3 次 = 15 分鐘），確認這次改動沒有動到原本那條路。
  const ladder = enrich.finishEnrichPlan(
    { id: 2, post_id: 8, run_seq: 1, request_seq: 1, attempt_count: 3 },
    { status: "failed", error: "http_403", errorClass: "transient" },
    null,
    now,
  );
  assert.equal(Date.parse(ladder.retryAt) - now, 15 * 60_000, "transient 階梯第 3 拍要還是 15 分鐘");
});

// --- 3. 鎖住之後真的不再被 claim（這是「不打外部站台」的關鍵）----------------
test("pending_missing 退避中的 job 不會被 claim；到時間才可被拿", () => {
  const now = Date.parse("2026-10-07T12:00:00.000Z");
  const stamp = new Date(now).toISOString();
  db.prepare("DELETE FROM listing_enrich_jobs").run();
  const put = (postId, retryIso, cls) => db.prepare(`
    INSERT INTO listing_enrich_jobs
      (post_id, source, job_kind, status, missing_fields, priority, attempt_count,
       request_seq, run_seq, requested_via, last_attempt_at, next_retry_at,
       last_error, last_error_class, created_at, timings)
    VALUES (?, 'houseprice', 'enrich', 'failed', '["facility"]', 10, 7, 1, 1, 'scheduler',
            ?, ?, 'facility', ?, ?, '{}')`).run(postId, stamp, retryIso, cls, stamp);

  put(101, new Date(now + 5 * HOUR).toISOString(), "pending_missing"); // 還在退避
  put(102, new Date(now - 1).toISOString(), "pending_missing"); // 已到期
  const claimed = enrich.claimEnrichJobs(db, { limit: 6 }, now);
  const ids = claimed.map((r) => r.post_id).sort((a, b) => a - b);
  assert.deepEqual(ids, [102], "退避中的 101 不得被拿走，只准拿 102");
});

// --- 4. 接線：呼叫點必須用分派函式，不准退回寫死的 ternary ------------------
test("processOneEnrichJob 的結尾改用 enrichErrorClass（舊寫法已被淘汰）", () => {
  assert.match(SRC, /errorClass: enrichErrorClass\(jobStatus, evalResult\),/);
  // 原本那行把 failed 一律歸 transient，就是 386 次重試的来源；不得復活。
  assert.doesNotMatch(SRC, /jobStatus === "source_limited" \? "source_limited" : "transient"/);
  // 新類別要進「next_retry_at 要当真鎖住」的清單，否則退避會被當作可立即重排。
  assert.match(SRC, /const SOURCE_PAUSE_CLASSES = \[[^\]]*"pending_missing"[^\]]*\]/);
});

// --- 5. 規則死鎖的現場還原（說明為什麼這事必須分開處理）--------------------
test("來源沒提供設備且是推估時，評估結果仍判 pending（缺欄位記帳不動，只放行展示）", () => {
  const listing = {
    post_id: 900001, source: "houseprice", source_id: "hp1", url: "https://example.test/hp1",
    title: "測試", price: "20000", price_num: 20000, address: "台北市士林區天玉街9巷3號",
    floor_name: "4/4", kind_name: "整層住家", tags: '["冰箱"]', lat: 25.11, lng: 121.52,
    geo_source: "houseprice", furnish_items: '["冰箱"]',
  };
  const evalResult = prepMod.evaluateHpPrep(listing, {
    fetched: true, detailRecognized: true, alreadyReady: false, facilityPartial: true,
  });
  // 抓到了（fetched:true、沒有 parseFailed），但 facility 仍進 missing ⇒ 這種筆以前每 15 分鐘打一次。
  assert.equal(evalResult.status, prepMod.PREP_PENDING);
  // 2026-10-08 決定：唯一缺口是「推估的設施」時**可以展示**（正式站 5297 筆卡在這裡），
  // 但缺欄位記帳與重試車道維持原樣 ⇒ 下面 `pending_missing` 那條斷言才是本檔存在的理由。
  assert.equal(evalResult.displayReady, true, "推估設施不再擋展示（記帳與重試車道不動）");
  assert.ok(evalResult.missing.includes("facility"), "此情境 facility 應仍在缺漏清單內");
  assert.equal(enrich.enrichErrorClass("failed", evalResult), "pending_missing");
});
