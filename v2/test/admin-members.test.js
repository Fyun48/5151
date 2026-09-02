import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ensurePersonalSchema } from "../src/personalSchema.js";
import { listUsers, registerUser, setUserPlan } from "../src/members.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensurePersonalSchema(db);
  return db;
}

test("member list for admins never includes password hashes", () => {
  const db = memoryDb();
  registerUser(db, { email: "a@b.com", password: "password1", acceptDisclaimer: true });
  const rows = listUsers(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, "a@b.com");
  assert.equal(rows[0].plan, "free");
  assert.equal(Object.prototype.hasOwnProperty.call(rows[0], "password_hash"), false);
  assert.doesNotMatch(JSON.stringify(rows), /scrypt:/);
  assert.doesNotMatch(JSON.stringify(rows), /password1/);
});

test("admin can mark a member as sponsored", () => {
  const db = memoryDb();
  const user = registerUser(db, { email: "a@b.com", password: "password1", acceptDisclaimer: true });
  const next = setUserPlan(db, user.id, "sponsor");
  assert.equal(next.plan, "sponsor");
  assert.equal(setUserPlan(db, user.id, "free").plan, "free");
});

test("admin page lists members, smtp, and templates without password fields", () => {
  const html = readFileSync(path.join(dir, "../public/admin.html"), "utf8");
  assert.match(html, /後台管理/);
  assert.match(html, /\/api\/admin\/members/);
  assert.match(html, /\/api\/admin\/mail/);
  assert.match(html, /\/api\/admin\/sponsor/);
  assert.match(html, /\/api\/admin\/maps/);
  assert.match(html, /通勤路線／Google 計費/);
  assert.match(html, /id="googleEnabled"/);
  assert.match(html, /使用 Google Directions（會計費，預設關閉）/);
  assert.match(html, /關閉並清除金鑰/);
  assert.match(html, /官方價目試算/);
  assert.match(html, /本月合計/);
  assert.match(html, /America\/Los_Angeles/);
  assert.match(html, /SMTP 主機/);
  assert.match(html, /贊助連結/);
  assert.match(html, /忘記密碼主旨/);
  assert.match(html, /註冊歡迎主旨/);
  assert.match(html, /變更密碼主旨/);
  assert.match(html, /贊助通知主旨/);
  assert.match(html, /系統信/);
  assert.match(html, /不會用這裡的帳號代寄/);
  assert.match(html, /\{\{tempPassword\}\}/);
  assert.match(html, /看不到會員密碼/);
  assert.doesNotMatch(html, /password_hash/);
  const blocks = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    if (/\bsrc\s*=/i.test(block[1])) continue;
    assert.doesNotThrow(() => new Function(block[2]));
  }
});

test("admin API routes exist and members payload is guarded", () => {
  const src = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  assert.match(src, /app\.get\("\/admin\.html"/);
  assert.match(src, /\/api\/admin\/members/);
  assert.match(src, /\/api\/admin\/mail/);
  assert.match(src, /\/api\/admin\/sponsor/);
  assert.match(src, /\/api\/admin\/maps/);
  const backfillFn = src.slice(src.indexOf("function queueGeoBackfill"), src.indexOf("async function tick"));
  assert.ok(backfillFn.indexOf("backfillListingRoutes") < backfillFn.indexOf("backfillListingCoords"));
  assert.match(src, /publicSponsorSettings/);
  assert.match(src, /會員列表不得含密碼/);
  assert.match(src, /requireAdminApi/);
  assert.match(src, /queueSystemMail\("welcome"/);
  assert.match(src, /app\.post\("\/api\/change-password"/);
});
