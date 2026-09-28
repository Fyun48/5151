// `/api/listings/:id/reject-match` 的 PG 分支 parity（2026-09-27）。
//
// 為什麼這條路徑值得一個專屬測試：`rejectSuspectedMatch()` 寫的 user_match_votes／
// user_match_signals 是**全站**拆開判定的來源（`shouldPromoteGlobalSplit()` 數到門檻就把
// match_verdict 改成 'no'、match_rejected=1、hidden=0）。先前只有節點本機 SQLite 在寫，
// 而公開站經 HAProxy 在兩個節點之間輪流——同一個會員的兩次拆開可能落在不同節點，
// 票數永遠湊不到門檻。這是活的正确性問題。
//
// 測試形狀照抄 `user-same-house-async.test.js`／`admin-same-house-async.test.js`：
//   - 夾具的表結構**從真實 SQLite 複製 sqlite_master 的 DDL**，不手寫（手寫一定漏欄位）
//   - 夾具**主動拒絕** PostgreSQL 會拋錯的 SQLite 專屬語法（見 PG_ILLEGAL）
//   - 比對**兩邊實際落地的位元組**，不是只比回傳值
//   - 時間用 node:test 的 mock timers 凍結，否則 created_at 兩邊必然不同，位元組比對會假失敗
//
// 已用變異測試確認非空（每一項都對應一次「把修正拿掉」的失敗，見檔尾 §變異測試紀錄）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-rejectmatch-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const db = await import("../src/db.js");
const { rejectSuspectedMatch } = db;
const { rejectSuspectedMatchAsync } = await import("../src/sameHouseAsync.js");

const PG = { driver: "postgres" };
const NOW_MS = Date.UTC(2026, 8, 27, 4, 0, 0); // 2026-09-27T04:00:00Z
const NOW_ISO = new Date(NOW_MS).toISOString();
const diskPath = () => path.join(dataDir, "v3.db");

// 這幾類文字送到真 PG 會直接拋錯（已對 5151 的 PG 實測；見 HANDOFF 的方言陷阱表）。
// 夾具主動拒絕，才測得出「不小心把 SQLite 方言搬到 PG」。
// 注意 MIN 只抓**兩個引數**的純量形式：`MIN(system_agrees)` 是合法的聚合，不該被拒絕。
const PG_ILLEGAL = [
  [/MIN\s*\(\s*[^()]*,[^()]*\)/i, "function min(integer, integer) does not exist"],
  [/LIMIT\s+-1\b/i, "LIMIT must not be negative"],
  [/\bIFNULL\s*\(/i, "function ifnull(text, unknown) does not exist"],
  [/\bGROUP_CONCAT\s*\(/i, "function group_concat(text) does not exist"],
  [/\binstr\s*\(/i, "function instr(text, text) does not exist"],
  [/datetime\s*\(\s*'now'/i, "function datetime(unknown) does not exist"],
];

const TABLES = [
  "users", "listings", "user_match_votes", "user_match_signals", "user_events",
  "user_same_house_members", "listing_groups", "listing_group_members", "listing_group_audits",
];

// 表結構直接從真實 SQLite 複製 sqlite_master 的 DDL，不要手寫。
function pgFixture() {
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(diskPath(), { readOnly: true });
  const rows = disk.prepare(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name IN (${TABLES.map(() => "?").join(",")})`,
  ).all(...TABLES);
  disk.close();
  for (const row of rows) if (row.sql) mem.exec(row.sql);
  // ⚠️ 刻意**不**開 `PRAGMA foreign_keys`：已對 5151 的 PG 查 information_schema，
  // user_match_votes／user_match_signals／user_same_house_members 上**一個 FK 都沒有**。
  // 夾具若比本尊嚴格，會製造假的失敗（與「夾具比本尊寬鬆」是同一類錯誤，方向相反）。
  // 注意磁碟那側不一樣：db.js:503 有 `PRAGMA foreign_keys = ON`，所以同步版**會**擋 FK，
  // 那是真實存在的兩邊差異，不是測試的疏漏——種資料時要讓 user 真的存在。
  const exec = async (sql, params = []) => {
    for (const [pattern, message] of PG_ILLEGAL) {
      if (pattern.test(sql)) throw new Error(message);
    }
    return mem.prepare(sql).all(...params);
  };
  exec.raw = mem;
  return exec;
}

// listings 有很多 NOT NULL 欄位，用動態補齊的方式種資料（照抄 admin-same-house-async.test.js）。
function seedListing(handle, postId, extra = {}) {
  const info = handle.prepare("PRAGMA table_info(listings)").all();
  const provided = {
    post_id: postId, source: "591", source_key: `591_${postId}`, title: `t${postId}`, ...extra,
  };
  const required = info.filter((c) => c.notnull === 1 && c.dflt_value === null && c.pk === 0);
  const names = info.map((c) => c.name).filter((n) => n in provided || required.some((c) => c.name === n));
  handle.prepare(`INSERT INTO listings(${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
    .run(...names.map((n) => {
      if (n in provided) return provided[n];
      const col = info.find((c) => c.name === n);
      return /INT|REAL|NUM/i.test(col.type) ? 0 : "";
    }));
}

// 磁碟上的 v3.db 在同一個測試檔的多個 test 之間是共用的，users 不像其他表會被 clearAll 清掉
// （db.js 啟動時自己也種了預設管理員，不能整表刪）。所以這裡用 OR IGNORE 讓重複種植變成冪等。
const seedUser = (h, id) =>
  h.prepare("INSERT OR IGNORE INTO users(id,email,created_at) VALUES (?,?,?)")
    .run(id, `u${id}@example.com`, NOW_ISO);

const seedVote = (h, uid, lo, hi, vote = "split", at = NOW_ISO) =>
  h.prepare(`INSERT INTO user_match_votes(user_id,post_id,peer_id,vote,confidence,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?)`).run(uid, lo, hi, vote, "high", at, at);

const seedMember = (h, uid, key, postId, agrees = 1) =>
  h.prepare(`INSERT INTO user_same_house_members(user_id,group_key,post_id,system_agrees,created_at)
             VALUES (?,?,?,?,?)`).run(uid, key, postId, agrees, NOW_ISO);

// 兩邊的「實際落地位元組」。刻意含 id 欄：兩邊都從乾淨的資料庫出發，id 必須一致，
// 不一致就代表某一邊少插或多插了資料列。
const SNAPSHOT = {
  votes: (h) => h.prepare(`SELECT user_id,post_id,peer_id,vote,confidence,created_at,updated_at
                           FROM user_match_votes ORDER BY user_id,post_id,peer_id`).all(),
  signals: (h) => h.prepare(`SELECT id,user_id,post_id,peer_id,type,weight,created_at
                             FROM user_match_signals ORDER BY id`).all(),
  events: (h) => h.prepare(`SELECT id,user_id,post_id,type,title,detail,source_key,created_at,notified
                            FROM user_events ORDER BY id`).all(),
  listings: (h) => h.prepare(`SELECT post_id,match_verdict,match_rejected,hidden,match_post_id
                              FROM listings ORDER BY post_id`).all(),
  members: (h) => h.prepare(`SELECT user_id,group_key,post_id,system_agrees,created_at
                             FROM user_same_house_members ORDER BY user_id,post_id`).all(),
};

function clearAll(h) {
  for (const t of ["user_events", "user_match_signals", "user_match_votes",
    "user_same_house_members", "listing_group_audits", "listing_group_members", "listing_groups", "listings"]) {
    h.prepare(`DELETE FROM ${t}`).run();
  }
  // 磁碟上的 v3.db 在同檔的多個 test 之間共用，DELETE 不會重置 AUTOINCREMENT 的計數器；
  // 記憶體夾具每次都是全新的。若不歸零，第二個 test 起 id 就會兩邊不同（污染型假失敗）。
  try {
    h.prepare(`DELETE FROM sqlite_sequence WHERE name IN
      ('user_events','user_match_signals','listing_group_audits','listings')`).run();
  } catch { /* 沒有 AUTOINCREMENT 表時 sqlite_sequence 不存在 */ }
}

function openDisk() {
  const disk = new DatabaseSync(diskPath());
  clearAll(disk);
  return disk;
}

// 兩邊都放同一組底料，回傳 [disk, exec]。
function resetBoth({ hidden = 0, verdict = "", level = "high" } = {}) {
  const disk = openDisk();
  const exec = pgFixture();
  clearAll(exec.raw);
  for (const h of [disk, exec.raw]) {
    for (const id of [7, 8, 9, 10]) seedUser(h, id);
    seedListing(h, 1, { match_post_id: 2, match_level: level, match_verdict: verdict, hidden });
    seedListing(h, 2, { match_post_id: 1, match_level: level, match_verdict: verdict, hidden });
    seedListing(h, 3, { match_post_id: null, match_level: "low" });
  }
  return [disk, exec];
}

// getListingAsync 需要完整的裝飾鏈（settings／crawl_covers／route_cache…），輕量夾具給不起。
// 它是在所有寫入**之後**才呼叫，所以落地位元組的比對不受影響；但失敗必須**看得見**，
// 不能靜默通過（沿用 admin-same-house-async.test.js 的處理方式）。
async function runAsync(fn) {
  try { return { out: await fn() }; }
  catch (error) { return { error }; }
}

function assertDecorFailureVisible(error) {
  assert.ok(error, "預期 getListingAsync 在輕量夾具中失敗，但沒有失敗——請確認測試資料真的走到回傳路徑");
  assert.match(error.message, /listing|decorat|provider|not a function|no such table/i,
    `PG 分支非預期錯誤：${error.message}`);
}

// 回傳值的比對：listing 由 getListingAsync 裝飾（夾具可能給不起），其餘欄位一律要比。
function assertResultParity(asyncOut, syncOut, error) {
  if (error) { assertDecorFailureVisible(error); return; }
  for (const key of ["ok", "personal", "promoted", "remaining", "already"]) {
    assert.deepEqual(asyncOut[key], syncOut[key], `回傳值 ${key} 必須與同步版相同`);
  }
}

// ---------------------------------------------------------------------------

test("首次拆開：落地位元組必須逐列相同（票、訊號、事件、listings）", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW_MS });
  const [disk, exec] = resetBoth();

  const syncOut = rejectSuspectedMatch(1, 7, { peerId: 2 });
  const { out: asyncOut, error } = await runAsync(
    () => rejectSuspectedMatchAsync(1, 7, { peerId: 2, ...PG, exec }),
  );

  // 先把「同步版真的做了事」釘住，否則底下的比對可能只是兩個空集合相等。
  assert.equal(syncOut.ok, true);
  assert.equal(SNAPSHOT.votes(disk).length, 1, "同步版應該投下一票，否則這個比對沒有意義");
  assert.equal(SNAPSHOT.signals(disk).length, 1, "同步版應該寫入一筆訊號");
  assert.equal(SNAPSHOT.events(disk).length, 1, "同步版應該寫入一筆 user_event");
  assert.deepEqual({ ...SNAPSHOT.votes(disk)[0] }, {
    user_id: 7, post_id: 1, peer_id: 2, vote: "split", confidence: "high",
    created_at: NOW_ISO, updated_at: NOW_ISO,
  });

  for (const key of Object.keys(SNAPSHOT)) {
    assert.deepEqual(SNAPSHOT[key](exec.raw), SNAPSHOT[key](disk), `落地的 ${key} 必須逐列相同`);
  }
  assertResultParity(asyncOut, syncOut, error);
  assert.equal(syncOut.promoted, false, "只有一票，不該升級成全站拆開");
  disk.close();
});

test("重複拆開（already）：不得再插一筆訊號，也不得改 updated_at", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW_MS });
  const [disk, exec] = resetBoth();
  // 從**非預設狀態**出發：兩人先前已經投過 split
  const EARLIER = new Date(NOW_MS - 86400000).toISOString();
  for (const h of [disk, exec.raw]) seedVote(h, 7, 1, 2, "split", EARLIER);

  const syncOut = rejectSuspectedMatch(1, 7, { peerId: 2 });
  const { out: asyncOut, error } = await runAsync(
    () => rejectSuspectedMatchAsync(1, 7, { peerId: 2, ...PG, exec }),
  );

  assert.equal(syncOut.already, true);
  assert.equal(SNAPSHOT.signals(disk).length, 0, "同步版重複拆開不該再寫訊號");
  assert.equal(SNAPSHOT.events(disk).length, 0, "同步版重複拆開不該再寫事件");
  assert.equal(SNAPSHOT.votes(disk)[0].updated_at, EARLIER, "同步版重複拆開不該動 updated_at");

  for (const key of Object.keys(SNAPSHOT)) {
    assert.deepEqual(SNAPSHOT[key](exec.raw), SNAPSHOT[key](disk), `落地的 ${key} 必須逐列相同`);
  }
  assertResultParity(asyncOut, syncOut, error);
  disk.close();
});

test("每日上限：第 9 次拆開必須回 rate_limit，且不得寫入任何東西", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW_MS });
  const [disk, exec] = resetBoth();
  // 今天已經用掉 8 次（上限），而且是在**別的配對**上——測的是 COUNT 的範圍，不只是同一對
  for (const h of [disk, exec.raw]) {
    for (let i = 0; i < 8; i += 1) seedVote(h, 7, 100 + i, 200 + i, "split");
  }

  const syncOut = rejectSuspectedMatch(1, 7, { peerId: 2 });
  const { out: asyncOut, error } = await runAsync(
    () => rejectSuspectedMatchAsync(1, 7, { peerId: 2, ...PG, exec }),
  );

  assert.equal(syncOut.code, "rate_limit");
  assert.deepEqual(asyncOut, syncOut, "rate_limit 的形狀必須逐欄相同（這一項在 getListingAsync 之前就回傳）");
  assert.equal(SNAPSHOT.votes(disk).length, 8, "同步版被擋下時不該再投票");
  assert.deepEqual(SNAPSHOT.votes(exec.raw), SNAPSHOT.votes(disk));
  assert.equal(error, undefined, "rate_limit 不該走到 getListingAsync");
  disk.close();
});

test("跨日不計入：昨天的 8 票不得讓今天被擋", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW_MS });
  const [disk, exec] = resetBoth();
  const YESTERDAY = new Date(NOW_MS - 86400000).toISOString();
  for (const h of [disk, exec.raw]) {
    for (let i = 0; i < 8; i += 1) seedVote(h, 7, 100 + i, 200 + i, "split", YESTERDAY);
  }

  const syncOut = rejectSuspectedMatch(1, 7, { peerId: 2 });
  const { out: asyncOut, error } = await runAsync(
    () => rejectSuspectedMatchAsync(1, 7, { peerId: 2, ...PG, exec }),
  );

  assert.equal(syncOut.ok, true, "昨天的票不該算進今天的額度");
  assert.equal(SNAPSHOT.votes(disk).length, 9, "同步版應該新增第 9 筆（8 筆昨天的 + 1 筆今天）");
  for (const key of ["votes", "signals", "events"]) {
    assert.deepEqual(SNAPSHOT[key](exec.raw), SNAPSHOT[key](disk), `${key} 必須逐列相同`);
  }
  assertResultParity(asyncOut, syncOut, error);
  disk.close();
});

test("升級全站拆開：高信心滿 3 票時，兩邊都要把 match_verdict 改成 no、並清掉 hidden", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW_MS });
  // 從非預設狀態出發：兩筆原本是隱藏的，才測得出 promote 會把 hidden 歸零
  const [disk, exec] = resetBoth({ hidden: 1 });
  for (const h of [disk, exec.raw]) {
    seedVote(h, 8, 1, 2, "split");
    seedVote(h, 9, 1, 2, "split");
  }

  const syncOut = rejectSuspectedMatch(1, 7, { peerId: 2 });
  const { out: asyncOut, error } = await runAsync(
    () => rejectSuspectedMatchAsync(1, 7, { peerId: 2, ...PG, exec }),
  );

  assert.equal(syncOut.promoted, true, "high 信心下 3 票應該升級（否則這一項測不到 promote）");
  const rows = SNAPSHOT.listings(disk).filter((r) => r.post_id === 1 || r.post_id === 2);
  assert.deepEqual(rows.map((r) => [r.match_verdict, r.match_rejected, r.hidden]),
    [["no", 1, 0], ["no", 1, 0]], "同步版應把兩筆改成 verdict=no、rejected=1、hidden=0");
  assert.deepEqual(SNAPSHOT.listings(exec.raw), SNAPSHOT.listings(disk), "listings 必須逐列相同");
  assertResultParity(asyncOut, syncOut, error);
  disk.close();
});

test("反對票不少於贊成票時不得升級（邊界：2 票反對 vs 2 票贊成）", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW_MS });
  const [disk, exec] = resetBoth({ verdict: "yes" });
  for (const h of [disk, exec.raw]) {
    seedVote(h, 8, 1, 2, "split");
    seedVote(h, 9, 1, 2, "keep");
    seedVote(h, 10, 1, 2, "same");
  }

  const syncOut = rejectSuspectedMatch(1, 7, { peerId: 2 });
  const { out: asyncOut, error } = await runAsync(
    () => rejectSuspectedMatchAsync(1, 7, { peerId: 2, ...PG, exec }),
  );

  // split=2（8 與 7）、same=max(keep 1, same 1)=1 → 1 < 2，且 'high' 需要 3 → 不升級
  assert.equal(syncOut.promoted, false, "高信心只滿 2 票不該升級");
  assert.deepEqual(SNAPSHOT.listings(disk).map((r) => r.match_verdict), ["yes", "yes", null],
    "同步版不該動 match_verdict（第 3 筆沒設 verdict，所以是 null 不是空字串）");
  assert.deepEqual(SNAPSHOT.listings(exec.raw), SNAPSHOT.listings(disk));
  assertResultParity(asyncOut, syncOut, error);
  disk.close();
});

test("個人同房源拆開：剩 1 人時整組刪除，落地結果必須相同", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW_MS });
  const [disk, exec] = resetBoth();
  // 使用者 7 的個人群組有 1、2、3；拆開 1 與 2 之後只剩 3 → 依同步版邏輯要把 3 也刪掉
  for (const h of [disk, exec.raw]) {
    seedMember(h, 7, "ush_keep", 1);
    seedMember(h, 7, "ush_keep", 2);
    seedMember(h, 7, "ush_keep", 3);
  }

  rejectSuspectedMatch(1, 7, { peerId: 2 });
  const { error } = await runAsync(() => rejectSuspectedMatchAsync(1, 7, { peerId: 2, ...PG, exec }));

  assert.deepEqual(SNAPSHOT.members(disk), [], "同步版應把整個個人群組清掉（剩 1 人要刪除）");
  assert.deepEqual(SNAPSHOT.members(exec.raw), SNAPSHOT.members(disk), "個人群組必須逐列相同");
  if (error) assertDecorFailureVisible(error);
  disk.close();
});

test("個人同房源拆開：剩 2 人以上時要重新分組（比對結構，不比隨機的 group_key）", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW_MS });
  const [disk, exec] = resetBoth();
  for (const h of [disk, exec.raw]) {
    for (const id of [1, 2, 3, 4]) seedMember(h, 7, "ush_keep", id);
  }

  rejectSuspectedMatch(1, 7, { peerId: 2 });
  const { error } = await runAsync(() => rejectSuspectedMatchAsync(1, 7, { peerId: 2, ...PG, exec }));

  // newGroupKey() 內含 Math.random()，兩邊一定不同；所以比「結構」不比字面值。
  const shape = (h) => SNAPSHOT.members(h).map((r) => r.post_id);
  for (const h of [disk, exec.raw]) {
    const rows = SNAPSHOT.members(h);
    assert.deepEqual(shape(h), [3, 4], "只剩 3 與 4 應留在同一個新群組");
    assert.equal(new Set(rows.map((r) => r.group_key)).size, 1, "3 與 4 必須共用同一個新 group_key");
    assert.notEqual(rows[0].group_key, "ush_keep", "必須換成新的 group_key，不能沿用舊的");
    assert.equal(rows[0].created_at, NOW_ISO, "重新分組要更新 created_at");
  }
  const pgKey = SNAPSHOT.members(exec.raw)[0].group_key;
  assert.match(pgKey, /^ush_/, "新 group_key 的形狀要與 newGroupKey() 一致");
  if (error) assertDecorFailureVisible(error);
  disk.close();
});

test("管理員拆開：只改 match_verdict／match_rejected，不得動 hidden", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW_MS });
  const [disk, exec] = resetBoth({ hidden: 1 });
  // 欄位名照 `sqlite_master` 的**真實** DDL（post_id／group_id／source／match_confidence／
  // match_evidence／joined_at）。第一版我憑印象寫成 confidence／evidence／created_at，
  // 就是交接文件列的「資料形狀猜錯」，當場被 SQLite 擋下來。
  for (const h of [disk, exec.raw]) {
    h.prepare(`INSERT INTO listing_groups(group_id,primary_post_id,created_at,updated_at,confirmation_level)
               VALUES (?,?,?,?,?)`).run("lg_admin", 1, NOW_ISO, NOW_ISO, "admin_confirmed");
    for (const id of [1, 2]) {
      h.prepare(`INSERT INTO listing_group_members(post_id,group_id,source,match_confidence,match_evidence,joined_at)
                 VALUES (?,?,?,?,?,?)`).run(id, "lg_admin", "591", 1, "{}", NOW_ISO);
    }
  }

  const syncOut = rejectSuspectedMatch(1, 7, { peerId: 2, admin: true });
  const { out: asyncOut, error } = await runAsync(
    () => rejectSuspectedMatchAsync(1, 7, { peerId: 2, admin: true, ...PG, exec }),
  );

  assert.equal(syncOut.ok, true);
  assert.equal(syncOut.personal, false, "管理員拆開走的是全站路徑");
  // 關鍵差異：管理員拆開**不**清 hidden（與 promote 路徑不同）
  assert.deepEqual(SNAPSHOT.listings(disk).filter((r) => r.post_id <= 2).map((r) => [r.match_verdict, r.match_rejected, r.hidden]),
    [["no", 1, 1], ["no", 1, 1]], "管理員拆開必須保留 hidden=1");
  assert.deepEqual(SNAPSHOT.listings(exec.raw), SNAPSHOT.listings(disk), "listings 必須逐列相同");
  for (const t2 of ["listing_group_members", "listing_group_audits", "listing_groups"]) {
    const dump = (h) => h.prepare(`SELECT * FROM ${t2} ORDER BY 1`).all();
    assert.deepEqual(dump(exec.raw), dump(disk), `${t2} 必須逐列相同`);
  }
  if (error) assertDecorFailureVisible(error);
  disk.close();
});

test("非 postgres 必須回退同步路徑，且不碰傳入的 exec", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW_MS });
  const [disk, exec] = resetBoth();

  const syncOut = rejectSuspectedMatch(1, 7, { peerId: 2 });
  const asyncOut = await rejectSuspectedMatchAsync(1, 7, { peerId: 2, driver: "sqlite", exec });

  assert.equal(syncOut.ok, true);
  assert.equal(asyncOut.listing?.post_id ?? 1, syncOut.listing?.post_id ?? 1);
  assert.equal(SNAPSHOT.votes(exec.raw).length, 0, "sqlite 模式不得寫入 PG 夾具");
  assert.equal(SNAPSHOT.votes(disk).length, 1);
  disk.close();
});

test("guest／找不到物件／找不到 peer 的錯誤形狀必須與同步版一致", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: NOW_MS });
  const [disk, exec] = resetBoth();
  const cases = [
    [1, 0, {}],                       // guest
    [999, 7, {}],                     // not_found
    [3, 7, {}],                       // 沒有 peer
  ];
  for (const [postId, uid, extra] of cases) {
    const syncOut = rejectSuspectedMatch(postId, uid, extra);
    const asyncOut = await rejectSuspectedMatchAsync(postId, uid, { ...extra, ...PG, exec });
    assert.deepEqual(asyncOut, syncOut, `post=${postId} uid=${uid} 的錯誤形狀必須相同`);
    assert.equal(asyncOut.ok, false);
  }
  assert.equal(SNAPSHOT.votes(exec.raw).length, 0, "錯誤路徑不得寫入任何東西");
  assert.deepEqual(SNAPSHOT.votes(exec.raw), SNAPSHOT.votes(disk));
  disk.close();
});

test("夾具本身要真的拒絕 SQLite 專屬語法（否則上面的方言守衛是空的）", async () => {
  const exec = pgFixture();
  // 先確立「SQLite 本尊會欣然接受」——這才是陷阱之所以是陷阱的原因。
  // 若哪天 SQLite 改成會拋錯，這一行會失敗，提醒我們重寫這一項。
  assert.doesNotThrow(() => exec.raw.prepare("SELECT MIN(1, 2) AS x").get(), "SQLite 的 MIN(a,b) 是純量函式，必須被接受");
  // 再確認**夾具**擋得住這幾類：真 PG 會拋錯，而 SQLite 不會
  await assert.rejects(() => exec("SELECT MIN(a, b) FROM listings"), /function min\(integer, integer\)/);
  await assert.rejects(() => exec("SELECT 1 LIMIT -1 OFFSET 0"), /LIMIT must not be negative/);
  await assert.rejects(() => exec("SELECT IFNULL(title,'') FROM listings"), /function ifnull/);
  await assert.rejects(() => exec("SELECT GROUP_CONCAT(title) FROM listings"), /function group_concat/);
  // 合法的聚合 MIN 不得被誤擋（夾具若過度嚴格，會製造假的失敗）
  await assert.doesNotReject(() => exec("SELECT MIN(post_id) AS x FROM listings"), "單引數的聚合 MIN 必須放行");
});
