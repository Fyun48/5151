// 配對寫入（setListingMatch）與同屋重評估（reconcileListingById）PG 分支的行為回歸。
//
// 為什麼要測：站上的同屋顯示讀 PG 的 `listing_group_members`，但配對結果原本只寫本機 SQLite，
// 所以新配對在站上永遠看不到。listingMatchAsync.js 讓 PG 分支把配對欄位、群組成員與評估列
// 都寫進 PG。這裡釘住「寫哪個 store」與「該跳過的情境真的跳過、且不留下評估列」。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONFIRM_ADMIN, CONFIRM_AUTO, ensureListingGroupSchema } from "../src/listingGroups.js";
import { reconcileListingById, setListingMatch } from "../src/listingMatchAsync.js";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-match-async-"));
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
    CREATE TABLE listings (post_id INTEGER PRIMARY KEY, address TEXT, community_name TEXT, source TEXT,
      area_name TEXT, floor_name TEXT, layout TEXT, price REAL, lat REAL, lng REAL,
      last_seen_at TEXT, offline INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0,
      match_post_id INTEGER, match_level TEXT, match_detail TEXT, match_rejected INTEGER DEFAULT 0);
  `);
  ensureListingGroupSchema(db);
  const insert = db.prepare(
    `INSERT INTO listings(post_id, address, community_name, source, area_name, floor_name, layout, price, lat, lng, last_seen_at, offline, match_level)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?)`,
  );
  insert.run(201, "台北市士林區測試路201號", "測試社區", "591", "25.5", "3", "3房2廳", 30000, 25.09, 121.52, "2026-09-26T00:00:00.000Z", null);
  insert.run(202, "台北市士林區測試路202號", "測試社區", "591", "25.5", "3", "3房2廳", 30500, 25.0901, 121.5201, "2026-09-26T00:00:00.000Z", null);
  return db;
}

function sqliteExec(db) {
  return async (sql, params = []) => {
    const text = String(sql);
    const stmt = db.prepare(text);
    if (/^\s*select/i.test(text)) return stmt.all(...params);
    stmt.run(...params);
    return [];
  };
}

test("setListingMatch PG 分支：配對欄位與群組成員都寫進 PG", async () => {
  const db = fixture();
  const exec = sqliteExec(db);

  await setListingMatch(exec, 201, { match_post_id: 202, match_level: "high", match_detail: "同地址" });

  const listing = db.prepare("SELECT match_post_id, match_level, match_detail, match_rejected FROM listings WHERE post_id = ?").get(201);
  assert.equal(listing.match_post_id, 202, "配對欄位要落在 PG 的 listings");
  assert.equal(listing.match_level, "high");
  assert.equal(listing.match_rejected, 0);

  const members = db.prepare("SELECT post_id, group_id FROM listing_group_members ORDER BY post_id").all();
  assert.equal(members.length, 2, "兩筆都要進 listing_group_members（站上讀的就是這張表）");
  assert.equal(members[0].group_id, members[1].group_id, "兩筆要綁在同一個 group");

  const group = db.prepare("SELECT group_id, primary_post_id, confirmation_level FROM listing_groups").get();
  assert.ok(group, "要建立 listing_groups 列");
  assert.equal(group.confirmation_level, CONFIRM_AUTO, "match_level=high 預設為 auto_confirmed");
  assert.ok(group.primary_post_id, "primary 必須被設定");
});

test("setListingMatch PG 分支：沒有 peer 時只更新欄位，不建立群組", async () => {
  const db = fixture();
  const exec = sqliteExec(db);
  await setListingMatch(exec, 201, { match_post_id: null, match_level: null, match_detail: "" });
  const members = db.prepare("SELECT COUNT(*) AS n FROM listing_group_members").get();
  assert.equal(Number(members.n), 0, "沒有配對對象時不該建立群組");
  const group = db.prepare("SELECT COUNT(*) AS n FROM listing_groups").get();
  assert.equal(Number(group.n), 0);
});

test("reconcileListingById PG 分支：找不到房源時回 missing，不寫任何評估", async () => {
  const db = fixture();
  const result = await reconcileListingById(sqliteExec(db), 999999, { reason: "test" });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "missing");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM listing_match_evaluations").get().n), 0);
});

test("reconcileListingById PG 分支：管理員已確認的群組不再自動重評估", async () => {
  const db = fixture();
  const exec = sqliteExec(db);
  db.prepare("INSERT INTO listing_groups(group_id, primary_post_id, created_at, updated_at, confirmation_level) VALUES (?,?,?,?,?)")
    .run("lg_admin", 201, "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", CONFIRM_ADMIN);
  db.prepare("INSERT INTO listing_group_members(post_id, group_id, source, match_confidence, match_evidence, joined_at) VALUES (?,?,?,?,?,?)")
    .run(201, "lg_admin", "591", 1, "{}", "2026-09-01T00:00:00.000Z");

  const result = await reconcileListingById(exec, 201, { reason: "test" });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "admin_confirmed");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM listing_match_evaluations").get().n), 0, "跳過時不得留下評估列");
});

test("reconcileListingById PG 分支：auto 群組且 match_level=high 時視為已確認", async () => {
  const db = fixture();
  const exec = sqliteExec(db);
  db.prepare("INSERT INTO listing_groups(group_id, primary_post_id, created_at, updated_at, confirmation_level) VALUES (?,?,?,?,?)")
    .run("lg_auto", 201, "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z", CONFIRM_AUTO);
  db.prepare("INSERT INTO listing_group_members(post_id, group_id, source, match_confidence, match_evidence, joined_at) VALUES (?,?,?,?,?,?)")
    .run(201, "lg_auto", "591", 1, "{}", "2026-09-01T00:00:00.000Z");
  db.prepare("UPDATE listings SET match_level = 'high' WHERE post_id = ?").run(201);

  const result = await reconcileListingById(exec, 201, { reason: "test" });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "auto_confirmed");
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM listing_match_evaluations").get().n), 0);
});

test("reconcileListingById PG 分支：證據不足時回 insufficient_evidence 並帶上 trigger", async () => {
  const db = fixture();
  // 把地址與社區都清掉，讓 hasReconcileEvidence 判定證據不足。
  db.prepare("UPDATE listings SET address = '', community_name = '', lat = NULL, lng = NULL WHERE post_id = ?").run(201);
  const result = await reconcileListingById(sqliteExec(db), 201, { reason: "detail_enrichment" });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "insufficient_evidence");
  assert.equal(result.trigger, "detail_enrichment", "要保留呼叫端傳入的 reason");
});
