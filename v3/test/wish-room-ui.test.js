import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(path.join(dir, "..", p), "utf8");
const html = read("public/index.html");
const wish = read("public/wish.html");
const server = read("src/server.js");
const auth = read("src/auth.js");
const demand = read("src/demand.js");

test("navigation and empty/owner copy use 許願房", () => {
  assert.match(html, />許願房</);
  assert.match(html, /<h2[^>]*>許願房<\/h2>/);
  assert.match(html, /建立我的許願房/);
  assert.match(html, /目前沒有公開的許願房/);
  assert.match(html, /id="wishCreateBtn"/);
  assert.match(html, /id="wishSaveDraft"/);
  assert.match(html, /id="wishEditBtn"/);
  assert.match(html, /id="wishCloseBtn"/);
  assert.match(html, /id="wishSaveExampleBtn"/);
  assert.match(html, /id="wishLoadExampleBtn"/);
  assert.doesNotMatch(html, /需求專區/);
  assert.doesNotMatch(html, /刊登需求</);
});

test("form has renter fields, priority groups, and no long legal wall or 適合對象", () => {
  assert.match(html, /id="demandRentMax"/);
  assert.match(html, /房租上限/);
  assert.match(html, /id="wishIncludesFee"/);
  assert.match(html, /id="wishMoveIn"/);
  assert.match(html, /id="wishLease"/);
  assert.match(html, /id="wishMust"/);
  assert.match(html, /id="wishNice"/);
  assert.match(html, /id="wishAvoid"/);
  assert.match(html, /需要可開伙/);
  assert.match(html, /需要可養寵物/);
  assert.match(html, /需要可申請租補／報稅/);
  assert.match(html, /需要可步行捷運（1 公里內）/);
  assert.match(html, /for="wishLayout">格局</);
  assert.match(html, /for="wishMoveIn">預計入住</);
  assert.match(html, /for="wishLease">租期</);
  assert.match(html, /for="wishTransit">捷運／車站</);
  assert.doesNotMatch(html, /希望1公里內有之捷運／車站名稱/);
  assert.match(html, /未指定/);
  assert.match(html, /全部要有/);
  assert.match(html, /整頁全部清除/);
  assert.match(html, /terms\.html\?type=wish_room_rules/);
  assert.doesNotMatch(html, /需求牆是公開留言板/);
  assert.doesNotMatch(html, /同時最多 2 則未過期需求/);
  const demandView = html.slice(html.indexOf('id="demandView"'), html.indexOf('id="notifyView"'));
  assert.doesNotMatch(demandView, /適合對象/);
  assert.doesNotMatch(demandView, /限女性|限男性|國籍|外籍/);
  assert.doesNotMatch(demandView, /id="wishFilters"/);
  assert.doesNotMatch(demandView, /id="wishCity"/);
  assert.doesNotMatch(demandView, /id="demandRentMin"/);
  assert.doesNotMatch(demandView, /id="wishLocationNote"/);
  assert.doesNotMatch(demandView, /id="wishDestination"/);
  assert.doesNotMatch(demandView, /id="wishCommute"/);
  assert.doesNotMatch(demandView, /id="wishContactName"/);
  assert.doesNotMatch(demandView, /id="wishContactPhone"/);
  assert.doesNotMatch(demandView, /id="wishContactLine"/);
  assert.doesNotMatch(demandView, /id="wishContactPick"/);
  assert.doesNotMatch(demandView, /未滿 1\.5 公里/);
});

test("public share page and routes exist; guests can read", () => {
  assert.match(wish, /許願房/);
  assert.match(wish, /\/api\/public\/wish-room\//);
  assert.match(server, /app\.get\("\/w\/:id"/);
  assert.match(server, /app\.get\("\/api\/wish-rooms"/);
  assert.match(server, /app\.get\("\/api\/public\/wish-room\/:id"/);
  assert.match(server, /"extend", "pause", "resume", "complete", "confirm", "full_reconfirm"/);
  assert.match(html, /id="wishCatalogV2"/);
  assert.match(html, /selected\.choices/);
  assert.match(html, /PraHelpers\.applyWishBulkToSection/);
  assert.match(html, /PraHelpers\.findWishBulkSection/);
  assert.match(html, /\/api\/public\/wish-room\//);
  assert.match(html, /wishPublicRef/);
  assert.match(html, /data-wish-public/);
  assert.match(html, /lifecycle !== "completed"/);
  assert.match(html, /paintSelfTraits\(Array\.isArray\(data\.traits\)/);
  assert.match(html, /data-listing-polar/);
  assert.match(html, /id="wishLifecycleBar"/);
  assert.match(html, /id="wishConfirmReview"/);
  assert.match(html, /full_reconfirm/);
  assert.match(html, /id="wishStatus"/);
  assert.match(wish, /label_want|nice_to_have_labels/);
  assert.match(auth, /p\.startsWith\("\/w\/"\)/);
  assert.match(auth, /p === "\/api\/wish-rooms"/);
});

test("index script still parses and keeps demand view id", () => {
  assert.match(html, /data-nav="demand"/);
  assert.match(html, /id="demandView"/);
  assert.match(html, /function loadDemand/);
  assert.match(html, /\/api\/wish-rooms\/\$\{wishEditingId\}/);
});

test("server-side one-active and example APIs are present", () => {
  assert.match(demand, /idx_demand_one_open/);
  assert.match(demand, /idx_demand_one_mutable/);
  assert.match(demand, /status IN \('open', 'draft'\)/);
  assert.match(demand, /wish_room_example/);
  assert.match(server, /app\.put\("\/api\/wish-rooms\/example"/);
  assert.match(server, /app\.post\("\/api\/wish-rooms\/:id\/reopen"/);
  assert.match(server, /app\.post\("\/api\/wish-rooms\/:id\/publish"/);
  assert.match(server, /app\.get\("\/api\/admin\/wish-conditions"/);
  assert.match(server, /app\.put\("\/api\/admin\/wish-conditions"/);
});

test("full reconfirm intent is scoped and cancel returns to ordinary edit", () => {
  assert.match(html, /function beginWishFullReconfirm/);
  assert.match(html, /function clearWishFullReconfirm/);
  assert.match(html, /function isWishFullReconfirm/);
  assert.match(html, /wishFullReconfirm = \{ id: 0 \}/);
  assert.match(html, /id="wishCancelEdit"/);
  assert.match(html, /\$\("wishCancelEdit"\)[\s\S]*?clearWishFullReconfirm\(\)/);
  assert.match(html, /\$\("wishEditBtn"\)\?\.addEventListener\("click"[\s\S]*?clearWishFullReconfirm\(\)/);
  assert.match(html, /\$\("wishCreateBtn"\)\?\.addEventListener\("click"[\s\S]*?clearWishFullReconfirm\(\)/);
  assert.match(html, /const pendingFull = isWishFullReconfirm\(pendingId\)/);
  assert.match(html, /if \(!show\) clearWishFullReconfirm\(\)/);
  assert.match(html, /\$\("demandSubmit"\)\.textContent = "公開許願房"/);
  assert.doesNotMatch(html, /wishPendingFullReconfirm/);
});

test("admin can edit Wish Room condition catalog", () => {
  const admin = read("public/admin.html");
  assert.match(admin, /id="wishConditionsCard"/);
  assert.match(admin, /許願房條件選單/);
  assert.match(admin, /id="wishCondSave"/);
  assert.match(admin, /\/api\/admin\/wish-conditions/);
  assert.match(admin, /id="catalogCatDrawer"/);
  assert.match(admin, /data-cat-edit/);
  assert.match(admin, /id="catalogRenameTemplate"/);
  assert.match(admin, /id="catalogDeleteTemplate"/);
});
