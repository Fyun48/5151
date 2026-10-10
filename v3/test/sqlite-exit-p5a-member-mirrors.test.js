// SQLite 退場 P5a（2026-10-10）：會員／公開路徑上「PG 已寫成功、接著再寫本機 SQLite」的
// 鏡射寫入已移除。
//
// 這一包要釘住的**是當初的 bug 本身**，不是 parity：正式站（`PG_NO_SQLITE_OPEN=1` ＋
// `DB_DRIVER=postgres`）的 `sqliteHandle()` 是 `createNoOpenSqliteProxy()` 回傳的拋錯 proxy，
// 任何 `.prepare/.exec` 一碰就丟 `business SQLite is closed`。
//   * **沒有 try/catch 的那些點**（關閉刊登／隱藏／改匯入草稿／取消匯入草稿／通知偏好／
//     配對訂閱／取消訂閱／問卷／許願範例）＝ PG 已經寫成功、會員卻收到 **400**
//     （會員路由的 error handler 是 `res.status(error.status || 400)`）。
//   * **有 try/catch 的那些點**（建立草稿／建立匯入草稿／公開匯入草稿／建立並公開）＝
//     錯誤被吞掉，但那段程式碼是死的（Owner 裁決一併刪）。
//   * `assertCanPublishAsync()` 原本在熱路徑上把拋錯 proxy 傳給同步版的
//     `isFixtureMaturityAuthorized()`：生產 `maturity` 恆 undefined 會短路，但這是潛伏的
//     SQLite 存取，已改用 awaited 的 PG 版。
//
// 驗法沿用 `sqlite-exit-mirror-drop-p3.test.js`／`pg-no-sqlite-open.test.js` 的形狀：
// **子行程**在乾淨的 process 裡帶著閘 import（`db.js` 開不開 SQLite 是 import 階段決定的，
// 而 ESM 模組會被快取）。
//   - 夾具：v3.db 由一支**沒有閘**的子行程先建好（DDL 由真正的 migrations 產生，不手寫），
//     接著子行程自己唯讀讀 DDL、建 in-memory SQLite 當 PG 替身，再用同一族的方言跑真實 SQL。
//   - PG 替身回「自己是自己的 rows」的陣列：同時滿足兩種 exec 慣例（裸陣列／`{ rows }`），
//     見 `self-listing-publish-async.test.js` 的同一個技巧。
//   - 修好之前，下面每一個 case 都會拿到 `business SQLite is closed`（PR 描述的 git stash 對照）。
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(repoRoot, "src");
const dbJsUrl = pathToFileURL(join(srcDir, "db.js")).href;
const selfUrl = pathToFileURL(join(srcDir, "selfListingsAsync.js")).href;
const prefsUrl = pathToFileURL(join(srcDir, "rentalNotifyPrefsAsync.js")).href;
const surveyUrl = pathToFileURL(join(srcDir, "rentalSurveyAsync.js")).href;
const exampleUrl = pathToFileURL(join(srcDir, "wishExampleAsync.js")).href;
const opsUrl = pathToFileURL(join(srcDir, "siteCommandApplyAsync.js")).href;
const registryUrl = pathToFileURL(join(srcDir, "stage1FixtureRegistry.js")).href;

const dataDir = mkdtempSync(join(tmpdir(), "v3-p5a-gate-"));
process.on("exit", () => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const PROBE = `
const { DatabaseSync } = await import("node:sqlite");
const { writeFileSync } = await import("node:fs");
const path = await import("node:path");

const OLD = "2026-01-01T00:00:00.000Z";
const NOW = "2026-10-10T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";
const USER = 91;
const OTHER = 92;
const REPORTER = 93;
const LISTING = 700001;
const OWNER99 = 99;
const DRAFT = 800001;
const DRAFT2 = 800002;
const DRAFT3 = 800003;
const WISH = 831;
const TOKEN = "tok-p5a";
const MEDIA_KEY = "d".repeat(32) + ".jpg";
const MEDIA_URL = "/media/lib/" + MEDIA_KEY;
const PG = { driver: "postgres", strict: true };

// PG 替身：in-memory SQLite ＋ 從磁碟鏡射 DDL。回「自己是自己的 rows」的陣列。
function fixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(path.join(process.env.DATA_DIR, "v3.db"), { readOnly: true });
  const tables = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  for (const row of tables) if (row.sql) mem.exec(row.sql);
  disk.close();
  const exec = async (sql, params = []) => {
    if (typeof sql !== "string") throw new Error("夾具收到不是 SQL 的東西");
    // 與其他 PG 夾具同一個做法：注入式 exec 不經過 toPostgresSql()，所以這裡自己把
    // SQLite 方言的 IFNULL 換成兩邊都合法的 COALESCE。
    const text = sql.replace(/\\bIFNULL\\s*\\(/gi, "COALESCE(");
    const rows = mem.prepare(text).all(...params);
    rows.rowCount = Number(mem.prepare("SELECT changes() AS n").get().n) || 0;
    rows.rows = rows;
    return rows;
  };
  exec.raw = mem;
  return exec;
}

function seedBase(h) {
  for (const id of [USER, OTHER, REPORTER, OWNER99]) {
    h.prepare(
      "INSERT INTO users(id, email, nickname, role, plan, created_at) VALUES (?, ?, ?, 'member', 'sponsor', ?)",
    ).run(id, "p5a" + id + "@example.com", "P5a " + id, OLD);
  }
  h.prepare("INSERT INTO settings(key, value) VALUES ('rentalMarketplaceFlags', ?)").run(
    JSON.stringify({ wish: { notifications_enabled: true }, rental_catalog_v2: { enabled: true } }),
  );
}

function seedListing(h, { id = LISTING, ownerId = USER, status = "open" } = {}) {
  h.prepare(
    "INSERT INTO listings(post_id, source_key, title, url, source, listed_by_user_id, self_status, self_body, " +
    "self_photos, cover, self_expires_at, first_seen_at, last_seen_at) " +
    "VALUES (?, ?, ?, ?, 'self', ?, ?, '草稿內容', '[]', '', ?, ?, ?)",
  ).run(id, "self-" + id, "P5a 刊登 " + id, "https://example.com/" + id, ownerId, status, FUTURE, OLD, OLD);
}

function seedMedia(h, userId) {
  h.prepare(
    "INSERT INTO member_media(user_id, storage_key, mime, format, created_at, deleted_at) VALUES (?, ?, 'image/jpeg', 'jpg', ?, NULL)",
  ).run(userId, MEDIA_KEY, OLD);
}

const CREATE_INPUT = {
  district: "1-8", street: "台北市士林區中正路100號", rent: 28000, ping: "25", accept_pledge: true,
  body: "近捷運、採光好、生活機能佳、可立即入住，適合小家庭。",
  floor: 5, total_floors: 12, rooms: 2, living: 1, bath: 1,
  title: "P5a 建立測試刊登", kind: "apartment", role: "owner", contact_name: "測試屋主",
  photos: [MEDIA_URL],
};
const PUBLISH_INPUT = Object.assign({}, CREATE_INPUT, { title: "P5a 公開測試刊登" });

const out = { probe: process.env.PROBE_CASE, threw: false, message: "", detail: null, secondThrow: "" };
try {
  const exec = fixture();
  const h = exec.raw;
  seedBase(h);
  const c = process.env.PROBE_CASE;

  if (c === "close") {
    seedListing(h);
    const mod = await import(process.env.SELF_URL);
    await mod.closeSelfListingAsync(USER, LISTING, Object.assign({}, PG, { exec, now: new Date(NOW) }));
    out.detail = { pg: h.prepare("SELECT self_status FROM listings WHERE post_id=?").get(LISTING) };
  } else if (c === "hide") {
    seedListing(h);
    const mod = await import(process.env.SELF_URL);
    const res = await mod.hideSelfListingAsync(LISTING, Object.assign({}, PG, { exec, now: new Date(NOW) }));
    out.detail = {
      returned: res.hidden,
      pg: h.prepare("SELECT self_status FROM listings WHERE post_id=?").get(LISTING),
      ban: h.prepare("SELECT self_ban_until FROM users WHERE id=?").get(USER).self_ban_until,
    };
  } else if (c === "report") {
    seedListing(h, { ownerId: OWNER99 });
    const mod = await import(process.env.SELF_URL);
    await mod.reportSelfListingAsync(USER, LISTING, "廣告", Object.assign({}, PG, { exec, now: new Date(NOW) }));
    const second = await mod.reportSelfListingAsync(REPORTER, LISTING, "重複張貼", Object.assign({}, PG, { exec, now: new Date(NOW) }));
    out.detail = {
      returned: second.hidden,
      pg: h.prepare("SELECT self_status FROM listings WHERE post_id=?").get(LISTING),
      ban: h.prepare("SELECT self_ban_until FROM users WHERE id=?").get(OWNER99).self_ban_until,
    };
  } else if (c === "draftUpdate") {
    seedListing(h, { id: DRAFT, status: "draft" });
    const mod = await import(process.env.SELF_URL);
    await mod.updateImportedDraftListingAsync(USER, DRAFT, { title: "新的標題", body: "新的內容" }, Object.assign({}, PG, { exec }));
    out.detail = { pg: h.prepare("SELECT title, self_body FROM listings WHERE post_id=?").get(DRAFT) };
  } else if (c === "draftAbandon") {
    seedListing(h, { id: DRAFT2, status: "draft" });
    const mod = await import(process.env.SELF_URL);
    await mod.abandonImportedDraftListingAsync(USER, DRAFT2, Object.assign({}, PG, { exec, now: new Date(NOW) }));
    out.detail = { pg: h.prepare("SELECT self_status FROM listings WHERE post_id=?").get(DRAFT2) };
  } else if (c === "draftInsert") {
    const mod = await import(process.env.SELF_URL);
    const view = await mod.insertSelfDraftListingAsync(USER, { title: "P5a 草稿", body: "草稿內容" }, Object.assign({}, PG, { exec, now: new Date(NOW) }));
    out.detail = {
      postId: Number(view.post_id) || 0,
      pg: h.prepare("SELECT self_status, title FROM listings WHERE post_id=?").get(Number(view.post_id) || 0),
    };
  } else if (c === "importedDraftInsert") {
    const mod = await import(process.env.SELF_URL);
    const view = await mod.insertImportedDraftListingAsync(USER, { title: "P5a 匯入草稿", body: "匯入內容" }, Object.assign({}, PG, { exec, now: new Date(NOW) }));
    out.detail = {
      postId: Number(view.post_id) || 0,
      pg: h.prepare("SELECT self_status, title FROM listings WHERE post_id=?").get(Number(view.post_id) || 0),
    };
  } else if (c === "publish") {
    seedListing(h, { id: DRAFT3, status: "draft" });
    seedMedia(h, USER);
    const mod = await import(process.env.SELF_URL);
    const view = await mod.publishImportedDraftListingAsync(USER, DRAFT3, PUBLISH_INPUT, Object.assign({}, PG, { exec, now: new Date(NOW) }));
    out.detail = {
      returned: String(view.title || ""),
      pg: h.prepare("SELECT self_status FROM listings WHERE post_id=?").get(DRAFT3),
    };
  } else if (c === "create") {
    seedMedia(h, USER);
    const mod = await import(process.env.SELF_URL);
    const view = await mod.createSelfListingAsync(USER, CREATE_INPUT, Object.assign({}, PG, { exec, now: new Date(NOW) }));
    out.detail = {
      postId: Number(view.post_id) || 0,
      pg: h.prepare("SELECT self_status FROM listings WHERE post_id=?").get(Number(view.post_id) || 0),
    };
  } else if (c === "maturity") {
    seedListing(h, { id: DRAFT, status: "draft" });
    const registry = await import(process.env.REGISTRY_URL);
    const mod = await import(process.env.SELF_URL);
    const maturity = {};
    maturity[registry.FIXTURE_MATURITY] = true;
    maturity.userId = USER;
    await mod.assertCanPublishAsync(exec, USER, new Date(NOW), { maturity });
    out.detail = { ran: true };
  } else if (c === "prefs") {
    const mod = await import(process.env.PREFS_URL);
    const view = await mod.saveRentalNotifyPrefsForAsync(USER, { new_match: false }, Object.assign({}, PG, { exec, now: new Date(NOW) }));
    out.detail = {
      enabled: view.enabled,
      pg: h.prepare("SELECT new_match, channel_mail FROM rental_notify_prefs WHERE user_id=?").get(USER),
      analytics: Number(h.prepare("SELECT COUNT(*) AS n FROM rental_analytics_daily").get().n) || 0,
    };
  } else if (c === "subscribe") {
    seedListing(h);
    const mod = await import(process.env.PREFS_URL);
    const view = await mod.saveMatchSubscriptionAsync(USER, LISTING, "instant", Object.assign({}, PG, { exec, now: new Date(NOW) }));
    out.detail = {
      mode: view.mode,
      pg: h.prepare("SELECT mode, public_token FROM rental_match_subscriptions WHERE owner_user_id=? AND listing_id=?").get(USER, LISTING),
    };
  } else if (c === "unsubscribe") {
    h.prepare(
      "INSERT INTO rental_unsubscribe_tokens(token, user_id, scope, expires_at, used_at) VALUES (?, ?, 'all', ?, NULL)",
    ).run(TOKEN, USER, FUTURE);
    const mod = await import(process.env.PREFS_URL);
    const view = await mod.applyUnsubscribeTokenAsync(TOKEN, Object.assign({}, PG, { exec, now: new Date(NOW) }));
    out.detail = {
      returned: view.ok,
      pg: h.prepare("SELECT used_at FROM rental_unsubscribe_tokens WHERE token=?").get(TOKEN),
      prefs: h.prepare("SELECT channel_mail, new_match FROM rental_notify_prefs WHERE user_id=?").get(USER),
    };
  } else if (c === "survey") {
    h.prepare(
      "INSERT INTO demand_posts(id, user_id, districts, rent_max, housing_type, mrt_walk, body, status, created_at, " +
      "updated_at, expires_at, published_at, public_token, legacy_numeric_share, lifecycle, closed_reason) " +
      "VALUES (?, ?, '[\\"1-5\\"]', 30000, 'any', 0, '找房的內容', 'closed', ?, ?, ?, ?, ?, 1, 'completed', '')",
    ).run(WISH, USER, NOW, NOW, FUTURE, NOW, "tok-" + WISH);
    const mod = await import(process.env.SURVEY_URL);
    const view = await mod.submitCompletionSurveyAsync(USER, WISH, { found_via_site: "yes" }, Object.assign({}, PG, { exec, now: new Date(NOW) }));
    out.detail = {
      ref: Boolean(view.survey_ref),
      pg: h.prepare("SELECT found_via_site FROM rental_completion_surveys WHERE wish_id=?").get(WISH),
      analytics: Number(h.prepare("SELECT COUNT(*) AS n FROM rental_analytics_daily").get().n) || 0,
    };
  } else if (c === "wishExample") {
    const mod = await import(process.env.EXAMPLE_URL);
    const view = await mod.saveWishExampleAsync(USER, {
      districts: ["1-5"], rent_max: 25000, body: "範例內容、近捷運", contact_name: "小明",
    }, Object.assign({}, PG, { exec, now: new Date(NOW) }));
    out.detail = {
      returned: String(view.contact_name || ""),
      pg: h.prepare("SELECT payload FROM wish_room_example WHERE user_id=?").get(USER),
    };
  } else if (c === "gate") {
    // 閘門自我檢查：這一個 case **必須**拋（正常的拋錯長相就是下面那一句）。
    const db = await import(process.env.DB_JS_URL);
    db.sqliteHandle().prepare("SELECT 1 AS n").get();
    out.detail = { reached: true };
  } else if (c === "opsStore") {
    const mod = await import(process.env.OPS_URL);
    const ddl = [];
    const queries = [];
    const driver = {
      exec: async (sql) => { ddl.push(String(sql)); },
      query: async (sql) => {
        queries.push(String(sql));
        if (/information_schema\\.tables/.test(sql)) return { rows: [{ one: 1 }] };
        if (/information_schema\\.columns/.test(sql)) return { rows: [{ name: "id", type: "text", is_nullable: "NO", column_default: null }] };
        return { rows: [] };
      },
    };
    const snap = await mod.ensureSiteCommandStoreOnce(driver);
    out.detail = {
      ran: true,
      ddl: ddl.slice(0, 3),
      usedInformationSchema: queries.some((sql) => sql.indexOf("information_schema") !== -1),
      usedSqliteMaster: queries.concat(ddl).some((sql) => sql.indexOf("sqlite_master") !== -1),
    };
  } else {
    throw new Error("未知的 PROBE_CASE：" + c);
  }
} catch (error) {
  out.threw = true;
  out.message = String((error && error.message) || error);
  out.secondThrow = String((error && error.code) || "");
}
if (process.env.DISK_DB === "1") {
  // 另外確認磁碟上的 v3.db 沒有被碰過（開閘時它根本不該被開來寫）。
  const { DatabaseSync: DiskDb } = await import("node:sqlite");
  const disk = new DiskDb(path.join(process.env.DATA_DIR, "v3.db"), { readOnly: true });
  out.diskListings = Number(disk.prepare("SELECT COUNT(*) AS n FROM listings").get().n) || 0;
  disk.close();
}
writeFileSync(process.env.RESULT_FILE, JSON.stringify(out));
`;

before(() => {
  const setup = spawnSync(process.execPath, ["--input-type=module", "-e", "await import(process.env.DB_JS_URL);"], {
    env: { ...process.env, DATA_DIR: dataDir, DB_JS_URL: dbJsUrl, DB_DRIVER: "sqlite", PG_NO_SQLITE_OPEN: "" },
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(setup.status, 0, `建 v3.db 失敗：${String(setup.stderr).slice(0, 800)}`);
});

function probe(probeCase) {
  const resultFile = join(dataDir, `result-${probeCase}.json`);
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", PROBE], {
    cwd: repoRoot,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      DB_DRIVER: "postgres",
      PG_NO_SQLITE_OPEN: "1",
      SELF_URL: selfUrl,
      PREFS_URL: prefsUrl,
      SURVEY_URL: surveyUrl,
      EXAMPLE_URL: exampleUrl,
      OPS_URL: opsUrl,
      REGISTRY_URL: registryUrl,
      DB_JS_URL: dbJsUrl,
      PROBE_CASE: probeCase,
      RESULT_FILE: resultFile,
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  if (r.status !== 0) return { probe: probeCase, threw: true, message: `子行程退出碼 ${r.status}：${String(r.stderr).slice(0, 800)}` };
  return JSON.parse(readFileSync(resultFile, "utf8"));
}

const MIRROR_ERROR = /business SQLite is closed/;

// 修好之前每一條都會拿到 `business SQLite is closed (PG_NO_SQLITE_OPEN=1, DB_DRIVER=postgres)`。
test("關閉自己的站內刊登：開閘下不得碰 sqliteHandle", () => {
  const result = probe("close");
  assert.equal(result.threw, false, `開閘不得拋錯（真的拋了：${result.message}）`);
  assert.deepEqual(result.detail.pg, { self_status: "closed" }, "PG 那一列要照樣關掉");
});

test("後台隱藏／檢舉達門檻：開閘下不得碰 sqliteHandle", () => {
  const hide = probe("hide");
  assert.equal(hide.threw, false, `開閘不得拋錯（真的拋了：${hide.message}）`);
  assert.equal(hide.detail.pg.self_status, "hidden", "PG 那一列要照樣隱藏");
  assert.ok(hide.detail.ban, "PG 的停權時間要照樣寫入");

  const report = probe("report");
  assert.equal(report.threw, false, `開閘不得拋錯（真的拋了：${report.message}）`);
  assert.equal(report.detail.returned, true, "第二筆檢舉要達門檻");
  assert.equal(report.detail.pg.self_status, "hidden", "PG 那一列要照樣隱藏");
  assert.ok(report.detail.ban, "PG 的停權時間要照樣寫入");
});

test("改匯入草稿／取消匯入草稿：開閘下不得碰 sqliteHandle", () => {
  const update = probe("draftUpdate");
  assert.equal(update.threw, false, `開閘不得拋錯（真的拋了：${update.message}）`);
  assert.deepEqual(update.detail.pg, { title: "新的標題", self_body: "新的內容" }, "PG 那一列要照樣更新");

  const abandon = probe("draftAbandon");
  assert.equal(abandon.threw, false, `開閘不得拋錯（真的拋了：${abandon.message}）`);
  assert.equal(abandon.detail.pg.self_status, "cancelled", "PG 那一列要照樣取消");
});

test("建立草稿／建立匯入草稿／公開／建立並公開：開閘下不得碰 sqliteHandle", () => {
  const draft = probe("draftInsert");
  assert.equal(draft.threw, false, `開閘不得拋錯（真的拋了：${draft.message}）`);
  assert.equal(draft.detail.pg.self_status, "draft", "PG 上要照樣多一則草稿");
  assert.equal(draft.detail.pg.title, "P5a 草稿");

  const imported = probe("importedDraftInsert");
  assert.equal(imported.threw, false, `開閘不得拋錯（真的拋了：${imported.message}）`);
  assert.equal(imported.detail.pg.self_status, "draft", "PG 上要照樣多一則匯入草稿");

  const publish = probe("publish");
  assert.equal(publish.threw, false, `開閘不得拋錯（真的拋了：${publish.message}）`);
  assert.equal(publish.detail.pg.self_status, "open", "PG 那一列要照樣公開");

  const create = probe("create");
  assert.equal(create.threw, false, `開閘不得拋錯（真的拋了：${create.message}）`);
  assert.equal(create.detail.pg.self_status, "open", "PG 上要照樣多一則公開刊登");
});

test("可刊登條件（成熟度）：開閘下不得把拋錯 proxy 傳給同步版授權函式", () => {
  const result = probe("maturity");
  assert.equal(result.threw, false, `開閘不得拋錯（真的拋了：${result.message}）`);
  assert.equal(result.detail.ran, true);
});

test("通知偏好／配對訂閱：開閘下不得碰 sqliteHandle", () => {
  const prefs = probe("prefs");
  assert.equal(prefs.threw, false, `開閘不得拋錯（真的拋了：${prefs.message}）`);
  assert.equal(prefs.detail.enabled, true, "caps 照樣算得出來");
  assert.deepEqual(prefs.detail.pg, { new_match: 0, channel_mail: 0 }, "PG 那一列要照樣寫入");
  assert.equal(prefs.detail.analytics, 1, "PG 的計數照樣記一次");

  const subscribe = probe("subscribe");
  assert.equal(subscribe.threw, false, `開閘不得拋錯（真的拋了：${subscribe.message}）`);
  assert.equal(subscribe.detail.mode, "instant");
  assert.equal(subscribe.detail.pg.mode, "instant", "PG 那一列要照樣寫入");
  assert.ok(subscribe.detail.pg.public_token, "token 照樣產生");
});

test("公開的取消訂閱（免登入路由）：開閘下不得碰 sqliteHandle", () => {
  const result = probe("unsubscribe");
  assert.equal(result.threw, false, `開閘不得拋錯（真的拋了：${result.message}）`);
  assert.equal(result.detail.returned, true);
  assert.ok(result.detail.pg.used_at, "PG 上要照樣標記已用");
  assert.equal(result.detail.prefs.channel_mail, 0, "PG 的 prefs 要照樣被改到");
});

test("完成找房問卷：開閘下不得碰 sqliteHandle", () => {
  const result = probe("survey");
  assert.equal(result.threw, false, `開閘不得拋錯（真的拋了：${result.message}）`);
  assert.equal(result.detail.ref, true, "survey_ref 照樣產生");
  assert.equal(result.detail.pg.found_via_site, "yes", "PG 那一列要照樣寫入");
  assert.equal(result.detail.analytics, 1, "PG 的計數只記一次");
});

test("許願房範例：開閘下不得碰 sqliteHandle", () => {
  const result = probe("wishExample");
  assert.equal(result.threw, false, `開閘不得拋錯（真的拋了：${result.message}）`);
  assert.ok(String(result.detail.pg.payload || "").includes("範例內容"), "PG 那一列要照樣寫入");
});

test("Ops 指令套用（site_command_inbox 的 DDL）：開閘下走 PG 原生，不碰 sqliteHandle", () => {
  const result = probe("opsStore");
  assert.equal(result.threw, false, `開閘不得拋錯（真的拋了：${result.message}）`);
  assert.equal(result.detail.usedInformationSchema, true, "要改問 information_schema");
  assert.equal(result.detail.usedSqliteMaster, false, "不得再讀 sqlite_master");
  assert.ok(
    result.detail.ddl.some((sql) => /CREATE UNIQUE INDEX/i.test(sql)),
    `PG 端要照樣補上唯一索引（實際：${JSON.stringify(result.detail.ddl)}）`,
  );
});

// 原始碼層級：就算夾具哪天變了，也不能再把這些鏡射寫回來。
test("原始碼層級：本機鏡射呼叫點已移除", () => {
  // 註解一律先剔除：本檔留下的「🚫 已刪」說明文字裡會提到那些變數名。
  const strip = (text) => text.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
  const self = readFileSync(join(srcDir, "selfListingsAsync.js"), "utf8");
  for (const sqlName of ["CLOSE_SELF_LISTING_SQL", "HIDE_SELF_LISTING_SQL", "DRAFT_LISTING_UPDATE_SQL", "ABANDON_DRAFT_LISTING_SQL", "BAN_SELF_PUBLISHER_SQL"]) {
    assert.doesNotMatch(self, new RegExp(`sqliteHandle\\(\\)\\.prepare\\(${sqlName}\\)`), `${sqlName} 不得再鏡射本機`);
  }
  assert.doesNotMatch(self, /isFixtureMaturityAuthorized\(sqliteHandle\(\)/, "成熟度授權要走 awaited 的 PG 版");
  // 建立類的鏡射與「SQLite 回退分支」用的是同一句 ⇒ 用**次數**釘住（回退分支各留一次）。
  // 先去掉整行註解：本檔留下的「🚫 已刪」說明文字裡也提到同一句。
  const code = strip(self);
  const count = (text, re) => (text.match(re) || []).length;
  assert.equal(count(code, /insertSelfDraftListing\(sqliteHandle\(\)/g), 1, "建立草稿只剩回退分支那一次");
  assert.equal(count(code, /createImportedDraftListing\(sqliteHandle\(\)/g), 1, "建立匯入草稿只剩回退分支那一次");
  assert.equal(count(code, /createSelfListing\(sqliteHandle\(\)/g), 2, "建立並公開只剩兩個回退分支");
  assert.equal(count(code, /publishImportedDraftListing\(sqliteHandle\(\)/g), 2, "公開匯入草稿只剩兩個回退分支");
  assert.equal(count(code, /matchCandidates: \(\) => \[\]/g), 0, "已刪的鏡射都帶空的 matchCandidates（這個形狀不得再出現）");

  const prefs = strip(readFileSync(join(srcDir, "rentalNotifyPrefsAsync.js"), "utf8"));
  assert.doesNotMatch(prefs, /sqliteHandle\(\)\.prepare\(PREFS_UPSERT_SQL\)/, "prefs 不得再鏡射本機");
  assert.doesNotMatch(prefs, /bumpAnalytics\(sqliteHandle\(\)/, "本機計數不得再記一次");
  assert.doesNotMatch(prefs, /localRow/, "訂閱不得再讀本機那一列");
  assert.doesNotMatch(prefs, /localToken/, "取消訂閱不得再動本機那一列");

  const survey = strip(readFileSync(join(srcDir, "rentalSurveyAsync.js"), "utf8"));
  assert.doesNotMatch(survey, /local\.prepare\(SURVEY_INSERT_SQL\)/, "問卷不得再鏡射本機");
  assert.doesNotMatch(survey, /bumpAnalytics\(sqliteHandle\(\)/, "本機計數不得再記一次");

  const example = strip(readFileSync(join(srcDir, "wishExampleAsync.js"), "utf8"));
  assert.doesNotMatch(example, /WISH_EXAMPLE_UPSERT_SQL/, "許願範例不得再鏡射本機");
  assert.doesNotMatch(example, /local\.prepare\(/, "許願範例不得再讀本機 users");

  const ops = strip(readFileSync(join(srcDir, "siteCommandApplyAsync.js"), "utf8"));
  assert.match(ops, /if \(sqliteHandleIsUsable\(sqlite\)\) ensureSiteCommandInboxSync\(sqlite\)/, "DDL 要有可用 handle 的守衛");
});

test("閘門自我檢查：同一個子行程形狀下，sqliteHandle() 真的會拋 business SQLite is closed", () => {
  // 這一條釘住「紅燈的長相」：如果哪天 `pg-no-sqlite-open` 的閘門失效（`sqliteHandle()` 又回真的
  // handle），上面那些「不得拋錯」會在**不知道為什麼**的情況下繼續綠——這一條會在那一刻變紅。
  const result = probe("gate");
  assert.equal(result.threw, true, "開閘時 sqliteHandle().prepare() 必須拋錯");
  assert.match(result.message, MIRROR_ERROR, `拋的必須是 business SQLite is closed（實際：${result.message}）`);
});
