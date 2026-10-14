import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  MEMBER_MAX_WATCHED,
  SPONSOR_MAX_WATCHED,
  canAddWatch,
  countWatched,
  watchGateVerdict,
  watchLimitForActor,
  watchLimitMessage,
} from "../src/watchLimits.js";
import { setUserListingFlags } from "../src/personalFlags.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

// 隔離子程序在 CI（Gitea runner：CPU 較慢且 node --test 會並行多個檔案）上可能遠超過 30s；
// 這是環境時序而非程式錯誤，因此只保留防卡死的寬鬆上限，可用 V3_ISOLATED_TEST_TIMEOUT_MS 覆寫。
const ISOLATED_TIMEOUT_MS = Math.max(30_000, Number(process.env.V3_ISOLATED_TEST_TIMEOUT_MS) || 180_000);

// 夾具同時要有 `listings`：新的使用量口徑要 JOIN 它讀 `fold_component_root`
// （Owner 2026-10-14「疑似同屋源整群算 1 次」）。真實 SQLite 沒有這一欄，
// 所以夾具自己建（測試自己的 schema，不是產品 DDL）。
function mem() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE user_listing_flags (
      user_id INTEGER NOT NULL,
      post_id INTEGER NOT NULL,
      viewed INTEGER NOT NULL DEFAULT 0,
      watched INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      watch_note TEXT NOT NULL DEFAULT '',
      viewed_at TEXT,
      watched_at TEXT,
      hidden_at TEXT,
      PRIMARY KEY (user_id, post_id)
    )
  `);
  db.exec(`
    CREATE TABLE listings (
      post_id INTEGER PRIMARY KEY,
      offline_confirmed INTEGER NOT NULL DEFAULT 0,
      fold_component_root INTEGER
    )
  `);
  return db;
}

// `root` 省略（或 null）＝孤列／沒有折疊資料 ⇒ 自己一群（用 post_id 當鍵）。
function addListing(db, postId, { offlineConfirmed = 0, root = null } = {}) {
  db.prepare("INSERT INTO listings(post_id, offline_confirmed, fold_component_root) VALUES (?,?,?)")
    .run(postId, offlineConfirmed, root);
}

function watch(db, uid, postId) {
  setUserListingFlags(db, uid, postId, { watched: true });
}

test("watch limits are 6 for members, 15 for sponsors, unlimited for admin", () => {
  assert.equal(watchLimitForActor({ role: "member", plan: "free" }), MEMBER_MAX_WATCHED);
  assert.equal(watchLimitForActor({ role: "member", plan: "sponsor" }), SPONSOR_MAX_WATCHED);
  assert.equal(watchLimitForActor({ role: "admin", plan: "free" }), 0);
  assert.match(watchLimitMessage(MEMBER_MAX_WATCHED), /一般會員最多特別關注 6 筆/);
  assert.doesNotMatch(watchLimitMessage(MEMBER_MAX_WATCHED), /管理員/);
  assert.doesNotMatch(watchLimitMessage(SPONSOR_MAX_WATCHED), /管理員/);
});

test("stats counts personal watches even when listings are pending offline", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-watch-stats-"));
  const script = `
    import assert from "node:assert/strict";
    import { db, defaultUserId, setFlags, stats, upsertListing } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/db.js")).href)};
    import { countWatched } from ${JSON.stringify(pathToFileURL(path.join(dir, "../src/watchLimits.js")).href)};
    const stamp = "2026-09-01T00:00:00.000Z";
    function seed(post_id) {
      upsertListing({
        post_id, source: "591", source_key: "1|8|" + post_id, search_key: "https://example.test",
        title: "關注 " + post_id, url: "https://example.test/" + post_id,
        price: "20000元", price_num: 20000, extra_fees: [],
        address: "台北市士林區測試路" + post_id + "號",
        area_name: "20坪", layout: "2房1廳", floor_name: "5/12",
        kind_name: "整層住家", role_name: "", cover: "", tags: "[]",
        refresh_time: stamp, first_seen_at: stamp, last_seen_at: stamp, last_event: "new",
      });
    }
    seed(701);
    seed(702);
    seed(703);
    const uid = defaultUserId();
    setFlags(701, { watched: true }, uid);
    setFlags(702, { watched: true }, uid);
    setFlags(703, { watched: true }, uid);
    db.prepare("UPDATE listings SET offline = 1, offline_confirmed = 0 WHERE post_id = 702").run();
    db.prepare("UPDATE listings SET offline = 1, offline_confirmed = 1 WHERE post_id = 703").run();
    const st = stats([], uid);
    assert.equal(countWatched(db, uid), 2, 'confirmed offline no longer occupies the quota');
    assert.equal(st.watchedTotal, 2);
    assert.equal(st.watched, 2, 'pending offline stays in watched; confirmed offline does not');
    db.prepare('DELETE FROM listings WHERE post_id = 701').run();
    assert.equal(countWatched(db, uid), 1, 'orphan watch flags do not occupy quota');
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      timeout: ISOLATED_TIMEOUT_MS,
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("member cannot add a 7th watch", () => {
  const db = mem();
  for (let i = 1; i <= 6; i += 1) {
    watch(db, 1, i);
    addListing(db, i, { root: 9000 + i }); // 六筆各自不同群 ⇒ 六格
  }
  assert.equal(countWatched(db, 1), 6);
  const gate = canAddWatch(db, 1, { role: "member", plan: "free" });
  assert.equal(gate.ok, false);
  assert.match(gate.error, /6 筆/);
  assert.equal(canAddWatch(db, 1, { role: "member", plan: "sponsor" }).ok, true);
  assert.equal(canAddWatch(db, 1, { role: "admin" }).ok, true);
  assert.equal(canAddWatch(db, 1, { role: "member", plan: "free" }, { alreadyWatched: true }).ok, true);
});

// ── Owner 2026-10-14：疑似同屋源的物件群，整群算 1 次 ────────────────────────────
// 分組鍵＝`listings.fold_component_root`（NULL ⇒ 自己一群，用 post_id 當鍵）。
test("watched 使用量：同群 2 筆算 1、不同群各算 1", () => {
  const db = mem();
  // 同屋源 2 筆（同一 root）⇒ 1
  watch(db, 11, 201); watch(db, 11, 202);
  addListing(db, 201, { root: 77001 });
  addListing(db, 202, { root: 77001 });
  assert.equal(countWatched(db, 11), 1, "同屋源 2 筆要算 1 次");
  // 不同屋源 2 筆（兩個 root）⇒ 2
  watch(db, 12, 203); watch(db, 12, 204);
  addListing(db, 203, { root: 77002 });
  addListing(db, 204, { root: 77003 });
  assert.equal(countWatched(db, 12), 2, "不同屋源 2 筆要算 2 次");
  // 群 ＋ 無關 ⇒ 2
  watch(db, 13, 205); watch(db, 13, 206); watch(db, 13, 207);
  addListing(db, 205, { root: 77004 });
  addListing(db, 206, { root: 77004 });
  addListing(db, 207, { root: 77005 });
  assert.equal(countWatched(db, 13), 2, "一群（2 筆）＋ 一筆無關＝2");
});

test("watched 使用量：確認下架不計、孤兒旗標不計", () => {
  const db = mem();
  watch(db, 21, 301); watch(db, 21, 302);
  addListing(db, 301, { root: 78001 });
  addListing(db, 302, { root: 78002, offlineConfirmed: 1 });
  assert.equal(countWatched(db, 21), 1, "確認下架的那一筆不佔配額（即使它自成一群）");
  watch(db, 22, 303); watch(db, 22, 304);
  addListing(db, 304, { root: 78003 }); // 303 沒有 listings 列＝孤兒旗標
  assert.equal(countWatched(db, 22), 1, "孤兒旗標不佔配額");
  // 確認下架 ＋ 同群仍算 1（兩筆同群、其中一筆確認下架 ⇒ 剩下那一筆代表這個群）
  watch(db, 23, 305); watch(db, 23, 306);
  addListing(db, 305, { root: 78004 });
  addListing(db, 306, { root: 78004, offlineConfirmed: 1 });
  assert.equal(countWatched(db, 23), 1);
});

test("canAddWatch 邊界：滿 6 群時，加同群成員 ok、加新群擋", () => {
  const db = mem();
  for (let i = 0; i < 6; i += 1) {
    const postId = 401 + i;
    watch(db, 31, postId);
    addListing(db, postId, { root: 79000 + i }); // 六個不同的群
  }
  assert.equal(countWatched(db, 31), 6);
  // 新群（root 79999）⇒ 擋
  addListing(db, 500, { root: 79999 });
  const blocked = canAddWatch(db, 31, { role: "member", plan: "free" }, { postId: 500 });
  assert.equal(blocked.ok, false, "滿 6 群再加新群要被擋");
  assert.match(blocked.error, /6 筆/);
  assert.equal(blocked.count, 6);
  // 同群成員（root 79000，與 401 同群）⇒ ok，而且不增量
  addListing(db, 501, { root: 79000 });
  const allowed = canAddWatch(db, 31, { role: "member", plan: "free" }, { postId: 501 });
  assert.equal(allowed.ok, true, "同群成員不增量，即使已滿 6 群");
  assert.equal(allowed.count, 6, "群數不變");
  // 加入之後仍然是 6 格
  watch(db, 31, 501);
  assert.equal(countWatched(db, 31), 6, "同群第二筆不會把使用量推到 7");
  // 沒有 fold 資料（root NULL）的新列⇒ 自己一群 ⇒ 擋
  addListing(db, 502, { root: null });
  assert.equal(canAddWatch(db, 31, { role: "member", plan: "free" }, { postId: 502 }).ok, false);
});

test("watchGateVerdict 是 SQLite／PG 兩版唯一的一份規則（原始碼守門）", () => {
  // 規則本體只有一份：`watchLimits.js` 的 watchGateVerdict。PG 版（personalFlagsAsync.js）
  // 必須進口它與共用 SQL 常數，不得自己再抄一份規則或 SQL。
  assert.equal(watchGateVerdict({ limit: 6, count: 6, groupHit: true }).ok, true);
  assert.equal(watchGateVerdict({ limit: 6, count: 6, groupHit: false }).ok, false);
  assert.equal(watchGateVerdict({ limit: 0, count: 99 }).ok, true);
  assert.equal(watchGateVerdict({ limit: 6, count: 99, alreadyWatched: true }).ok, true);
  const source = readFileSync(path.join(dir, "../src/personalFlagsAsync.js"), "utf8");
  assert.match(source, /from "\.\/watchLimits\.js"/);
  assert.match(source, /WATCHED_COUNT_SQL/);
  assert.match(source, /WATCHED_GROUP_HIT_SQL/);
  assert.match(source, /watchGateVerdict/);
  assert.doesNotMatch(source, /COUNT_WATCHED_SQL/, "不得自己抄一份 count SQL");
  assert.doesNotMatch(source, /if \(count >= limit\)/, "不得自己抄一份規則");
});
