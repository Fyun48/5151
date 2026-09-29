// 法律文案（免責聲明／個資說明）PG 分支的 parity（2026-09-28，第五十批）。
//
// 涵蓋的路由：
//   GET /api/disclaimer         → `getLegalCopyAsync`
//   GET /api/admin/legal-copy   → `getLegalCopyAsync`
//   PUT /api/admin/legal-copy   → `saveLegalCopyAsync`
//   GET /api/me                 → 同一支（顯示「使用者同意的那一份」）
//   GET /auth/:provider         → `getStoredOauthAsync` ＋ `getRequiredRegistrationDocumentsAsync`
//
// 🚨 **這一包最重要的發現：`settings.legalCopy` 其實是「種子」，不是來源。**
//   `legalCopyFromDocuments()`（contentDocuments.js:441）**永遠不會回 null**：文件不在時它回
//   `defaultLegalCopy()` 的欄位。而 `getLegalCopy()` 的判斷是
//   `if (fromDocs?.disclaimer && fromDocs?.privacy) return publicLegalCopy(fromDocs)` ——
//   兩個欄位永遠是 truthy ⇒ **`?? settingKey("legalCopy")` 那一路實際上到不了**（除非文件讀取丟例外）。
//   所以：
//     - `settings.legalCopy` 只在 **bootstrap 種文件**時被讀（`seedDefaultDocuments(db, {legalCopy})`）
//     - 之後真正的來源是 `content_documents` 的 registration_terms ＋ privacy_notice
//   測試若按「settings 是回退」寫，會寫出永遠測不到的期望值（第一版就是這樣，5 條紅）。
//
// 這一包要釘住四件事：
//
//   1. **文件優先**：`settings` 就算存了別的值也不會被採用（兩邊都要看得出來）。
//   2. **沒有文件時回「預設值」而不是 settings**（上面那個語意的守衛）。
//   3. **寫入要兩邊都寫**：settings（舊讀者／bootstrap 種子）與 content_documents（CMS 生效來源）。
//   4. **本機鏡射**：還沒移植的同步讀者（`updateUserProfile()` → `withLegalProfile()`）讀節點本機，
//      所以 PG 寫完要順手把本機那份也寫成同一個值。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-legalcopy-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const asyncMod = await import("../src/legalCopyAsync.js");
const dbMod = await import("../src/db.js");
const legalCopy = await import("../src/legalCopy.js");

const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");
const handle = () => dbMod.sqliteHandle();

const NOW = new Date("2026-09-28T00:00:00.000Z");
const IDLE = legalCopy.IDLE_LEGAL_PARAGRAPH;

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown, unknown) does not exist"],
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
];

const TABLES = ["settings", "content_documents", "content_document_events"];

// 夾具把**磁碟上真實的** DDL 與內容文件複製進來（不自己寫表格定義）：
// bootstrap 就種了 registration_terms／privacy_notice，那兩列決定了「走文件還是走預設」。
function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  for (const t of TABLES) {
    const rows = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").all(t);
    assert.equal(rows.length, 1, `必須抓到 ${t} 的 DDL`);
    mem.exec(rows[0].sql);
  }
  for (const t of ["content_documents", "content_document_events"]) {
    const rows = disk.prepare(`SELECT * FROM ${t}`).all();
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    const stmt = mem.prepare(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
    for (const row of rows) stmt.run(...cols.map((c) => row[c]));
  }
  disk.close();
  const exec = async (sql, params = []) => {
    if (typeof sql !== "string" || !/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) {
      throw new Error(`夾具收到不是 SQL 的東西：${Object.prototype.toString.call(sql)}`);
    }
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    const stmt = mem.prepare(sql);
    const rows = stmt.all(...params);
    rows.rowCount = Number(mem.prepare("SELECT changes() AS n").get().n) || 0;
    return rows;
  };
  exec.raw = mem;
  return exec;
}

const setSettings = (h, value) => h.prepare(
  "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
).run("legalCopy", JSON.stringify(value));

const dropDocs = (h) => h.prepare(
  "DELETE FROM content_documents WHERE document_type IN ('registration_terms','privacy_notice')",
).run();

const plain = (value) => JSON.parse(JSON.stringify(value));

// ---------------------------------------------------------------------------

test("文件優先：settings 存了別的值也不會被採用（parity ＋ 絕對值）", async () => {
  const disk = handle();
  const exec = pgFixture();
  // 兩邊的 settings 刻意寫成不同值：誰不小心改成「settings 優先」，parity 與絕對值都會紅。
  const decoy = { disclaimer: "settings假免責", privacy: "settings假個資", version: "v-settings" };
  setSettings(disk, decoy);
  setSettings(exec.raw, decoy);
  const sync = plain(dbMod.getLegalCopy());
  const async_ = plain(await asyncMod.getLegalCopyAsync({ ...PG, exec, strict: true }));
  assert.deepEqual(async_, sync, "兩邊必須逐鍵相同");
  assert.ok(sync.disclaimer && sync.disclaimer !== decoy.disclaimer,
    "前提：磁碟上的文件版本不是那個誘餌值（否則這條測試沒有鑑別力）");
  assert.doesNotMatch(async_.disclaimer || "", /settings假免責/, "必須採用文件，不是 settings");
});

test("文件不存在時回**預設值**，不是 settings（那一路到不了）", async () => {
  const disk = handle();
  const exec = pgFixture();
  const decoy = { disclaimer: "settings假免責", privacy: "settings假個資", version: "v-settings" };
  setSettings(disk, decoy);
  setSettings(exec.raw, decoy);
  dropDocs(disk);
  dropDocs(exec.raw);
  const sync = plain(dbMod.getLegalCopy());
  const async_ = plain(await asyncMod.getLegalCopyAsync({ ...PG, exec, strict: true }));
  assert.deepEqual(async_, sync, "兩邊必須逐鍵相同");
  assert.equal(async_.disclaimer, plain(legalCopy.defaultLegalCopy()).disclaimer,
    "沒有文件時是**預設值**——`legalCopyFromDocuments()` 永遠不會回 null，所以 settings 那一路到不了");
  assert.doesNotMatch(async_.disclaimer || "", /settings假免責/);
  // SQLite 模式的 async 入口必須與同步版完全相同（也讓「非 postgres 也走 PG 分支」的變異有鑑別力：
  // 走 PG 分支時會拿到「文件 → 預設值」，同步版拿到的是 settings 的誘餌值，兩者不同）。
  assert.deepEqual(plain(await asyncMod.getLegalCopyAsync({ driver: "sqlite" })), sync,
    "SQLite 模式的 async 入口必須等於同步版");
});

test("文件讀取丟例外時才走 settings（那一路唯一到得了的情況）", async () => {
  const disk = handle();
  const exec = pgFixture();
  const seeded = {
    disclaimer: "settings裡真正的免責", privacy: "settings裡真正的個資",
    disclaimerCheck: "同意免責", privacyCheck: "同意個資", version: "v-seed",
  };
  setSettings(disk, seeded);
  setSettings(exec.raw, seeded);
  // PG 側：只讓 `content_documents` 的查詢失敗（settings 的查詢照常）——模擬「文件表還沒補建」。
  const selective = async (sql, params = []) => {
    if (/content_documents/i.test(String(sql))) throw new Error('relation "content_documents" does not exist');
    return exec(sql, params);
  };
  // 本機側：把表暫時改名，讓同步版也讀不到文件（同一條 catch → settings）。
  disk.exec("ALTER TABLE content_documents RENAME TO content_documents_hidden");
  try {
    const sync = plain(dbMod.getLegalCopy());
    const async_ = plain(await asyncMod.getLegalCopyAsync({ ...PG, exec: selective, strict: true }));
    assert.deepEqual(async_, sync, "兩邊都必須退回 settings（parity）");
    assert.match(async_.disclaimer, /^settings裡真正的免責/, "必須是 settings 的值（不是預設值）");
    assert.match(async_.disclaimer, /兩個月/, "閒置條款仍要補上");
  } finally {
    disk.exec("ALTER TABLE content_documents_hidden RENAME TO content_documents");
  }
});

test("saveLegalCopyAsync：合併、兩邊都寫、本機鏡射、reset（並與同步版比對落地的位元組）", async () => {
  const disk = handle();
  const exec = pgFixture();
  const before = plain(legalCopy.defaultLegalCopy());
  const TEXT = "同步與非同步都要一樣的免責聲明";

  // 對照組：同步版直接把「落地的位元組」寫進本機（settings 的 JSON ＋ 文件的 body）。
  dbMod.saveLegalCopy({ disclaimer: TEXT });
  const localSetting = JSON.parse(disk.prepare("SELECT value FROM settings WHERE key='legalCopy'").get().value);
  const localBodies = Object.fromEntries(disk.prepare(
    "SELECT document_type, body FROM content_documents WHERE status='published' AND document_type IN ('registration_terms','privacy_notice')",
  ).all().map((row) => [row.document_type, row.body]));
  assert.equal(localSetting.disclaimer, TEXT, "前提：同步版存的是原文（閒置條款是讀取時才補的）");

  const saved = plain(await asyncMod.saveLegalCopyAsync({ disclaimer: TEXT }, { ...PG, exec, strict: true }));
  // `publicLegalCopy()` 會補上兩個月／一年的條款（`ensureIdleLegalClauses`），兩邊一致。
  assert.equal(saved.disclaimer, legalCopy.ensureIdleLegalClauses(TEXT), "讀出來要有自動補的閒置條款");
  assert.equal(saved.privacy, before.privacy, "沒給的欄位要保留（合併而非覆蓋）");

  // 最強的 parity：**兩邊落地的位元組**相同（不是只比回傳值）。
  const pgSetting = JSON.parse(exec.raw.prepare("SELECT value FROM settings WHERE key='legalCopy'").get().value);
  assert.deepEqual(pgSetting, localSetting, "PG 與本機的 settings JSON 必須逐鍵相同");
  const pgBodies = Object.fromEntries(exec.raw.prepare(
    "SELECT document_type, body FROM content_documents WHERE status='published' AND document_type IN ('registration_terms','privacy_notice')",
  ).all().map((row) => [row.document_type, row.body]));
  assert.deepEqual(pgBodies, localBodies, "PG 與本機的文件 body 必須逐字相同");
  assert.equal(pgBodies.registration_terms, TEXT, "免責那份是這次給的字");
  assert.equal(pgBodies.privacy_notice, before.privacy, "個資那份維持原值（合併）");

  // 本機鏡射（還沒移植的同步讀者要用）：現在兩邊讀出來的值要相同
  assert.deepEqual(plain(dbMod.getLegalCopy()), saved, "本機那份也要被鏡射成同一個值");

  // reset：回預設值，而且本機鏡射跟著走
  const reset = plain(await asyncMod.saveLegalCopyAsync({ reset: true }, { ...PG, exec, strict: true }));
  assert.equal(reset.disclaimer, before.disclaimer, "reset 要回預設值");
  assert.deepEqual(plain(dbMod.getLegalCopy()), reset, "本機鏡射也要跟著 reset");
});

test("非 postgres 模式必須走同步路徑（不碰傳入的 exec）", async () => {
  let touched = 0;
  const exec = async () => { touched += 1; return []; };
  const current = plain(dbMod.getLegalCopy()); // 寫入之前先快照，否則比到的是寫入後的狀態
  const read = plain(await asyncMod.getLegalCopyAsync({ driver: "sqlite", exec }));
  const written = plain(await asyncMod.saveLegalCopyAsync({ disclaimer: "走本機" }, { driver: "sqlite", exec }));
  assert.equal(touched, 0, "SQLite 模式不得碰 PG runner");
  assert.deepEqual(read, current, "SQLite 模式讀到的必須是寫入前的本機值");
  assert.equal(written.disclaimer, legalCopy.ensureIdleLegalClauses("走本機"));
  assert.deepEqual(plain(dbMod.getLegalCopy()), written, "同步寫入要落在本機");
});

test("讀取失敗時回退本機（fail-open），寫入失敗時**不**回退（strict）", async () => {
  const disk = handle();
  const local = plain(dbMod.getLegalCopy());
  const broken = async () => { throw new Error("PG 掛了"); };
  const read = plain(await asyncMod.getLegalCopyAsync({ ...PG, exec: broken }));
  assert.deepEqual(read, local, "讀取失敗要回退本機（與同步版相同）");
  await assert.rejects(
    () => asyncMod.saveLegalCopyAsync({ disclaimer: "不該寫進去" }, { ...PG, exec: broken, strict: true }),
    /PG 掛了/,
  );
  assert.notEqual(plain(dbMod.getLegalCopy()).disclaimer, legalCopy.ensureIdleLegalClauses("不該寫進去"),
    "strict 之下不得偷偷寫本機");
  assert.equal(plain(dbMod.getLegalCopy()).disclaimer, local.disclaimer, "本機那份不該被動到");

  // 沒有 `strict` 也要 fail-closed：`sqliteFallback.js` 的預設政策就是「寫入不回退」
  // （回退的話會「表面成功、實際寫在節點本機」，正是這一支要修掉的病）。
  const localNow = plain(dbMod.getLegalCopy());
  await assert.rejects(
    () => asyncMod.saveLegalCopyAsync({ disclaimer: "沒 strict 也不該寫" }, { ...PG, exec: broken }),
    /PG 掛了/,
    "預設政策下寫入失敗必須往上丟，不得回退本機",
  );
  assert.deepEqual(plain(dbMod.getLegalCopy()), localNow, "預設政策下本機那份也不該被動到");
});

test("OAuth 與同意文件同源：PG 有設定才算開通（本機沒有也要看得到）", async () => {
  const settingsKv = await import("../src/settingsKvAsync.js");
  const adminAsync = await import("../src/adminSettingsAsync.js");
  const docsAsync = await import("../src/contentDocumentsAsync.js");
  const exec = pgFixture();
  await settingsKv.setSiteSettingAsync("oauth", {
    google: { enabled: true, clientId: "pg-client", clientSecret: "pg-secret" },
  }, { ...PG, exec, strict: true });
  const stored = plain(await adminAsync.getStoredOauthAsync({ ...PG, exec, strict: true }));
  assert.equal(stored.google.enabled, true, "PG 的設定必須讀得到");
  assert.equal(stored.google.clientId, "pg-client");
  const local = plain(dbMod.getStoredOauth());
  assert.notEqual(local.google?.clientId, "pg-client", "本機不該有這個設定（這樣才證明讀的是 PG）");

  // 同意文件走同一條路：PG 這邊有 published 的兩份時，`/auth/:provider?accept=1` 拿得到 consents
  const consents = plain(await docsAsync.getRequiredRegistrationDocumentsAsync({ now: NOW, ...PG, exec, strict: true }));
  assert.deepEqual(consents.map((d) => d.document_type), ["registration_terms", "privacy_notice"],
    "兩份同意文件都要從 PG 讀出來（順序固定）");
});

test("wiring：三條路由＋/api/me 都必須用 PG 島嶼入口，且不得再留同步呼叫", async () => {
  const { readFileSync } = await import("node:fs");
  const server = readFileSync(path.join(import.meta.dirname, "../src/server.js"), "utf8");
  assert.match(server, /res\.json\(await getLegalCopyAsync\(\)\)/, "GET /api/disclaimer 與 GET /api/admin/legal-copy 都要用島嶼入口");
  assert.match(server, /res\.json\(await saveLegalCopyAsync\(req\.body \|\| \{\}\)\)/, "PUT /api/admin/legal-copy 要走島嶼入口");
  assert.match(server, /const legal = await getLegalCopyAsync\(\)/, "GET /api/me 也要走島嶼入口");
  assert.match(server, /const cfg = \(await getStoredOauthAsync\(\)\)\[provider\]/, "OAuth 設定要從 PG 讀");
  assert.match(server, /const consents = accept \? await getRequiredRegistrationDocumentsAsync\(\) : \[\]/);
  assert.doesNotMatch(server, /getLegalCopy\(\)/, "不得再有同步的法律文案讀取");
  assert.doesNotMatch(server, /saveLegalCopy\(req\.body/, "不得再有同步的法律文案寫入");
  assert.doesNotMatch(server, /getStoredOauth\(\)/, "不得再有同步的 OAuth 設定讀取");
});
