// 忘記密碼（`requestTempPasswordAsync`）的 parity（2026-09-28，第五十三批）。
//
// 這一支的規則（冷卻、信件內容、寄信失敗要把**舊雜湊**寫回去）全部留在
// `forgotPassword.js`（它本來就是 async 且可注入），PG 版只換資料層與 SMTP／範本來源。
// 這裡要釘住的正是「換掉的那幾個回呼」：
//   1. 帳號在 PG ⇒ 臨時密碼寫進 PG（本機不得被動到）
//   2. 沒有設定 SMTP ⇒ 503（**不能**先去改密碼）
//   3. 寄信失敗 ⇒ 舊雜湊要寫回去（否則使用者被鎖在外面，而信根本沒寄出）
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-forgot-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const dbMod = await import("../src/db.js");
const password = await import("../src/password.js");
const forgot = await import("../src/forgotPassword.js");
const forgotAsync = await import("../src/forgotPasswordAsync.js");

const PG = { driver: "postgres" };
const handle = () => dbMod.sqliteHandle();
const UID = 900000005001;
const EMAIL = "forgot@example.test";
const OLD_HASH = password.hashPassword("originalpass1");

function worlds({ smtpConfigured = true } = {}) {
  const lite = handle();
  lite.prepare("DELETE FROM users WHERE id = ?").run(UID);
  const insert = (db) => db.prepare(
    "INSERT INTO users(id, email, role, plan, created_at, password_hash, email_verified) VALUES (?,?,?,?,?,?,?)",
  ).run(UID, EMAIL, "member", "free", "2026-01-01T00:00:00.000Z", OLD_HASH, 1);
  insert(lite);
  const mem = new DatabaseSync(":memory:");
  mem.exec(lite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get().sql);
  insert(mem);
  // 設定（SMTP／信件範本）也放進 PG 那一份：`getStoredSmtpAsync()`／`getMailTemplatesAsync()` 讀它。
  for (const table of ["settings", "user_settings"]) {
    const ddl = lite.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (ddl?.sql) mem.exec(ddl.sql);
  }
  if (smtpConfigured) {
    mem.prepare("INSERT INTO settings(key, value) VALUES (?, ?)").run("smtp", JSON.stringify({
      host: "smtp.example.test", port: 587, user: "mailer", pass: "secret", from: "no-reply@example.test", secure: false,
    }));
  }
  const exec = async (sql, params = []) => mem.prepare(sql).all(...params);
  const hash = () => mem.prepare("SELECT password_hash FROM users WHERE id = ?").get(UID)?.password_hash;
  return [lite, mem, exec, hash];
}

// ⚠️ `sent` 是模組層級的：每個測試開頭都要清空，否則前一條寄出的信會讓後面幾條的
// 「沒有寄出」斷言失敗（第一版就是這樣紅的）。
const sent = [];
const fakeSend = async (mail) => { sent.push(mail); return { ok: true }; };

test("寄信成功：臨時密碼寫進 PG、信寄出、舊雜湊消失", async () => {
  sent.length = 0;
  const [lite, , exec, hash] = worlds();
  const out = await forgotAsync.requestTempPasswordAsync(EMAIL, {
    ...PG, exec, strict: true,
    send: fakeSend, makePassword: () => "temp12345",
    configured: undefined, // 由島嶼自己用 PG 的 SMTP 設定判斷
    attempts: new Map(),
  });
  assert.equal(out.ok, true, `必須回 ok（實際 ${JSON.stringify(out)}）`);
  assert.match(out.message, /臨時密碼/);
  assert.equal(sent.length, 1, "要寄出一封");
  assert.equal(sent[0].to, EMAIL);
  assert.match(sent[0].text, /temp12345/, "信裡必須有臨時密碼");
  const pgHash = hash();
  assert.notEqual(pgHash, OLD_HASH, "PG 的雜湊必須被換成臨時密碼");
  assert.ok(password.verifyPassword("temp12345", pgHash), "臨時密碼要能通過驗證");
  assert.equal(lite.prepare("SELECT password_hash FROM users WHERE id = ?").get(UID).password_hash, OLD_HASH,
    "本機那一份不得被動到（PG 模式的身分來源是 PG）");
});

test("沒設定 SMTP：503，而且不得先改密碼（否則信沒寄出、人也進不去）", async () => {
  sent.length = 0;
  const [lite, , exec, hash] = worlds({ smtpConfigured: false });
  const before = hash();
  let error = null;
  try {
    await forgotAsync.requestTempPasswordAsync(EMAIL, {
      ...PG, exec, strict: true, send: fakeSend, makePassword: () => "temp12345", attempts: new Map(),
    });
  } catch (e) { error = e; }
  assert.equal(error?.status, 503, "必須是 503");
  assert.match(error.message, /尚未設定寄信/);
  assert.equal(hash(), before, "PG 的雜湊不得被改");
  assert.equal(lite.prepare("SELECT password_hash FROM users WHERE id = ?").get(UID).password_hash, OLD_HASH);
  assert.equal(sent.length, 0);
});

test("寄信失敗：舊雜湊要寫回去（兩邊一致）", async () => {
  sent.length = 0;
  const [lite, mem, exec, hash] = worlds();
  const boom = async () => { throw new Error("smtp down"); };
  const error = await forgotAsync.requestTempPasswordAsync(EMAIL, {
    ...PG, exec, strict: true, send: boom, makePassword: () => "temp12345", attempts: new Map(),
  }).then(() => null, (e) => e);
  assert.ok(error, "寄信失敗必須往上丟");
  assert.equal(hash(), OLD_HASH, "PG 的舊雜湊必須被寫回去（使用者才能用原密碼登入）");
  assert.ok(password.verifyPassword("originalpass1", hash()), "原密碼必須仍然有效");
  // 同步版對照組：同一份 store 上跑一次，結果必須一樣
  const syncError = await forgot.requestTempPassword(mem, EMAIL, {
    send: boom, makePassword: () => "temp12345", attempts: new Map(),
    smtp: { host: "smtp.example.test", from: "no-reply@example.test" },
    findUser: (key) => mem.prepare("SELECT * FROM users WHERE email = ?").get(key),
    setPassword: (id, pass) => mem.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(password.hashPassword(pass), id),
  }).then(() => null, (e) => e);
  assert.ok(syncError, "前提：同步版也會丟錯");
  assert.equal(error.message, syncError.message, "兩邊的錯誤訊息必須相同");
  assert.equal(hash(), OLD_HASH, "同步版跑完也不得留下臨時密碼");
});

test("冷卻時間：同一個 email 5 分鐘內第二次是 429（兩邊一致）", async () => {
  sent.length = 0;
  const [, , exec] = worlds();
  const attempts = new Map();
  const first = await forgotAsync.requestTempPasswordAsync(EMAIL, {
    ...PG, exec, strict: true, send: fakeSend, makePassword: () => "temp12345", attempts,
  });
  assert.equal(first.ok, true);
  const error = await forgotAsync.requestTempPasswordAsync(EMAIL, {
    ...PG, exec, strict: true, send: fakeSend, makePassword: () => "temp12345", attempts,
  }).then(() => null, (e) => e);
  assert.equal(error?.status, 429, "冷卻中必須是 429");
  assert.match(error.message, /秒後再試/);
});

test("查無此人：仍然回同一句訊息（不洩漏帳號是否存在），且不改任何雜湊", async () => {
  sent.length = 0;
  const [, , exec, hash] = worlds();
  const out = await forgotAsync.requestTempPasswordAsync("nobody@example.test", {
    ...PG, exec, strict: true, send: fakeSend, attempts: new Map(),
  });
  assert.equal(out.ok, true, "不得洩漏帳號不存在");
  assert.match(out.message, /若此帳號存在/);
  assert.equal(sent.length, 0);
  assert.equal(hash(), OLD_HASH);
});
