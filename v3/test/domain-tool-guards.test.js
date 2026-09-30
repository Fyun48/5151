// 維運／CI 腳本的 store 安全閥（2026-09-30，第八十八批）。
//
// 這一包要釘住的是「**跑錯地方要看得見**」：正式站已是 PostgreSQL（`DB_DRIVER=postgres`），
// 但有一整批非路由工具仍假設「本機 SQLite 就是正式資料」——它們會靜默寫進容器本機
// `/data/v3.db`（站上讀 PG ⇒ 等於沒生效），而 workflow 照樣回報成功；
// 另一批會寫 PG 的工具則完全由 `PG_URL` 決定目標，指到正式庫就寫正式庫。
// 盤點見 `docs/handoffs/PG-ISLAND-MIGRATION-PLAN-20260927.md` §88.3。
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const {
  ALLOWED_PG_TARGET_DBS,
  PG_TARGET_OVERRIDE_ENV,
  assertPgTargetAllowed,
  assertSynchronousDomainTool,
  databaseNameFromUrl,
  driverOf,
} = await import("../src/domainToolGuards.js");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFileSync(path.join(ROOT, rel), "utf8");
const throwsWith = (fn, pattern, label) => {
  assert.throws(fn, (error) => {
    assert.match(String(error?.message || ""), pattern, label);
    return true;
  }, label);
};

test("assertSynchronousDomainTool：SQLite 模式放行、PG 模式 fail-closed（訊息要指名工具與後果）", () => {
  assert.doesNotThrow(() => assertSynchronousDomainTool("t", { env: { DB_DRIVER: "sqlite" } }));
  assert.doesNotThrow(() => assertSynchronousDomainTool("t", { env: {} }));
  for (const raw of ["postgres", "PostgreSQL", " pg "]) {
    throwsWith(
      () => assertSynchronousDomainTool("my-tool", { env: { DB_DRIVER: raw }, hint: "改用 admin API" }),
      /my-tool：只支援 SQLite 模式/,
      `DB_DRIVER=${raw} 必須拒絕`,
    );
    throwsWith(
      () => assertSynchronousDomainTool("my-tool", { env: { DB_DRIVER: raw }, hint: "改用 admin API" }),
      /v3\.db/,
      "訊息要說清楚「只會寫進容器本機 v3.db」",
    );
    throwsWith(
      () => assertSynchronousDomainTool("my-tool", { env: { DB_DRIVER: raw }, hint: "改用 admin API" }),
      /替代做法：改用 admin API/,
      "有 hint 時要附替代做法",
    );
  }
});

test("driverOf：與 resolveDbDriver 同一組判定", () => {
  assert.equal(driverOf({}), "sqlite");
  assert.equal(driverOf({ DB_DRIVER: "postgresql" }), "postgres");
  assert.equal(driverOf({ DB_DRIVER: "PG" }), "postgres");
  assert.equal(driverOf({ DB_DRIVER: "sqlite" }), "sqlite");
});

test("assertPgTargetAllowed：允許清單內放行、清單外必須明示覆寫", () => {
  for (const db of ALLOWED_PG_TARGET_DBS) {
    assert.equal(assertPgTargetAllowed("t", `postgres://u:p@host:5432/${db}`, { env: {} }), db);
  }
  // 正式庫名稱必須被擋下（這正是「指到正式庫就寫正式庫」的那個坑）
  throwsWith(
    () => assertPgTargetAllowed("pg-import", "postgres://u:p@host:5432/5151_shadow", { env: {} }),
    /不在允許清單/,
    "正式庫不得預設放行",
  );
  // 覆寫後放行（而且要回得出資料庫名稱）
  assert.equal(
    assertPgTargetAllowed("pg-import", "postgres://u:p@host:5432/5151_shadow", { env: { [PG_TARGET_OVERRIDE_ENV]: "1" } }),
    "5151_shadow",
  );
  // 取不出名字一律拒絕（不猜目標）
  throwsWith(() => assertPgTargetAllowed("t", "", { env: {} }), /看不出資料庫名稱/, "空 URL 要拒絕");
  throwsWith(() => assertPgTargetAllowed("t", "not-a-url", { env: {} }), /看不出資料庫名稱/, "壞 URL 要拒絕");
  assert.equal(databaseNameFromUrl("postgres://u:p@h:5432/repro?sslmode=require"), "repro");
});

test("v3/scripts 的 PG 工具都接上目標庫守衛（而且 import 真的在）", () => {
  const cases = [
    ["v3/scripts/pg-import.mjs", "pg-import"],
    ["v3/scripts/pg-integration-setup.mjs", "pg-integration-setup"],
    ["v3/scripts/pg-columns-ab.mjs", "pg-columns-ab"],
  ];
  for (const [file, tool] of cases) {
    const src = read(file);
    assert.ok(src.includes('from "../src/domainToolGuards.js"'), `${file} 必須 import 守衛`);
    assert.ok(src.includes(`assertPgTargetAllowed("${tool}"`), `${file} 必須呼叫守衛（指名 ${tool}）`);
  }
});

test("只吃 SQLite handle 的 CI 腳本都接上內嵌守衛（PG 模式 fail-closed）", () => {
  const files = [
    ".github/scripts/activate-rental-marketplace-stage1-domain.mjs",
    ".github/scripts/activate-rental-marketplace-stages-domain.mjs",
    ".github/scripts/activate-rental-marketplace-pra-domain.mjs",
    ".github/scripts/activate-rental-marketplace-stage1-postcheck.mjs",
    ".github/scripts/production-uat-stages-wiring.mjs",
  ];
  for (const file of files) {
    const src = read(file);
    const tool = path.basename(file, ".mjs");
    assert.ok(src.includes("function assertSqliteMode(tool)"), `${file} 必須有內嵌守衛（不能依賴 /app/src 新模組）`);
    assert.ok(src.includes(`assertSqliteMode("${tool}")`), `${file} 必須在做事之前呼叫守衛`);
    // 守衛必須在**任何 DB 存取之前**：比對「呼叫位置」與「第一個 DB 存取記號」的字元索引
    // （不用行號：這些腳本的呼叫點有的在檔案開頭、有的在 main() 裡，行號不是重點）。
    const callAt = src.indexOf(`assertSqliteMode("${tool}")`);
    // ⚠️ 不能用 `db.prepare(` 當記號：這些腳本的 `countDemandPosts(db)` 是**吃參數的純函式**，
    // 它在檔案開頭就出現，卻只有在守衛之後才會被呼叫（第一版就是這樣誤報）。
    // 要盯的是「真的把本機 handle 接上去」與「真的讀寫 flags」的那幾個呼叫點。
    // 盯「main() 真的開始做事」的那幾個記號：動態 import 應用模組、呼叫狀態機、
    // 或（pra-domain 這種沒有 main 的）頂層 mode 分派。狀態機**定義**裡出現的
    // `saveRentalMarketplaceFlags(` 不算——那些函式只有在守衛之後才會被呼叫。
    const dbTokens = [
      "await import(href)", "await import(dbHref)", "import(href)", "import(dbHref)",
      "  runStage1Domain({", "  runStagedDomain({",   // 兩個空白縮排＝main() 內的呼叫，不是函式定義
      "const mode = String(",
    ];
    const firstDbAt = Math.min(...dbTokens.map((t) => {
      const at = src.indexOf(t);
      return at === -1 ? Number.POSITIVE_INFINITY : at;
    }));
    assert.ok(Number.isFinite(firstDbAt), `${file} 找不到 DB 存取記號（這條斷言就沒有鑑別力了）`);
    assert.ok(callAt >= 0 && callAt < firstDbAt,
      `${file} 的守衛必須早於任何 DB 存取（守衛 @${callAt}，第一個 DB 存取 @${firstDbAt}）`);
  }
});

test("PG 工具真的會拒絕未在清單內的目標（以子程序跑 pg-import 的空跑守衛）", () => {
  // pg-import 先檢查 SNAP_DB；這裡刻意只給 PG_URL，確認「守衛」而不是「別的前置檢查」在講話。
  const out = execFileSync(process.execPath, ["-e", `
    process.env.DB_DRIVER = "postgres";
    const { assertPgTargetAllowed } = await import("${path.join(ROOT, "v3/src/domainToolGuards.js")}");
    try {
      assertPgTargetAllowed("pg-import", "postgres://u:p@h:5432/5151_shadow");
      console.log("ALLOWED");
    } catch (error) {
      console.log("REFUSED:" + error.message);
    }
  `], { encoding: "utf8", cwd: ROOT }).trim();
  assert.match(out, /^REFUSED:pg-import：目標資料庫 "5151_shadow" 不在允許清單/);
});

test("run-pg-integration.sh：沒有 PG 要大聲 SKIP，REQUIRE_PG=1 要失敗", () => {
  const script = path.join(ROOT, "v3/scripts/run-pg-integration.sh");
  const cleanEnv = { ...process.env };
  for (const key of ["PG_URL", "PG_TEST_URL", "PGHOST", "DB_DRIVER", "REQUIRE_PG"]) delete cleanEnv[key];

  const skipped = execFileSync("bash", [script], { encoding: "utf8", cwd: ROOT, env: cleanEnv, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(skipped.trim(), "", "沒有 PG 時不該有 stdout（只有 stderr 的 SKIP）");

  let stderr = "";
  try {
    execFileSync("bash", [script], { encoding: "utf8", cwd: ROOT, env: { ...cleanEnv, REQUIRE_PG: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    assert.fail("REQUIRE_PG=1 時必須失敗");
  } catch (error) {
    stderr = String(error.stderr || "");
    assert.notEqual(error.status, 0, "REQUIRE_PG=1 時必須以非 0 結束");
  }
  assert.match(stderr, /SKIP：沒有設定 PG/, "要明講 SKIP（不能靜默通過）");
  assert.match(stderr, /REQUIRE_PG=1/, "要說明為什麼失敗");
});

test("mutation-check：不是 git 工作區就拒絕執行（正式站原始碼目錄會被容器熱載入）", () => {
  const script = path.join(ROOT, "v3/scripts/mutation-check.mjs");
  const src = read("v3/scripts/mutation-check.mjs");
  assert.ok(src.includes("assertMutableSourceTree();"), "必須在工具開頭呼叫守衛");
  assert.ok(src.includes("MUTATION_CHECK_ALLOW_NON_GIT"), "要提供明確覆寫（拋棄式複本用）");

  const tmp = mkdtempSync(path.join(os.tmpdir(), "v3-mutguard-"));
  try {
    let stderr = "";
    try {
      execFileSync(process.execPath, [script, path.join(ROOT, "v3/test/route-data-map.test.js"), "--check-anchors-only"], {
        encoding: "utf8", cwd: tmp, stdio: ["ignore", "pipe", "pipe"],
      });
      assert.fail("非 git 目錄必須拒絕");
    } catch (error) {
      stderr = String(error.stderr || "");
      assert.equal(error.status, 2, "守衛的離開碼要是 2");
    }
    assert.match(stderr, /不是 git 工作區/, "訊息要說明原因");
    assert.match(stderr, /MUTATION_CHECK_ALLOW_NON_GIT=1/, "訊息要提供覆寫方式");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
