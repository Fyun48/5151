// 後台會員管理（`adminMembersAsync`）的 parity（2026-09-28，第五十四批）。
//
// 涵蓋的五條路由：`GET /api/admin/members`、`.../:id/delete`、`.../:id/restore`、
// `PATCH .../:id`、`POST /api/account/delete`。
//
// 這一叢的同步版要讀**三份本機資料**才算得出一列會員：`users`、該會員的 `settings`
// （通知間隔）、`user_listing_flags` ＋ `listings`（關注數／刊登數）。PG 模式下那是
// 別的節點的資料 ⇒ 後台看到「關注 0 筆、刊登 0 筆、間隔是預設值」，而且**不會報錯**。
// 所以每一條測試都刻意讓「只有 PG 那一份才有值」成為唯一來源。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-adminmembers-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const dbMod = await import("../src/db.js");
const adminAsync = await import("../src/adminMembersAsync.js");
const { ADMIN_DELETE_REASONS } = await import("../src/members.js");

const PG = { driver: "postgres" };
const handle = () => dbMod.sqliteHandle();
const MEMBER = 900000006001;
const OTHER = 900000006002;
const ADMIN = 900000006003;
const TABLES = ["users", "settings", "user_settings", "user_listing_flags", "listings"];

function fixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(path.join(dataDir, "v3.db"), { readOnly: true });
  for (const table of TABLES) {
    const ddl = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
    assert.ok(ddl?.sql, `必須抓到 ${table} 的 DDL`);
    mem.exec(ddl.sql);
  }
  disk.close();
  const exec = async (sql, params = []) => mem.prepare(sql).all(...params);
  exec.raw = mem;
  return exec;
}

// 只把「會員與他的資料」放進 PG（本機刻意留空，才證明得了讀的是 PG）。
function pgOnlyWorld() {
  const exec = fixture();
  const now = "2026-01-01T00:00:00.000Z";
  const insertUser = exec.raw.prepare(
    "INSERT INTO users(id, email, role, plan, created_at, signup_count) VALUES (?,?,?,?,?,?)",
  );
  insertUser.run(MEMBER, "member@example.test", "member", "free", now, 3);
  insertUser.run(OTHER, "other@example.test", "member", "free", now, 1);
  insertUser.run(ADMIN, "admin@example.test", "admin", "free", now, 1);
  // 該會員的通知間隔（PG 的 user_settings）
  exec.raw.prepare("INSERT INTO user_settings(user_id, key, value) VALUES (?,?,?)")
    .run(MEMBER, "intervalMinutes", JSON.stringify(42));
  exec.raw.prepare("INSERT INTO user_settings(user_id, key, value) VALUES (?,?,?)")
    .run(MEMBER, "intervalAdminSet", JSON.stringify(true));
  // 兩筆關注（一筆已確認離線 ⇒ 不佔額度）＋ 兩筆自主刊登（一筆已過期 ⇒ 不算「開著」）
  // `user_listing_flags` 有一堆 NOT NULL 欄位（viewed／hidden／watch_note／watch_group_id）⇒ 全部要給值。
  const flag = exec.raw.prepare(
    "INSERT INTO user_listing_flags(user_id, post_id, viewed, watched, hidden, watch_note, watch_group_id) VALUES (?,?,0,1,0,'','')",
  );
  flag.run(MEMBER, 910001);
  flag.run(MEMBER, 910002);
  // `listings` 是寬表、好幾個 NOT NULL 欄位沒有預設值 ⇒ 用 pragma 自動補齊必要欄位
  // （與 `listing-tools-async.test.js` 的 `seedUser()` 同一招），不要一個個猜欄位名。
  for (const [postId, title, source, selfStatus, offline, expiresAt] of [
    [910001, "還在", "591", null, 0, null],
    [910002, "已離線", "591", null, 1, null],
    [910003, "自主開著", "self", "open", 0, null],
    [910004, "自主過期", "self", "open", 0, "2020-01-01T00:00:00.000Z"],
  ]) {
    seedListing(exec.raw, {
      post_id: postId,
      title,
      source,
      source_key: `1|${postId}`,
      self_status: selfStatus,
      offline_confirmed: offline,
      listed_by_user_id: MEMBER,
      self_expires_at: expiresAt,
    });
  }
  return exec;
}

const byId = (members, id) => members.find((m) => Number(m.id) === Number(id));

// 只填「有給的欄位 ＋ 沒有預設值的 NOT NULL 欄位」，其餘交給 DDL 的預設值。
function seedListing(handle, provided) {
  const info = handle.prepare("PRAGMA table_info(listings)").all();
  const required = info.filter((c) => c.notnull === 1 && c.dflt_value === null && c.pk === 0);
  const names = info.map((c) => c.name).filter((n) => n in provided || required.some((c) => c.name === n));
  handle.prepare(`INSERT INTO listings(${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
    .run(...names.map((name) => {
      if (name in provided) return provided[name];
      const col = info.find((c) => c.name === name);
      return /INT|REAL|NUM/i.test(col.type) ? 0 : "";
    }));
}

test("列表：PG 才有的會員也要算得出關注數／刊登數／通知間隔", async () => {
  const exec = pgOnlyWorld();
  assert.strictEqual(dbMod.getUserById(MEMBER), null, "前提：本機沒有這位會員");
  const members = await adminAsync.listAdminMembersAsync({}, { ...PG, exec, strict: true });
  const me = byId(members, MEMBER);
  assert.ok(me, "必須列出 PG 才有的會員");
  assert.equal(me.email, "member@example.test");
  assert.equal(me.signup_count, 3);
  assert.equal(me.watchCount, 1, "已確認離線的那筆不佔額度（2 筆關注 → 1）");
  assert.equal(me.listingCount, 1, "過期的自主刊登不算（2 筆 → 1）");
  assert.equal(me.intervalMinutes, 42, "通知間隔要讀 PG 的 user_settings，不是預設值");
  assert.equal(me.intervalAdminSet, true);
  assert.equal(me.deleted, false);
  assert.ok(!("password_hash" in me), "投影不得帶出雜湊");
  // 沒有設定的人要用方案的預設間隔（與同步版同一份 `planIntervalMinutes`）
  const other = byId(members, OTHER);
  assert.equal(other.watchCount, 0);
  assert.equal(other.listingCount, 0);
  assert.ok(other.intervalMinutes > 0, "預設間隔不得是 0");
  // 排序與過濾（`q`）也要與同步版一致
  const filtered = await adminAsync.listAdminMembersAsync({ q: "MEMBER@example" }, { ...PG, exec, strict: true });
  assert.deepEqual(filtered.map((m) => Number(m.id)), [MEMBER], "q 是 email 子字串、大小寫無關");
});

test("刪除／復原：守衛訊息相同、PG 的列真的被改、而且不會刪到管理員", async () => {
  const exec = pgOnlyWorld();
  // 管理員不可刪
  const adminError = await adminAsync.adminDeleteMemberAsync(ADMIN, { reasonCode: "abuse" }, { ...PG, exec, strict: true })
    .then(() => null, (e) => e);
  assert.equal(adminError?.status, 400);
  assert.match(adminError.message, /不能刪除管理員帳號/);

  const result = await adminAsync.adminDeleteMemberAsync(MEMBER, { reasonCode: "abuse" }, { ...PG, exec, strict: true });
  assert.equal(result.member.deleted, true, "回傳的投影要看得出已刪除");
  assert.ok(result.reason.text, "理由文字不得為空");
  assert.equal(result.reason.code, "abuse");
  const row = exec.raw.prepare("SELECT deleted_at, deleted_by, deleted_reason_code FROM users WHERE id = ?").get(MEMBER);
  assert.ok(String(row.deleted_at || "").trim(), "PG 的 deleted_at 必須寫入");
  assert.equal(row.deleted_by, "admin");
  assert.equal(row.deleted_reason_code, "abuse");
  // 再刪一次 → 400「已經刪除」
  const again = await adminAsync.adminDeleteMemberAsync(MEMBER, { reasonCode: "abuse" }, { ...PG, exec, strict: true })
    .then(() => null, (e) => e);
  assert.equal(again?.status, 400);
  assert.match(again.message, /已經刪除/);
  // 復原
  const restored = await adminAsync.adminRestoreMemberAsync(MEMBER, { ...PG, exec, strict: true });
  assert.equal(restored.deleted, false);
  assert.equal(exec.raw.prepare("SELECT deleted_by FROM users WHERE id = ?").get(MEMBER).deleted_by, "");
  // 沒刪除的人不能復原
  const notDeleted = await adminAsync.adminRestoreMemberAsync(OTHER, { ...PG, exec, strict: true }).then(() => null, (e) => e);
  assert.match(notDeleted.message, /尚未刪除/);
  // 不存在的人：404
  const missing = await adminAsync.adminDeleteMemberAsync(999999999, {}, { ...PG, exec, strict: true }).then(() => null, (e) => e);
  assert.equal(missing?.status, 404);
  assert.match(missing.message, /找不到這位會員/);
});

test("會員自己刪帳號：deleted_by 是 self、理由代碼固定 self", async () => {
  const exec = pgOnlyWorld();
  const member = await adminAsync.deleteOwnAccountAsync(MEMBER, "不想用了", { ...PG, exec, strict: true });
  assert.equal(member.deleted, true);
  const row = exec.raw.prepare("SELECT deleted_by, deleted_reason, deleted_reason_code FROM users WHERE id = ?").get(MEMBER);
  assert.equal(row.deleted_by, "self");
  assert.equal(row.deleted_reason, "不想用了");
  assert.equal(row.deleted_reason_code, "self");
});

test("改方案：方案落地、通知間隔依方案重設；指定 intervalMinutes 時 intervalAdminSet 要變 true", async () => {
  const exec = pgOnlyWorld();
  const sponsor = await adminAsync.adminPatchMemberAsync(MEMBER, { plan: "sponsor" }, { ...PG, exec, strict: true });
  assert.equal(sponsor.plan, "sponsor");
  assert.equal(exec.raw.prepare("SELECT plan FROM users WHERE id = ?").get(MEMBER).plan, "sponsor");
  assert.equal(sponsor.intervalAdminSet, false, "只改方案 ⇒ 間隔依方案重設，adminSet 應為 false");
  assert.notEqual(sponsor.intervalMinutes, 42, "方案改了，間隔要跟著方案走");

  const pinned = await adminAsync.adminPatchMemberAsync(MEMBER, { intervalMinutes: 7 }, { ...PG, exec, strict: true });
  assert.equal(pinned.intervalMinutes, 7);
  assert.equal(pinned.intervalAdminSet, true, "手動指定間隔要標記 adminSet");

  const missing = await adminAsync.adminPatchMemberAsync(999999999, { plan: "free" }, { ...PG, exec, strict: true })
    .then(() => null, (e) => e);
  assert.equal(missing?.status, 404);
});

test("非 postgres：五條入口都走同步路徑（不碰傳入的 exec）", async () => {
  let calls = 0;
  const boom = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  const sqlite = { driver: "sqlite", exec: boom };
  // sqlite 模式讀的是應用程式自己的 store（不是夾具），所以這裡只驗「工作交給了同步版」：
  // 清單是同步版的結果、數值相同，而且**完全不碰** PG runner。
  const members = await adminAsync.listAdminMembersAsync({}, sqlite);
  assert.deepEqual(members, dbMod.listAdminMembers({}), "必須等於同步版的結果");
  assert.equal(await adminAsync.countOpenSelfListingsAsync(MEMBER, sqlite), dbMod.countOpenSelfListings(MEMBER));
  const error = await adminAsync.adminRestoreMemberAsync(MEMBER, sqlite).then(() => null, (e) => e);
  assert.equal(error?.status, 404, "本機沒有這位會員 ⇒ 同步版丟 404");
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
});

test("投影形狀：刪除理由清單必須來自同一份常數（前端契約）", () => {
  assert.ok(ADMIN_DELETE_REASONS.length >= 2);
  const custom = ADMIN_DELETE_REASONS.find((row) => row.id === "custom");
  assert.ok(custom, "必須有 custom 這個選項");
});
