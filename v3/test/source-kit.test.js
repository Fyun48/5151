import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHbDetailHtml } from "../src/hbhousing.js";
import { parseHfDetailHtml } from "../src/housefun.js";
import { kitFromActiveNames } from "../src/listingKit.js";
import { parseRakuyaDetailHtml } from "../src/rakuya.js";
import { parseSinyiDetailHtml } from "../src/sinyi.js";
import { fetchSourceKit, isSourceKitSource, resolveSourceKitUrl } from "../src/sourceKit.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const readFix = (name) => readFileSync(path.join(dir, "fixtures", name), "utf8");

test("kitFromActiveNames keeps ticked items and maps 床組", () => {
  const kit = kitFromActiveNames(["洗衣機", "天然瓦斯", "1陽台", "床組", "冰箱"]);
  assert.equal(kit.has_natural_gas, true);
  assert.equal(kit.has_balcony, true);
  assert.deepEqual(kit.furnish_items, ["洗衣機", "床", "冰箱"]);
});

test("住商明細讀 NUXT 家俱、瓦斯與陽台", () => {
  const kit = parseHbDetailHtml(readFix("hbhousing-detail-kit.html"));
  assert.equal(kit.has_natural_gas, true);
  assert.equal(kit.has_balcony, true);
  assert.ok(kit.furnish_items.includes("冷氣"));
  assert.ok(kit.furnish_items.includes("洗衣機"));
  assert.ok(kit.furnish_items.includes("沙發"));
  assert.equal(kit.furnish_items.includes("陽台"), false);
});

test("信義明細只採已勾傢俱，未勾電視冰箱不寫", () => {
  const kit = parseSinyiDetailHtml(readFix("sinyi-detail-kit.html"));
  assert.equal(kit.has_natural_gas, true);
  assert.deepEqual(kit.furnish_items, ["沙發", "洗衣機", "冷氣"]);
  assert.equal(kit.furnish_items.includes("電視"), false);
  assert.equal(kit.furnish_items.includes("冰箱"), false);
});

test("好房明細只採 tableData has，略過生活機能", () => {
  const kit = parseHfDetailHtml(readFix("housefun-detail-kit.html"));
  assert.equal(kit.has_natural_gas, true);
  assert.equal(kit.has_balcony, true);
  assert.deepEqual(kit.furnish_items, ["洗衣機", "冷氣", "衣櫃"]);
  assert.equal(kit.furnish_items.includes("冰箱"), false);
  assert.equal(kit.furnish_items.includes("傳統市場"), false);
});

test("樂屋明細讀設備瓦斯陽台", () => {
  const detail = parseRakuyaDetailHtml(readFix("rakuya-detail.html"), "https://www.rakuya.com.tw/rent_item/info?ehid=rk001");
  assert.equal(detail.has_natural_gas, true);
  assert.equal(detail.has_balcony, true);
  assert.ok(detail.furnish_items.includes("洗衣機"));
  assert.ok(detail.furnish_items.includes("冷氣"));
});

test("empty source pages do not count as fetched kit", () => {
  assert.throws(() => parseHbDetailHtml("<html></html>"), { code: "KIT_PARSE_EMPTY" });
  assert.throws(() => parseSinyiDetailHtml("<html></html>"), { code: "KIT_PARSE_EMPTY" });
  assert.throws(() => parseHfDetailHtml("<html></html>"), { code: "KIT_PARSE_EMPTY" });
});

test("source kit URL must stay on the listing host", () => {
  assert.throws(
    () => resolveSourceKitUrl({ source: "sinyi", url: "https://127.0.0.1/steal" }, "https://evil.example/x"),
    { code: "KIT_PARSE_EMPTY" },
  );
  assert.equal(
    resolveSourceKitUrl(
      { source: "housefun", url: "https://evil.example/x" },
      "https://rent.housefun.com.tw/rent/house/1/",
    ),
    "https://rent.housefun.com.tw/rent/house/1/",
  );
});

test("fetchSourceKit routes four sources and skips 591／5168／租租通", async () => {
  assert.equal(isSourceKitSource("sinyi"), true);
  assert.equal(isSourceKitSource("591"), false);
  assert.equal(isSourceKitSource("houseprice"), false);
  assert.equal(isSourceKitSource("ddroom"), false);
  await assert.rejects(
    () => fetchSourceKit(
      { source: "rakuya", url: "https://www.rakuya.com.tw/rent_item/info?ehid=rk001" },
      { fetchText: async () => ({ status: 200, text: "<html>Just a moment... cf-browser-verification</html>" }) },
    ),
    { code: "FETCH_BLOCKED" },
  );
  const kit = await fetchSourceKit(
    { source: "housefun", url: "https://rent.housefun.com.tw/rent/house/1/" },
    { fetchText: async () => ({ status: 200, text: readFix("housefun-detail-kit.html") }) },
  );
  assert.equal(kit.has_natural_gas, true);
  assert.deepEqual(kit.furnish_items, ["洗衣機", "冷氣", "衣櫃"]);
});
