// 註冊（`POST /api/register`）的 PG 島嶼 parity（2026-09-28，第七十五批）。
//
// 為什麼這一包重要：同步版 `registerUser()` 把新帳號寫進**節點本機 SQLite**，而
// `verifyLoginAsync()` 讀的是 PG ⇒ PG 模式下「註冊成功、卻登不進去」（與第七十批的改密碼同類）。
// 同一條路由還有第二個 store 錯誤：`issueVerifyToken()` 把開通 token 寫在本機，會員點信裡的
// 連結時（`confirmVerifyTokenAsync` 讀 PG）永遠是「找不到這個開通連結」。
//
// 這一包釘住的五件事：
//
//   1. **落地欄位與同步版逐鍵相同**（`role`／`plan`／`signup_count`／`email_verified`／
//      `accepted_disclaimer_at`／`disclaimer_version`），而且 PG 模式下**不寫本機的帳號**。
//   2. **未驗證帳號可重送**：沿用同一列、只更新雜湊與同意戳記，不得多一列。
//   3. **已刪除帳號可復活**：`signup_count + 1`、`deleted_at` 清空、`plan` 回到 free；
//      已刪除兩次是 409（訊息逐字相同）。
//   4. **驗證與錯誤形狀**：免責聲明／個資／Email／密碼四種 400、已註冊 409，訊息與同步版逐字相同。
//   5. **開通 token 與同意紀錄都寫 PG**：`issueVerifyTokenAsync()` 的 UPDATE 要讓 PG 讀得到
//      （點連結才不會壞），`registerUserWithConsentsAsync()` 的帳號 ＋ 同意要在同一個交易。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-register-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ } });

const dbMod = await import("../src/db.js");
const members = await import("../src/members.js");
const usersAsync = await import("../src/usersAsync.js");
const verifyAsync = await import("../src/emailVerifyAsync.js");
const emailVerify = await import("../src/emailVerify.js");
const { hashPassword, verifyPassword } = await import("../src/password.js");

const PG = { driver: "postgres", strict: true };
const handle = () => dbMod.sqliteHandle();
const diskPath = () => path.join(dataDir, "v3.db");
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
const NOW = "2026-09-28T00:00:00.000Z";
const TTL_DAYS = 3;
// 新帳號的 id 由 `users` 的 AUTOINCREMENT 決定：夾具先種一列哨兵，讓新註冊的 id 落在
// 本機既有帳號之上（否則本機鏡射會寫到別的帳號，斷言會互相污染）。
const SENTINEL = 960000;

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown, unknown) does not exist"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  [/\bAUTOINCREMENT\b/i, "syntax error at or near \"AUTOINCREMENT\""],
];
const TABLES = ["users", "settings", "member_consents", "content_documents"];

const userColumns = (h) => h.prepare("PRAGMA table_info(users)").all().map((c) => c.name);

/** 種一列會員：只指定需要的欄位，其餘交給 DDL 的預設值（`disclaimer_version` 等是 NOT NULL）。 */
function seedUser(h, { email, plan = "free", emailVerified = 0, signupCount = 1, deletedAt = null, password = "oldpassword1" }) {
  const values = {
    email,
    nickname: "既有會員",
    role: "member",
    plan,
    created_at: NOW,
    email_verified: emailVerified,
    signup_count: signupCount,
    deleted_at: deletedAt,
    password_hash: hashPassword(password),
  };
  const cols = Object.keys(values);
  h.prepare(`INSERT INTO users(${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(...cols.map((c) => values[c]));
  return Number(h.prepare("SELECT id FROM users WHERE email = ?").get(email).id);
}

/** PG 替身：鏡射磁碟上的 DDL（**不自己寫表格定義**）＋ 複製 bootstrap 的文件列。 */
function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  for (const t of TABLES) {
    const rows = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").all(t);
    assert.equal(rows.length, 1, `必須抓到 ${t} 的 DDL（夾具不自己寫表格定義）`);
    mem.exec(rows[0].sql);
  }
  // 正式 PG 站上已經有 bootstrap 種好的註冊文件；夾具只鏡射 DDL ⇒ 要把磁碟的列原樣複製，
  // 兩個 store 的「待同意清單」才會一樣（否則註冊會拿到 503「無法取得有效的註冊條款」）。
  const docCols = disk.prepare("PRAGMA table_info(content_documents)").all().map((c) => c.name);
  const docRows = disk.prepare("SELECT * FROM content_documents").all();
  assert.ok(docRows.length >= 2, "前提：bootstrap 至少要種出註冊用的兩份文件");
  const docInsert = mem.prepare(
    `INSERT INTO content_documents(${docCols.join(",")}) VALUES (${docCols.map(() => "?").join(",")})`,
  );
  for (const row of docRows) docInsert.run(...docCols.map((c) => row[c]));
  disk.close();
  assert.ok(userColumns(mem).includes("profile_privacy_at"), "前提：users 要有個資戳記欄");
  seedUser(mem, { email: "sentinel@example.test", emailVerified: 1 });
  mem.prepare("UPDATE users SET id = ? WHERE email = 'sentinel@example.test'").run(SENTINEL);
  const exec = async (sql, params = []) => {
    if (typeof sql !== "string" || !/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i.test(sql)) {
      throw new Error(`夾具收到不是 SQL 的東西：${Object.prototype.toString.call(sql)}`);
    }
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    const rows = mem.prepare(sql).all(...params);
    return { rows, rowCount: Number(mem.prepare("SELECT changes() AS n").get().n) || 0 };
  };
  exec.raw = mem;
  return exec;
}

/** 兩個 store 種同一份起點（同步基準在本機、PG 版在替身）。 */
function worlds(seed) {
  const disk = handle();
  const exec = pgFixture();
  if (seed) seed({ disk, pg: exec.raw });
  return [disk, exec];
}

const registrationDocs = (h) => h.prepare(
  "SELECT id, document_type, version, content_hash FROM content_documents WHERE document_type IN ('registration_terms','privacy_notice') ORDER BY document_type",
).all();
const REGISTRATION_DOC_COUNT = 2;
const consentsFor = (h) => registrationDocs(h).map((doc) => ({
  document_type: doc.document_type,
  document_id: doc.id,
  version: doc.version,
  content_hash: doc.content_hash,
}));

let seq = 0;
const freshEmail = () => `reg-${Date.now()}-${(seq += 1)}@example.test`;
const localUser = (email) => handle().prepare("SELECT * FROM users WHERE email = ?").get(email) || null;

/** 只比對「註冊會落地」的欄位；時間戳與 id 兩個 store 一定不同。 */
const shape = (row) => ({
  role: row.role,
  plan: row.plan,
  signup_count: Number(row.signup_count),
  email_verified: Number(row.email_verified),
  disclaimer_version: row.disclaimer_version,
  accepted_disclaimer: Boolean(String(row.accepted_disclaimer_at || "").trim()),
  privacy_stamped: Boolean(String(row.profile_privacy_at || "").trim()),
  deleted: Boolean(String(row.deleted_at || "").trim()),
});
const errorShape = (fn) => {
  try { fn(); return null; } catch (error) { return { status: error.status, message: error.message }; }
};
const asyncErrorShape = async (fn) => {
  try { await fn(); return null; } catch (error) { return { status: error.status, message: error.message }; }
};

test("新增帳號：落地欄位與同步版逐鍵相同，而且 PG 模式不寫本機帳號", async () => {
  const [disk, exec] = worlds();
  const syncEmail = freshEmail();
  const asyncEmail = freshEmail();
  const syncUser = members.registerUser(disk, { email: syncEmail, password: "password1", acceptDisclaimer: true });
  const asyncUser = await usersAsync.registerUserAsync(
    exec, { email: asyncEmail, password: "password1", acceptDisclaimer: true, emailVerified: false }, { now: NOW },
  );
  assert.equal(asyncUser.email, asyncEmail);
  assert.deepEqual(
    shape(asyncUser),
    { ...shape(syncUser), email_verified: 0 },
    "落地欄位必須與同步版逐鍵相同（`email_verified` 例外：註冊路由傳 false）",
  );
  assert.ok(verifyPassword("password1", asyncUser.password_hash), "密碼要能用同一份雜湊驗證通過");
  assert.equal(localUser(asyncEmail), null, "PG 模式下不得在本機多寫一個帳號（否則又是兩個 store）");
  assert.ok(Number(asyncUser.id) > SENTINEL, "新帳號要有 id（`RETURNING id`）");
});

test("未驗證帳號可重送：沿用同一列、更新雜湊；已驗證帳號是 409", async () => {
  const email = freshEmail();
  const [disk, exec] = worlds(({ disk: d, pg }) => {
    seedUser(d, { email, emailVerified: 0, password: "oldpassword1" });
    seedUser(pg, { email, emailVerified: 0, password: "oldpassword1" });
  });
  const before = exec.raw.prepare("SELECT id, password_hash FROM users WHERE email = ?").get(email);
  const localBefore = localUser(email).password_hash;
  const input = { email, password: "newpassword2", acceptDisclaimer: true, emailVerified: false };
  // PG 版先跑：本機那一列還沒有被同步基準改過，才驗得出「PG 版不碰本機」。
  const asyncAgain = await usersAsync.registerUserAsync(exec, input, { now: NOW });
  assert.equal(Number(asyncAgain.id), Number(before.id), "重送必須沿用同一列（不是新帳號）");
  assert.notEqual(asyncAgain.password_hash, before.password_hash, "密碼雜湊要更新成新的");
  assert.ok(verifyPassword("newpassword2", asyncAgain.password_hash), "新密碼要能驗證");
  assert.equal(exec.raw.prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").get(email).n, 1, "重送不得多出一列");
  assert.equal(Number(asyncAgain.email_verified), 0, "重送之後仍然是未驗證");
  assert.equal(localUser(email).password_hash, localBefore, "PG 版的寫入不得碰本機那一列");
  assert.equal(verifyPassword("oldpassword1", asyncAgain.password_hash), false, "舊密碼必須失效");
  const syncAgain = members.registerUser(disk, input);
  assert.deepEqual(shape(asyncAgain), shape(syncAgain), "重送後的落地欄位必須與同步版相同");

  // 已驗證且未刪除 → 409（與同步版同一個訊息）
  const takenEmail = freshEmail();
  seedUser(disk, { email: takenEmail, emailVerified: 1 });
  seedUser(exec.raw, { email: takenEmail, emailVerified: 1 });
  const syncErr = errorShape(() => members.registerUser(disk, { email: takenEmail, password: "password1", acceptDisclaimer: true, emailVerified: false }));
  const asyncErr = await asyncErrorShape(() => usersAsync.registerUserAsync(
    exec, { email: takenEmail, password: "password1", acceptDisclaimer: true, emailVerified: false }, { now: NOW },
  ));
  assert.equal(syncErr?.status, 409, "前提：同步版對已註冊帳號丟 409");
  assert.deepEqual(asyncErr, syncErr, "錯誤形狀必須與同步版相同");

  // 「未驗證」+ `emailVerified` **不是 false**（例如 OAuth 或後台代開）⇒ 走的是 409，不能順手改密碼。
  // 這一格是 `emailVerified === false` 這個條件的鑑別力來源（少了它就變成「未驗證帳號任人改密碼」）。
  const unverifiedEmail = freshEmail();
  seedUser(disk, { email: unverifiedEmail, emailVerified: 0 });
  seedUser(exec.raw, { email: unverifiedEmail, emailVerified: 0 });
  const openInput = { email: unverifiedEmail, password: "password9", acceptDisclaimer: true };
  const openSync = errorShape(() => members.registerUser(disk, openInput));
  const openAsync = await asyncErrorShape(() => usersAsync.registerUserAsync(exec, openInput, { now: NOW }));
  assert.equal(openSync?.status, 409, "前提：同步版對未驗證但非註冊流程的帳號丟 409");
  assert.deepEqual(openAsync, openSync, "未驗證帳號 + `emailVerified` 未指定時必須與同步版相同（409）");
  assert.ok(
    verifyPassword("oldpassword1", exec.raw.prepare("SELECT password_hash FROM users WHERE email = ?").get(unverifiedEmail).password_hash),
    "被擋下時不得改動那一列的雜湊",
  );
});

test("已刪除帳號：復活時 signup_count +1、deleted_at 清空、plan 回 free；兩次之後 409", async () => {
  const email = freshEmail();
  const [disk, exec] = worlds(({ disk: d, pg }) => {
    for (const h of [d, pg]) {
      seedUser(h, { email, plan: "sponsor", emailVerified: 0, signupCount: 1, deletedAt: "2026-09-01T00:00:00.000Z" });
    }
  });
  const input = { email, password: "password1", acceptDisclaimer: true, emailVerified: false };
  const syncUser = members.registerUser(disk, input);
  const revived = await usersAsync.registerUserAsync(exec, input, { now: NOW });
  assert.equal(revived.deleted_at, null, "deleted_at 必須清空");
  assert.deepEqual(shape(revived), shape(syncUser), "復活後的落地欄位必須與同步版相同");
  assert.equal(revived.plan, "free", "復活要回到 free 方案");
  assert.equal(Number(revived.signup_count), 2, "signup_count 要 +1（刪除兩次的上限靠它）");
  assert.equal(String(revived.deleted_by || ""), "", "刪除註記要清掉");
  assert.equal(String(revived.deleted_reason || ""), "", "刪除原因要清掉");
  assert.equal(Number(revived.id), Number(exec.raw.prepare("SELECT id FROM users WHERE email = ?").get(email).id), "復活要用原本那一列");

  // 第二次刪除之後（signup_count = 2）不能再註冊
  for (const h of [disk, exec.raw]) h.prepare("UPDATE users SET signup_count = 2, deleted_at = ? WHERE email = ?").run(NOW, email);
  const syncErr = errorShape(() => members.registerUser(disk, input));
  const asyncErr = await asyncErrorShape(() => usersAsync.registerUserAsync(exec, input, { now: NOW }));
  assert.ok(syncErr, "前提：同步版擋下已刪除兩次的帳號");
  assert.deepEqual(asyncErr, syncErr, "錯誤形狀必須與同步版相同");
  assert.equal(asyncErr?.message, "這個 Email 已刪除兩次，不能再註冊", "訊息必須逐字相同");
  assert.equal(
    Number(exec.raw.prepare("SELECT signup_count FROM users WHERE email = ?").get(email).signup_count), 2,
    "被擋下時不得改動 signup_count",
  );
});

test("參數驗證：四種 400 的訊息與同步版逐字相同（不會偷偷寫入）", async () => {
  const [disk, exec] = worlds();
  const cases = [
    [{ email: freshEmail(), password: "password1" }, "沒有同意免責聲明"],
    [{ email: freshEmail(), password: "password1", acceptDisclaimer: true, acceptPrivacy: false }, "不同意個資"],
    [{ email: "not-an-email", password: "password1", acceptDisclaimer: true }, "Email 不合法"],
    [{ email: freshEmail(), password: "short", acceptDisclaimer: true }, "密碼太短"],
  ];
  for (const [input, why] of cases) {
    const syncErr = errorShape(() => members.registerUser(disk, input));
    const asyncErr = await asyncErrorShape(() => usersAsync.registerUserAsync(exec, input, { now: NOW }));
    assert.ok(syncErr, `前提：同步版要擋下（${why}）`);
    assert.deepEqual(asyncErr, syncErr, `錯誤形狀必須相同（${why}）`);
    assert.equal(
      exec.raw.prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").get(String(input.email)).n, 0,
      `被擋下時不得寫入（${why}）`,
    );
  }
});

test("交易版（含同意紀錄）：同意列寫進 PG；帳號與同意同一個交易", async () => {
  const [disk, exec] = worlds();
  const register = (email) => usersAsync.registerUserWithConsentsAsync(
    { email, password: "password1", acceptDisclaimer: true, emailVerified: false, consents: consentsFor(exec.raw) },
    { now: NOW, ...PG, exec },
  );
  const pgConsents = (uid) => exec.raw.prepare(
    "SELECT document_type, document_id, version, content_hash, source FROM member_consents WHERE user_id = ? ORDER BY document_type",
  ).all(uid);

  // (a) 本機沒有這個帳號（PG 模式的常態）⇒ 同意列只寫 PG，不硬寫本機（`member_consents` 有 FK）。
  const email = freshEmail();
  const user = await register(email);
  assert.equal(user.email, email);
  const rows = pgConsents(user.id);
  assert.equal(rows.length, REGISTRATION_DOC_COUNT, "每一個註冊文件都要有一列同意紀錄");
  assert.ok(rows.every((row) => row.source === "registration"), "來源必須是 registration");
  assert.ok(rows.every((row) => row.content_hash), "同意列要留下當下的 content_hash");
  assert.equal(localUser(email), null, "PG 模式的註冊不得在本機補出帳號（否則又是兩個 store）");
  assert.equal(
    disk.prepare("SELECT COUNT(*) AS n FROM member_consents WHERE user_id = ?").get(user.id).n, 0,
    "本機沒有那個帳號時，同意列不得硬寫本機",
  );

  // (b) 本機本來就有同一個 id 的帳號（舊站升級、或別的節點同步過來）：P5b 起**不再鏡射**——
  // `db.js` 的同步同意讀者已無呼叫端，鏡射只會在開閘後撞到關閉的 handle。
  const mirroredEmail = freshEmail();
  const nextId = Number(user.id) + 1;
  assert.equal(nextId, SENTINEL + 2, "前提：PG 的 id 是可預期的（哨兵 +1 之後遞增）");
  disk.prepare("INSERT INTO users(id, email, role, plan, created_at, disclaimer_version, password_hash) VALUES (?,?,?,?,?,?,?)")
    .run(nextId, mirroredEmail, "member", "free", NOW, "", hashPassword("password1"));
  const mirrored = await register(mirroredEmail);
  assert.equal(Number(mirrored.id), nextId);
  assert.equal(
    disk.prepare("SELECT COUNT(*) AS n FROM member_consents WHERE user_id = ?").get(nextId).n, 0,
    "本機不得再被鏡射補寫同意列（PG 才是唯一來源）",
  );

  // 同意不齊 → 400，且**不得**留下帳號（比對同步版）
  const badEmail = freshEmail();
  const badInput = { email: badEmail, password: "password1", acceptDisclaimer: true, consents: [] };
  const syncErr = errorShape(() => dbMod.registerUserWithConsents(badInput, { now: new Date(NOW) }));
  const asyncErr = await asyncErrorShape(() => usersAsync.registerUserWithConsentsAsync(badInput, { now: NOW, ...PG, exec }));
  assert.ok(syncErr, "前提：同步版對缺同意丟錯");
  assert.deepEqual(asyncErr, syncErr, "錯誤形狀必須與同步版相同");
  assert.equal(exec.raw.prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").get(badEmail).n, 0, "沒有同意就不該有帳號");

  // 帳號與同意列要**同一個交易**：注入式 exec 沒有交易，所以這條只能靠原始碼斷言
  // （突變：把 `runInTransaction(...)` 拿掉會活下來 ⇒ 這一行是唯一的殺手）。
  const source = readFileSync(path.join(SRC, "usersAsync.js"), "utf8");
  assert.match(source, /return runInTransaction\(options, async \(tx\) => \{/, "帳號與同意紀錄必須包在同一個交易內");
});

test("開通 token：PG 版寫進 PG（PG 讀得到），且與同步版逐欄相同", async () => {
  const email = freshEmail();
  const syncEmail = freshEmail();
  const [, exec] = worlds(({ pg }) => seedUser(pg, { email, emailVerified: 1, password: "password1" }));
  seedUser(handle(), { email: syncEmail, emailVerified: 1, password: "password1" });
  const uid = Number(exec.raw.prepare("SELECT id FROM users WHERE email = ?").get(email).id);
  const syncUid = Number(handle().prepare("SELECT id FROM users WHERE email = ?").get(syncEmail).id);

  const { token, expiresAt } = await verifyAsync.issueVerifyTokenAsync(uid, { now: Date.parse(NOW) }, { ...PG, exec });
  assert.ok(token && token.length >= 32, "token 要夠長");
  assert.equal(expiresAt, new Date(Date.parse(NOW) + TTL_DAYS * 24 * 60 * 60 * 1000).toISOString(), "有效期必須是 3 天（與同步版同一個常數）");
  emailVerify.issueVerifyToken(handle(), syncUid, { now: Date.parse(NOW) });
  const fields = (h, id) => {
    const row = h.prepare("SELECT email_verified, verify_token, verify_expires_at, verify_expire_notified, verify_used_at FROM users WHERE id = ?").get(id);
    return {
      email_verified: Number(row.email_verified),
      verify_expires_at: row.verify_expires_at,
      verify_expire_notified: Number(row.verify_expire_notified),
      verify_used_at: row.verify_used_at,
    };
  };
  assert.deepEqual(fields(exec.raw, uid), fields(handle(), syncUid), "同步版與 PG 版落的欄位必須相同");
  assert.equal(
    exec.raw.prepare("SELECT verify_token FROM users WHERE id = ?").get(uid).verify_token, token,
    "token 必須寫進 PG（寫在本機的話會員點連結就是 404）",
  );

  // 這一顆 token 必須讓 PG 的確認流程走得完（＝會員點信裡的連結真的能開通）
  const confirmed = await verifyAsync.confirmVerifyTokenAsync(token, { now: Date.parse(NOW) + 1000 }, { ...PG, exec });
  assert.equal(Number(confirmed.id), uid);
  assert.equal(Number(exec.raw.prepare("SELECT email_verified FROM users WHERE id = ?").get(uid).email_verified), 1);

  // sqlite 模式：走同步路徑，不碰傳入的 exec
  let calls = 0;
  const boom = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  const liteEmail = freshEmail();
  const liteUid = seedUser(handle(), { email: liteEmail, emailVerified: 1, password: "password1" });
  await verifyAsync.issueVerifyTokenAsync(liteUid, { now: Date.parse(NOW) }, { driver: "sqlite", exec: boom });
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
  assert.ok(String(handle().prepare("SELECT verify_token FROM users WHERE id = ?").get(liteUid).verify_token || "").trim(), "sqlite 模式要寫本機");
});

test("路由接線：`POST /api/register` 用 async 島嶼（不得再用同步的 store）", () => {
  const server = readFileSync(path.join(SRC, "server.js"), "utf8");
  const start = server.indexOf('app.post("/api/register"');
  assert.ok(start > 0, "找得到註冊路由");
  const body = server.slice(start, server.indexOf("\n});", start));
  for (const needle of [
    "await getStoredSmtpAsync(",
    "await registerUserWithConsentsAsync(",
    "await issueVerifyTokenAsync(",
    "await queueSystemMailAsync(",
  ]) {
    assert.ok(body.includes(needle), `註冊路由必須用 ${needle}`);
  }
  for (const banned of ["registerUserWithConsents({", "issueVerifyToken(user.id)", "getStoredSmtp()", 'queueSystemMail("welcome"']) {
    assert.ok(!body.includes(banned), `註冊路由不得再用同步的 ${banned}`);
  }
});
