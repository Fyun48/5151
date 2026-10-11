// SQLite 退場 P3（2026-10-10）：五處「PG 已寫成功、接著再寫本機 SQLite」的鏡射寫入已移除。
//
// 這一包要釘住的是**當初的 bug 本身**，不是 parity：正式站三隻都開著 `PG_NO_SQLITE_OPEN=1`，
// 所以那五句鏡射會直接拋「business SQLite is closed」——資料已經進 PG、使用者卻收到失敗
// （半套寫入）。修好之前這五個呼叫點**必定拋錯**（見 PR 描述的開閘 probe 輸出）。
//
// 驗法沿用 `pg-no-sqlite-open.test.js` 的形狀：**子行程**在乾淨的 process 裡帶著閘 import，
// 因為 `db.js` 開不開 SQLite 是 import 階段決定的，而 ESM 模組會被快取。
//   - 夾具：v3.db 由一支沒有閘的子行程先建好（拿它的 DDL 當 PG 替身的來源，不手寫表格定義），
//     子行程自己唯讀讀 DDL、建 in-memory SQLite 當 PG 替身，再用同一族的方言跑真實 SQL。
//   - pg 替身故意**種 `listing_id = NULL` 的匯入列**：`selfListingsAsync.js` 還有自己的鏡射點
//     （`updateImportedDraftListingAsync`／`abandonImportedDraftListingAsync`），那幾處不在本包
//     範圍，會蓋掉這裡要驗的五行。清單見 PR 描述。
//   - `siteContentAsync.js` 的兩支照 Owner 指定的形狀：`exec` 只要回 `{ rows: [], rowCount: 0 }`。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(repoRoot, "src");
const dbJsUrl = pathToFileURL(join(srcDir, "db.js")).href;
const importModUrl = pathToFileURL(join(srcDir, "listingImportAsync.js")).href;
const contentModUrl = pathToFileURL(join(srcDir, "siteContentAsync.js")).href;

const dataDir = mkdtempSync(join(tmpdir(), "v3-p3-gate-"));
process.on("exit", () => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

// 子行程：帶著閘（PG_NO_SQLITE_OPEN=1、DB_DRIVER=postgres）跑指定的那個呼叫點。
const PROBE = `
const { DatabaseSync } = await import("node:sqlite");
const { writeFileSync } = await import("node:fs");
const path = await import("node:path");

const OLD = "2026-01-01T00:00:00.000Z";
const NOW = "2026-10-10T00:00:00.000Z";
const USER = 91;
const IMPORT_ID = 610001;
const DOC_ID = 700001;
// 由真正的 migrations 建出來的表（DDL 逐字取自 v3.db，不自己寫表格定義）。
const TABLES = ["content_documents", "listing_import", "listings", "member_consents", "member_media", "media_tag_map", "media_tags", "settings", "users"];

function fixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(path.join(process.env.DATA_DIR, "v3.db"), { readOnly: true });
  for (const t of TABLES) {
    const rows = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").all(t);
    if (!rows.length) throw new Error("夾具找不到 " + t + " 的 DDL");
    mem.exec(rows[0].sql);
  }
  disk.close();
  const exec = async (sql, params = []) => {
    const rows = mem.prepare(sql).all(...params);
    const rowCount = Number(mem.prepare("SELECT changes() AS n").get().n) || 0;
    return { rows, rowCount };
  };
  exec.raw = mem;
  return exec;
}

function seed(h) {
  h.prepare("INSERT INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?, 'member','sponsor', ?)")
    .run(USER, "p3-gate@example.com", "P3 閘", OLD);
  h.prepare(
    \`INSERT INTO content_documents(id, document_type, version, title, body, format, check_label, status, enabled,
       requires_reacceptance, effective_from, effective_until, content_hash, created_at, published_at)
     VALUES (?, 'external_import_declaration', 1, '匯入聲明', '內容', 'plain', '', 'published', 1, 0, NULL, NULL, 'decl-v1', ?, ?)\`,
  ).run(DOC_ID, OLD, OLD);
  // ⚠️ \`listing_id = NULL\`：草稿那條路徑的鏡射在 selfListingsAsync.js（不在本包範圍），
  // 留著會先拋錯、蓋掉這裡要驗的五行。
  h.prepare(
    \`INSERT INTO listing_import(id, user_id, provider, original_source_url, normalized_source_url, source_listing_id,
       status, imported_title, imported_text, listing_id, terms_document_id, declaration_version,
       declaration_content_hash, created_at, fetched_at, confirmed_at, failure_code, failure_reason, photo_errors, media_ids)
     VALUES (?, ?, '591', 'https://example.com/610001', 'https://example.com/610001', '', 'ready_for_review',
       '匯入標題 610001', '匯入內容', NULL, NULL, NULL, '', ?, ?, NULL, '', '', '[]', '[]')\`,
  ).run(IMPORT_ID, USER, OLD, OLD);
}

const PG = { driver: "postgres", strict: true };
const out = { probe: process.env.PROBE_CASE, threw: false, message: "", detail: null };
try {
  const exec = fixture();
  seed(exec.raw);
  if (process.env.PROBE_CASE === "review") {
    const mod = await import(process.env.IMPORT_MOD_URL);
    const view = await mod.reviewListingImportAsync(USER, IMPORT_ID, { title: "新的標題", body: "新的內容" }, { ...PG, exec });
    out.detail = { returned: view.imported_title, pg: exec.raw.prepare("SELECT status, imported_title, imported_text FROM listing_import WHERE id=?").get(IMPORT_ID) };
  } else if (process.env.PROBE_CASE === "cancel") {
    const mod = await import(process.env.IMPORT_MOD_URL);
    const view = await mod.cancelListingImportAsync(USER, IMPORT_ID, { ...PG, exec, now: new Date(NOW) });
    out.detail = { returned: view.status, pg: exec.raw.prepare("SELECT status FROM listing_import WHERE id=?").get(IMPORT_ID) };
  } else if (process.env.PROBE_CASE === "confirm") {
    const mod = await import(process.env.IMPORT_MOD_URL);
    const view = await mod.confirmListingImportAsync(USER, IMPORT_ID, { accept: true, document_id: DOC_ID, version: 1, content_hash: "decl-v1" }, { ...PG, exec, now: new Date(NOW) });
    out.detail = { returned: view.status, pg: exec.raw.prepare("SELECT status, terms_document_id, declaration_version, declaration_content_hash FROM listing_import WHERE id=?").get(IMPORT_ID), consents: Number(exec.raw.prepare("SELECT COUNT(*) AS n FROM member_consents").get().n) || 0 };
  } else if (process.env.PROBE_CASE === "catalog") {
    const mod = await import(process.env.CONTENT_MOD_URL);
    const stub = async () => ({ rows: [], rowCount: 0 });
    const snap = await mod.refreshSiteCatalogStatsAsync({ ...PG, exec: stub });
    out.detail = { total: snap.total, at: snap.at };
  } else if (process.env.PROBE_CASE === "saveCrawl") {
    const mod = await import(process.env.CONTENT_MOD_URL);
    const stub = async () => ({ rows: [], rowCount: 0 });
    const next = await mod.saveSystemCrawlAsync({ intervalMinutes: 90 }, { ...PG, exec: stub });
    out.detail = { intervalMinutes: next.intervalMinutes, catalog: typeof next.catalog?.total === "number" };
  } else {
    throw new Error("未知的 PROBE_CASE：" + process.env.PROBE_CASE);
  }
} catch (error) {
  out.threw = true;
  out.message = String((error && error.message) || error);
}
writeFileSync(process.env.RESULT_FILE, JSON.stringify(out));
`;

before(() => {
  const setup = spawnSync(process.execPath, ["--input-type=module", "-e", "await import(process.env.DB_JS_URL);"], {
    env: { ...process.env, DATA_DIR: dataDir, DB_JS_URL: dbJsUrl, DB_DRIVER: "sqlite", PG_NO_SQLITE_OPEN: "" },
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(setup.status, 0, `建 v3.db 失敗：${String(setup.stderr).slice(0, 800)}`);
});

function probe(probeCase) {
  const resultFile = join(dataDir, `result-${probeCase}.json`);
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", PROBE], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      DB_DRIVER: "postgres",
      PG_NO_SQLITE_OPEN: "1",
      IMPORT_MOD_URL: importModUrl,
      CONTENT_MOD_URL: contentModUrl,
      PROBE_CASE: probeCase,
      RESULT_FILE: resultFile,
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  if (r.status !== 0) return { probe: probeCase, threw: true, message: `子行程退出碼 ${r.status}：${String(r.stderr).slice(0, 800)}` };
  return JSON.parse(readFileSync(resultFile, "utf8"));
}

// 五個呼叫點各一條：修好之前每一條都會拿到
// `business SQLite is closed (PG_NO_SQLITE_OPEN=1, DB_DRIVER=postgres)`。
test("審核匯入（改標題／內文）：PG 成功後不得再碰 sqliteHandle（開閘不拋）", () => {
  const result = probe("review");
  assert.equal(result.threw, false, `開閘不得拋錯（真的拋了：${result.message}）`);
  assert.deepEqual(result.detail.pg, { status: "ready_for_review", imported_title: "新的標題", imported_text: "新的內容" }, "PG 那一列要照樣寫成功");
});

test("取消匯入：PG 成功後不得再碰 sqliteHandle（開閘不拋）", () => {
  const result = probe("cancel");
  assert.equal(result.threw, false, `開閘不得拋錯（真的拋了：${result.message}）`);
  assert.equal(result.detail.pg.status, "cancelled", "PG 那一列要照樣取消成功");
  assert.equal(result.detail.returned, "cancelled");
});

test("確認匯入：PG 成功後不得再碰 sqliteHandle（開閘不拋）", () => {
  const result = probe("confirm");
  assert.equal(result.threw, false, `開閘不得拋錯（真的拋了：${result.message}）`);
  assert.deepEqual(result.detail.pg, { status: "confirmed", terms_document_id: 700001, declaration_version: 1, declaration_content_hash: "decl-v1" }, "PG 那一列要照樣確認成功");
  assert.equal(result.detail.consents, 1, "同意紀錄也要進 PG（鏡射寫在本機那一步不影響它）");
});

test("refreshSiteCatalogStatsAsync：開閘下不碰 sqliteHandle（stub exec 回 {rows:[],rowCount:0}）", () => {
  const result = probe("catalog");
  assert.equal(result.threw, false, `開閘不得拋錯（真的拋了：${result.message}）`);
  assert.equal(result.detail.total, 0, "快照照樣算得出來（stub 沒有列）");
  assert.match(String(result.detail.at), /^\d{4}-\d{2}-\d{2}T/, "at 仍要是 ISO 時間字串");
});

test("saveSystemCrawlAsync：開閘下不碰 sqliteHandle（stub exec 回 {rows:[],rowCount:0}）", () => {
  const result = probe("saveCrawl");
  assert.equal(result.threw, false, `開閘不得拋錯（真的拋了：${result.message}）`);
  assert.equal(typeof result.detail.intervalMinutes, "number", "五個鍵照樣寫進 PG（stub 沒有值 ⇒ 夾回政策預設）");
  assert.equal(result.detail.catalog, true, "後面接的目錄快照也要跑完");
});

// 原始碼層級：就算夾具哪天變了，也不能再把這五處鏡射寫回來。
test("原始碼層級：五處鏡射呼叫點已移除，siteContentAsync 不再引用 sqliteHandle", () => {
  const imports = readFileSync(join(srcDir, "listingImportAsync.js"), "utf8");
  assert.doesNotMatch(imports, /sqliteHandle\(\)\.prepare\(IMPORT_TITLE_TEXT_UPDATE_SQL\)/, "審核不得再鏡射本機 listing_import");
  assert.doesNotMatch(imports, /sqliteHandle\(\)\.prepare\(IMPORT_STATUS_UPDATE_SQL\)\.run\(IMPORT_STATUSES\.CANCELLED/, "取消不得再鏡射本機 listing_import");
  assert.doesNotMatch(imports, /sqliteHandle\(\)\.prepare\(IMPORT_CONFIRM_UPDATE_SQL\)/, "確認不得再鏡射本機 listing_import");

  const content = readFileSync(join(srcDir, "siteContentAsync.js"), "utf8");
  assert.doesNotMatch(content, /sqliteHandle/, "siteContentAsync 不得再碰本機 handle（連 import 都不該有）");
  assert.doesNotMatch(content, /SETTINGS_UPSERT_SQL/, "siteContentAsync 不得再寫本機 settings");
});
