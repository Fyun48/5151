import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SELF_TRAIT_GROUPS,
  LEGACY_TRAIT_LABELS,
  normalizeSelfTraits,
  normalizeSelfTraitsInput,
  selfTraitLabels,
} from "../src/selfTraits.js";

const activeIds = new Set(SELF_TRAIT_GROUPS.flatMap((g) => g.items.map((i) => i.id)));

test("new form taxonomy: negative living conditions, no 適合對象, no 近捷運", () => {
  // 生活條件改為否定式全新 id（不重用舊的正向 id，避免語意反轉）
  assert.ok(activeIds.has("nocook") && activeIds.has("nopet") && activeIds.has("notax"));
  assert.ok(!activeIds.has("cook") && !activeIds.has("pet") && !activeIds.has("tax"));
  assert.ok(!activeIds.has("mrt")); // 近捷運已移除
  // 適合對象整組移除（降低居住歧視）
  assert.ok(!SELF_TRAIT_GROUPS.some((g) => g.id === "who"));
  for (const id of ["anygender", "female", "male", "student", "worker"]) assert.ok(!activeIds.has(id));
  // 建物新增
  assert.ok(activeIds.has("trash24") && activeIds.has("parcel"));
  // 設備新增
  assert.ok(activeIds.has("heater_e") && activeIds.has("cable") && activeIds.has("dining"));
});

test("label refinements keep the SAME id (no data inversion, presence still = has feature)", () => {
  const label = (id) => SELF_TRAIT_GROUPS.flatMap((g) => g.items).find((i) => i.id === id)?.label;
  assert.equal(label("trash"), "社區定時定點集中收垃圾");
  assert.equal(label("manage"), "有門衛管理");
  assert.equal(label("community"), "電梯大樓");
  assert.equal(label("elevator"), "電梯華廈／寓");
  assert.equal(label("heater"), "瓦斯熱水器");
});

test("new submissions reject deprecated/discriminatory ids", () => {
  const cleaned = normalizeSelfTraitsInput(["cook", "pet", "tax", "mrt", "female", "student", "nocook", "elevator", "unknown"]);
  assert.deepEqual(cleaned, ["nocook", "elevator"]); // 只留有效 id，保序
});

test("historical listings still display deprecated labels (backward compatible)", () => {
  // 既有刊登可能存有 cook/pet/tax/who ；顯示不可遺失、不可反轉
  assert.equal(LEGACY_TRAIT_LABELS.cook, "可開伙");
  assert.equal(LEGACY_TRAIT_LABELS.tax, "可報稅");
  const labels = selfTraitLabels(["cook", "pet", "tax", "female", "elevator"]);
  assert.ok(labels.includes("可開伙"));
  assert.ok(labels.includes("可報稅"));
  assert.ok(labels.includes("限女性"));
  assert.ok(labels.includes("電梯華廈／寓"));
  // 顯示用 normalize 保留 legacy ids（不丟棄歷史）
  assert.deepEqual(normalizeSelfTraits(["cook", "elevator"]), ["cook", "elevator"]);
});

test("A3：共用條件目錄的名稱優先於靜態標籤（後台改名要同步到卡片與分享頁）", () => {
  // 這一條是 A3 的根因：舊寫法把目錄標籤放在 || 後面，後台改名永遠被靜態表蓋掉。
  assert.deepEqual(selfTraitLabels(["elevator"], { elevator: "華廈/公寓電梯" }), ["華廈/公寓電梯"]);
  assert.deepEqual(selfTraitLabels(["elevator"], new Map([["elevator", "電梯華廈"]])), ["電梯華廈"]);
  // 目錄沒有的 id（legacy）仍落回靜態標籤，歷史顯示不變
  assert.deepEqual(selfTraitLabels(["cook", "elevator"], { elevator: "華廈/公寓電梯" }), ["可開伙", "華廈/公寓電梯"]);
  // 沒有目錄時維持原樣
  assert.deepEqual(selfTraitLabels(["elevator"]), ["電梯華廈／寓"]);
  // 目錄給了空字串時不可把標籤吃掉（fallback 仍要能顯示）
  assert.deepEqual(selfTraitLabels(["elevator"], { elevator: "" }), ["電梯華廈／寓"]);
});

test("A3：後台必須看得出來目錄草稿還沒發布", async () => {
  const fs = await import("node:fs/promises");
  const html = await fs.readFile(new URL("../public/admin.html", import.meta.url), "utf8");
  assert.match(html, /草稿，未發布/);
  assert.match(html, /尚未發布：確認並發布/);
  assert.match(html, /listingCatalogPreviewTitle/);
  assert.match(html, /「寫入草稿」只存草稿，前台不會變/);
});
