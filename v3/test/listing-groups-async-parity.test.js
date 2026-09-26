// 同物件群組寫入的 driver parity（2026-09-26 上線收尾）。
//
// 背景：站上的同屋顯示讀 PG 的 `listing_group_members`（repository/decorationData.js 的
// loadGroupIds／loadGroupMemberRows），但寫入原本只到本機 SQLite——讀 PG、寫 SQLite 的結果是
// 新配對在站上永遠看不到，兩台節點也各自累積不同的群組。
//
// 這裡釘住 listingGroupsAsync.js 的 PG 分支與 listingGroups.js 的同步版本在**同一份資料**上
// 產生**完全相同**的列。離線用 SQLite fixture 當 PG 替身（PG 真實執行時 SQL 文字由
// sqlDialect.translateSqliteToPg 轉換，語意相同）；注入式 exec 收到的是 `?` 風格語句。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CONFIRM_ADMIN,
  CONFIRM_AUTO,
  bindListingsToGroup as bindSync,
  ensureListingGroupSchema,
  recordMatchEvaluation as recordSync,
  unbindListingFromGroup as unbindSync,
} from "../src/listingGroups.js";
import {
  bindListingsToGroup,
  recordMatchEvaluation,
  unbindListingFromGroup,
} from "../src/listingGroupsAsync.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-group-parity-"));
process.env.DATA_DIR = dataDir;
after(() => {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows keeps the file locked
  }
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE listings (post_id INTEGER PRIMARY KEY, address TEXT, source TEXT, area_name TEXT,
      floor_name TEXT, layout TEXT, price REAL, last_seen_at TEXT, offline INTEGER DEFAULT 0,
      match_post_id INTEGER, match_level TEXT, match_detail TEXT, match_rejected INTEGER DEFAULT 0);
    CREATE TABLE user_listing_flags (user_id INTEGER NOT NULL, post_id INTEGER NOT NULL,
      watched INTEGER NOT NULL DEFAULT 0, watch_group_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (user_id, post_id));
    CREATE TABLE user_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, post_id INTEGER,
      group_id TEXT NOT NULL DEFAULT '');
  `);
  ensureListingGroupSchema(db);
  const insert = db.prepare(
    "INSERT INTO listings(post_id, address, source, area_name, floor_name, layout, price, last_seen_at, offline) VALUES (?,?,?,?,?,?,?,?,0)",
  );
  for (const id of [101, 102, 103, 104]) {
    insert.run(id, `台北市士林區測試路${id}號`, "591", "25.5", "3", "3房2廳", 30000, "2026-09-26T00:00:00.000Z");
  }
  return db;
}

// 注入式 exec：SELECT 回列、寫入回空陣列（與 pgSharedDriver／scheduleTransaction 同一形狀）。
function sqliteExec(db) {
  return async (sql, params = []) => {
    const text = String(sql);
    const stmt = db.prepare(text);
    if (/^\s*select/i.test(text)) return stmt.all(...params);
    stmt.run(...params);
    return [];
  };
}

function snapshot(db) {
  const groups = db.prepare(
    "SELECT group_id, primary_post_id, confirmation_level, confirmed_by, confirmed_at FROM listing_groups ORDER BY group_id",
  ).all();
  const members = db.prepare(
    "SELECT post_id, group_id, source, match_confidence, match_evidence, joined_at FROM listing_group_members ORDER BY post_id",
  ).all();
  const evals = db.prepare(
    "SELECT post_id, candidate_post_id, candidate_source, confidence, level, signals, veto_reasons, matcher_version, evaluated_at FROM listing_match_evaluations ORDER BY post_id, candidate_post_id",
  ).all();
  const audits = db.prepare(
    "SELECT action, admin_user_id, post_ids, previous_group_ids, resulting_group_id FROM listing_group_audits ORDER BY id",
  ).all();
  const flags = db.prepare("SELECT user_id, post_id, watched, watch_group_id FROM user_listing_flags ORDER BY user_id, post_id").all();
  const events = db.prepare("SELECT user_id, post_id, group_id FROM user_events ORDER BY id").all();
  return { groups, members, evals, audits, flags, events };
}

const PAIR = (ids, extra = {}) => ids.map((post_id, i) => ({
  post_id, source: "591", match_level: i ? "high" : "medium", ...extra,
}));

const NOW = new Date("2026-09-26T00:00:00.000Z");
const EVAL = (incoming, candidate) => ({
  incoming_post_id: incoming,
  candidate_post_id: candidate,
  candidate_source: "591",
  confidence: 0.91,
  level: "high",
  signals: ["street", "community"],
  veto_reasons: [],
  matcher_version: "same-house-v3",
  evaluated_at: "2026-09-26T00:00:01.000Z",
});

// 同一組操作分別跑同步（SQLite）與 async（PG 分支），回傳兩個 snapshot 供比對。
// `run` 會拿到原始 fixture handle，方便在流程中途植入關注／事件列（兩個 fixture 都說 SQLite）。
async function bothWays(run) {
  const sqliteDb = fixture();
  const pgDb = fixture();
  const syncOut = await run({
    db: sqliteDb,
    bind: (listings, opts) => bindSync(sqliteDb, listings, opts),
    eval: (evaluation) => recordSync(sqliteDb, evaluation),
    unbind: (postId, opts) => unbindSync(sqliteDb, postId, opts),
  });
  const asyncOut = await run({
    db: pgDb,
    bind: (listings, opts) => bindListingsToGroup(sqliteExec(pgDb), listings, opts),
    eval: (evaluation) => recordMatchEvaluation(sqliteExec(pgDb), evaluation),
    unbind: (postId, opts) => unbindListingFromGroup(sqliteExec(pgDb), postId, opts),
  });
  return { sync: snapshot(sqliteDb), async: snapshot(pgDb), syncOut, asyncOut };
}

test("新配對：同步與 PG 分支建立相同群組、成員與 primary", async () => {
  const { sync, async: pg, syncOut, asyncOut } = await bothWays(async (api) => {
    const gid = await api.bind(PAIR([101, 102]), { evidence: { detail: "同地址" }, confidence: 0.9, now: NOW });
    await api.eval(EVAL(101, 102));
    return gid;
  });
  assert.ok(syncOut, "同步分支要回傳 group id");
  assert.equal(asyncOut, syncOut, "PG 分支必須算出同一個 group id");
  assert.deepEqual(pg.groups, sync.groups);
  assert.deepEqual(pg.members, sync.members);
  assert.deepEqual(pg.evals, sync.evals);
  assert.equal(pg.members.length, 2);
  assert.ok(pg.groups[0].primary_post_id, "primary 必須被設定");
});

test("合併兩個既有群組：同步與 PG 分支的成員搬移、loser 刪除與 primary 相同", async () => {
  const { sync, async: pg } = await bothWays(async (api) => {
    await api.bind(PAIR([101, 102]), { now: NOW });
    await api.bind(PAIR([103, 104]), { now: NOW });
    await api.bind(PAIR([102, 103]), { now: NOW });
  });
  assert.deepEqual(pg.groups, sync.groups);
  assert.deepEqual(pg.members, sync.members);
  assert.equal(pg.groups.length, 1, "合併後只留一個群組");
  assert.equal(pg.members.length, 4, "四個成員都要在 canonical 群組");
  assert.equal(pg.members.filter((m) => m.group_id !== pg.groups[0].group_id).length, 0);
});

test("合併時關注與事件綁定要一起搬到 canonical id（兩分支相同）", async () => {
  const { sync, async: pg } = await bothWays(async (api) => {
    const first = await api.bind(PAIR([101, 102]), { now: NOW });
    const second = await api.bind(PAIR([103, 104]), { now: NOW });
    // 把關注與事件綁在「即將被合併掉的」那個群組上，才驗得到搬移。
    api.db.prepare("INSERT INTO user_listing_flags(user_id, post_id, watched, watch_group_id) VALUES (?,?,?,?)")
      .run(5, 103, 1, second);
    api.db.prepare("INSERT INTO user_listing_flags(user_id, post_id, watched, watch_group_id) VALUES (?,?,?,?)")
      .run(5, 104, 0, second);
    api.db.prepare("INSERT INTO user_events(user_id, post_id, group_id) VALUES (?,?,?)").run(5, 103, second);
    const merged = await api.bind(PAIR([102, 103]), { now: NOW });
    return { first, second, merged };
  });
  assert.deepEqual(pg.flags, sync.flags);
  assert.deepEqual(pg.events, sync.events);
  // 已關注的那一列要搬到 canonical；未關注（watched=0）的留在原處。
  const watched = pg.flags.find((f) => f.user_id === 5 && f.post_id === 103);
  const unwatched = pg.flags.find((f) => f.user_id === 5 && f.post_id === 104);
  assert.equal(watched.watch_group_id, pg.groups[0].group_id, "已關注列要搬到 canonical 群組");
  assert.notEqual(unwatched.watch_group_id, pg.groups[0].group_id, "未關注列的 watch_group_id 不搬");
  assert.equal(pg.events[0].group_id, pg.groups[0].group_id, "事件要歸到 canonical 群組");
});

test("重複綁同一組：不會產生重複成員或第二個群組（兩分支相同）", async () => {
  const { sync, async: pg } = await bothWays(async (api) => {
    await api.bind(PAIR([101, 102]), { now: NOW });
    await api.bind(PAIR([101, 102]), { now: NOW });
    await api.bind(PAIR([102, 101]), { now: NOW });
  });
  assert.deepEqual(pg.groups, sync.groups);
  assert.deepEqual(pg.members, sync.members);
  assert.equal(pg.groups.length, 1);
  assert.equal(pg.members.length, 2);
});

test("管理員已確認的群組：非 admin 綁定不得降級（兩分支相同）", async () => {
  const { sync, async: pg } = await bothWays(async (api) => {
    await api.bind(PAIR([101, 102]), { now: NOW, confirmationLevel: CONFIRM_ADMIN, adminUserId: 7 });
    await api.bind(PAIR([102, 103]), { now: NOW, confirmationLevel: CONFIRM_AUTO });
  });
  assert.deepEqual(pg.groups, sync.groups);
  assert.deepEqual(pg.members, sync.members);
  assert.equal(pg.groups[0].confirmation_level, CONFIRM_ADMIN, "admin 確認不能被自動配對降級");
  assert.equal(pg.members.find((m) => m.post_id === 103).group_id, pg.groups[0].group_id);
});

test("解除綁定：成員少於二時刪群組，兩分支結果相同", async () => {
  const { sync, async: pg } = await bothWays(async (api) => {
    await api.bind(PAIR([101, 102]), { now: NOW });
    await api.unbind(101, { now: NOW });
  });
  assert.deepEqual(pg.groups, sync.groups);
  assert.deepEqual(pg.members, sync.members);
  assert.equal(pg.groups.length, 0, "只剩一個成員時群組要刪掉");
  assert.equal(pg.members.length, 0);
});

test("三個成員解除一個：群組保留、primary 重算（兩分支相同）", async () => {
  const { sync, async: pg } = await bothWays(async (api) => {
    await api.bind(PAIR([101, 102, 103]), { now: NOW });
    await api.unbind(101, { now: NOW });
  });
  assert.deepEqual(pg.groups, sync.groups);
  assert.deepEqual(pg.members, sync.members);
  assert.equal(pg.groups.length, 1, "還有兩個成員，群組要留著");
  assert.equal(pg.members.length, 2);
});
