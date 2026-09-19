import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applyWishLifecycleAction,
  createDemandPost,
  ensureDemandSchema,
  listDemandPosts,
  listPublicWishRooms,
  publishWishRoom,
  setRentalCatalogCache,
  setRentalMarketplaceFlags,
  updateWishRoom,
  wishRoomOwnerSummary,
} from "../src/demand.js";
import { defaultCatalog } from "../src/rentalCatalog.js";
import { beginWishFormMutation, endWishFormMutation, isWishDraftContext, planWishDraftSave, planWishPublish, wishCreateButtonLabel } from "../src/wishDraftUi.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");

function open() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      nickname TEXT,
      created_at TEXT NOT NULL
    );
  `);
  ensureDemandSchema(db);
  db.prepare("INSERT INTO users(id, email, nickname, created_at) VALUES (1, 'a@example.com', '阿花', '2026-01-01T00:00:00.000Z')").run();
  return db;
}

function sample(extra = {}) {
  return {
    districts: ["1-8"],
    rent_max: 28000,
    housing_type: "whole",
    layout: "2",
    body: "【PR-A-UAT】士林兩房可開伙找屋",
    must_have: ["need_cook"],
    avoid: ["parking_car"],
    choices: { need_cook: "want", parking_car: "avoid", fridge: "unspecified" },
    ...extra,
  };
}

test("create draft stays draft and is absent from public list", () => {
  const db = open();
  const draft = createDemandPost(db, 1, { ...sample(), draft: true });
  assert.equal(draft.status, "draft");
  assert.equal(draft.lifecycle, "draft");
  assert.equal(listDemandPosts(db).length, 0);
  assert.equal(listPublicWishRooms(db).length, 0);
  db.close();
});

test("double create draft keeps a single user draft id", () => {
  const db = open();
  const first = createDemandPost(db, 1, { ...sample(), draft: true });
  const again = createDemandPost(db, 1, { ...sample({ body: "【PR-A-UAT】第二次點儲存草稿" }), draft: true });
  assert.equal(again.id, first.id);
  assert.equal(again.status, "draft");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM demand_posts WHERE user_id=1 AND status='draft'").get().n, 1);
  db.close();
});

test("wish form single-flight blocks save-vs-publish race", () => {
  let gate = { inFlight: false };
  const first = beginWishFormMutation(gate);
  assert.equal(first.allowed, true);
  gate = first.state;
  assert.equal(beginWishFormMutation(gate).allowed, false);
  gate = endWishFormMutation(gate);
  assert.equal(beginWishFormMutation(gate).allowed, true);
});

test("owner summary can reload the same draft after save", () => {
  const db = open();
  const draft = createDemandPost(db, 1, { ...sample(), draft: true });
  const mine = wishRoomOwnerSummary(db, 1);
  assert.equal(mine.draft?.id, draft.id);
  assert.equal(mine.active, null);
  assert.equal(mine.draft.body, sample().body);
  db.close();
});

test("draft PATCH updates fields without publishing", () => {
  const db = open();
  const draft = createDemandPost(db, 1, { ...sample(), draft: true });
  const updated = updateWishRoom(db, 1, draft.id, {
    ...sample({ rent_max: 32000, body: "【PR-A-UAT】改過預算的草稿說明" }),
    draft: true,
  });
  assert.equal(updated.id, draft.id);
  assert.equal(updated.status, "draft");
  assert.equal(updated.rent_max, 32000);
  assert.equal(listPublicWishRooms(db).length, 0);
  db.close();
});

test("publish existing draft keeps the same id and becomes active", () => {
  const db = open();
  setRentalMarketplaceFlags({ wish: { lifecycle_enabled: true } });
  const draft = createDemandPost(db, 1, { ...sample(), draft: true });
  const published = publishWishRoom(db, 1, draft.id);
  assert.equal(published.id, draft.id);
  assert.equal(published.status, "open");
  assert.equal(published.lifecycle, "active");
  assert.equal(listPublicWishRooms(db).length, 1);
  setRentalMarketplaceFlags({});
  db.close();
});

test("canonical wish choices round-trip on draft and leftover nice_to_have stays leftover", () => {
  const db = open();
  setRentalMarketplaceFlags({ rental_catalog_v2: { enabled: true } });
  setRentalCatalogCache(defaultCatalog());
  const draft = createDemandPost(db, 1, {
    ...sample({
      nice_to_have: ["fridge"],
      choices: { need_cook: "want", parking_car: "avoid", fridge: "unspecified" },
    }),
    draft: true,
  });
  assert.equal(draft.choices.need_cook, "want");
  assert.equal(draft.choices.parking_car, "avoid");
  assert.notEqual(draft.choices.fridge, "want");
  const mine = wishRoomOwnerSummary(db, 1).draft;
  assert.equal(mine.choices.need_cook, "want");
  assert.equal(mine.choices.parking_car, "avoid");
  setRentalMarketplaceFlags({});
  setRentalCatalogCache(null);
  db.close();
});

test("draft UI action is hidden on active edit and create draft posts draft:true", () => {
  assert.equal(isWishDraftContext({ editingId: 9, activeId: 9 }), false);
  assert.equal(planWishDraftSave({ editingId: 9, activeId: 9 }).allowed, false);
  assert.equal(planWishDraftSave({ editingId: 0, activeId: 0 }).body.draft, true);
  assert.equal(planWishDraftSave({ editingId: 4, activeId: 0 }).method, "PATCH");
  assert.equal(planWishDraftSave({ editingId: 4, activeId: 0 }).publish, false);
  assert.equal(planWishPublish({ editingId: 4, activeId: 0 }).publish, true);
  assert.equal(planWishPublish({ editingId: 9, activeId: 9 }).publish, false);
  assert.equal(wishCreateButtonLabel({ draft: { id: 4 } }), "繼續編輯草稿");
  assert.equal(wishCreateButtonLabel({ active: { id: 9 }, draft: { id: 4 } }), "建立我的許願房");
});

test("index.html exposes 儲存草稿 without using it on the publish path", () => {
  const draftHandler = html.slice(
    html.indexOf('$("wishSaveDraft")?.addEventListener("click"'),
    html.indexOf('$("wishCancelEdit")?.addEventListener("click"'),
  );
  const publishHandler = html.slice(
    html.indexOf('$("demandForm")?.addEventListener("submit"'),
    html.indexOf('$("wishSaveDraft")?.addEventListener("click"'),
  );
  assert.match(html, /src="\/pra-helpers\.js"/);
  assert.match(html, /id="wishSaveDraft"/);
  assert.match(html, />儲存草稿</);
  assert.match(html, /id="demandSubmit">公開許願房</);
  assert.match(html, /id="wishCancelEdit">取消</);
  assert.match(html, /PraHelpers\.planWishDraftSave/);
  assert.match(html, /PraHelpers\.planWishPublish/);
  assert.match(html, /beginWishFormBusy\(\)/);
  assert.match(draftHandler, /PraHelpers\.planWishDraftSave/);
  assert.match(draftHandler, /beginWishFormBusy\(\)/);
  assert.doesNotMatch(draftHandler, /\/publish/);
  assert.match(publishHandler, /PraHelpers\.planWishPublish/);
  assert.match(publishHandler, /beginWishFormBusy\(\)/);
  assert.match(html, /PraHelpers\.wishCreateButtonLabel/);
  assert.match(readFileSync(path.join(dir, "../public/pra-helpers.js"), "utf8"), /繼續編輯草稿/);
  assert.match(html, /你的許願房正在曝光/);
});

function mutableCount(db, userId = 1) {
  return db.prepare(
    "SELECT COUNT(*) n FROM demand_posts WHERE user_id=? AND status IN ('open','draft')",
  ).get(userId).n;
}

test("stale open create publishes the existing draft instead of open+draft", () => {
  const db = open();
  setRentalMarketplaceFlags({ wish: { lifecycle_enabled: true } });
  const draft = createDemandPost(db, 1, { ...sample(), draft: true });
  const published = createDemandPost(db, 1, sample({ body: "【PR-A-UAT】過期分頁誤送公開" }));
  assert.equal(published.id, draft.id);
  assert.equal(published.status, "open");
  assert.equal(published.lifecycle, "active");
  assert.equal(mutableCount(db), 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM demand_posts WHERE user_id=1 AND status='draft'").get().n, 0);
  setRentalMarketplaceFlags({});
  db.close();
});

test("stale draft create while open exists is 409 and stays open-only", () => {
  const db = open();
  const openWish = createDemandPost(db, 1, sample());
  assert.throws(
    () => createDemandPost(db, 1, { ...sample({ body: "【PR-A-UAT】過期分頁誤存草稿" }), draft: true }),
    (e) => e.status === 409 && e.code === "wish_mutable_limit",
  );
  assert.equal(mutableCount(db), 1);
  assert.equal(db.prepare("SELECT status FROM demand_posts WHERE id=?").get(openWish.id).status, "open");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM demand_posts WHERE user_id=1 AND status='draft'").get().n, 0);
  db.close();
});

test("concurrent draft save vs publish across two connections leaves one mutable row", async () => {
  const file = path.join(os.tmpdir(), `wish-mutable-${process.pid}-${Date.now()}.db`);
  const seed = new DatabaseSync(file);
  seed.exec("PRAGMA journal_mode=WAL");
  seed.exec("PRAGMA busy_timeout=5000");
  seed.exec("PRAGMA foreign_keys = ON");
  seed.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, created_at TEXT);`);
  seed.prepare("INSERT INTO users(id, email, created_at) VALUES (1, 'a@example.com', '2026-01-01T00:00:00.000Z')").run();
  ensureDemandSchema(seed);
  const draft = createDemandPost(seed, 1, { ...sample(), draft: true });
  seed.close();

  const a = new DatabaseSync(file);
  const b = new DatabaseSync(file);
  a.exec("PRAGMA busy_timeout=5000");
  b.exec("PRAGMA busy_timeout=5000");
  await Promise.allSettled([
    Promise.resolve().then(() => createDemandPost(a, 1, { ...sample({ body: "【PR-A-UAT】併發再存草稿" }), draft: true })),
    Promise.resolve().then(() => publishWishRoom(b, 1, draft.id)),
  ]);
  const check = new DatabaseSync(file);
  assert.equal(mutableCount(check), 1);
  const openN = check.prepare("SELECT COUNT(*) n FROM demand_posts WHERE user_id=1 AND status='open'").get().n;
  const draftN = check.prepare("SELECT COUNT(*) n FROM demand_posts WHERE user_id=1 AND status='draft'").get().n;
  assert.equal(openN + draftN, 1);
  a.close();
  b.close();
  check.close();
});

test("normal draft publish still keeps the same id after mutable invariant", () => {
  const db = open();
  setRentalMarketplaceFlags({ wish: { lifecycle_enabled: true } });
  const draft = createDemandPost(db, 1, { ...sample(), draft: true });
  const published = publishWishRoom(db, 1, draft.id);
  assert.equal(published.id, draft.id);
  assert.equal(published.status, "open");
  assert.equal(mutableCount(db), 1);
  setRentalMarketplaceFlags({});
  db.close();
});

test("startup collapse retires leftover draft beside open without paused resume", () => {
  const db = open();
  setRentalMarketplaceFlags({ wish: { lifecycle_enabled: true } });
  db.exec("DROP INDEX IF EXISTS idx_demand_one_mutable");
  db.exec("DROP INDEX IF EXISTS idx_demand_one_open");
  db.exec("DROP INDEX IF EXISTS idx_demand_one_draft");
  db.prepare(`
    INSERT INTO demand_posts(id, user_id, body, status, created_at, expires_at, lifecycle)
    VALUES (11, 1, '【PR-A-UAT】既有公開', 'open', '2026-01-01T00:00:00.000Z', '9999-12-31T00:00:00.000Z', 'active')
  `).run();
  db.prepare(`
    INSERT INTO demand_posts(id, user_id, body, status, created_at, expires_at, lifecycle)
    VALUES (12, 1, '【PR-A-UAT】leftover draft', 'draft', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'draft')
  `).run();
  ensureDemandSchema(db);
  const leftover = db.prepare("SELECT status, lifecycle, closed_reason FROM demand_posts WHERE id=12").get();
  assert.equal(leftover.status, "closed");
  assert.equal(leftover.lifecycle, "draft");
  assert.notEqual(leftover.lifecycle, "paused");
  assert.equal(leftover.closed_reason, "legacy_collapsed");
  assert.equal(db.prepare("SELECT status FROM demand_posts WHERE id=11").get().status, "open");
  assert.equal(mutableCount(db), 1);
  assert.throws(
    () => applyWishLifecycleAction(db, 1, 12, "resume"),
    (e) => e.status === 400,
  );
  const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_demand_one_mutable'").get();
  assert.match(String(indexes?.sql || ""), /status IN \('open', 'draft'\)/);
  setRentalMarketplaceFlags({});
  db.close();
});

function rowState(db, id) {
  return db.prepare("SELECT status, lifecycle, closed_reason, closed_at FROM demand_posts WHERE id=?").get(id);
}

test("publish refuses completed Wish and leaves it completed/closed", () => {
  const db = open();
  setRentalMarketplaceFlags({ wish: { lifecycle_enabled: true } });
  const draft = createDemandPost(db, 1, { ...sample(), draft: true });
  const active = publishWishRoom(db, 1, draft.id);
  const done = applyWishLifecycleAction(db, 1, active.id, "complete");
  assert.equal(done.lifecycle, "completed");
  assert.throws(
    () => publishWishRoom(db, 1, done.id),
    (e) => e.status === 400 && e.code === "wish_completed",
  );
  const after = rowState(db, done.id);
  assert.equal(after.status, "closed");
  assert.equal(after.lifecycle, "completed");
  assert.equal(after.closed_reason, "completed");
  setRentalMarketplaceFlags({});
  db.close();
});

test("publish refuses blocked/hidden Wish and leaves it blocked", () => {
  const db = open();
  setRentalMarketplaceFlags({ wish: { lifecycle_enabled: true } });
  const draft = createDemandPost(db, 1, { ...sample(), draft: true });
  const active = publishWishRoom(db, 1, draft.id);
  db.prepare("UPDATE demand_posts SET status='hidden', lifecycle='blocked', closed_reason='blocked' WHERE id=?").run(active.id);
  assert.throws(
    () => publishWishRoom(db, 1, active.id),
    (e) => e.status === 400 && e.code === "wish_blocked",
  );
  const after = rowState(db, active.id);
  assert.equal(after.status, "hidden");
  assert.equal(after.lifecycle, "blocked");
  setRentalMarketplaceFlags({});
  db.close();
});

test("publish refuses paused Wish; resume remains the legal path", () => {
  const db = open();
  setRentalMarketplaceFlags({ wish: { lifecycle_enabled: true } });
  const draft = createDemandPost(db, 1, { ...sample(), draft: true });
  const active = publishWishRoom(db, 1, draft.id);
  const paused = applyWishLifecycleAction(db, 1, active.id, "pause");
  assert.equal(paused.lifecycle, "paused");
  assert.throws(
    () => publishWishRoom(db, 1, paused.id),
    (e) => e.status === 400 && e.code === "wish_use_resume",
  );
  const afterPublish = rowState(db, paused.id);
  assert.equal(afterPublish.status, "closed");
  assert.equal(afterPublish.lifecycle, "paused");
  const resumed = applyWishLifecycleAction(db, 1, paused.id, "resume");
  assert.equal(resumed.id, paused.id);
  assert.equal(resumed.status, "open");
  assert.equal(resumed.lifecycle, "active");
  setRentalMarketplaceFlags({});
  db.close();
});

test("already-open publish is idempotent and does not rewrite fields", () => {
  const db = open();
  setRentalMarketplaceFlags({ wish: { lifecycle_enabled: true } });
  const draft = createDemandPost(db, 1, { ...sample(), draft: true });
  const published = publishWishRoom(db, 1, draft.id);
  const again = publishWishRoom(db, 1, published.id, {
    rent_max: 99000,
    body: "【PR-A-UAT】不該用 publish 改欄位",
  });
  assert.equal(again.id, published.id);
  assert.equal(again.status, "open");
  assert.equal(again.rent_max, published.rent_max);
  assert.equal(again.body, published.body);
  setRentalMarketplaceFlags({});
  db.close();
});

test("server /publish route only forwards to publishWishRoomFor", () => {
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  const route = server.slice(
    server.indexOf('app.post("/api/wish-rooms/:id/publish"'),
    server.indexOf('app.post("/api/wish-rooms/:id/reopen"'),
  );
  assert.match(route, /publishWishRoomFor\(session\.userId, req\.params\.id/);
  assert.doesNotMatch(route, /applyPublishInPlace/);
  assert.doesNotMatch(route, /lifecycle\s*=\s*['"]active['"]/);
  assert.match(readFileSync(path.join(dir, "../src/demand.js"), "utf8"), /classifyWishPublishState/);
});
