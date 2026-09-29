// 物件來源歷史（`sourceHistoryAsync`）的 parity（2026-09-29，第六十一批）。
//
// `GET /api/listings/:id/history` 會列出「同一個 source_key 的其他刊登」再疊上**這個人的旗標**。
// 同步版兩個 store 都讀本機 ⇒ PG 模式下會列出別的節點看不到的舊資料，旗標也是本機那一份
// （已看過／關注／隱藏／備註全部錯位，而且不會報錯）。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-srchist-"));
process.env.DATA_DIR = dataDir;
after(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows lock */ } });

const dbMod = await import("../src/db.js");
const { sourceHistoryAsync } = await import("../src/sourceHistoryAsync.js");

const PG = { driver: "postgres", strict: true };
const handle = () => dbMod.sqliteHandle();
const UID = 900000009001;
const KEY = "1|8|hist";
const TABLES = ["users", "listings", "user_listing_flags"];

function seedWorld() {
  const lite = handle();
  for (const h of [lite]) {
    h.prepare("DELETE FROM user_listing_flags WHERE user_id = ?").run(UID);
    // ⚠️ 要按 post_id 範圍刪：第三筆（別的 source_key）也要清掉，否則第二個測試會撞 post_id。
    h.prepare("DELETE FROM listings WHERE post_id >= 940000").run();
  }
  const mem = new DatabaseSync(":memory:");
  const disk = new DatabaseSync(path.join(dataDir, "v3.db"), { readOnly: true });
  for (const table of TABLES) {
    const ddl = disk.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
    assert.ok(ddl?.sql, `必須抓到 ${table} 的 DDL`);
    mem.exec(ddl.sql);
  }
  disk.close();

  // `listings` 是寬表：用 pragma 自動補齊 NOT NULL 欄位（不要一個個猜欄位名）。
  const insertListing = (h, provided) => {
    const info = h.prepare("PRAGMA table_info(listings)").all();
    const required = info.filter((c) => c.notnull === 1 && c.dflt_value === null && c.pk === 0);
    const names = info.map((c) => c.name).filter((n) => n in provided || required.some((c) => c.name === n));
    h.prepare(`INSERT INTO listings(${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
      .run(...names.map((name) => {
        if (name in provided) return provided[name];
        const col = info.find((c) => c.name === name);
        return /INT|REAL|NUM/i.test(col.type) ? 0 : "";
      }));
  };
  const flag = (h, postId, watched, viewed, note) => h.prepare(
    "INSERT INTO user_listing_flags(user_id, post_id, viewed, watched, hidden, watch_note, watch_group_id) VALUES (?,?,?,?,0,?,'')",
  ).run(UID, postId, viewed, watched, note);

  for (const h of [lite, mem]) {
    h.prepare("INSERT OR REPLACE INTO users(id, email, nickname, role, plan, created_at) VALUES (?,?,?,?,?,?)")
      .run(UID, "hist@example.test", "歷史", "member", "free", "2026-01-01T00:00:00.000Z");
    insertListing(h, { post_id: 940001, title: "舊的", source_key: KEY, source: "591", last_seen_at: "2026-09-01T00:00:00.000Z" });
    insertListing(h, { post_id: 940002, title: "新的", source_key: KEY, source: "591", last_seen_at: "2026-09-20T00:00:00.000Z" });
    insertListing(h, { post_id: 940003, title: "別的來源", source_key: "1|9|other", source: "591", last_seen_at: "2026-09-21T00:00:00.000Z" });
  }
  // 只有 PG 那一份有旗標（本機沒有）⇒ 若讀錯 store，個人化欄位會是全 0。
  flag(mem, 940001, 1, 1, "PG 的備註");
  const exec = async (sql, params = []) => mem.prepare(sql).all(...params);
  exec.raw = mem;
  return [lite, exec];
}

test("PG 與同步版：只列同一個 source_key、由新到舊，個人化欄位相同", async () => {
  const [lite, exec] = seedWorld();
  const viaPg = await sourceHistoryAsync(KEY, UID, { ...PG, exec });
  assert.equal(viaPg.length, 2, "只列同一個 source_key 的兩筆（第三筆是別的來源）");
  assert.deepEqual(viaPg.map((r) => Number(r.post_id)), [940002, 940001], "依 last_seen_at 由新到舊");
  assert.equal(viaPg[0].watched, 0, "940002 在 PG 沒有旗標");
  assert.equal(viaPg[1].watched, 1, "940001 的關注要從 PG 的旗標來");
  assert.equal(viaPg[1].viewed, 1);
  assert.equal(viaPg[1].watch_note, "PG 的備註", "備註也要帶出來");
  // 形狀：與同步版同一組鍵
  const sync = dbMod.sourceHistory(KEY, UID);
  assert.deepEqual(Object.keys(viaPg[0]).sort(), Object.keys(sync[0]).sort(), "回傳的鍵必須與同步版相同");
  // 同步版讀本機（沒有旗標）⇒ 個人化欄位本來就不同，這正是鑑別力
  assert.equal(sync.find((r) => Number(r.post_id) === 940001).watched, 0, "本機那一份沒有旗標");
  // 空 key：兩邊都回空陣列，且不得送出查詢
  let calls = 0;
  const counting = async (sql, params = []) => { calls += 1; return exec(sql, params); };
  assert.deepEqual(await sourceHistoryAsync("", UID, { ...PG, exec: counting }), []);
  assert.equal(calls, 0, "空 source_key 必須早退");
});

test("注入式 exec 的兩種形狀都要吃得下；非 postgres 走同步版", async () => {
  const [lite, exec] = seedWorld();
  const bare = async (sql, params = []) => exec(sql, params);
  const wrapped = async (sql, params = []) => {
    const rows = await exec(sql, params);
    return { rows, rowCount: Number(rows.rowCount) || 0 };
  };
  assert.deepEqual(
    await sourceHistoryAsync(KEY, UID, { ...PG, exec: wrapped }),
    await sourceHistoryAsync(KEY, UID, { ...PG, exec: bare }),
    "兩種 exec 形狀必須相同",
  );
  let calls = 0;
  const boom = async () => { calls += 1; throw new Error("exec 不該被呼叫（sqlite 模式）"); };
  const viaSqlite = await sourceHistoryAsync(KEY, UID, { driver: "sqlite", exec: boom });
  assert.deepEqual(viaSqlite, dbMod.sourceHistory(KEY, UID));
  assert.equal(calls, 0, "sqlite 模式不得呼叫 PG runner");
});
