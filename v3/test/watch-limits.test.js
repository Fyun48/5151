import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
  watchLimitForActor,
  watchLimitMessage,
} from "../src/watchLimits.js";
import { setUserListingFlags } from "../src/personalFlags.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

// 隔離子程序在 CI（Gitea runner：CPU 較慢且 node --test 會並行多個檔案）上可能遠超過 30s；
// 這是環境時序而非程式錯誤，因此只保留防卡死的寬鬆上限，可用 V3_ISOLATED_TEST_TIMEOUT_MS 覆寫。
const ISOLATED_TIMEOUT_MS = Math.max(30_000, Number(process.env.V3_ISOLATED_TEST_TIMEOUT_MS) || 180_000);

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
  return db;
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
  for (let i = 1; i <= 6; i += 1) setUserListingFlags(db, 1, i, { watched: true });
  assert.equal(countWatched(db, 1), 6);
  const gate = canAddWatch(db, 1, { role: "member", plan: "free" });
  assert.equal(gate.ok, false);
  assert.match(gate.error, /6 筆/);
  assert.equal(canAddWatch(db, 1, { role: "member", plan: "sponsor" }).ok, true);
  assert.equal(canAddWatch(db, 1, { role: "admin" }).ok, true);
  assert.equal(canAddWatch(db, 1, { role: "member", plan: "free" }, { alreadyWatched: true }).ok, true);
});
