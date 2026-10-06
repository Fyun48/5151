// 贊助連動 Phase 3 單測：schema 冪等、代碼生命週期、出站組裝、開通冪等與到期降級、
// webhook 簽章、門檻判定；async 版 parity（SQLite 當替身，無 PG 照樣綠）。
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.DATA_DIR = process.env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), "sponsor-ent-"));

const {
  ensureSponsorEntitlementSchema,
  normalizeSponsorEntitlementFlags,
  normalizeSponsorEntitlementRules,
  getSponsorEntitlementFlags,
  setSponsorEntitlementFlags,
  getSponsorEntitlementRules,
  setSponsorEntitlementRules,
  issueMemberSupportCode,
  currentMemberSupportCode,
  resolveMemberSupportCode,
  markSupportCodeUsed,
  extractSupportCode,
  buildSponsorOutbound,
  sponsorProviderCapability,
  applySponsorEntitlement,
  expireSponsorEntitlements,
  verifyBmcWebhookSignature,
  verifyKofiVerificationToken,
  evaluateSupportMatch,
} = await import("../src/sponsorEntitlement.js");

const {
  issueMemberSupportCodeAsync,
  currentMemberSupportCodeAsync,
  resolveMemberSupportCodeAsync,
  recordSponsorWebhookTransactionAsync,
  recentSupportSumAsync,
  applySponsorEntitlementAsync,
  getSponsorEntitlementFlagsAsync,
} = await import("../src/sponsorEntitlementAsync.js");

const NOW = new Date("2026-10-06T12:00:00.000Z");

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'member',
      plan TEXT NOT NULL DEFAULT 'free',
      nickname TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS support_transaction (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT '',
      provider_transaction_id TEXT,
      supporter_user_id INTEGER,
      supporter_name TEXT,
      supporter_email TEXT,
      amount REAL NOT NULL DEFAULT 0,
      fee REAL NOT NULL DEFAULT 0,
      net_amount REAL NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'TWD',
      status TEXT NOT NULL DEFAULT 'pending',
      anonymous INTEGER NOT NULL DEFAULT 1,
      message TEXT,
      channel TEXT NOT NULL DEFAULT 'personal',
      received_at TEXT NOT NULL,
      raw_reference TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  ensureSponsorEntitlementSchema(db);
  return db;
}

test("schema 冪等：連跑兩次不炸", () => {
  const db = open();
  ensureSponsorEntitlementSchema(db);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%support%' OR name LIKE '%grant%'").all();
  assert.ok(tables.length >= 3);
});

test("flags 全預設關；rules 預設 100/30/30/不撤銷", () => {
  const db = open();
  assert.deepEqual(getSponsorEntitlementFlags(db), { codeAttribution: false, autoEntitlement: false, apiPoll: false, webhook: false });
  assert.deepEqual(getSponsorEntitlementRules(db), { minAmountTWD: 100, windowDays: 30, durationDays: 30, revokeOnRefund: false });
  setSponsorEntitlementFlags(db, { codeAttribution: true, webhook: "yes" });
  assert.deepEqual(getSponsorEntitlementFlags(db), { codeAttribution: true, autoEntitlement: false, apiPoll: false, webhook: false });
  setSponsorEntitlementRules(db, { minAmountTWD: -5, windowDays: 999 });
  assert.equal(getSponsorEntitlementRules(db).minAmountTWD, 1);
  assert.equal(getSponsorEntitlementRules(db).windowDays, 365);
  assert.equal(normalizeSponsorEntitlementFlags(null).autoEntitlement, false);
  assert.equal(normalizeSponsorEntitlementRules(undefined).durationDays, 30);
});

test("代碼生命週期：發行→解析→過期不可用→標記使用後不可用", () => {
  const db = open();
  const issued = issueMemberSupportCode(db, { userId: 7, now: NOW });
  assert.match(issued.code, /^JIBBY-[A-Z2-9]{5}$/);
  assert.deepEqual(resolveMemberSupportCode(db, { code: issued.code.toLowerCase(), now: NOW }), { userId: 7, code: issued.code });
  assert.equal(currentMemberSupportCode(db, { userId: 7, now: NOW }).code, issued.code);
  const later = new Date(NOW.getTime() + 25 * 3600 * 1000);
  assert.equal(resolveMemberSupportCode(db, { code: issued.code, now: later }), null);
  const second = issueMemberSupportCode(db, { userId: 7, now: NOW });
  markSupportCodeUsed(db, { code: second.code, now: NOW });
  assert.equal(resolveMemberSupportCode(db, { code: second.code, now: NOW }), null);
  assert.equal(extractSupportCode("你好，贊助代碼 jibby-ab2cd 請收下"), "JIBBY-AB2CD");
  assert.equal(extractSupportCode("沒有代碼"), "");
});

test("出站組裝：靜態管道原網址＋代碼文案；email 預設不送", () => {
  const out = buildSponsorOutbound("bmc", "https://buymeacoffee.com/jibby", { code: "JIBBY-AB2CD", displayName: "小吉" });
  assert.equal(out.url, "https://buymeacoffee.com/jibby");
  assert.equal(out.mode, "static-with-code");
  assert.match(out.instructions, /JIBBY-AB2CD/);
  assert.doesNotMatch(out.instructions, /@/);
  const withMail = buildSponsorOutbound("bmc", "https://x", { code: "JIBBY-AB2CD", displayName: "小吉", sendEmail: true, email: "a@b.c" });
  assert.match(withMail.instructions, /a@b\.c/);
  const anon = buildSponsorOutbound("custom", "https://x", {});
  assert.match(anon.instructions, /人工對帳/);
  assert.equal(sponsorProviderCapability("nope").matchKeys[0], "code-manual");
  assert.equal(sponsorProviderCapability("bmc").webhook, true);
});

test("開通冪等：同交易第二次 already；到期才降級", () => {
  const db = open();
  const plans = [];
  const first = applySponsorEntitlement(db, {
    userId: 9, transactionId: "bmc:tx1", provider: "bmc", amount: 100, reason: "webhook:single",
    now: NOW, durationDays: 30, applyPlan: (uid, plan) => plans.push([uid, plan]),
  });
  assert.deepEqual(first, { ok: true, already: false, userId: 9, entitlementExpiresAt: first.entitlementExpiresAt });
  const second = applySponsorEntitlement(db, { userId: 9, transactionId: "bmc:tx1", now: NOW, applyPlan: () => plans.push(["x"]) });
  assert.equal(second.already, true);
  assert.deepEqual(plans, [[9, "sponsor"]]);
  assert.equal(applySponsorEntitlement(db, { userId: 0, transactionId: "x" }).ok, false);

  let current = "sponsor";
  const before = expireSponsorEntitlements(db, { now: NOW, readPlan: () => current, applyPlan: (_uid, plan) => { current = plan; } });
  assert.deepEqual(before, []); // 還沒到期
  const after = expireSponsorEntitlements(db, {
    now: new Date(NOW.getTime() + 31 * 86400000),
    readPlan: () => current,
    applyPlan: (_uid, plan) => { current = plan; },
  });
  assert.deepEqual(after, [9]);
  assert.equal(current, "free");
});

test("webhook 簽章與門檻判定", () => {
  const secret = "s3cret";
  const body = JSON.stringify({ event: "payment.completed", data: { id: 1 } });
  const sig = crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex");
  assert.equal(verifyBmcWebhookSignature(body, secret, sig), true);
  assert.equal(verifyBmcWebhookSignature(body, secret, "deadbeef"), false);
  assert.equal(verifyBmcWebhookSignature(body, "", sig), false);
  assert.equal(verifyKofiVerificationToken({ verification_token: "tok" }, "tok"), true);
  assert.equal(verifyKofiVerificationToken({ verification_token: "tok" }, "other"), false);

  assert.deepEqual(evaluateSupportMatch({ amount: 100 }), { eligible: true, reason: "single" });
  assert.deepEqual(evaluateSupportMatch({ amount: 60, recentSumTWD: 0 }), { eligible: false, reason: "below_threshold" });
  assert.deepEqual(evaluateSupportMatch({ amount: 60, recentSumTWD: 140 }), { eligible: true, reason: "window" });
});

test("async parity：代碼與 webhook 進帳（SQLite 替身）", async () => {
  const db = open();
  const opts = { db };
  const issued = await issueMemberSupportCodeAsync({ userId: 3, now: NOW }, opts);
  assert.match(issued.code, /^JIBBY-/);
  assert.equal((await currentMemberSupportCodeAsync({ userId: 3, now: NOW }, opts)).code, issued.code);
  assert.equal((await resolveMemberSupportCodeAsync({ code: issued.code, now: NOW }, opts)).userId, 3);

  const rec = await recordSponsorWebhookTransactionAsync({
    provider: "bmc", providerTransactionId: "tx-9", userId: 3, amount: 120, message: `代碼 ${issued.code}`, receivedAt: NOW,
  }, opts);
  assert.equal(rec.duplicate, false);
  const dup = await recordSponsorWebhookTransactionAsync({ provider: "bmc", providerTransactionId: "tx-9", userId: 3, amount: 120, receivedAt: NOW }, opts);
  assert.equal(dup.duplicate, true);
  const sum = await recentSupportSumAsync({ userId: 3, sinceMs: 30 * 86400000 }, opts);
  assert.equal(sum, 120);

  const flags = await getSponsorEntitlementFlagsAsync(opts);
  assert.equal(flags.webhook, false);
});

test("async 開通：冪等且寫入 grant（module db 替身）", async () => {
  const { sqliteHandle } = await import("../src/db.js");
  const db = sqliteHandle();
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'member',
      plan TEXT NOT NULL DEFAULT 'free',
      nickname TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  ensureSponsorEntitlementSchema(db);
  db.prepare("INSERT INTO users (email, plan, created_at) VALUES ('s@example.com','free',?)").run(new Date().toISOString());
  const uid = db.prepare("SELECT id FROM users WHERE email='s@example.com'").get().id;
  const first = await applySponsorEntitlementAsync({ userId: uid, transactionId: "bmc:tx-async-1", amount: 100 }, { db });
  assert.equal(first.ok, true);
  const second = await applySponsorEntitlementAsync({ userId: uid, transactionId: "bmc:tx-async-1", amount: 100 }, { db });
  assert.equal(second.already, true);
  assert.equal(db.prepare("SELECT plan FROM users WHERE id=?").get(uid).plan, "sponsor");
});
