// 抓取沙盒（2026-09-30，第九十四批）。
//
// 為什麼要有這一支：第九十一～九十三批都是**部署後拿正式站當白老鼠**才發現問題。
// 沙盒容器（`docker-compose.crawl-sandbox.yml` ＋ `v3/scripts/crawl-sandbox.mjs`）讓同樣的
// 真實輪次可以在隔離庫上先跑。這一組測試釘住三件事：
//   1. **安全閥**：沙盒拒絕非 PG 模式、拒絕允許清單以外的資料庫（絕不能指向正式庫）。
//   2. **報告形狀**：一輪的報告要能判斷「有沒有逾時、哪個來源失敗、完成紀錄有沒有前進」。
//   3. **接線**：compose 不發佈任何埠、用同一顆映像、掛載 repo 的 src／scripts；
//      同步腳本存在且可執行（沒有它，沙盒跑的是舊程式碼）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");

const { parseSandboxArgs, checkSandboxTarget, buildRoundReport, formatRoundReport } =
  await import("../scripts/crawl-sandbox.mjs");

const SANDBOX_URL = "postgres://user:pw@192.168.0.220:15434/crawl_sandbox";

test("命令列：--once 跑一輪、--rounds N 跑 N 輪、預設常駐（0）", () => {
  assert.deepEqual(parseSandboxArgs([]), { once: false, json: false, rounds: 0 });
  assert.equal(parseSandboxArgs(["--once"]).rounds, 1);
  assert.equal(parseSandboxArgs(["--rounds", "3"]).rounds, 3);
  assert.equal(parseSandboxArgs(["--rounds", "0"]).rounds, 1, "0 輪沒有意義，至少要一輪");
  assert.equal(parseSandboxArgs(["--rounds", "abc"]).rounds, 1);
  assert.equal(parseSandboxArgs(["--once", "--json"]).json, true);
});

test("安全閥：沙盒只認「postgres ＋ 允許清單內的資料庫」", () => {
  const ok = checkSandboxTarget({ DB_DRIVER: "postgres", PG_URL: SANDBOX_URL });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.database, "crawl_sandbox");
  // 沒設 DB_DRIVER ⇒ 會退回節點本機 SQLite：那不是沙盒，要拒絕。
  const sqlite = checkSandboxTarget({ PG_URL: SANDBOX_URL });
  assert.equal(sqlite.ok, false);
  assert.match(sqlite.reason, /DB_DRIVER=postgres/);
  // 🚨 最重要的一條：指到正式庫（5151_shadow）必須拒絕，而且訊息要說清楚。
  const prod = checkSandboxTarget({ DB_DRIVER: "postgres", PG_URL: "postgres://user:pw@192.168.0.140:25433/5151_shadow" });
  assert.equal(prod.ok, false);
  assert.match(prod.reason, /不在允許清單/);
  assert.match(prod.reason, /5151_shadow/);
  // 沒有 PG_URL 也要拒絕（不能猜目標）。
  assert.equal(checkSandboxTarget({ DB_DRIVER: "postgres" }).ok, false);
  assert.equal(checkSandboxTarget({ DB_DRIVER: "postgres", PG_URL: "postgres://user:pw@host/" }).ok, false);
});

test("報告：逾時、來源狀態、完成紀錄前進都要看得出來", () => {
  const report = buildRoundReport({
    round: 3,
    startedAt: Date.parse("2026-09-30T10:00:00.000Z"),
    finishedAt: Date.parse("2026-09-30T10:25:00.000Z"),
    result: {
      fetched: 1234,
      covers: [{ href: "a" }, { href: "b" }],
      warnings: ["抓取來源「5168 租屋」已連續失敗 3 輪…"],
      errors: ["e1", "e2", "e3", "e4", "e5", "e6"],
      sources: [
        { source: "591", covered: 6, total: 6, fails: 0, tolerated: false, lastError: "" },
        { source: "houseprice", covered: 0, total: 6, fails: 3, tolerated: true, lastError: "5168 中山區 第 1 頁 …" },
      ],
    },
    schedule: { completed: { a: {}, b: {} } },
    covers: [{ last_run_at: "2026-09-27T04:05:35.771Z" }, { last_run_at: "2026-09-30T10:24:00.000Z" }],
    budgetMs: 40 * 60 * 1000,
  });
  assert.equal(report.duration_ms, 25 * 60 * 1000);
  assert.equal(report.timed_out, false, "25 分鐘 < 40 分鐘預算");
  assert.equal(report.fetched, 1234);
  assert.equal(report.jobs, 2);
  assert.equal(report.completed, 2);
  assert.equal(report.covers_rows, 2);
  assert.equal(report.covers_max_last_run_at, "2026-09-30T10:24:00.000Z", "要看得出完成紀錄有沒有前進");
  assert.equal(report.errors_total, 6);
  assert.equal(report.errors_sample.length, 5, "樣本最多 5 筆，總數另外記");
  assert.deepEqual(report.sources.map((row) => row.source), ["591", "houseprice"]);
  assert.equal(report.sources[1].tolerated, true);
  assert.equal(report.warnings.length, 1);
  // 被 withBudget 放棄的輪次要標成逾時（正式站最常見的失敗型態）。
  const timedOut = buildRoundReport({
    startedAt: 0, finishedAt: 41 * 60 * 1000,
    result: { error: "這輪抓取超過 40 分鐘沒結束，已自動放棄" },
    budgetMs: 40 * 60 * 1000,
  });
  assert.equal(timedOut.timed_out, true);
  // 逾時但沒有 error 訊息時，也要靠耗時判斷。
  assert.equal(buildRoundReport({ startedAt: 0, finishedAt: 40 * 60 * 1000, budgetMs: 40 * 60 * 1000 }).timed_out, true);
});

test("報告摘要（日誌用）要包含來源覆蓋數與放行狀態", () => {
  const line = formatRoundReport(buildRoundReport({
    round: 2, startedAt: 0, finishedAt: 1000,
    result: {
      fetched: 10, covers: [{}],
      sources: [
        { source: "591", covered: 6, total: 6 },
        { source: "sinyi", covered: 1, total: 6, fails: 3, tolerated: true },
      ],
    },
    schedule: { completed: { x: {} } },
    covers: [{ last_run_at: "2026-09-30T10:00:00.000Z" }],
  }));
  assert.match(line, /第 2 輪/);
  assert.match(line, /落地 10 筆/);
  assert.match(line, /591 6\/6/);
  assert.match(line, /sinyi 1\/6\(已放行\) fails=3/);
  assert.match(line, /completed=1/);
});

test("接線：compose 不發佈埠、用同一顆映像、掛載 repo 的 src／scripts", () => {
  const compose = read("docker-compose.crawl-sandbox.yml");
  assert.match(compose, /container_name: 5151-crawl-sandbox/);
  assert.match(compose, /image: \$\{V3_IMAGE:-ghcr\.io\/fyun48\/5151:latest\}/);
  assert.match(compose, /restart: unless-stopped/);
  assert.doesNotMatch(compose, /^\s+ports:/m, "沙盒不得發佈任何埠（不服務請求、也不在 tunnel ingress）");
  assert.match(compose, /DB_DRIVER: postgres/);
  assert.match(compose, /\.\/v3\/src:\/app\/src:ro/);
  assert.match(compose, /\.\/v3\/scripts:\/app\/scripts:ro/);
  assert.match(compose, /command: \["node", "scripts\/crawl-sandbox\.mjs"\]/);
  assert.match(compose, /env_file:\n\s+- \.env/, "PG_URL 由 .env（600）提供，不寫進 repo");
  assert.doesNotMatch(compose, /SMTP_|VAPID|WEB_PUSH/i, "沙盒不得具備寄信／推播能力");
  // 正式站的 compose／tunnel 不可以混進沙盒服務。
  assert.doesNotMatch(read("docker-compose.yml"), /crawl-sandbox/);
  // 同步腳本一定要在（沒有它，沙盒跑的是上一次同步的舊程式碼）。
  for (const rel of ["v3/scripts/crawl-sandbox.mjs", "v3/scripts/crawl-sandbox-setup.sh", "v3/scripts/crawl-sandbox-sync.sh"]) {
    assert.ok(existsSync(path.join(ROOT, rel)), `${rel} 必須存在`);
  }
  assert.ok((statSync(path.join(ROOT, "v3/scripts/crawl-sandbox-sync.sh")).mode & 0o111) !== 0, "同步腳本要可執行");
  const sync = read("v3/scripts/crawl-sandbox-sync.sh");
  assert.match(sync, /scp -q -r "\$REPO_ROOT\/v3\/src\/\."/, "同步腳本要把 v3/src 送上沙盒");
  assert.match(sync, /scp -q -r "\$REPO_ROOT\/v3\/scripts\/\."/, "同步腳本要把 v3/scripts 送上沙盒");
  const setup = read("v3/scripts/crawl-sandbox-setup.sh");
  assert.match(setup, /SANDBOX_PG_URL/, "沙盒庫連線字串只能來自 secrets");
  assert.match(setup, /pg-integration-setup\.mjs/, "schema 要用既有的鏡射腳本，不要自己寫一份");
});
