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
  assert.match(html, /id="wishEditBtn"/);
  assert.match(html, /id="wishCloseBtn"/);
  assert.match(html, /id="wishSaveExampleBtn"/);
  assert.match(html, /id="wishLoadExampleBtn"/);
  assert.doesNotMatch(html, /需求專區/);
  assert.doesNotMatch(html, /刊登需求</);
});

test("form has renter fields, priority groups, and no long legal wall or 適合對象", () => {
  assert.match(html, /id="demandRentMin"/);
  assert.match(html, /id="wishIncludesFee"/);
  assert.match(html, /id="wishMoveIn"/);
  assert.match(html, /id="wishLease"/);
  assert.match(html, /id="wishMust"/);
  assert.match(html, /id="wishNice"/);
  assert.match(html, /id="wishAvoid"/);
  assert.match(html, /需要可開伙/);
  assert.match(html, /需要可養寵物/);
  assert.match(html, /需要可申請租補／報稅/);
  assert.match(html, /terms\.html\?type=wish_room_rules/);
  assert.doesNotMatch(html, /需求牆是公開留言板/);
  assert.doesNotMatch(html, /同時最多 2 則未過期需求/);
  const demandView = html.slice(html.indexOf('id="demandView"'), html.indexOf('id="notifyView"'));
  assert.doesNotMatch(demandView, /適合對象/);
  assert.doesNotMatch(demandView, /限女性|限男性|國籍|外籍/);
  assert.match(html, /id="wishContactPick"/);
});

test("public share page and routes exist; guests can read", () => {
  assert.match(wish, /許願房/);
  assert.match(wish, /\/api\/public\/wish-room\//);
  assert.match(server, /app\.get\("\/w\/:id"/);
  assert.match(server, /app\.get\("\/api\/wish-rooms"/);
  assert.match(server, /app\.get\("\/api\/public\/wish-room\/:id"/);
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
  assert.match(demand, /wish_room_example/);
  assert.match(server, /app\.put\("\/api\/wish-rooms\/example"/);
  assert.match(server, /app\.post\("\/api\/wish-rooms\/:id\/reopen"/);
  assert.match(server, /app\.post\("\/api\/wish-rooms\/:id\/publish"/);
});
