import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  collapseSameHouseNotifyEvents,
  ensureUserSameHouseSchema,
  judgeMergeSet,
  loadPersonalSameHouseIds,
  mergePersonalSameHouse,
  splitPersonalSameHouse,
  systemJudgesSameHouse,
} from "../src/userSameHouse.js";

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    INSERT INTO users(id) VALUES (1), (2);
  `);
  ensureUserSameHouseSchema(db);
  return db;
}

test("user merge always writes personal rows and never marks shared", () => {
  const db = open();
  const a = { post_id: 101, title: "芝山兩房", address: "台北市士林區福華路141巷", layout: "2房1廳", area_name: "17坪", floor_name: "3F/4F", price_num: 32000, source: "591" };
  const b = { post_id: 202, title: "芝山兩房採光", address: "台北市士林區福華路", layout: "2房2廳", area_name: "17坪", floor_name: "3F/4F", price_num: 32000, source: "houseprice" };
  const result = mergePersonalSameHouse(db, 1, [a, b]);
  assert.equal(result.ok, true);
  assert.equal(result.shared, false);
  assert.equal(result.personal, true);
  assert.deepEqual(loadPersonalSameHouseIds(db, 1, 101).sort(), [202]);
  assert.deepEqual(loadPersonalSameHouseIds(db, 2, 101), []);
  assert.match(result.message, /只改你的列表|只留在你的帳號/);
});

test("system disagreement is returned but merge still happens", () => {
  const db = open();
  const a = { post_id: 11, title: "天母套房", address: "台北市士林區天玉街1號", layout: "1房", area_name: "8坪", source: "591" };
  const b = { post_id: 22, title: "淡水整層", address: "新北市淡水區中山路93號", layout: "3房", area_name: "30坪", source: "houseprice" };
  assert.equal(systemJudgesSameHouse(a, b), false);
  const result = mergePersonalSameHouse(db, 1, [a, b]);
  assert.equal(result.ok, true);
  assert.equal(result.systemAgrees, false);
  assert.match(result.message, /系統判定不是同屋源/);
  assert.equal(loadPersonalSameHouseIds(db, 1, 11).includes(22), true);
});

test("same source_key is judged same house", () => {
  const a = { post_id: 1, source_key: "abc", address: "x" };
  const b = { post_id: 2, source_key: "abc", address: "x" };
  assert.equal(systemJudgesSameHouse(a, b), true);
  assert.equal(judgeMergeSet([a, b]).systemAgrees, true);
});

test("split removes only that user pair", () => {
  const db = open();
  const a = { post_id: 3, source_key: "k", title: "A" };
  const b = { post_id: 4, source_key: "k", title: "B" };
  mergePersonalSameHouse(db, 1, [a, b]);
  mergePersonalSameHouse(db, 2, [a, b]);
  assert.equal(splitPersonalSameHouse(db, 1, 3, 4), true);
  assert.deepEqual(loadPersonalSameHouseIds(db, 1, 3), []);
  assert.deepEqual(loadPersonalSameHouseIds(db, 2, 3), [4]);
});

test("webhook collapse keeps the primary listing event", () => {
  const events = [
    { type: "price_update", post_id: 202, same_house_primary_id: 101, title: "副卡" },
    { type: "price_update", post_id: 101, same_house_primary_id: 101, title: "主卡" },
    { type: "new", post_id: 303, title: "另一間" },
  ];
  const kept = collapseSameHouseNotifyEvents(events, (event) => Number(event.same_house_primary_id) || Number(event.post_id));
  const prices = kept.filter((row) => row.type === "price_update");
  assert.equal(prices.length, 1);
  assert.equal(prices[0].post_id, 101);
  assert.equal(kept.some((row) => row.post_id === 303), true);
});
