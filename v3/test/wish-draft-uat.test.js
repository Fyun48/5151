import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
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
