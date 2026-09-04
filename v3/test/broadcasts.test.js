import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBroadcasts, publicBroadcasts } from "../src/broadcasts.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("broadcasts hide until enabled with copy", () => {
  const cfg = normalizeBroadcasts({
    items: {
      announcement: { enabled: true, title: "維護", body: "凌晨暫停", hops: 2 },
      news: { enabled: true, title: "", body: "", hops: 3 },
      sponsor: { enabled: true, title: "贊助", body: "讓站台維持免費", url: "javascript:alert(1)", hops: 99 },
    },
  });
  assert.equal(cfg.items.announcement.enabled, true);
  assert.equal(cfg.items.news.enabled, false);
  assert.equal(cfg.items.sponsor.hops, 20);
  const pub = publicBroadcasts(cfg);
  assert.equal(pub.length, 2);
  assert.equal(pub.find((row) => row.id === "sponsor").url, "");
});

test("admin and index expose broadcast and spirit page", () => {
  const admin = readFileSync(path.join(dir, "../public/admin.html"), "utf8");
  const index = readFileSync(path.join(dir, "../public/index.html"), "utf8");
  const spirit = readFileSync(path.join(dir, "../public/spirit.html"), "utf8");
  const server = readFileSync(path.join(dir, "../src/server.js"), "utf8");
  assert.match(admin, /公告／最新消息／贊助提醒/);
  assert.match(admin, /\/api\/admin\/broadcasts/);
  assert.match(index, /id="siteNotice"/);
  assert.match(index, /maybeShowBroadcast/);
  assert.match(index, /spirit\.html/);
  assert.match(index, /profileName"\)\.value = "暫存"/);
  assert.match(spirit, /這個站為什麼存在/);
  assert.match(spirit, /居住正義/);
  assert.match(server, /publicBroadcastsSettings/);
});
