// OAuth callback（`GET /auth/:provider/callback`）的 PG 島嶼 parity（2026-09-29，第八十五批）。
//
// 為什麼這一條是最後三條 MIXED 之一：整條 callback 只有**兩個**落地點是同步的
// （`findUserByEmail` ＋ `linkOauthIdentity`，加上註冊分支的 `registerUserWithConsents`、
// 寄信分支的 `issueVerifyToken`／`queueSystemMail`、登入副作用 `afterMemberSession`、
// 歸因 `attributeShare`），但每一個都指向**節點本機 SQLite**，而 PG 模式的登入讀的是 PG。
//
// 這一包釘住的四件事：
//
//   1. **綁定欄位寫進 PG**：同步版把 provider／subject 寫在本機，PG 模式沒有人讀得到，
//      而且同步版的 try/catch 會把錯誤吞掉（靜默失效）。島嶼版的 SQL／參數要與同步版逐字相同
//      （含 `.slice(0, 40)`／`.slice(0, 120)` 的截斷）。
//   2. **刻意維持「不擋登入」的語意**：綁定失敗只吞掉，strict 模式也不例外——這是同步版的取捨，
//      島嶼版不得偷偷改成 fail-closed 而讓社群登入整條掛掉。
//   3. **id 0 直接短路**：`Number(userId) || 0` 為 0 時同步版也是直接 return，不得送出一條
//      `WHERE id = 0` 的 UPDATE。
//   4. **路由接線**：callback 內不得再有任何同步落地點，而且用到的島嶼**真的被 import**
//      （只刪 import、body 還在呼叫的話，量尺會誤判成 PG，執行時卻是 undefined）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-oauthcb-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ } });

const dbMod = await import("../src/db.js");
const members = await import("../src/members.js");
const usersAsync = await import("../src/usersAsync.js");

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const PG = { driver: "postgres", strict: true };
const handle = () => dbMod.sqliteHandle();
const STAMP = "2026-09-29T00:00:00.000Z";
const UID = 851001;

/** 種一列會員：只要 id／email 與 `users` 的 NOT NULL 欄位，其餘交給 DDL 預設值。 */
function seedUser(id = UID) {
  handle().prepare(
    "INSERT OR IGNORE INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?,?,?,?)",
  ).run(id, `oauth-${id}@example.test`, "社群會員", "member", "free", STAMP);
}

// node:sqlite 回的是 null-prototype 物件：複製成普通物件，`deepEqual` 才比得到值（不是比原型）。
const oauthRow = (id) => ({ ...handle().prepare("SELECT oauth_provider, oauth_subject FROM users WHERE id = ?").get(id) });

/** 收斂 runner 呼叫，讓斷言只看「送了什麼 SQL／參數」。 */
function recorder() {
  const calls = [];
  return {
    calls,
    exec: async (sql, params = []) => { calls.push({ sql, params }); return { rows: [], rowCount: 1 }; },
  };
}

test("PG 模式下 provider／subject 寫進 PG，SQL 與參數與同步版逐字相同（含截斷）", async () => {
  seedUser();
  const provider = "p".repeat(60);
  const subject = "s".repeat(200);
  const truncProvider = provider.slice(0, 40);
  const truncSubject = subject.slice(0, 120);

  // 前提：同步版（本機 SQLite）落地的是截斷後的值。
  members.linkOauthIdentity(handle(), UID, { provider, subject });
  assert.deepEqual(oauthRow(UID), { oauth_provider: truncProvider, oauth_subject: truncSubject });

  // 換成本機哨兵值，證明等一下的島嶼版**不寫本機**（`oauth_*` 是 NOT NULL，不能設 NULL）。
  handle().prepare("UPDATE users SET oauth_provider = 'seed-p', oauth_subject = 'seed-s' WHERE id = ?").run(UID);

  const spy = recorder();
  await usersAsync.linkOauthIdentityAsync(UID, { provider, subject }, { ...PG, exec: spy.exec });

  assert.equal(spy.calls.length, 1, "只送一條 UPDATE");
  assert.equal(spy.calls[0].sql, usersAsync.USER_OAUTH_LINK_SQL);
  assert.match(spy.calls[0].sql, /UPDATE users SET oauth_provider = \?, oauth_subject = \? WHERE id = \?/);
  assert.doesNotMatch(spy.calls[0].sql, /\$\d/, "島嶼 SQL 一律用 ? 佔位（真正的 PG 路徑才做 toPostgresSql）");
  assert.deepEqual(spy.calls[0].params, [truncProvider, truncSubject, UID]);
  assert.deepEqual(oauthRow(UID), { oauth_provider: "seed-p", oauth_subject: "seed-s" },
    "PG 模式不得再寫本機（同步版只寫本機，是靜默失效）");
});

test("缺欄位時同步版送空字串：島嶼版參數逐字相同（不是 undefined）", async () => {
  seedUser();
  members.linkOauthIdentity(handle(), UID, {});
  assert.deepEqual(oauthRow(UID), { oauth_provider: "", oauth_subject: "" });

  const spy = recorder();
  await usersAsync.linkOauthIdentityAsync(UID, {}, { ...PG, exec: spy.exec });
  assert.deepEqual(spy.calls[0].params, ["", "", UID], "`String(provider || \"\")` 的形狀要一致");
});

test("id 0 直接短路：不得送出 WHERE id = 0 的 UPDATE", async () => {
  const spy = recorder();
  await usersAsync.linkOauthIdentityAsync(0, { provider: "google", subject: "s" }, { ...PG, exec: spy.exec });
  await usersAsync.linkOauthIdentityAsync(undefined, { provider: "google", subject: "s" }, { ...PG, exec: spy.exec });
  await usersAsync.linkOauthIdentityAsync("nope", { provider: "google", subject: "s" }, { ...PG, exec: spy.exec });
  assert.equal(spy.calls.length, 0, "沒有 id 就不該碰 DB");
});

test("綁定失敗只吞掉：strict 模式也不例外（與同步版同一個取捨）", async () => {
  const boom = async () => { throw new Error("column \"oauth_provider\" does not exist"); };
  await usersAsync.linkOauthIdentityAsync(UID, { provider: "google", subject: "s" }, { ...PG, exec: boom });
  // 同步版（driver 不是 postgres）也是吞掉的：舊庫沒欄位時不擋登入。
  await usersAsync.linkOauthIdentityAsync(UID, { provider: "google", subject: "s" }, { driver: "sqlite", exec: boom });
});

test("sqlite 模式走同步路徑、不碰 runner", async () => {
  seedUser();
  handle().prepare("UPDATE users SET oauth_provider = 'seed-p', oauth_subject = 'seed-s' WHERE id = ?").run(UID);
  const spy = recorder();
  await usersAsync.linkOauthIdentityAsync(UID, { provider: "line", subject: "U-9" }, { driver: "sqlite", exec: spy.exec });
  assert.equal(spy.calls.length, 0, "sqlite 模式不得呼叫 PG runner");
  assert.deepEqual(oauthRow(UID), { oauth_provider: "line", oauth_subject: "U-9" });
});

test("路由接線：callback 全走 PG 島嶼（而且島嶼真的有 import）", () => {
  const server = readFileSync(path.join(SRC, "server.js"), "utf8");
  const start = server.indexOf('app.get("/auth/:provider/callback"');
  assert.ok(start > 0, "找得到 callback 路由");
  const body = server.slice(start, server.indexOf('app.post("/api/forgot-password"', start));

  for (const wanted of [
    "await findUserByEmailAsync(profile.email)",
    "await registerUserWithConsentsAsync({",
    "await linkOauthIdentityAsync(user.id, { provider, subject: profile.subject })",
    "await updateUserProfileWithLegalAsync(user.id, { nickname: nick })",
    "await issueVerifyTokenAsync(user.id)",
    'await queueSystemMailAsync("welcome"',
    "await afterMemberSessionAsync(user)",
    'await attributeShareAsync(req, user.id, "signup")',
    "mailConfigured(await getStoredSmtpAsync())",
  ]) {
    assert.ok(body.includes(wanted), `要用 ${wanted}`);
  }
  for (const banned of [
    "findUserByEmail(profile.email)",
    "registerUserWithConsents({",
    "linkOauthIdentity(user.id",
    "updateUserProfile(user.id",
    "issueVerifyToken(user.id)",
    'queueSystemMail("welcome"',
    "afterMemberSession(user)",
    "attributeShare(req,",
    "getStoredSmtp()",
  ]) {
    assert.ok(!body.includes(banned), `不得再用同步的 ${banned}`);
  }

  const importBlock = server.slice(
    Math.max(0, server.indexOf('} from "./usersAsync.js";') - 600),
    server.indexOf('} from "./usersAsync.js";'),
  );
  for (const name of ["linkOauthIdentityAsync", "findUserByEmailAsync"]) {
    assert.ok(importBlock.includes(name), `${name} 必須真的被 import（只刪 import 會讓量尺誤判成 PG）`);
  }
  // 同步版 `afterMemberSession()` 的最後一個呼叫端就是這條路由：留著會是死碼，還把同步的
  // `touchLastLogin`／`resumeIdleIfNeeded` 拉在檔案裡。
  assert.ok(!server.includes("function afterMemberSession(user)"), "不得留下沒有人呼叫的同步版");
  for (const bannedImport of ["  touchLastLogin,\n", "  resumeIdleIfNeeded,\n", "  linkOauthIdentity,\n"]) {
    assert.ok(!server.includes(bannedImport), `不得再 import 同步的 ${bannedImport.trim()}`);
  }
});
