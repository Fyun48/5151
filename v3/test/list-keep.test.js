import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  keptListShouldRerender,
  listLoadBlockedByNotes,
  mergeAppendedListings,
} from "../src/listKeep.js";

const html = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../public/index.html"),
  "utf8",
);

test("load more is not blocked by 特別關注 note focus", () => {
  assert.equal(listLoadBlockedByNotes({ noteBusy: true }), true);
  assert.equal(listLoadBlockedByNotes({ noteBusy: true, force: true }), false);
  assert.equal(listLoadBlockedByNotes({ noteBusy: true, append: true }), false);
  assert.equal(listLoadBlockedByNotes({ noteBusy: false, append: true }), false);
  assert.match(html, /if \(!options\.force && !options\.append && watchNoteBusy\(\)\)/);
  assert.match(html, /if \(!options\.force && !append && watchNoteBusy\(\)\)/);
  assert.match(html, /loadList\(\{ append: true, keep: true, silent: false, busyText: "正在載入更多…" \}\)/);
  assert.doesNotMatch(html, /loadList\(\{ append: true, keep: true, silent: true/);
  assert.match(html, /if \(options\.keep && !append && listCache\.length && !options\.refreshCards\)/);
  assert.match(html, /if \(append\) syncListMore/);
});

test("append merge keeps existing cards and drops duplicate post ids", () => {
  const first = [{ post_id: 1, title: "已關注 A" }, { post_id: 2, title: "已關注 B" }];
  const page = [{ post_id: 2, title: "重複 B" }, { post_id: 3, title: "新的 C" }];
  assert.deepEqual(
    mergeAppendedListings(first, page).map((row) => row.post_id),
    [1, 2, 3],
  );
  assert.equal(mergeAppendedListings(first, page)[1].title, "已關注 B");
  assert.equal(keptListShouldRerender(first, first, { append: true }), true);
  assert.equal(keptListShouldRerender(first, first), false);
});
