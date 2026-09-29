// 個人資料更新（`updateUserProfileAsync`）的 parity（2026-09-29，第六十二批）。
//
// 涵蓋：`PATCH /api/profile`。
//
// 規則是「**只有帶到的欄位才改**、其餘沿用舊值」，而且 `email` 不可改、頭像／LINE QR 要過 URL 白名單、
// 生日與性別要正規化。同步版讀寫節點本機的 `users` ⇒ PG 模式下會員改資料會「看起來成功」，
// 但別的管理節點／後台看到的還是舊的。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-profile-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const dbMod = await import("../src/db.js");
const profile = await import("../src/profile.js");
const profileAsync = await import("../src/profileAsync.js");
const usersAsync = await import("../src/usersAsync.js");

const PG = { driver: "postgres", strict: true };
const handle = () => dbMod.sqliteHandle();
const UID = 900000011001;
const EMAIL = "profile@example.test";

function fixture() {
  const mem = new DatabaseSync(":memory:");
  const ddl = handle().prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  assert.ok(ddl?.sql, "必須抓到 users 的 DDL");
  mem.exec(ddl.sql);
  // 離線夾具要把 PG 的 `$n` 換成 `?`（PG 的位置參數語法；SQLite 只認 `?`／`:name`）。
  // ⚠️ 這支的語句沒有重複引用同一個參數，所以直接依序替換就好（有重複時要重排，見 feedback-async 的夾具）。
  const exec = async (sql, params = []) => mem.prepare(String(sql).replace(/\$(\d+)/g, "?")).all(...params);
  exec.raw = mem;
  return exec;
}

// 只把「這個帳號」放進 PG（本機刻意留空）——PG 站的真實情況。
function pgOnlyWorld(extra = {}) {
  const exec = fixture();
  exec.raw.prepare(
    `INSERT INTO users(id, email, nickname, role, plan, created_at, home_address, contact_phone, birth_date, gender, residence)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(UID, EMAIL, "舊暱稱", "member", "free", "2026-01-01T00:00:00.000Z", "舊地址", "0900000000", "1990-05-05", "male", "台北");
  for (const [k, v] of Object.entries(extra)) exec.raw.prepare(`UPDATE users SET ${k} = ? WHERE id = ?`).run(v, UID);
  return exec;
}

test("只改帶到的欄位：沒帶的沿用、帶了的寫進 PG，形狀與同步版相同", async () => {
  const exec = pgOnlyWorld();
  const viaPg = await profileAsync.updateUserProfileAsync(UID, { nickname: "新暱稱", residence: "高雄" }, { ...PG, exec });
  assert.equal(viaPg.nickname, "新暱稱", "帶到的要改");
  assert.equal(viaPg.residence, "高雄");
  assert.equal(viaPg.home_address, "舊地址", "沒帶到的要沿用");
  assert.equal(viaPg.contact_phone, "0900000000");
  assert.equal(viaPg.birth_date, "1990-05-05");
  assert.equal(viaPg.gender, "male");
  assert.ok(String(viaPg.profile_onboarded_at || "").trim(), "第一次更新要蓋 onboarded 時間");
  const row = exec.raw.prepare("SELECT * FROM users WHERE id = ?").get(UID);
  assert.equal(row.nickname, "新暱稱", "PG 的列要真的被改");
  assert.equal(row.home_address, "舊地址");
  // 同步版（本機）走同一組規則：拿另一個 store 比對「政策」
  const localId = 900000011002;
  handle().prepare("INSERT OR REPLACE INTO users(id, email, nickname, created_at) VALUES (?,?,?,?)")
    .run(localId, "sync-profile@example.test", "舊暱稱", "2026-01-01T00:00:00.000Z");
  const viaSync = profile.updateUserProfile(handle(), localId, { nickname: "新暱稱", residence: "高雄" });
  assert.equal(viaSync.nickname, viaPg.nickname);
  assert.equal(viaSync.residence, viaPg.residence);
  handle().prepare("DELETE FROM users WHERE id = ?").run(localId);
});

test("驗證：email 不可改、頭像 URL 白名單、生日與性別正規化，訊息與同步版相同", async () => {
  const exec = pgOnlyWorld();
  const cases = [
    [{ email: "other@example.test" }, "註冊 Email 不能更改"],
    [{ avatar_url: "https://evil.example.test/x.jpg" }, "頭像"],
    [{ line_qr_url: "javascript:alert(1)" }, "LINE QR"],
    [{ contact_email: "not-an-email" }, "聯絡 Email 格式不對"],
  ];
  for (const [input, expected] of cases) {
    const error = await profileAsync.updateUserProfileAsync(UID, input, { ...PG, exec }).then(() => null, (e) => e);
    assert.ok(error, `${JSON.stringify(input)} 必須被擋下`);
    assert.equal(error.status, 400, `${JSON.stringify(input)} 應該是 400`);
    assert.match(error.message, new RegExp(expected), `訊息要提到 ${expected}（實際 ${error.message}）`);
  }
  // email 換成同一個（大小寫不同）不算改
  const same = await profileAsync.updateUserProfileAsync(UID, { email: EMAIL.toUpperCase() }, { ...PG, exec });
  assert.equal(same.email, EMAIL);
  // 性別與生日正規化：與純函式同一份
  const normalized = await profileAsync.updateUserProfileAsync(UID, { gender: "FEMALE", birth_date: "1991/02/03" }, { ...PG, exec });
  assert.equal(normalized.gender, profile.normalizeGender("FEMALE"));
  assert.equal(normalized.birth_date, profile.normalizeBirthDate("1991/02/03"));
});

test("找不到會員 404、未登入 401（與同步版同義）", async () => {
  const exec = pgOnlyWorld();
  const missing = await profileAsync.updateUserProfileAsync(900000011999, { nickname: "x" }, { ...PG, exec }).then(() => null, (e) => e);
  assert.equal(missing?.status, 404);
  assert.match(missing.message, /找不到這個會員/);
  const anon = await profileAsync.updateUserProfileAsync(0, {}, { ...PG, exec }).then(() => null, (e) => e);
  assert.equal(anon?.status, 401);
  assert.match(anon.message, /請先登入/);
});

test("updateUserProfileWithLegalAsync：法律文案要讀 PG（不是本機那一份）", async () => {
  const exec = pgOnlyWorld();
  // PG 的 settings 放一份與本機不同的法律文案（本機用 bootstrap 的預設值）。
  exec.raw.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)");
  exec.raw.exec("CREATE TABLE IF NOT EXISTS content_documents (id INTEGER PRIMARY KEY, document_type TEXT, version INTEGER, title TEXT, body TEXT, format TEXT, check_label TEXT, status TEXT, enabled INTEGER, requires_reacceptance INTEGER, effective_from TEXT, effective_until TEXT, content_hash TEXT, created_by INTEGER, created_at TEXT, supersedes_id INTEGER)");
  for (const [type, body, check] of [
    ["registration_terms", "PG 的免責內文", "PG 的免責勾選"],
    ["privacy_notice", "PG 的個資內文", "PG 的個資勾選"],
  ]) {
    exec.raw.prepare(
      `INSERT INTO content_documents(document_type, version, title, body, format, check_label, status, enabled, requires_reacceptance, effective_from, content_hash, created_by, created_at)
       VALUES (?, 1, 't', ?, 'plain', ?, 'published', 1, 0, '2026-01-01T00:00:00.000Z', 'h', 0, '2026-01-01T00:00:00.000Z')`,
    ).run(type, body, check);
  }
  const out = await usersAsync.updateUserProfileWithLegalAsync(UID, { nickname: "有法律文案" }, { ...PG, exec });
  assert.equal(out.nickname, "有法律文案");
  // ⚠️ `publicLegalCopy()` 會補上「兩個月／一年」的閒置條款（與同步版同一個 `ensureIdleLegalClauses`），
  // 所以比對用 startsWith：重點是**內文來自 PG**，不是被補上的那一段。
  assert.match(out.disclaimer_text, /^PG 的免責內文/, `法律文案要從 PG 讀（實際 ${out.disclaimer_text.slice(0, 40)}）`);
  assert.equal(out.privacy_text, "PG 的個資內文");
  assert.equal(out.disclaimer_check, "PG 的免責勾選");
  assert.match(String(out.legal_version), /^v\d+$/, "有生效文件時版本是 vN");
  assert.equal(out.email, EMAIL, "公開形狀要帶 email");
  assert.ok(!("password_hash" in out), "不得帶出雜湊");
});

test("非 postgres：走同步路徑（不碰傳入的 exec）", async () => {
  fixture();
  const localId = 900000011003;
  handle().prepare("INSERT OR REPLACE INTO users(id, email, nickname, created_at) VALUES (?,?,?,?)")
    .run(localId, "sqlite-profile@example.test", "本機", "2026-01-01T00:00:00.000Z");
  let calls = 0;
  const boom = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  const out = await profileAsync.updateUserProfileAsync(localId, { nickname: "改本機" }, { driver: "sqlite", exec: boom });
  assert.equal(out.nickname, "改本機");
  assert.equal(handle().prepare("SELECT nickname FROM users WHERE id = ?").get(localId).nickname, "改本機");
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
  handle().prepare("DELETE FROM users WHERE id = ?").run(localId);
});
