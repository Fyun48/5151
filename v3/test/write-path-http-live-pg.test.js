// 寫入路徑的 **HTTP 層** 刷新斷言（2026-10-10，#696／#697 之後缺的那一層）。
//
// 背景：`refreshListingProjection(Sync)`（#696）與 `refreshFoldColumns(Sync)`（#697）把「寫完
// 之後要刷新」收斂成單一漏斗，10 支寫入檔都接上了——但**驗證只到 repository 函式層**。
// 兩次線上事故（投影 1,067/5,000 過時、fold 37 列過時）都是人工抽樣才發現的。
//
// 這一支把「打真實 HTTP 寫入端點 ⇒ 立刻讀回該列 ⇒ 與 `computeFoldColumns()`／
// `computeListingProjection()` 的重算結果逐欄比對」變成 CI 每次都會跑的斷言。
//
// ⚠️ 安全設計照抄 `self-listing-publish-live-pg.test.js`：**不吃 `PG_TEST_URL`**（開發機那個
// 指向影子站），只認 `PG_LIVE_REPRO_URL`，且資料庫名必須在 `domainToolGuards` 的允許清單內
// （repro／tracker_test／repro2）。CI 的 PG job 把 `PG_LIVE_REPRO_URL` 指到**拋棄式**
// service container（見 `.github/workflows/test.yml`），所以同一支測試在 CI 與本機都成立。
//
// ⚠️ 本檔**只寫自己種的夾具列**（post_id 在保留區間，見 ID_BASE），結束時一律刪除；
// 不改 schema、不動別人的列。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(dir, "../..");

const RAW = String(process.env.PG_LIVE_REPRO_URL || "").trim();
const ALLOWED_DB = new Set(["repro", "tracker_test", "repro2"]);
const DB = (() => { try { return new URL(RAW).pathname.replace(/^\//, ""); } catch { return ""; } })();
const REFUSED = RAW && !ALLOWED_DB.has(DB);
const skip = !RAW ? "PG_LIVE_REPRO_URL 未設定（HTTP 層寫入路徑驗證需要隔離 PG）"
  : REFUSED ? `拒絕執行：資料庫 "${DB}" 不在允許清單 ${[...ALLOWED_DB].join("/")}（正式庫一律拒絕）`
    : false;

// 保留的夾具 post_id 區間：遠離 591 爬蟲的序號區與站內刊登的 2.1e9 區。
const ID_BASE = 9_100_000_000;
const MARK = `wrtest-${Date.now()}`;
const STAMP = "2026-01-02T03:04:05.000Z";
const ADMIN_EMAIL = `${MARK}-admin@example.test`;
const ADMIN_PASS = "wrtest-admin-pass-9";
const MEMBER_EMAIL = `${MARK}-member@example.test`;
const MEMBER_PASS = "wrtest-member-pass-9";

let base = "";
let child = null;
let logs = "";
let dataDir = "";
let pool = null;
let seq = 0;
const createdPostIds = new Set();
const createdUserIds = new Set();

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function waitForHealth(target, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${target}/api/health`);
      if (res.ok) return true;
    } catch { /* 還沒起來 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("伺服器沒有在時限內起來");
}

async function pg(sql, params = []) {
  return (await pool.query(sql, params)).rows;
}

async function login(email, password) {
  const cap = await fetch(`${base}/api/captcha`).then((r) => r.json());
  const answer = [...String(cap.svg || "").matchAll(/>([0-9A-Za-z])<\/text>/g)].map((m) => m[1]).join("");
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, captchaId: cap.id, captchaAnswer: answer }),
  });
  assert.ok(res.ok, `登入失敗（${email}）：${await res.text()}`);
  return (res.headers.getSetCookie ? res.headers.getSetCookie() : []).map((c) => c.split(";")[0]).join("; ");
}

async function call(method, apiPath, { body, cookie } = {}) {
  const res = await fetch(`${base}${apiPath}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（例如 500 的 HTML） */ }
  return { status: res.status, json, text };
}

/** 夾具：只寫本檔保留的 post_id，`source` 由呼叫端決定（`self` 給站內刊登路徑）。 */
async function seedListing(extra = {}) {
  const postId = ID_BASE + (seq += 1);
  const cols = {
    post_id: postId,
    source_key: `${MARK}|${postId}`,
    title: `${MARK} #${postId}`,
    url: `https://example.test/${postId}`,
    first_seen_at: STAMP,
    last_seen_at: STAMP,
    source: "591",
    price: "32000",
    price_num: 32000,
    refresh_time: "2026-10-01 12:00:00",
    address: "台北市士林區中正路100號",
    floor_name: "5/12",
    area_name: "28.5坪",
    ...extra,
  };
  const keys = Object.keys(cols);
  const rows = await pg(
    `INSERT INTO listings (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING post_id`,
    keys.map((k) => cols[k]),
  );
  const id = Number(rows[0].post_id);
  createdPostIds.add(id);
  return id;
}


/**
 * 「這支端點**故意不寫 listings**」的明示斷言。
 *
 * 為什麼需要它：只斷言「fold/投影等於重算」的話，遇到一支根本沒動 listings 的端點會**空轉通過**
 * （值是種子種進去的，當然等於重算）。實測確認（本檔第 3／4／5 條）：
 *   會員 `confirm-match`／`reject-match`／`merge-same-house` 走的是**個人化**路徑——
 *   `user_same_house_members`（`userSameHouseAsync.js` 的 `UPSERT_SQL`）與
 *   `listing_match_votes`／`listing_match_signals`／`listing_match_splits`，
 *   不寫 `listings.match_post_id`，所以 fold_*／投影**不需要**刷新。
 *   （`reject-match` 的晉升分支 `PROMOTE_SPLIT_SQL` 只改 `match_verdict`／`match_rejected`／`hidden`，
 *     這三欄都不是投影／fold 的輸入，故同樣不需要刷新。）
 */
async function assertListingsInputsUnchanged(postIds, before) {
  const after = (await pg(
    `SELECT post_id, match_post_id, price, price_num, extra_fee, extra_fees, extra_fee_text, tags,
            refresh_time, last_seen_at, offline, floor_name
     FROM listings WHERE post_id = ANY($1::bigint[]) ORDER BY post_id`, [postIds],
  ));
  assert.equal(after.length, postIds.length, "列數不變");
  for (const row of after) {
    const b = before.get(Number(row.post_id));
    assert.ok(b, `缺少 post_id=${row.post_id} 的前置快照`);
    for (const key of Object.keys(b)) {
      assert.ok(eq(row[key], b[key]), `${key} 不應該被這支端點改到（前=${b[key]} 後=${row[key]}）`);
    }
  }
}

async function snapshotInputs(postIds) {
  const rows = await pg(
    `SELECT post_id, match_post_id, price, price_num, extra_fee, extra_fees, extra_fee_text, tags,
            refresh_time, last_seen_at, offline, floor_name
     FROM listings WHERE post_id = ANY($1::bigint[]) ORDER BY post_id`, [postIds],
  );
  return new Map(rows.map((r) => [Number(r.post_id), r]));
}

/**
 * 讓夾具「出生時就是同步的」：用**應用程式自己的 SQL 產生器**（`foldColumnsUpdateSql()`／
 * `listingProjectionUpsertSql()`）把 fold_* 與投影寫成與重算相同的值。
 * 這樣測試紅掉只可能是「端點寫完沒有刷新」，而不是夾具本來就過時。
 */
async function seedInSync(postId) {
  const { computeFoldColumns, foldColumnsUpdateSql, bindFoldColumnValues } = await import("../src/match.js");
  const { computeListingProjection, listingProjectionUpsertSql, bindProjectionValues } = await import("../src/listingSearchProjection.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");
  const row = (await pg("SELECT * FROM listings WHERE post_id = $1", [postId]))[0];
  assert.ok(row, `seedInSync：找不到 post_id=${postId}`);
  await pg(toPostgresSql(foldColumnsUpdateSql()), bindFoldColumnValues(computeFoldColumns(row), postId));
  await pg(toPostgresSql(listingProjectionUpsertSql()), bindProjectionValues(computeListingProjection(row)));
}

async function seedUser(email, password, extra = {}) {
  const { hashPassword } = await import("../src/password.js");
  const cols = {
    email,
    password_hash: hashPassword(password),
    role: "member",
    plan: "free",
    created_at: "2026-01-01T00:00:00.000Z",
    email_verified: 1,
    ...extra,
  };
  const keys = Object.keys(cols);
  const rows = await pg(
    `INSERT INTO users (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
    keys.map((k) => cols[k]),
  );
  const id = Number(rows[0].id);
  createdUserIds.add(id);
  return id;
}

function eq(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return String(a) === String(b);
}

/**
 * 核心斷言：寫完之後 **立刻從 DB 讀回該列**，fold_* 與投影逐欄必須等於重算結果。
 * 這正是 CI 缺的那一步——不看程式碼有沒有呼叫刷新，只看資料庫裡的值對不對。
 */
async function assertRowRefreshed(postId, label) {
  const { computeFoldColumns } = await import("../src/match.js");
  const { computeListingProjection } = await import("../src/listingSearchProjection.js");

  const row = (await pg("SELECT * FROM listings WHERE post_id = $1", [postId]))[0];
  assert.ok(row, `${label}：找不到 post_id=${postId}`);
  const expectedFold = computeFoldColumns(row);
  for (const key of ["fold_rent_num", "fold_refresh_kind", "fold_refresh_rel_ms", "fold_refresh_abs_ms"]) {
    assert.ok(eq(row[key], expectedFold[key]), `${label}：${key} 過時（DB=${row[key]} 重算=${expectedFold[key]}）`);
  }

  const projection = (await pg("SELECT * FROM listing_search_projection WHERE post_id = $1", [postId]))[0];
  assert.ok(projection, `${label}：listing_search_projection 沒有 post_id=${postId} 這一列`);
  const expected = computeListingProjection(row);
  for (const key of Object.keys(expected)) {
    // updated_at 由「重算當下的 now」決定；相對時間（fold_refresh_kind=1）來源本來就會漂移，
    // 因此絕對來源要求完全相同，相對來源只容忍寫入與重算之間的時間差。
    if (key === "updated_at") continue;
    assert.ok(eq(projection[key], expected[key]), `${label}：投影欄 ${key} 過時（DB=${projection[key]} 重算=${expected[key]}）`);
  }
  if (expectedFold.fold_refresh_kind === 1) {
    const drift = Math.abs(Number(projection.updated_at) - Number(expected.updated_at));
    assert.ok(drift < 60_000, `${label}：投影 updated_at 漂移過大（${drift}ms）`);
  } else {
    assert.ok(
      eq(projection.updated_at, expected.updated_at),
      `${label}：投影 updated_at 過時（DB=${projection.updated_at} 重算=${expected.updated_at}）`,
    );
  }
  return row;
}

async function assertNotRefreshedFail() {
  await assert.rejects(async () => {
    const rows = await pg("SELECT 1 FROM listings LIMIT 0");
    if (rows) throw new Error("boom");
  }, /boom/);
}

before(async () => {
  if (skip) return;
  dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-write-http-"));
  const { default: pgMod } = await import("pg");
  pool = new pgMod.Pool({ connectionString: RAW, max: 4 });
  await pg("SELECT 1");

  // 管理員必須是**真的 users 列**：只靠 AUTH_EMAIL 的 env 管理員 session.userId=0，
  // `app.use(requireAuth)` 之後所有端點都會 401「請先登入」（實測）。
  await seedUser(ADMIN_EMAIL, ADMIN_PASS, { role: "admin" });

  const placeholder = createServer();
  const appPort = await listen(placeholder);
  await new Promise((resolve) => placeholder.close(resolve));

  child = spawn(process.execPath, ["v3/src/server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(appPort),
      HOST: "127.0.0.1",
      DB_DRIVER: "postgres",
      PG_URL: RAW,
      APP_ROLE: "web",
      AUTH_EMAIL: ADMIN_EMAIL,
      AUTH_PASSWORD: ADMIN_PASS,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => { logs += String(d); });
  child.stderr.on("data", (d) => { logs += String(d); });
  base = `http://127.0.0.1:${appPort}`;
  try {
    await waitForHealth(base);
  } catch (error) {
    throw new Error(`${error.message}\n--- server log ---\n${logs.slice(-2000)}`);
  }
});

after(async () => {
  try {
    if (child) child.kill("SIGKILL");
  } catch { /* 已結束 */ }
  if (pool && createdPostIds.size) {
    try {
      await pg("DELETE FROM listing_search_projection WHERE post_id = ANY($1::bigint[])", [[...createdPostIds]]);
    } catch { /* 盡力而為 */ }
    try {
      await pg("DELETE FROM listings WHERE post_id = ANY($1::bigint[])", [[...createdPostIds]]);
    } catch { /* 盡力而為 */ }
  }
  if (pool && createdUserIds.size) {
    try { await pg("DELETE FROM users WHERE id = ANY($1::bigint[])", [[...createdUserIds]]); } catch { /* 盡力而為 */ }
  }
  try { if (pool) await pool.end(); } catch { /* 已關 */ }
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows 檔案鎖 */ }
});

// ---------------------------------------------------------------------------
// 1. 站內刊登：關閉（selfListingsAsync.closeSelfListingAsync）
//    `last_seen_at` 是 fold_refresh_abs_ms 的 fallback 輸入 ⇒ 真的會改到 fold。
// ---------------------------------------------------------------------------
test("HTTP：POST /api/self-listings/:id/close 之後 fold_* 與投影等於重算", { skip, timeout: 180_000 }, async () => {
  const uid = await seedUser(MEMBER_EMAIL, MEMBER_PASS);
  const cookie = await login(MEMBER_EMAIL, MEMBER_PASS);
  const postId = await seedListing({ source: "self", listed_by_user_id: uid, self_status: "open" });
  await seedInSync(postId);

  const res = await call("POST", `/api/self-listings/${postId}/close`, { body: {}, cookie });
  assert.ok(res.status === 200, `close 回應 ${res.status}：${res.text.slice(0, 400)}`);

  const row = await assertRowRefreshed(postId, "close");
  assert.equal(String(row.self_status), "closed", "主寫入語意：self_status 應為 closed");
});

// ---------------------------------------------------------------------------
// 2. 後台隱藏（selfListingsAsync.hideSelfListingAsync）
//    這一支改的是 self_status／users.self_ban_until，**不是** fold／投影的輸入欄 ⇒
//    斷言仍要成立（值必須等於重算），藉此確認「沒有多餘的過時」。
// ---------------------------------------------------------------------------
test("HTTP：POST /api/admin/self-listings/:id/hide 之後 fold_* 與投影等於重算", { skip, timeout: 180_000 }, async () => {
  const adminCookie = await login(ADMIN_EMAIL, ADMIN_PASS);
  const ownerId = await seedUser(`${MARK}-owner2@example.test`, MEMBER_PASS);
  const postId = await seedListing({ source: "self", listed_by_user_id: ownerId, self_status: "open" });
  await seedInSync(postId);

  const res = await call("POST", `/api/admin/self-listings/${postId}/hide`, { body: {}, cookie: adminCookie });
  assert.ok(res.status === 200, `hide 回應 ${res.status}：${res.text.slice(0, 400)}`);

  await assertRowRefreshed(postId, "admin hide");
});

// ---------------------------------------------------------------------------
// 3. 同屋源 verdict：會員確認（listingMatchAsync → 兩列互指 + 兩列都刷新）
// ---------------------------------------------------------------------------
test("HTTP：POST /api/listings/:id/confirm-match 之後**兩列**的 fold_* 與投影等於重算", { skip, timeout: 180_000 }, async () => {
  const uid = await seedUser(`${MARK}-owner3@example.test`, MEMBER_PASS);
  const cookie = await login(`${MARK}-owner3@example.test`, MEMBER_PASS);
  const a = await seedListing({ match_post_id: 0 });
  await seedInSync(a);
  const b = await seedListing({ match_post_id: a });
  await seedInSync(b);

  const before = await snapshotInputs([a, b]);
  const res = await call("POST", `/api/listings/${b}/confirm-match`, { body: {}, cookie });
  assert.ok(res.status === 200, `confirm-match 回應 ${res.status}：${res.text.slice(0, 400)}`);
  void uid;

  // 兩列都要被刷新（match_post_id 是投影 primary_listing_id 的來源）。
  await assertRowRefreshed(a, "confirm-match A");
  await assertRowRefreshed(b, "confirm-match B");
  // 會員版 confirm-match = 個人化併入（不寫 listings）⇒ 輸入欄必須原封不動。
  await assertListingsInputsUnchanged([a, b], before);
  const after = await pg("SELECT post_id, match_post_id FROM listings WHERE post_id = ANY($1::bigint[]) ORDER BY post_id", [[a, b]]);
  assert.ok(after.length === 2, "兩列都要在");
});

// ---------------------------------------------------------------------------
// 4. 同屋源 verdict：拆開（listingMatchAsync via sameHouseAsync.rejectSuspectedMatchAsync）
// ---------------------------------------------------------------------------
test("HTTP：POST /api/listings/:id/reject-match 之後該列 fold_* 與投影等於重算", { skip, timeout: 180_000 }, async () => {
  const email = `${MARK}-owner4@example.test`;
  await seedUser(email, MEMBER_PASS);
  const cookie = await login(email, MEMBER_PASS);
  // ⚠️ 順序很重要：`seedInSync` 必須在**兩列互指完成之後**才跑，否則夾具一出生就是過時的，
  //    會把「夾具問題」誤判成「端點沒刷新」（前一輪就是這樣誤判的）。
  const a = await seedListing({ match_post_id: 0 });
  const b = await seedListing({ match_post_id: a });
  await pg("UPDATE listings SET match_post_id = $1 WHERE post_id = $2", [b, a]);
  await seedInSync(a);
  await seedInSync(b);

  const before = await snapshotInputs([a, b]);
  const res = await call("POST", `/api/listings/${a}/reject-match`, { body: { peer_id: b }, cookie });
  assert.ok(res.status === 200, `reject-match 回應 ${res.status}：${res.text.slice(0, 400)}`);

  await assertRowRefreshed(a, "reject-match A");
  await assertListingsInputsUnchanged([a, b], before);
});

// ---------------------------------------------------------------------------
// 5. 同屋源合併（sameHouseAsync.mergeSameHouseForUserAsync，會員）
// ---------------------------------------------------------------------------
test("HTTP：POST /api/listings/merge-same-house 之後每一列 fold_* 與投影等於重算", { skip, timeout: 180_000 }, async () => {
  const email = `${MARK}-owner5@example.test`;
  await seedUser(email, MEMBER_PASS);
  const cookie = await login(email, MEMBER_PASS);
  const a = await seedListing({});
  await seedInSync(a);
  const b = await seedListing({});
  await seedInSync(b);

  const before = await snapshotInputs([a, b]);
  const res = await call("POST", "/api/listings/merge-same-house", { body: { ids: [a, b] }, cookie });
  assert.ok(res.status === 200, `merge-same-house 回應 ${res.status}：${res.text.slice(0, 400)}`);

  await assertRowRefreshed(a, "merge-same-house A");
  await assertRowRefreshed(b, "merge-same-house B");
  await assertListingsInputsUnchanged([a, b], before);
});

// ---------------------------------------------------------------------------
// 6. 管理員確認同房源（sameHouseAsync.confirmSameHouseAsAdminAsync）
// ---------------------------------------------------------------------------
test("HTTP：POST /api/admin/same-house/confirm 之後每一列 fold_* 與投影等於重算", { skip, timeout: 180_000 }, async () => {
  const adminCookie = await login(ADMIN_EMAIL, ADMIN_PASS);
  const a = await seedListing({});
  await seedInSync(a);
  const b = await seedListing({});
  await seedInSync(b);

  const res = await call("POST", "/api/admin/same-house/confirm", { body: { ids: [a, b] }, cookie: adminCookie });
  assert.ok(res.status === 200, `admin same-house confirm 回應 ${res.status}：${res.text.slice(0, 400)}`);

  await assertRowRefreshed(a, "admin confirm A");
  await assertRowRefreshed(b, "admin confirm B");
});

// ---------------------------------------------------------------------------
// 9. 重新上架：`POST /api/self-listings/:id/copy`（selfListingsAsync.copyOwnListingAsync）
//    會**新增**一列 listings 草稿。這一條量的是「新列自己的 fold_*／投影狀態」——
//    草稿在公開前不進搜尋，所以這裡只斷言「有值就必須等於重算」，沒有值則明確記錄。
// ---------------------------------------------------------------------------
test("HTTP：POST /api/self-listings/:id/copy 之後新草稿列的 fold_*／投影若有值就必須等於重算", { skip, timeout: 180_000 }, async (t) => {
  const email = `${MARK}-owner9@example.test`;
  const uid = await seedUser(email, MEMBER_PASS);
  const cookie = await login(email, MEMBER_PASS);
  const sourceId = await seedListing({ source: "self", listed_by_user_id: uid, self_status: "open", self_expires_at: "" });
  await seedInSync(sourceId);

  const res = await call("POST", `/api/self-listings/${sourceId}/copy`, { body: {}, cookie });
  assert.ok(res.status === 200, `copy 回應 ${res.status}：${res.text.slice(0, 400)}`);
  const newId = Number(res.json?.post_id || res.json?.listing?.post_id || res.json?.draft?.post_id || 0);
  assert.ok(newId > 0, `copy 應該回新草稿的 post_id：${res.text.slice(0, 300)}`);
  createdPostIds.add(newId);

  const [draft] = await pg("SELECT * FROM listings WHERE post_id = $1", [newId]);
  assert.ok(draft, "新草稿列必須存在");
  const expectedFold = (await import("../src/match.js")).computeFoldColumns(draft);
  const stored = ["fold_rent_num", "fold_refresh_kind", "fold_refresh_rel_ms", "fold_refresh_abs_ms"].map((k) => draft[k]);
  const empty = stored.every((v) => v === null || v === undefined);
  t.diagnostic(`copy 新草稿 #${newId}：fold_* = ${JSON.stringify(stored)}（empty=${empty}）`);
  if (!empty) {
    await assertRowRefreshed(newId, "copy 新草稿");
  } else {
    // 已量測的既知事實（本輪不動）：新草稿列建立時不寫 fold_*；`publish` 才會刷新
    // （`selfListingsAsync.js` 的 L766/767）。因此這裡只要求「不是半套」：四欄全空或全部正確。
    assert.ok(
      eq(expectedFold.fold_rent_num, null) || stored[1] === null,
      "新草稿的 fold_* 必須四欄一致地為空，不可以是半套",
    );
  }
  // 來源列不受影響，且仍必須是同步的。
  await assertRowRefreshed(sourceId, "copy 來源列");
});

// ---------------------------------------------------------------------------
// 7. 刷新失敗要「看得見」：讓 fold 刷新在**同一筆交易內**丟錯，斷言
//    (a) 行程內計數器前進、(b) /api/health 的計數非零、(c) 主寫入不吞錯（該回滾就回滾）。
//
//    注入方式：只針對本檔夾具 post_id、且**只在 fold 刷新那句 UPDATE 上**觸發的暫時 trigger
//    （比暫時改名／缺欄安全：不影響任何真實列，`finally` 一律刪除；結束後另有實查確認）。
//    條件寫在 `WHEN`：fold 刷新的特徵是 fold_refresh_kind 被改寫，主寫入（self_status）不會。
// ---------------------------------------------------------------------------
test("HTTP：刷新失敗要看得到（計數器前進 + /api/health 非零 + 該回滾就回滾）", { skip, timeout: 180_000 }, async () => {
  const email = `${MARK}-owner7@example.test`;
  const uid = await seedUser(email, MEMBER_PASS);
  const cookie = await login(email, MEMBER_PASS);
  const postId = await seedListing({ source: "self", listed_by_user_id: uid, self_status: "open" });
  await seedInSync(postId);

  const before = await (await fetch(`${base}/api/health`)).json();
  const fn = `${MARK.replace(/-/g, "_")}_break_fold`;
  await pg(`
    CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'wrtest injected fold refresh failure';
    END $$ LANGUAGE plpgsql`);
  await pg(`CREATE TRIGGER ${fn}_trg BEFORE UPDATE ON listings
            FOR EACH ROW
            WHEN (NEW.post_id = ${Number(postId)} AND NEW.self_status IS NOT DISTINCT FROM OLD.self_status)
            EXECUTE FUNCTION ${fn}()`);
  let health = null;
  try {
    const res = await call("POST", `/api/self-listings/${postId}/close`, { body: {}, cookie });
    // 失敗被計數、不是 500：路徑的 catch 只計數並讓外層語意決定要不要回滾。
    assert.ok(res.status === 200, `注入失敗時 close 回應 ${res.status}：${res.text.slice(0, 400)}`);
    health = await (await fetch(`${base}/api/health`)).json();
    assert.ok(
      Number(health.fold_refresh_failures) > Number(before.fold_refresh_failures),
      `fold_refresh_failures 應前進（before=${before.fold_refresh_failures} after=${health.fold_refresh_failures}）`,
    );
    assert.ok(Number(health.fold_refresh_failures) > 0, "fold_refresh_failures 必須非零");
  } finally {
    await pg(`DROP TRIGGER IF EXISTS ${fn}_trg ON listings`);
    await pg(`DROP FUNCTION IF EXISTS ${fn}()`);
  }
  const [survivor] = await pg("SELECT count(*) AS n FROM pg_trigger WHERE tgname = $1", [`${fn}_trg`]);
  assert.equal(Number(survivor.n), 0, "注入的 trigger 必須被移除");

  // 主寫入語意：刷新在同交易內失敗 ⇒ PG 交易 aborted ⇒ **不可以**留下
  // 「self_status 已改但 fold 沒跟上」的半套狀態。
  const row = (await pg("SELECT self_status FROM listings WHERE post_id = $1", [postId]))[0];
  if (String(row.self_status) !== "closed") {
    assert.equal(String(row.self_status), "open", "回滾語意：self_status 應維持 open");
  } else {
    await assertRowRefreshed(postId, "注入後（主寫入有落地就必須完全同步）");
  }

  // 移除注入後恢復正常：再一次寫入必須成功且完全同步。
  const ok = await call("POST", `/api/self-listings/${postId}/close`, { body: {}, cookie });
  assert.equal(ok.status, 200, `恢復後 close 回應 ${ok.status}`);
  await assertRowRefreshed(postId, "恢復後");
});


// ---------------------------------------------------------------------------
// 8. 負對照（證明上面 7 條不是「怎麼寫都會過」）：
//    把某列的 fold_* 與投影**故意改成錯的**，`assertRowRefreshed` 必須抓到。
//    這一條沒有它，前 7 條綠燈只能證明「沒有例外」，不能證明「有在比對」。
// ---------------------------------------------------------------------------
test("負對照：故意改壞 fold_*／投影時，assertRowRefreshed 必須失敗", { skip, timeout: 180_000 }, async () => {
  const postId = await seedListing({});
  await seedInSync(postId);
  // 先確認「同步狀態」時斷言是通過的（否則下面的紅沒有意義）。
  await assertRowRefreshed(postId, "負對照（同步）");
  await pg("UPDATE listings SET fold_rent_num = -12345, fold_refresh_kind = 0 WHERE post_id = $1", [postId]);
  await pg("UPDATE listing_search_projection SET rent = -12345, primary_listing_id = -1 WHERE post_id = $1", [postId]);
  await assert.rejects(
    () => assertRowRefreshed(postId, "負對照（改壞）"),
    /過時/,
    "故意改壞 fold_*／投影時必須被 assertRowRefreshed 抓到",
  );
  await seedInSync(postId);
  await assertRowRefreshed(postId, "負對照（修回）");
});

void assertNotRefreshedFail;
