import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensurePersonalSchema } from "../src/personalSchema.js";

test("personal schema creates user, flag, cover, and event tables", () => {
  const db = new DatabaseSync(":memory:");
  ensurePersonalSchema(db);
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
  for (const need of ["users", "user_settings", "user_listing_flags", "crawl_covers", "user_events"]) {
    assert.ok(names.includes(need), `missing ${need}`);
  }
});
