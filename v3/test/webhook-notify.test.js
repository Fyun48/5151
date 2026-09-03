import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyExistingUpdate,
  formatNotifyFacts,
  formatUsableArea,
  isSameNotifyDetail,
  listingLastEvent,
  listingNotifyVars,
  listingPriceNum,
  listingSmtpReady,
  notify,
  parseNotifyChanges,
  shouldDockNotify,
  shouldMailNotify,
  shouldNotify,
  shouldWebhookNotify,
} from "../src/notify.js";
import { defaultMailTemplates } from "../src/siteMail.js";

const listing = {
  title: "士林二房",
  price: "28000",
  price_num: 28000,
  hidden: 0,
  offline: 0,
  watched: 0,
  kind_name: "整層住家",
  floor_name: "5F/12F",
};
const watched = { ...listing, watched: 1 };
const hookSettings = { discordWebhook: "https://discord.com/api/webhooks/1/abc" };

test("new listings always notify", () => {
  assert.equal(shouldNotify(hookSettings, listing, { type: "new" }), true);
  assert.equal(shouldDockNotify(hookSettings, listing, { type: "new" }), true);
  assert.equal(shouldWebhookNotify(hookSettings, listing, { type: "new" }), false);
  assert.equal(
    shouldWebhookNotify(
      { ...hookSettings, notifyMatrix: { new: { dock: true, push: true, webhook: true, mail: false } } },
      listing,
      { type: "new" },
    ),
    true,
  );
});

test("non-watched updates do not notify except new", () => {
  assert.equal(shouldNotify(hookSettings, listing, { type: "price_drop", detail: "x" }), false);
  assert.equal(shouldNotify(hookSettings, listing, { type: "title_update", detail: "x" }), false);
  assert.equal(shouldNotify(hookSettings, listing, { type: "same_source", detail: "重刊" }), false);
});

test("watched same_source relist can notify; non-watched cannot", () => {
  assert.equal(shouldNotify(hookSettings, watched, { type: "same_source", detail: "指紋相同" }), true);
  assert.equal(shouldNotify(hookSettings, listing, { type: "same_source", detail: "指紋相同" }), false);
});

test("watched listings notify on price, title, content, offline, relist", () => {
  assert.equal(shouldNotify(hookSettings, watched, { type: "price_drop", detail: "28000 → 25000" }), true);
  assert.equal(shouldNotify(hookSettings, watched, { type: "price_update", detail: "28000 → 30000" }), true);
  assert.equal(shouldNotify(hookSettings, watched, { type: "title_update", detail: "標題變更" }), true);
  assert.equal(shouldNotify(hookSettings, watched, { type: "update", detail: "格局 2房 → 3房" }), true);
  assert.equal(shouldNotify(hookSettings, { ...watched, offline: 1 }, { type: "offline", detail: "gone" }), true);
  assert.equal(shouldNotify(hookSettings, watched, { type: "relist", detail: "重新上架" }), true);
});

test("parseNotifyChanges splits layout and floor diffs", () => {
  const bits = parseNotifyChanges("格局 2房1廳 → 3房1廳；樓層 3F/5F → 5F/12F");
  assert.deepEqual(bits, [
    { label: "格局", from: "2房1廳", to: "3房1廳" },
    { label: "樓層", from: "3F/5F", to: "5F/12F" },
  ]);
  const title = parseNotifyChanges("標題：舊標題 → 新標題");
  assert.equal(title[0].label, "標題");
  assert.equal(title[0].to, "新標題");
  assert.equal(isSameNotifyDetail("格局 2房 → 3房", "格局 2房 → 3房"), true);
  assert.equal(isSameNotifyDetail("格局 2房 → 3房", "格局 2房 → 4房"), false);
  assert.equal(isSameNotifyDetail(null, "格局 2房 → 3房"), false);
});

test("detects content diff and price changes", () => {
  const drop = classifyExistingUpdate(
    { ...listing, price: "25000", price_num: 25000 },
    listing,
  );
  assert.equal(drop.type, "price_drop");

  const up = classifyExistingUpdate(
    { ...listing, price: "30000", price_num: 30000 },
    listing,
  );
  assert.equal(up.type, "price_update");

  const layout = classifyExistingUpdate(
    { ...listing, layout: "3房2廳" },
    listing,
  );
  assert.equal(layout.type, "update");
  assert.match(layout.detail, /格局/);

  const relist = classifyExistingUpdate(listing, { ...listing, offline: 1, offline_confirmed: 0 });
  assert.equal(relist.type, "relist");
});

test("address enrichment churn is not a content update", () => {
  const existing = {
    ...listing,
    address: "杭州大廈 蘆洲區長安街274巷",
    area_name: "46坪",
    floor_name: "6F/6F",
    layout: "3房2廳2衛",
  };
  const incoming = {
    ...listing,
    address: "蘆洲區長安街274巷",
    area_name: "46坪",
    floor_name: "6F/6F",
    layout: "3房2廳2衛",
  };
  assert.equal(classifyExistingUpdate(incoming, existing).type, "seen");
  assert.equal(
    classifyExistingUpdate(
      { ...incoming, area_name: "46.0坪" },
      existing,
    ).type,
    "seen",
  );
});

test("non-watched content updates never notify", () => {
  assert.equal(shouldNotify(hookSettings, listing, { type: "update", detail: "地址 x → y" }), false);
  assert.equal(shouldNotify(hookSettings, { ...listing, watched: 0 }, { type: "update" }), false);
  assert.equal(shouldNotify(hookSettings, { ...listing, watched: "0" }, { type: "update" }), false);
  assert.equal(shouldNotify(hookSettings, watched, { type: "update", detail: "格局變更" }), true);
});

test("display floor filters also block notifications", () => {
  const low = { ...listing, kind_name: "整層住家", floor_name: "1F/5F", watched: 0 };
  const prefs = { ...hookSettings, wholeFloorOnly: true, excludeLowFloors: true };
  assert.equal(shouldNotify(prefs, low, { type: "new" }), false);
  assert.equal(
    shouldNotify(prefs, { ...low, floor_name: "3F/5F" }, { type: "new" }),
    true,
  );
});

test("webhook requires URL", () => {
  assert.equal(shouldWebhookNotify({ discordWebhook: "" }, listing, { type: "new" }), false);
});

test("notify matrix can silence webhook without silencing dock", () => {
  const settings = {
    discordWebhook: "https://discord.com/api/webhooks/1/abc",
    notifyMatrix: {
      new: { dock: true, webhook: false },
      update: { dock: false, webhook: true },
    },
  };
  assert.equal(shouldDockNotify(settings, listing, { type: "new" }), true);
  assert.equal(shouldWebhookNotify(settings, listing, { type: "new" }), false);
  assert.equal(shouldDockNotify(settings, watched, { type: "update" }), false);
  assert.equal(shouldWebhookNotify(settings, watched, { type: "update" }), true);
});

test("notify matrix off on both channels blocks delivery", () => {
  const settings = {
    discordWebhook: "https://discord.com/api/webhooks/1/abc",
    notifyMatrix: { new: { dock: false, webhook: false } },
  };
  assert.equal(shouldNotify(settings, listing, { type: "new" }), true);
  assert.equal(shouldDockNotify(settings, listing, { type: "new" }), false);
  assert.equal(shouldWebhookNotify(settings, listing, { type: "new" }), false);
});

test("list last_event maps price drop and title to update", () => {
  assert.equal(listingLastEvent("price_drop", listing), "update");
  assert.equal(listingLastEvent("relist", listing), "same_source");
  assert.equal(listingPriceNum({ price: "28,000" }), 28000);
});

test("notify facts add usable ping and housing type instead of 整層住家", () => {
  assert.equal(formatUsableArea({ area_name: "15.5坪" }), "可使用 15.5 坪");
  assert.equal(formatUsableArea({ area_name: "20" }), "可使用 20 坪");
  const apt = formatNotifyFacts({
    address: "士林區中山北路",
    layout: "2房1廳",
    floor_name: "5F/12F",
    area_name: "22坪",
    kind_name: "整層住家",
    tags: ["公寓"],
  });
  assert.match(apt, /可使用 22 坪/);
  assert.match(apt, /公寓$/);
  assert.doesNotMatch(apt, /整層住家/);
  const tower = formatNotifyFacts({
    kind_name: "整層住家",
    tags: ["電梯大樓"],
    area_name: "30坪",
  });
  assert.match(tower, /電梯公寓\/大樓$/);
  const suite = formatNotifyFacts({ kind_name: "獨立套房", area_name: "8坪" });
  assert.match(suite, /套房$/);
  const commute = formatNotifyFacts({
    address: "士林區中山北路",
    commute_km: 11.2,
    commute_min_am: 28,
    commute_min_pm: 35,
  });
  assert.match(commute, /機車路線約 11.2 公里/);
  assert.doesNotMatch(commute, /上約/);
  assert.doesNotMatch(commute, /下約/);
  const kmOnly = formatNotifyFacts({ route_km: 9.4, kind_name: "公寓" });
  assert.match(kmOnly, /機車路線約 9.4 公里/);
  const car = formatNotifyFacts({ route_km: 18.5, commute_mode: "car", kind_name: "公寓" });
  assert.match(car, /汽車路線約 18.5 公里/);
});

test("mail notify uses registered address and can be unchecked", () => {
  const to = "member@example.com";
  assert.equal(shouldMailNotify({}, listing, { type: "new" }, { to, configured: true }), false);
  assert.equal(
    shouldMailNotify(
      { notifyMatrix: { new: { dock: true, push: true, webhook: false, mail: true } } },
      listing,
      { type: "new" },
      { to, configured: true },
    ),
    true,
  );
  assert.equal(shouldMailNotify({}, listing, { type: "new" }, { to: "", configured: true }), false);
  assert.equal(shouldMailNotify({}, listing, { type: "new" }, { to, configured: false }), false);
  assert.equal(shouldMailNotify({}, listing, { type: "new" }, { to }), false);
  assert.equal(listingSmtpReady({ host: "smtp.member.test" }), true);
  assert.equal(listingSmtpReady(null), false);
  assert.equal(
    shouldMailNotify(
      { notifyMatrix: { new: { dock: true, webhook: true, mail: false } } },
      listing,
      { type: "new" },
      { to, configured: true },
    ),
    false,
  );
  const vars = listingNotifyVars(
    { type: "new", title: "士林二房", price: "28000", post_id: 123, address: "士林區" },
    { email: to },
  );
  assert.equal(vars.event, "全新物件");
  assert.equal(vars.price, "28000 元/月");
  assert.equal(vars.email, to);
  assert.match(vars.url, /123/);
});

test("notify posts listing mail to the registered inbox", async () => {
  const sent = [];
  const event = {
    type: "new",
    title: "士林二房",
    price: "28000",
    post_id: 88,
    address: "士林區中山北路",
    layout: "2房1廳",
    commute_km: 11,
    commute_min_am: 28,
    commute_min_pm: 35,
  };
  await notify({}, [], {
    mailEvents: [event],
    mailTo: "member@example.com",
    mailTemplates: defaultMailTemplates(),
    send: async (mail) => sent.push(mail),
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "member@example.com");
  assert.match(sent[0].subject, /全新物件/);
  assert.match(sent[0].text, /士林二房/);
  assert.match(sent[0].text, /28000/);
  assert.match(sent[0].text, /機車路線約 11 公里/);
  assert.doesNotMatch(sent[0].text, /上約/);
  assert.doesNotMatch(sent[0].text, /下約/);
});

test("notify digest packs several listings into one mail", async () => {
  const sent = [];
  await notify({}, [], {
    mailEvents: [
      { type: "new", title: "甲物件", price: "20000", post_id: 1 },
      { type: "price_drop", title: "乙物件", price: "18000", post_id: 2, detail: "22000 → 18000" },
    ],
    mailTo: "member@example.com",
    mailTemplates: defaultMailTemplates(),
    send: async (mail) => sent.push(mail),
  });
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /2 則更新/);
  assert.match(sent[0].text, /甲物件/);
  assert.match(sent[0].text, /乙物件/);
});

test("listing mail without member SMTP is skipped", async () => {
  await notify({}, [], {
    mailEvents: [{ type: "new", title: "甲物件", price: "20000", post_id: 1 }],
    mailTo: "member@example.com",
    mailTemplates: defaultMailTemplates(),
  });
});

test("listing mail keeps the member smtp on the payload", async () => {
  const sent = [];
  const smtp = { host: "smtp.member.test", from: "me@example.com" };
  await notify({}, [], {
    mailEvents: [{ type: "new", title: "甲物件", price: "20000", post_id: 1 }],
    mailTo: "member@example.com",
    mailTemplates: defaultMailTemplates(),
    smtp,
    send: async (mail) => sent.push(mail),
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].smtp.host, "smtp.member.test");
});
