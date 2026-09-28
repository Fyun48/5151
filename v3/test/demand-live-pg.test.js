// 許願房寫入（檢舉／回覆／關閉）的 **live PG** 驗證（2026-09-28）。
//
// 離線 parity（demand-async.test.js）用的 PG 替身是**記憶體 SQLite**，它證明不了三件事：
//
//   1. **`ensurePgSchema` 的鏡射建表在真 PG 上真的跑得起來**。離線測試是自己 `CREATE TABLE`
//      的，完全沒走到 bootstrap。`demand_posts` 有 41 個欄位、含部分唯一索引
//      （`idx_demand_one_open` 這種 `WHERE status='open'` 的索引），SQLite 的 DDL
//      不是每一句都能直接餵給 PG。
//   2. **送進 PG 的語句真的合法**（`COALESCE`、`COUNT(*) AS n`、`ORDER BY id DESC LIMIT 1`）。
//      夾具會擋 SQLite 方言，但擋不了「PG 也不接受的第三種寫法」。
//   3. **寫入真的生效**，而不是只回了一個看起來對的結果。
//
// ⚠️ 安全設計照抄 `member-media-live-pg.test.js`：**不吃 `PG_TEST_URL`**（本機那個指向
// `5151_shadow` 正式影子庫），只認 `PG_LIVE_REPRO_URL` 且資料庫名要在允許清單內。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const RAW = String(process.env.PG_LIVE_REPRO_URL || "").trim();
const ALLOWED_DB = new Set(["repro", "tracker_test", "repro2"]);
const DB = (() => { try { return new URL(RAW).pathname.replace(/^\//, ""); } catch { return ""; } })();
const REFUSED = RAW && !ALLOWED_DB.has(DB);
const skip = !RAW ? "PG_LIVE_REPRO_URL 未設定（live PG 驗證需要隔離環境）"
  : REFUSED ? `拒絕執行：資料庫 "${DB}" 不在允許清單 ${[...ALLOWED_DB].join("/")}（正式庫 5151_shadow 一律拒絕）`
    : false;

// ⚠️ 刻意**不**自己指定 id：正式站的 INSERT 一律讓 identity 產生，測試也照做。
// 第一版用了 900000000x 這種很大的顯式 id，結果**把 identity 序列留在後面**
// （next=1、max=9e8），下一個跑到的 live 測試（reject-match-live-pg）就紅在
// 「identity 序列落後」那道守衛上。CI 就是這樣抓到的。
const TOKEN = "livetest-demand-token-0001";
const OLD = "2026-01-01T00:00:00.000Z";
const EXPIRES = "2099-01-01T00:00:00.000Z";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-demand-live-"));
process.env.DATA_DIR = process.env.DATA_DIR || dataDir;

test("live PG：bootstrap 之後檢舉／回覆／關閉真的生效，且 demand_posts 的部分唯一索引存在", { skip }, async () => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const demandAsync = await import("../src/demandAsync.js");
  const { sqliteHandle } = await import("../src/db.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  const who = (await query("SELECT current_database() AS db"))[0];
  assert.equal(who.db, DB, "連到的資料庫必須與 URL 一致");

  // 讓序列至少追過目前的 max：上一次執行若中途失敗，identity 可能還是舊值。
  // `setval(seq, max)` 之後 next = max+1，所以後續不指定 id 的 INSERT 一定不會撞。
  const syncSequence = async (table) => {
    await query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM ${table}), 1))`,
      [table],
    );
  };

  // 依「測試自己種的帳號」清理：先用郵箱找出所有殘留，再刪它們的貼文與回覆。
  // 這樣不論上一次是成功還是中途失敗，起點都一樣（並且不靠任何寫死的 id）。
  const cleanup = async () => {
    const users = await query("SELECT id FROM users WHERE email LIKE 'live-demand-%@example.com'");
    if (!users.length) return;
    const ids = users.map((r) => Number(r.id));
    const posts = await query("SELECT id FROM demand_posts WHERE user_id = ANY($1)", [ids]);
    const postIds = posts.map((r) => Number(r.id));
    if (postIds.length) {
      await query("DELETE FROM demand_reports WHERE target_id = ANY($1)", [postIds]);
      await query("DELETE FROM demand_replies WHERE post_id = ANY($1)", [postIds]);
      await query("DELETE FROM demand_posts WHERE id = ANY($1)", [postIds]);
    }
    await query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  };

  await cleanup();
  // 讓序列至少追過目前的 max：上一次執行若中途失敗，identity 可能還是舊值。
  // `setval(seq, max)` 之後 next = max+1，所以後續不指定 id 的 INSERT 一定不會撞。
  await syncSequence("users");
  await syncSequence("demand_posts");
  await syncSequence("demand_replies");
  await syncSequence("demand_reports");

  const [UID] = (await query(
    "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'屋主','member','free',$2) RETURNING id",
    [`live-demand-owner@example.com`, OLD],
  )).map((r) => Number(r.id));
  const [OTHER] = (await query(
    "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'路人甲','member','free',$2) RETURNING id",
    [`live-demand-reporter@example.com`, OLD],
  )).map((r) => Number(r.id));
  const [ADMIN] = (await query(
    "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'管理員','admin','free',$2) RETURNING id",
    [`live-demand-second@example.com`, OLD],
  )).map((r) => Number(r.id));
  assert.ok(UID && OTHER && ADMIN, "三個使用者必須真的被建立");

  const POST_ID = Number((await query(
    `INSERT INTO demand_posts(user_id, districts, rent_max, housing_type, mrt_walk, body, status, created_at, expires_at, public_token)
     VALUES ($1,'[]',0,'any',0,'live PG 驗證用的許願房','open',$2,$3,$4) RETURNING id`,
    [UID, OLD, EXPIRES, TOKEN],
  ))[0].id);
  const REPLY_ID = Number((await query(
    "INSERT INTO demand_replies(post_id, user_id, body, created_at, hidden) VALUES ($1,$2,'live 回覆',$3,0) RETURNING id",
    [POST_ID, UID, OLD],
  ))[0].id);

  // 注入式 exec 走的是**真的 PG**。⚠️ 但 `withFallback()` 在 `options.exec` 有值時
  // **不會**再包 `toPostgresSql`（見 `demandAsync.js` 的 `withFallback`），而 `pgDriver.query()`
  // **不翻譯 `?`**（這是既有紀律：方言陷阱清單裡的那一條）。所以這裡必須自己套
  // `toPostgresSql`，否則送進 PG 的會是 `SELECT id FROM demand_posts WHERE id = ?`
  // ⇒ `syntax error at end of input`。正式站走的是 `pgDriver.query(toPostgresSql(sql), …)`，
  // 這裡刻意做成一模一樣——第一次跑 CI 就是少了這一步才紅的。
  const exec = async (sql, params = []) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  };
  const opts = { driver: "postgres", pgDriver, exec, strict: true };

  // 1) 檢舉：第一筆不隱藏、第二筆（不同人）達門檻才隱藏
  const first = await demandAsync.reportDemandAsync(OTHER, { targetType: "post", targetId: POST_ID, reason: "live 廣告" }, opts);
  assert.deepEqual(first, { ok: true, hidden: false }, "第一筆檢舉不該隱藏");
  let status = (await query("SELECT status FROM demand_posts WHERE id = $1", [POST_ID]))[0].status;
  assert.equal(status, "open", "第一筆之後仍必須是 open");

  const second = await demandAsync.reportDemandAsync(ADMIN, { targetType: "post", targetId: POST_ID, reason: "live 廣告" }, opts);
  assert.deepEqual(second, { ok: true, hidden: true }, "第二筆必須達門檻");
  const afterReport = (await query("SELECT status, lifecycle, closed_reason FROM demand_posts WHERE id = $1", [POST_ID]))[0];
  // CI 第一次跑就是在這裡紅的：第一版只把隱藏寫進本機 handle，PG 上那一列還是 open。
  assert.equal(afterReport.status, "hidden", "檢舉達門檻必須在 PG 上真的把 status 設成 hidden");
  assert.equal(afterReport.lifecycle, "blocked", "lifecycle 也必須在 PG 上落地");
  assert.equal(afterReport.closed_reason, "blocked", "closed_reason 必須在 PG 上落地");
  const reports = await query("SELECT target_type, target_id, user_id, reason FROM demand_reports WHERE target_id = $1 ORDER BY id", [POST_ID]);
  assert.equal(reports.length, 2, "兩筆檢舉都必須真的寫進 PG 的 demand_reports");
  assert.equal(reports[0].target_type, "post");

  // 同一人重複檢舉：PG 上沒有唯一鍵，靠先查再寫——這一條要真的在 PG 上驗。
  const again = await demandAsync.reportDemandAsync(OTHER, { targetType: "post", targetId: POST_ID, reason: "live 廣告" }, opts);
  assert.deepEqual(again, { ok: true, already: true }, "同一人第二次必須回 already");
  assert.equal(
    (await query("SELECT COUNT(*)::int AS n FROM demand_reports WHERE target_id = $1", [POST_ID]))[0].n, 2,
    "重複檢舉不得寫入第三列",
  );

  // 把貼文還原成 open，繼續驗回覆與關閉
  await query("UPDATE demand_posts SET status = 'open', closed_at = NULL WHERE id = $1", [POST_ID]);
  // ⚠️ 這一句第一版寫成 `id <> $1 AND post_id = $1` 卻傳兩個參數 ⇒
  // PG 回「bind message supplies 2 parameters, but prepared statement requires 1」。
  // 參數編號要各自獨立（`?` 轉 `$n` 是**逐個出現**編號，不是依值去重）。
  await query("DELETE FROM demand_replies WHERE id <> $1 AND post_id = $2", [REPLY_ID, POST_ID]);

  // 2) 回覆：真的寫進 PG，而且 20 秒間隔在真 PG 的資料上也擋得住
  const replied = await demandAsync.addDemandReplyAsync(OTHER, POST_ID, "live PG 的回覆", opts);
  assert.deepEqual(replied, { ok: true, id: POST_ID, replied: true });
  const reply = (await query("SELECT body, user_id FROM demand_replies WHERE post_id = $1 AND user_id = $2", [POST_ID, OTHER]))[0];
  assert.ok(reply, "回覆必須真的寫進 PG 的 demand_replies");
  assert.equal(reply.body, "live PG 的回覆");

  await assert.rejects(
    () => demandAsync.addDemandReplyAsync(OTHER, POST_ID, "太快了", opts),
    /密集/,
    "20 秒間隔限制必須用真 PG 上的上一則時間擋下來",
  );

  // 3) 關閉：status 與 lifecycle 都要在 PG 上落地；非本人不得關閉
  await assert.rejects(
    () => demandAsync.closeDemandPostAsync(OTHER, POST_ID, {}, opts),
    /只能關閉自己的許願房/,
    "非本人不得關閉",
  );
  const closed = await demandAsync.closeDemandPostAsync(UID, POST_ID, {}, opts);
  assert.deepEqual(closed, { ok: true, id: POST_ID, status: "closed" });
  const afterClose = (await query("SELECT status, closed_at FROM demand_posts WHERE id = $1", [POST_ID]))[0];
  assert.equal(afterClose.status, "closed", "關閉必須在 PG 上真的生效");
  assert.ok(afterClose.closed_at, "closed_at 必須被寫入");

  // 4) bootstrap 的產物：`demand_posts` 的部分唯一索引。
  //    SQLite 的 `idx_demand_one_open` 是 `WHERE status='open'` 的**部分**唯一索引。
  //    這是「CREATE TABLE 的 UNIQUE 鏡射不到」那個坑的同類，所以要用真 PG 查一次。
  const idx = await query(
    "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = 'demand_posts' ORDER BY indexname",
  );
  const names = idx.map((r) => r.indexname);
  assert.ok(names.includes("demand_posts_pkey"), `demand_posts 必須有主鍵索引（實際：${names.join(",")}）`);
  // 這一句是「bootstrap 補建」的證據；索引名稱由 SQLite 的 DDL 沿用。
  const partial = idx.find((r) => /demand_posts_user_id.*open/i.test(r.indexdef) || /idx_demand_one_open/i.test(r.indexname));
  assert.ok(partial, `必須有『同一人只能有一則 open』的部分唯一索引（實際索引：${names.join(",")}）`);

  await cleanup();
  // 收尾不再 setval：這一輪的列是用 identity 產生的，刪掉之後 `max` 下降，
  // 而序列本來就已經追過它們（identity 每產生一個值就前進一次）⇒ 序列一定 > max，
  // 對下一個測試而言是健康的。反過來在這裡 setval 只會把 next 硬拉回 max+1。
  await pgDriver.close();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 檔案被鎖住就算了 */ }
  void sqliteHandle;
});

// 生命週期寫入（更新／刊登／重開）與範例儲存（`wish_room_example`）的 live PG 驗證。
//
// 離線 parity 用的是記憶體 SQLite 替身，證明不了這幾件事（與上面那一條同一個理由）：
//   1. `ensurePgSchema` 鏡射出來的表真的能接受這些 UPDATE（`COALESCE(?, status)`、
//      `condition_choices`、`lifecycle` 這些欄位在 PG 上的型別與 NOT NULL）。
//   2. 「同一人只能有一則 open／draft」的**部分唯一索引在 PG 上真的存在**——同步版靠
//      `BEGIN IMMEDIATE` ＋ 這個索引，PG 版沒有交易，只剩這個索引可以擋。
//   3. `wish_room_example` 的「先查再寫」在 PG 上真的能寫第二次（INSERT 之後 UPDATE）。
test("live PG：更新／刊登／重開與範例儲存真的生效，且部分唯一索引在 PG 上擋得住", { skip }, async () => {
  const { createPostgresDriver } = await import("../src/dbDriverPostgres.js");
  const demandAsync = await import("../src/demandAsync.js");
  const wishExampleAsync = await import("../src/wishExampleAsync.js");
  const { toPostgresSql } = await import("../src/sqlDialect.js");

  const pgDriver = await createPostgresDriver({ connectionString: RAW });
  const query = async (sql, params = []) => (await pgDriver.query(sql, params)).rows;
  const who = (await query("SELECT current_database() AS db"))[0];
  assert.equal(who.db, DB, "連到的資料庫必須與 URL 一致");

  const syncSequence = async (table) => {
    await query(
      `SELECT setval(pg_get_serial_sequence($1, 'id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM ${table}), 1))`,
      [table],
    );
  };
  const cleanup = async () => {
    const users = await query("SELECT id FROM users WHERE email LIKE 'live-wish-%@example.com'");
    if (!users.length) return;
    const ids = users.map((r) => Number(r.id));
    const posts = await query("SELECT id FROM demand_posts WHERE user_id = ANY($1)", [ids]);
    const postIds = posts.map((r) => Number(r.id));
    if (postIds.length) await query("DELETE FROM demand_posts WHERE id = ANY($1)", [postIds]);
    await query("DELETE FROM wish_room_example WHERE user_id = ANY($1)", [ids]);
    await query("DELETE FROM users WHERE id = ANY($1)", [ids]);
  };

  await cleanup();
  await syncSequence("users");
  await syncSequence("demand_posts");

  const [UID] = (await query(
    "INSERT INTO users(email, nickname, role, plan, created_at) VALUES ($1,'屋主','member','free',$2) RETURNING id",
    ["live-wish-owner@example.com", OLD],
  )).map((r) => Number(r.id));
  assert.ok(UID, "測試帳號必須真的被建立");

  const DRAFT_ID = Number((await query(
    `INSERT INTO demand_posts(user_id, districts, rent_max, housing_type, mrt_walk, body, status, created_at, expires_at, public_token)
     VALUES ($1,'[]',0,'any',0,'live PG 生命週期驗證','draft',$2,$3,$4) RETURNING id`,
    [UID, OLD, EXPIRES, `${TOKEN}-draft`],
  ))[0].id);

  // ⚠️ 與上面那一條同一個理由：`options.exec` 有值時 `withFallback()` 不再套 `toPostgresSql`，
  // 所以注入的 runner 自己要套（正式路徑也是這樣）。
  const exec = async (sql, params = []) => {
    const res = await pgDriver.query(toPostgresSql(sql), params);
    return { rows: res.rows, rowCount: Number(res.rowCount) || 0 };
  };
  const opts = { driver: "postgres", pgDriver, exec, strict: true };
  const rowOf = async (id) => (await query(
    "SELECT status, lifecycle, closed_at, published_at, districts, rent_min, rent_max, body, city FROM demand_posts WHERE id = $1",
    [id],
  ))[0];

  // 1) 刊登：draft → open，而且在 PG 上真的落地（不是只寫本機 handle）
  const published = await demandAsync.publishWishRoomAsync(UID, DRAFT_ID, { districts: ["1-5"], body: "live 刊登的內容" }, opts);
  assert.equal(published.status, "open", "回傳的許願房必須是 open");
  let row = await rowOf(DRAFT_ID);
  assert.equal(row.status, "open", "PG 上必須真的變 open");
  assert.equal(row.lifecycle, "active", "lifecycle 必須在 PG 上落地");
  assert.ok(row.published_at, "published_at 必須被寫入");
  assert.equal(row.closed_at, null, "closed_at 必須是 NULL");

  // 2) 更新：欄位正規化後寫進 PG
  const updated = await demandAsync.updateWishRoomAsync(UID, DRAFT_ID, {
    districts: ["1-5", "1-7"], rent_min: 15000, rent_max: 25000, body: "  live 更新後的內容  ",
  }, opts);
  assert.equal(updated.status, "open");
  row = await rowOf(DRAFT_ID);
  assert.equal(row.districts, '["1-5","1-7"]', "districts 必須以 JSON 陣列落地");
  assert.equal(row.city, "台北市", "city 必須由行政區推導");
  assert.equal(row.rent_min, 15000);
  assert.equal(row.body, "live 更新後的內容", "頭尾空白必須被正規化");

  // 3) 部分唯一索引：PG 上「同一人只能有一則 open／draft」是真的靠索引擋下來的
  //    （PG 版沒有 `BEGIN IMMEDIATE`，所以這是唯一的防線）。
  await assert.rejects(
    () => query(
      `INSERT INTO demand_posts(user_id, districts, rent_max, housing_type, mrt_walk, body, status, created_at, expires_at, public_token)
       VALUES ($1,'[]',0,'any',0,'第二則','draft',$2,$3,$4)`,
      [UID, OLD, EXPIRES, `${TOKEN}-second`],
    ),
    /idx_demand_one_(draft|mutable)|duplicate key/i,
    "PG 上必須有擋住『第二則 mutable』的部分唯一索引",
  );

  // 4) 重開：先關掉（PG 上），再走 PG 版重開
  await query("UPDATE demand_posts SET status = 'closed', lifecycle = 'paused', closed_at = $2 WHERE id = $1", [DRAFT_ID, OLD]);
  const reopened = await demandAsync.reopenWishRoomAsync(UID, DRAFT_ID, opts);
  assert.equal(reopened.status, "open");
  row = await rowOf(DRAFT_ID);
  assert.equal(row.status, "open", "重開必須在 PG 上真的生效");
  assert.equal(row.lifecycle, "active", "重開要把 lifecycle 寫回 active");
  assert.equal(row.closed_at, null, "重開必須清掉 closed_at");

  // 5) 範例：第一次 INSERT、第二次 UPDATE，兩次都要在 PG 上真的落地
  const firstExample = await wishExampleAsync.saveWishExampleAsync(UID, { districts: ["1-5"], rent_max: 20000, body: "live 範例一" }, opts);
  const afterFirst = (await query("SELECT created_at FROM wish_room_example WHERE user_id = $1", [UID]))[0];
  const secondExample = await wishExampleAsync.saveWishExampleAsync(UID, { districts: ["1-7"], rent_max: 26000, body: "live 範例二" }, opts);
  const stored = (await query("SELECT payload, created_at, updated_at FROM wish_room_example WHERE user_id = $1", [UID]))[0];
  assert.ok(stored, "範例必須真的寫進 PG 的 wish_room_example");
  assert.match(stored.payload, /live 範例二/, "第二次必須覆蓋第一次");
  assert.equal(stored.created_at, afterFirst.created_at, "第二次（UPDATE）不得改寫 created_at");
  assert.equal(firstExample.body, "live 範例一");
  assert.equal(secondExample.body, "live 範例二");
  assert.equal(
    (await query("SELECT COUNT(*)::int AS n FROM wish_room_example WHERE user_id = $1", [UID]))[0].n, 1,
    "一人只能有一列（先查再寫不得寫出第二列）",
  );

  await cleanup();
  await pgDriver.close();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 檔案被鎖住就算了 */ }
});
