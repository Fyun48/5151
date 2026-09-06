import { test } from "node:test";
import assert from "node:assert/strict";
import { openOpsDb } from "../src/opsDb.js";

// Canonical source of truth：state_entity.state 是唯一可寫的 lifecycle 狀態。
// 這個守護測試確保：ops schema 裡除了 state_entity，沒有其他表新增可獨立寫入的
// lifecycle 狀態欄位（state / status / lifecycle_state）。未來加 domain 表時，
// 只能存「衍生/去正規化」狀態；若真的要加狀態欄位，必須同時更新此白名單並附上不可分歧的理由。
test("only state_entity holds a lifecycle state column", () => {
  const db = openOpsDb(":memory:");
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);

  const STATE_COL = /^(state|status|lifecycle_state)$/i;
  const ALLOWED = new Set(["state_entity"]);
  const offenders = [];

  for (const table of tables) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    for (const col of cols) {
      if (STATE_COL.test(col) && !ALLOWED.has(table)) {
        offenders.push(`${table}.${col}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `發現非 canonical 的 lifecycle 狀態欄位：${offenders.join(", ")}。domain 表只能存衍生狀態。`,
  );
  // 確認 canonical 欄位存在
  const seCols = db.prepare("PRAGMA table_info(state_entity)").all().map((c) => c.name);
  assert.ok(seCols.includes("state"));
  assert.ok(seCols.includes("version"));
  db.close();
});
