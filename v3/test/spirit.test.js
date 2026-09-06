import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSpirit, normalizeSpirit, publicSpirit } from "../src/spirit.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(dir, rel), "utf8");

test("spirit defaults and normalize", () => {
  const d = defaultSpirit();
  assert.match(d.title, /這個站為什麼存在/);
  assert.match(d.body, /## 我們看見的問題/);
  const empty = normalizeSpirit({});
  assert.equal(empty.title, d.title);
  assert.equal(empty.body, d.body);
  const custom = normalizeSpirit({ title: "  新理念  ", body: "第一段\n\n## 小標\n- 一\n- 二" });
  assert.equal(custom.title, "新理念");
  assert.match(custom.body, /## 小標/);
  const clipped = normalizeSpirit({ title: "x".repeat(200) });
  assert.equal(clipped.title.length, 120);
  assert.equal(publicSpirit({ title: "" }).title, d.title);
});

test("spirit page and admin editor are wired to /api/spirit", () => {
  const spirit = read("../public/spirit.html");
  assert.match(spirit, /id="spiritTitle"/);
  assert.match(spirit, /id="spiritBody"/);
  assert.match(spirit, /fetch\("\/api\/spirit"/);
  const admin = read("../public/admin.html");
  assert.match(admin, /id="spiritForm"/);
  assert.match(admin, /\/api\/admin\/spirit/);
  assert.match(admin, /loadSpirit\(\)/);
  const server = read("../src/server.js");
  assert.match(server, /app\.get\("\/api\/spirit"/);
  assert.match(server, /app\.put\("\/api\/admin\/spirit", requireAdminApi/);
  const auth = read("../src/auth.js");
  assert.match(auth, /p === "\/api\/spirit"/);
});
