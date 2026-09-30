// Session 解析改成 PG（Owner 方案 A）的 parity 與回歸鎖（2026-09-27）。
//
// 為什麼要動 session：`readSession()` → `findUserByEmail()` → 節點本機 `v3.db`，是步驟 3
// 剩下的**最大單一卡點**——`server.js` 有 113 個呼叫點、尺規上 137 條路由因此被判成
// SQLite／MIXED。只要它在，後面每一批移植都會停在 MIXED、數字不會動。
//
// 這個檔要釘住的三件事，每一件都對應一個真的會壞掉的方式：
//
//   1. **身分真的來自 PG**（不是「看起來像」）——所以夾具刻意讓節點本機 SQLite
//      **完全沒有這個使用者**。快取一旦失效，`readSession()` 退回同步路徑就會回 null，
//      測試立刻失敗。
//   2. **每請求只查一次**——`readSession()` 在 `server.js` 被呼叫 113 次，
//      同一請求內常呼叫好幾次；快取壞掉會變成 N 次 `users` 查詢（效能退化）。
//   3. **失敗模式與舊版一致**——`readSession()` 從不丟錯、未登入就是 null。
//      PG 讀不到時 fail-open 回本機 SQLite（讀取政策），但中介層一律當未登入，
//      絕不讓 auth 的例外變成 500。
//
// ⚠️ 夾具是「用 SQLite 當 PG 的替身」，所以**必須主動拒絕 SQLite 專屬語法**，
// 否則方言寫錯照樣過關（本系列踩過 `IFNULL` 與 `LIMIT -1`）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-session-"));
process.env.DATA_DIR = dataDir;
const SECRET = "test-session-secret-591";
process.env.SESSION_SECRET = SECRET;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const db = (await import("../src/db.js")).sqliteHandle();
const {
  SESSION_BY_EMAIL_SQL,
  isStaticAssetPath,
  publicPath,
  readSession,
  readSessionAsync,
  requireAuth,
  resolveSession,
  sessionCookie,
  skippableStaticAsset,
} = await import("../src/auth.js");

const PG = { driver: "postgres" };
const diskPath = () => path.join(dataDir, "v3.db");

const PG_ILLEGAL = [
  [/\bIFNULL\s*\(/i, "function ifnull(unknown) does not exist"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
];

// PG 替身：`users` 的 DDL 直接從真的 sqlite_master 抄（不手寫欄位，本系列憑印象寫欄位
// 已經踩過三次），並記錄被查了幾次。
function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
  assert.ok(ddl?.sql, "必須抓到 users 的 DDL");
  mem.exec(ddl.sql);
  const calls = [];
  const exec = async (sql, params = []) => {
    for (const [pattern, message] of PG_ILLEGAL) if (pattern.test(sql)) throw new Error(message);
    calls.push({ sql, params });
    return mem.prepare(sql).all(...params);
  };
  exec.raw = mem;
  exec.calls = calls;
  return exec;
}

// 欄位從 PRAGMA 推導，只補 NOT NULL 且沒有 DEFAULT 的欄位。
function seedUser(handle, fields) {
  const info = handle.prepare("PRAGMA table_info(users)").all();
  const provided = {
    role: "member", plan: "free", deleted_at: null, nickname: "",
    created_at: "2026-01-01T00:00:00.000Z", ...fields,
  };
  const required = info.filter((c) => c.notnull === 1 && c.dflt_value === null && c.pk === 0);
  const names = info.map((c) => c.name).filter((n) => n in provided || required.some((c) => c.name === n));
  handle.prepare(`INSERT INTO users(${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
    .run(...names.map((n) => {
      if (n in provided) return provided[n];
      const col = info.find((c) => c.name === n);
      return /INT|REAL|NUM/i.test(col.type) ? 0 : "";
    }));
}

// ⚠️ 不能 `DELETE FROM users`：真的 SQLite schema 有 FOREIGN KEY（PG 那三張表沒有），
// db.js 匯入時建立的種子使用者被別的表參考著，整表刪除會 `FOREIGN KEY constraint failed`。
// 只清掉這支測試自己造的那一批（全部用 @example.test 網域）。
function resetUsers() {
  db.exec("DELETE FROM users WHERE email LIKE '%@example.test'");
  const exec = pgFixture();
  exec.raw.exec("DELETE FROM users WHERE email LIKE '%@example.test'");
  return exec;
}
const localUserCount = (email) =>
  db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").get(email).n;

const cookieHeader = (email) => sessionCookie({}, email);
const reqFor = (cookie, pathname = "/api/me") => ({ headers: cookie ? { cookie } : {}, path: pathname });

async function runMiddleware(req, options) {
  let nexted = 0;
  await resolveSession(options)(req, {}, () => { nexted += 1; });
  assert.equal(nexted, 1, "中介層一定要呼叫 next()（不然請求會卡住）");
  return req;
}

// 自己簽一個 token，才能造出「過期」與「竄改 MAC」這兩種情境。
function mintToken(email, exp) {
  const payload = Buffer.from(JSON.stringify({ e: email, exp })).toString("base64url");
  return `${payload}.${createHmac("sha256", SECRET).update(payload).digest("base64url")}`;
}

// ---------------------------------------------------------------------------

test("核心：PG 有、節點本機沒有的使用者必須登入成功（身分真的來自 PG）", async () => {
  const exec = resetUsers();
  seedUser(exec.raw, { id: 4242, email: "pgonly@example.test", role: "admin", plan: "sponsor" });
  // 這一條是整支測試的鑑別力來源：本機 SQLite **完全沒有**這個人。
  assert.equal(localUserCount("pgonly@example.test"), 0, "本機必須沒有這個人");

  const req = reqFor(cookieHeader("pgonly@example.test"));
  await runMiddleware(req, { ...PG, exec });
  const session = readSession(req);
  assert.ok(session, "PG 有这个人，session 就必須拿到（拿不到代表还在讀本機 SQLite）");
  assert.equal(session.userId, 4242);
  assert.equal(session.email, "pgonly@example.test");
  assert.equal(session.role, "admin", "role 必須逐欄正確，不能只驗 userId");
  assert.equal(session.plan, "sponsor", "plan 必須逐欄正確");

  // 反向對照：不經中介層的同步路徑在本機找不到人 ⇒ 上面的成功不可能来自本機。
  assert.equal(readSession(reqFor(cookieHeader("pgonly@example.test"))), null,
    "同步路徑讀本機 SQLite，本來就該找不到——這條對照證明快取真的有作用");
});

test("同一請求內讀快取：113 個呼叫點不該變成 113 次 users 查詢", async () => {
  const exec = resetUsers();
  seedUser(exec.raw, { id: 7, email: "cache@example.test" });
  const req = reqFor(cookieHeader("cache@example.test"));
  await runMiddleware(req, { ...PG, exec });
  assert.equal(exec.calls.length, 1, "中介層解析一次");
  for (let i = 0; i < 5; i += 1) readSession(req);
  assert.equal(exec.calls.length, 1, `readSession() 必須讀快取，實際查了 ${exec.calls.length} 次`);
  assert.equal(readSession(req).userId, 7);
});

test("查的是 users.email 這一欄（不是 id，也不是別的鍵）", async () => {
  const exec = resetUsers();
  seedUser(exec.raw, { id: 11, email: "byemail@example.test" });
  await runMiddleware(reqFor(cookieHeader("byemail@example.test")), { ...PG, exec });
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].sql, SESSION_BY_EMAIL_SQL, "SQL 必須是共用常數那一句");
  assert.match(exec.calls[0].sql, /FROM users WHERE email = \?/);
  assert.deepEqual(exec.calls[0].params, ["byemail@example.test"]);
});

test("已刪除的使用者不得有 session（deleted_at 判斷在 PG 這條路也要生效）", async () => {
  const exec = resetUsers();
  seedUser(exec.raw, { id: 21, email: "gone@example.test", deleted_at: "2026-09-01T00:00:00.000Z" });
  await runMiddleware(reqFor(cookieHeader("gone@example.test")), { ...PG, exec });
  assert.equal(readSession(reqFor(cookieHeader("gone@example.test"))), null, "沒經過中介層時也要是 null");
  const req = reqFor(cookieHeader("gone@example.test"));
  await runMiddleware(req, { ...PG, exec });
  assert.equal(readSession(req), null, "經過中介層時必須是 null");
});

test("PG 找不到這個人 → session 為 null（不是 undefined、也不是空物件）", async () => {
  const exec = resetUsers();
  const req = reqFor(cookieHeader("nobody@example.test"));
  await runMiddleware(req, { ...PG, exec });
  assert.equal(readSession(req), null);
  assert.equal(await readSessionAsync(reqFor(cookieHeader("nobody@example.test")), { ...PG, exec }), null);
});

test("過期的 token 不得放行，而且**不該查 DB**", async () => {
  const exec = resetUsers();
  seedUser(exec.raw, { id: 31, email: "expired@example.test" });
  const req = reqFor(`591_session=${mintToken("expired@example.test", Date.now() - 1000)}`);
  await runMiddleware(req, { ...PG, exec });
  assert.equal(readSession(req), null, "過期就必須是 null");
  assert.equal(exec.calls.length, 0, "過期的 token 在驗簽階段就該被擋下，不該浪費一次查詢");
});

test("MAC 被竄改的 token 不得放行，而且不該查 DB", async () => {
  const exec = resetUsers();
  seedUser(exec.raw, { id: 41, email: "tamper@example.test" });
  const good = mintToken("tamper@example.test", Date.now() + 600000);
  const req = reqFor(`591_session=${good.slice(0, -2)}xx`);
  await runMiddleware(req, { ...PG, exec });
  assert.equal(readSession(req), null);
  assert.equal(exec.calls.length, 0);
});

test("沒有 cookie 就完全不碰 DB（靜態資產不該換來 users 查詢）", async () => {
  const exec = resetUsers();
  const req = reqFor(null, "/api/me");
  await runMiddleware(req, { ...PG, exec });
  assert.equal(readSession(req), null);
  assert.equal(exec.calls.length, 0, "沒有 cookie 時一次 DB 都不該查");
});

test("靜態資產即使帶 cookie 也不解析 session（/media、/vendor、/icons、/brand）", async () => {
  const exec = resetUsers();
  seedUser(exec.raw, { id: 51, email: "static@example.test" });
  for (const p of ["/media/lib/a.png", "/media/self/b.jpg", "/vendor/htmx.min.js", "/icons/x.svg", "/brand/logo.png"]) {
    const req = reqFor(cookieHeader("static@example.test"), p);
    await runMiddleware(req, { ...PG, exec });
    assert.equal(readSession(req), null, `${p} 不該解析 session`);
  }
  assert.equal(exec.calls.length, 0, `靜態資產不得查 DB，實際 ${exec.calls.length} 次`);
  // 反向：**不是**靜態資產的路徑一定要解析（否則上面的斷言可能只是因為全部都跳過）。
  const apiReq = reqFor(cookieHeader("static@example.test"), "/api/media");
  await runMiddleware(apiReq, { ...PG, exec });
  assert.equal(readSession(apiReq)?.userId, 51, "/api/media 是 API，必須解析 session");
  assert.equal(exec.calls.length, 1);
});

test("🚨 2026-09-30 事故：requireAuth 會擋的靜態資產不得跳過解析（後台 .js 對所有人 302）", async () => {
  // 事故：`resolveSession()` 對**所有**靜態副檔名路徑都寫入「未登入」，但 `requireAuth()`
  // 仍然要擋 `/admin-ia.js` 這幾支（它們不在 `publicPath()` 裡）⇒ 連已登入的 Owner 都拿到
  // 302 → `/login.html`，瀏覽器把登入頁 HTML 當成 JS 執行（SyntaxError）⇒ 後台只剩靜態骨架
  //（左側功能分類與各卡片內容都不會 render）。判準：只有「公開的」靜態資產可以跳過解析。
  const GATED = ["/admin-ia.js", "/admin-support.js", "/admin-providers.js"];
  for (const p of GATED) {
    assert.equal(publicPath({ path: p }), false, `${p} 是「需要登入」的路徑（這條守衛的前提）`);
    assert.equal(isStaticAssetPath(p), true, `${p} 符合靜態副檔名`);
    assert.equal(skippableStaticAsset(p), false, `${p} 需要身分，跳過解析等於讓登入者也被導去登入頁`);
  }
  // 公開的靜態資產仍然要跳過（效能理由不變：一次載入 30 個檔案不該查 30 次 users）。
  for (const p of ["/mascot.js", "/tokens.css", "/support-page.js", "/media/lib/a.png",
    "/vendor/htmx.min.js", "/icons/i.svg", "/brand/b.png", "/kit/components.css"]) {
    assert.equal(publicPath({ path: p }), true, `${p} 應該是公開路徑`);
    assert.equal(skippableStaticAsset(p), true, `${p} 是公開資產，必須跳過解析`);
  }

  // 端到端（中介層 ＋ requireAuth 一起跑）：登入者要真的被放行，未登入者仍然要被擋。
  const exec = resetUsers();
  seedUser(exec.raw, { id: 91, email: "asset@example.test", role: "admin" });
  const fakeRes = () => {
    const res = {
      location: undefined,
      redirect(url) { res.location = url; },
      status() { return res; },
      json() { return res; },
    };
    return res;
  };
  for (const p of GATED) {
    const req = { headers: { cookie: cookieHeader("asset@example.test") }, path: p, accepts: () => "html" };
    await runMiddleware(req, { ...PG, exec });
    assert.ok(readSession(req), `${p}：解析後必須有 session（否則 requireAuth 一定擋）`);
    const res = fakeRes();
    let nexted = 0;
    requireAuth(req, res, () => { nexted += 1; });
    assert.equal(res.location, undefined, `${p} 不該被導去登入頁（實際 ${res.location}）`);
    assert.equal(nexted, 1, `${p} 必須放行到靜態檔處理`);
  }
  const anonReq = { headers: {}, path: "/admin-ia.js", accepts: () => "html" };
  await runMiddleware(anonReq, { ...PG, exec });
  assert.equal(readSession(anonReq), null);
  const anonRes = fakeRes();
  requireAuth(anonReq, anonRes, () => { throw new Error("未登入不得放行後台資產"); });
  assert.equal(anonRes.location, "/login.html", "未登入仍然要擋（不能為了修這個把後台資產變成公開）");
});

test("isStaticAssetPath：靜態檔要跳過、動態路由不得被誤判", () => {
  // ⚠️ 第一版只認四個前綴（/vendor/、/icons/、/brand/、/media/），於是
  // `express.static(v3/public)` 服務的**根目錄檔案**全部沒被跳過——那才是最大一批
  // （登入者每次載入頁面都會為每個 .js／.css 各查一次 users）。
  for (const p of ["/media/lib/a.png", "/vendor/htmx.min.js", "/icons/i.svg", "/brand/b.png",
    // 這一組是第一版漏掉的：
    "/app.js", "/support-page.css", "/admin-support.js", "/cities-embed.js", "/sw.js"]) {
    assert.equal(isStaticAssetPath(p), true, `${p} 應為靜態`);
  }
  for (const p of ["/api/media", "/api/media/tags", "/l/abc", "/w/abc", "/", "/index.html",
    "/terms.html", "/media/self", "/api/public/listings", "/go/123", "/api/brand",
    "/manifest.webmanifest",
    // `/api/` 底下即使帶副檔名也必須解析（API 一律要身分）
    "/api/export/report.csv", "/api/thing.json"]) {
    assert.equal(isStaticAssetPath(p), false, `${p} 不該被當成靜態資產`);
  }
});

test("非 postgres 模式必須回退同步路徑（讀本機 SQLite）", async () => {
  const exec = resetUsers();
  seedUser(db, { id: 61, email: "sqlite@example.test", role: "admin" });
  seedUser(exec.raw, { id: 62, email: "sqlite@example.test", role: "member" });
  const req = reqFor(cookieHeader("sqlite@example.test"));
  await runMiddleware(req, { driver: "sqlite", exec });
  assert.equal(readSession(req)?.userId, 61, "sqlite 模式必須讀本機");
  assert.equal(readSession(req)?.role, "admin", "不可以拿到夾具那一份（role=member）");
  assert.equal(exec.calls.length, 0, "sqlite 模式不得碰 PG");
});

test("PG 查詢失敗時 fail-open 回本機 SQLite（讀取政策），strict 則往上丟", async () => {
  resetUsers();
  seedUser(db, { id: 71, email: "fallback@example.test", role: "admin" });
  const broken = async () => { throw new Error("connection terminated unexpectedly"); };
  broken.calls = [];

  const session = await readSessionAsync(reqFor(cookieHeader("fallback@example.test")), { ...PG, exec: broken });
  assert.equal(session?.userId, 71, "讀取要 fail-open，不能因為 PG 抖一下就等於全站登出");
  await assert.rejects(
    () => readSessionAsync(reqFor(cookieHeader("fallback@example.test")), { ...PG, exec: broken, strict: true }),
    /connection terminated/,
  );

  // 中介層這一層：`readSessionAsync` 已經 fail-open（回傳本機那一份），所以中介層拿到的是
  // **有效的 session**，不是 null。這一點值得寫清楚——「PG 掛掉」不等於「全站登出」。
  const req = reqFor(cookieHeader("fallback@example.test"));
  let nexted = 0;
  await resolveSession({ ...PG, exec: broken })(req, {}, () => { nexted += 1; });
  assert.equal(nexted, 1, "失敗時仍然要呼叫 next()");
  assert.equal(readSession(req)?.userId, 71,
    "fail-open 要一路走到中介層：PG 讀不到時仍用本機那一份登入");

  // 最後一道：`strict` 讓 readSessionAsync 往上丟，中介層必須把它收成「未登入」，
  // 絕不能讓 auth 的例外變成 500。
  const strictReq = reqFor(cookieHeader("fallback@example.test"));
  let strictNexted = 0;
  await resolveSession({ ...PG, exec: broken, strict: true })(strictReq, {}, () => { strictNexted += 1; });
  assert.equal(strictNexted, 1, "strict 下仍然要呼叫 next()");
  assert.equal(readSession(strictReq), null, "strict 下解析失敗一律當未登入");
});

test("PG 與本機兩條路的 session 形狀逐欄相同（不是只比空物件）", async () => {
  const exec = resetUsers();
  const fields = { id: 81, email: "shape@example.test", role: "admin", plan: "sponsor" };
  seedUser(exec.raw, fields);
  seedUser(db, { ...fields, email: "shape2@example.test" });
  const fromPg = await readSessionAsync(reqFor(cookieHeader("shape@example.test")), { ...PG, exec });
  const fromSqlite = await readSessionAsync(reqFor(cookieHeader("shape2@example.test")), { driver: "sqlite", exec });
  assert.deepEqual(Object.keys(fromPg).sort(), Object.keys(fromSqlite).sort(), "鍵集合必須相同");
  for (const key of ["email", "userId", "role", "plan"]) {
    assert.ok(fromPg[key] !== undefined && fromPg[key] !== null && fromPg[key] !== "",
      `PG 這一條的 ${key} 必須有值（否則比對會變成兩個空值相等）`);
    assert.equal(typeof fromPg[key], typeof fromSqlite[key], `${key} 的型別必須相同`);
  }
  assert.equal(fromPg.role, "admin");
  assert.equal(fromSqlite.role, "admin");
  assert.equal(fromPg.plan, "sponsor");
  assert.equal(fromSqlite.plan, "sponsor");
});

test("夾具本身要真的拒絕 IFNULL／GROUP_CONCAT／LIMIT -1（否則方言守衛是空的）", async () => {
  const exec = pgFixture();
  await assert.rejects(() => exec("SELECT IFNULL(email,'') FROM users"), /function ifnull/);
  await assert.rejects(() => exec("SELECT GROUP_CONCAT(email) FROM users"), /group_concat/);
  await assert.rejects(() => exec("SELECT email FROM users LIMIT -1"), /LIMIT must not be negative/);
  await assert.doesNotReject(() => exec("SELECT COALESCE(email,'') AS e FROM users"), "COALESCE 必須放行");
});
