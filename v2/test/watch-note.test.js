import { test } from "node:test";
import assert from "node:assert/strict";
import { nextWatchNote } from "../src/watchFlags.js";

const listing = { watch_note: "採光好，可養貓" };

test("unwatch keeps the existing note even if the request sends an empty note", () => {
  assert.equal(nextWatchNote(listing, { watched: false }), "採光好，可養貓");
  assert.equal(nextWatchNote(listing, { watched: false, watch_note: "" }), "採光好，可養貓");
  assert.equal(nextWatchNote(listing, { watched: 0, watch_note: "   " }), "採光好，可養貓");
});

test("watching again can send the stored note or a new one", () => {
  assert.equal(nextWatchNote(listing, { watched: true }), "採光好，可養貓");
  assert.equal(nextWatchNote(listing, { watched: true, watch_note: "格局方正" }), "格局方正");
});

test("an explicit new note still replaces the old one while watched", () => {
  assert.equal(nextWatchNote(listing, { watch_note: "改備註" }), "改備註");
});
