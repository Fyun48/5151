import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  addDemandReply,
  closeDemandPost,
  createDemandPost,
  DEMAND_LEGAL,
  demandMeta,
  ensureDemandSchema,
  listDemandPosts,
  reportDemand,
} from "../src/demand.js";

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
  `);
  ensureDemandSchema(db);
  return db;
}

function addUser(db, { id, email, createdAt }) {
  db.prepare("INSERT INTO users(id, email, created_at) VALUES (?, ?, ?)").run(id, email, createdAt);
}

const OLD = "2026-01-01T00:00:00.000Z";

test("demand wall guests can list and login is required to post", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com", createdAt: OLD });
  const listed = listDemandPosts(db);
  assert.equal(listed.length, 0);
  assert.match(demandMeta().legal, /不是仲介/);
  assert.match(DEMAND_LEGAL, /不經手金錢/);
  assert.throws(() => createDemandPost(db, 0, { districts: ["1-8"], body: "找兩房" }), /請先登入/);
  const post = createDemandPost(db, 1, {
    districts: ["1-8", "1-9"],
    rent_max: 28000,
    housing_type: "apartment",
    mrt_walk: true,
    body: "士林北投兩房近捷運",
  });
  assert.equal(post.districts.length, 2);
  assert.equal(post.mrt_walk, true);
  assert.equal(listDemandPosts(db).length, 1);
  db.close();
});

test("open post quota and new-account wait", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com", createdAt: OLD });
  addUser(db, { id: 2, email: "new@example.com", createdAt: new Date().toISOString() });
  createDemandPost(db, 1, { districts: ["1-8"], body: "第一則需求內容" });
  createDemandPost(db, 1, { districts: ["1-9"], body: "第二則需求內容" });
  assert.throws(
    () => createDemandPost(db, 1, { districts: ["1-5"], body: "第三則應該被擋" }),
    /最多 2 則/,
  );
  assert.throws(
    () => createDemandPost(db, 2, { districts: ["1-8"], body: "新帳號想發文" }),
    /24 小時/,
  );
  const first = listDemandPosts(db, { viewerId: 1 })[0];
  closeDemandPost(db, 1, first.id);
  assert.equal(listDemandPosts(db).length, 1);
  db.close();
});

test("public replies, rate limit, report hide", () => {
  const db = open();
  addUser(db, { id: 1, email: "a@example.com", createdAt: OLD });
  addUser(db, { id: 2, email: "b@example.com", createdAt: OLD });
  addUser(db, { id: 3, email: "c@example.com", createdAt: OLD });
  const post = createDemandPost(db, 1, { districts: ["1-8"], body: "找電梯兩房" });
  const replied = addDemandReply(db, 2, post.id, "我看到一間可以參考");
  assert.equal(replied.replies.length, 1);
  assert.match(replied.replies[0].author, /\*\*\*/);
  assert.throws(() => addDemandReply(db, 2, post.id, "太快了吧"), /密集/);
  reportDemand(db, 2, { targetType: "post", targetId: post.id, reason: "廣告" });
  const second = reportDemand(db, 3, { targetType: "post", targetId: post.id, reason: "廣告" });
  assert.equal(second.hidden, true);
  assert.equal(listDemandPosts(db).length, 0);
  db.close();
});
