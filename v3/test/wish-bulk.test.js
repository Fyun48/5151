import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WISH_BULK_SECTION_SELECTOR,
  applyWishBulkToSection,
  findWishBulkSection,
  nextWishBulkStates,
  wishBulkConditionRowsFromSection,
} from "../src/wishBulk.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(dir, "../public/index.html"), "utf8");

const PETS = [
  { id: "need_cook", allowWant: true, allowAvoid: true, current: "unspecified" },
  { id: "need_pet", allowWant: true, allowAvoid: true, current: "unspecified" },
  { id: "need_subsidy", allowWant: false, allowAvoid: true, current: "unspecified" },
];
const BUILDING = [
  { id: "elevator", allowWant: true, allowAvoid: true, current: "want" },
  { id: "manage", allowWant: true, allowAvoid: false, current: "unspecified" },
];

function fakeNode({ tag, className = "", attrs = {}, children = [], parent = null }) {
  const node = {
    tag,
    className,
    dataset: {},
    attrs: { ...attrs },
    children,
    parent,
    getAttribute(name) { return this.attrs[name]; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    closest(sel) {
      let cur = this;
      while (cur) {
        if (sel === ".wish-v2-cat" && cur.className.split(/\s+/).includes("wish-v2-cat")) return cur;
        if (sel === "[data-wish-cat]" && ("wishCat" in cur.dataset || cur.attrs["data-wish-cat"] != null)) return cur;
        if (sel === "[data-wish-bulk]" && ("wishBulk" in cur.dataset || cur.attrs["data-wish-bulk"] != null)) return cur;
        cur = cur.parent;
      }
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (el) => {
        if (match(el, sel)) out.push(el);
        (el.children || []).forEach(walk);
      };
      (this.children || []).forEach(walk);
      return out;
    },
  };
  if (attrs["data-wish-cat"] != null) node.dataset.wishCat = attrs["data-wish-cat"];
  if (attrs["data-wish-bulk"] != null) node.dataset.wishBulk = attrs["data-wish-bulk"];
  if (attrs["data-wish-v2"] != null) node.dataset.wishV2 = attrs["data-wish-v2"];
  if (attrs["data-wish-action"] != null) node.dataset.wishAction = attrs["data-wish-action"];
  for (const child of children) child.parent = node;
  return node;
}

function match(el, sel) {
  if (sel === "[data-wish-v2]") return Boolean(el.dataset.wishV2);
  const id = sel.match(/^\[data-wish-v2="(.+)"\]$/)?.[1];
  return id ? el.dataset.wishV2 === id : false;
}

function makeCondition(section, id, { want = true, avoid = true, current = "unspecified" } = {}) {
  const btns = [
    fakeNode({ tag: "button", attrs: { "data-wish-v2": id, "data-wish-action": "unspecified", "aria-pressed": current === "unspecified" ? "true" : "false" } }),
  ];
  if (want) {
    btns.push(fakeNode({ tag: "button", attrs: { "data-wish-v2": id, "data-wish-action": "want", "aria-pressed": current === "want" ? "true" : "false" } }));
  }
  if (avoid) {
    btns.push(fakeNode({ tag: "button", attrs: { "data-wish-v2": id, "data-wish-action": "avoid", "aria-pressed": current === "avoid" ? "true" : "false" } }));
  }
  const row = fakeNode({ tag: "div", className: "wish-v2-row", children: btns });
  section.children.push(row);
  row.parent = section;
  btns.forEach((btn) => { btn.parent = row; });
  return btns;
}

function makeCatalog() {
  const pets = fakeNode({ tag: "section", className: "wish-v2-cat", attrs: { "data-wish-cat": "pets" } });
  const building = fakeNode({ tag: "section", className: "wish-v2-cat", attrs: { "data-wish-cat": "building" } });
  const petsBulk = fakeNode({
    tag: "button",
    className: "ghost",
    attrs: { "data-wish-bulk": "want", "data-wish-cat": "pets" },
    parent: pets,
  });
  pets.children.push(petsBulk);
  makeCondition(pets, "need_cook");
  makeCondition(pets, "need_pet");
  makeCondition(pets, "need_subsidy", { want: false });
  makeCondition(building, "elevator", { current: "want" });
  makeCondition(building, "manage", { avoid: false });
  return { pets, building, petsBulk };
}

test("old closest([data-wish-cat]) hits the bulk button and would no-op", () => {
  const { pets, petsBulk } = makeCatalog();
  const buggy = petsBulk.closest("[data-wish-cat]");
  assert.equal(buggy, petsBulk);
  assert.equal(buggy.querySelectorAll("[data-wish-v2]").length, 0);
  const section = findWishBulkSection(petsBulk);
  assert.equal(section, pets);
  assert.equal(WISH_BULK_SECTION_SELECTOR, ".wish-v2-cat");
  assert.ok(wishBulkConditionRowsFromSection(section).length >= 3);
});

test("category bulk want only sets conditions that allow want", () => {
  const next = nextWishBulkStates(PETS, "want");
  assert.equal(next.need_cook, "want");
  assert.equal(next.need_pet, "want");
  assert.equal(next.need_subsidy, "unspecified");
});

test("category bulk avoid only sets conditions that allow avoid", () => {
  const next = nextWishBulkStates(BUILDING, "avoid");
  assert.equal(next.elevator, "avoid");
  assert.equal(next.manage, "unspecified");
});

test("category clear returns every condition to unspecified", () => {
  const next = nextWishBulkStates([
    { id: "need_cook", allowWant: true, allowAvoid: true, current: "want" },
    { id: "need_pet", allowWant: true, allowAvoid: true, current: "avoid" },
  ], "clear");
  assert.equal(next.need_cook, "unspecified");
  assert.equal(next.need_pet, "unspecified");
});

test("capability restriction keeps illegal polarity unspecified", () => {
  const next = nextWishBulkStates(PETS, "want");
  assert.equal(next.need_subsidy, "unspecified");
  assert.notEqual(next.need_subsidy, "want");
});

test("bulk on one category does not rewrite another category", () => {
  const { pets, building } = makeCatalog();
  applyWishBulkToSection(pets, "want");
  const petsRows = wishBulkConditionRowsFromSection(pets);
  const buildingRows = wishBulkConditionRowsFromSection(building);
  assert.equal(petsRows.find((row) => row.id === "need_cook").current, "want");
  assert.equal(buildingRows.find((row) => row.id === "elevator").current, "want");
  assert.equal(buildingRows.find((row) => row.id === "manage").current, "unspecified");
});

test("index.html uses section selector and keeps 375 tri-state markup", () => {
  assert.match(html, /class="wish-v2-cat"/);
  assert.match(html, /bulk\.closest\("\.wish-v2-cat"\)/);
  assert.doesNotMatch(html, /bulk\.closest\("\[data-wish-cat\]"\)/);
  assert.match(html, /data-wish-bulk="want"/);
  assert.match(html, /data-wish-bulk="avoid"/);
  assert.match(html, /data-wish-bulk="clear"/);
  assert.match(html, /btn\("unspecified", "未指定"\)/);
  assert.match(html, /btn\("want", "要有"\)/);
  assert.match(html, /btn\("avoid", "不要"\)/);
  assert.match(html, /min-height: var\(--touch\)/);
  assert.match(html, /@media \(max-width: 480px\) \{[\s\S]*\.wish-seg button \{ flex: 1; \}/);
  assert.match(html, /id="wishClearAll"/);
});
