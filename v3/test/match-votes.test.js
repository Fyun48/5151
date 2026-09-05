import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MATCH_SPLIT_DAILY_LIMIT,
  pairConfidence,
  shouldPromoteGlobalSplit,
  votePair,
  votePairKey,
} from "../src/matchVotes.js";

const dir = path.dirname(fileURLToPath(import.meta.url));

test("vote pairs normalize order and promotion needs more than one person", () => {
  assert.deepEqual(votePair(22, 11), [11, 22]);
  assert.equal(votePairKey(22, 11), "11:22");
  assert.equal(pairConfidence({ match_level: "medium" }, { match_level: "high" }), "high");
  assert.equal(shouldPromoteGlobalSplit({ split: 1, confidence: "high" }), false);
  assert.equal(shouldPromoteGlobalSplit({ split: 2, confidence: "medium" }), true);
  assert.equal(shouldPromoteGlobalSplit({ split: 2, confidence: "high" }), false);
  assert.equal(shouldPromoteGlobalSplit({ split: 3, confidence: "high" }), true);
  assert.equal(shouldPromoteGlobalSplit({ split: 3, same: 3, confidence: "high" }), false);
  assert.equal(MATCH_SPLIT_DAILY_LIMIT, 8);
});

test("personal split hides affiliate only for that user until consensus", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-match-votes-"));
  const script = `
    import {
      ensureUser,
      listListings,
      rejectSuspectedMatch,
      setListingMatch,
      upsertListing,
    } from ${JSON.stringify(path.join(dir, "../src/db.js"))};
    const stamp = "2026-09-05T00:00:00.000Z";
    const cheap = {
      post_id: 910001,
      source_key: "1|1|cheap",
      search_key: "https://example.test",
      title: "南港便宜",
      url: "https://rent.591.com.tw/910001",
      price: "32000元",
      price_num: 32000,
      extra_fees: [],
      address: "台北市南港區忠孝東路七段1號",
      area_name: "20坪",
      layout: "2房1廳",
      floor_name: "5/12",
      kind_name: "整層住家",
      role_name: "",
      cover: "",
      tags: "[]",
      refresh_time: "",
      first_seen_at: stamp,
      last_seen_at: stamp,
      last_event: "new",
      source: "591",
    };
    upsertListing(cheap);
    upsertListing({
      ...cheap,
      post_id: 910002,
      source_key: "1|1|pricey",
      title: "南港較貴",
      url: "https://rent.591.com.tw/910002",
      price: "34000元",
      price_num: 34000,
      extra_fee: 3500,
      extra_fees: [{ name: "管理費", value: "另計 3500", amount: 3500 }],
      source: "591",
    });
    setListingMatch(910002, { match_post_id: 910001, match_level: "high", match_detail: "同屋源" });
    const guest = listListings({ filter: "guest", sort: "newest", limit: 20, matchVoteUserId: 0 });
    const idsGuest = (guest.listings || []).map((row) => row.post_id);
    const primary = (guest.listings || []).find((row) => row.post_id === 910001);
    const alice = ensureUser("alice-split@example.com");
    const bob = ensureUser("bob-split@example.com");
    const first = rejectSuspectedMatch(910002, alice, { peerId: 910001 });
    const aliceList = listListings({ filter: "guest", sort: "newest", limit: 20, userId: alice, matchVoteUserId: alice });
    const bobList = listListings({ filter: "guest", sort: "newest", limit: 20, userId: bob, matchVoteUserId: bob });
    const second = rejectSuspectedMatch(910002, bob, { peerId: 910001 });
    const third = rejectSuspectedMatch(910002, ensureUser("cara-split@example.com"), { peerId: 910001 });
    const after = listListings({ filter: "guest", sort: "newest", limit: 20, matchVoteUserId: 0 });
    console.log(JSON.stringify({
      guestIds: idsGuest,
      guestHasCompare: Boolean(primary?.same_house?.compare?.headline),
      headline: primary?.same_house?.compare?.headline || "",
      firstOk: first.ok,
      firstPromoted: first.promoted,
      firstVerdict: first.listing?.match_verdict || "",
      aliceHasExpensive: (aliceList.listings || []).some((row) => row.post_id === 910002),
      alicePrimaryHouse: Boolean((aliceList.listings || []).find((row) => row.post_id === 910001)?.same_house),
      bobStillBundled: Boolean((bobList.listings || []).find((row) => row.post_id === 910001)?.same_house),
      bobHidesExpensive: !(bobList.listings || []).some((row) => row.post_id === 910002),
      thirdPromoted: third.promoted,
      afterIds: (after.listings || []).map((row) => row.post_id),
      afterBundled: Boolean((after.listings || []).find((row) => row.post_id === 910001)?.same_house),
    }));
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const line = result.stdout.trim().split("\n").filter((row) => row.startsWith("{")).at(-1);
    const out = JSON.parse(line);
    assert.deepEqual(out.guestIds.filter((id) => id === 910001 || id === 910002), [910001]);
    assert.equal(out.guestHasCompare, true);
    assert.match(out.headline, /總月費差/);
    assert.equal(out.firstOk, true);
    assert.equal(out.firstPromoted, false);
    assert.equal(out.firstVerdict, "");
    assert.equal(out.aliceHasExpensive, true);
    assert.equal(out.alicePrimaryHouse, false);
    assert.equal(out.bobStillBundled, true);
    assert.equal(out.bobHidesExpensive, true);
    assert.equal(out.thirdPromoted, true);
    assert.equal(out.afterBundled, false);
    assert.ok(out.afterIds.includes(910001));
    assert.ok(out.afterIds.includes(910002));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
