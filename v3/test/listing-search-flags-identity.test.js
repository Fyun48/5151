import { test } from "node:test";
import assert from "node:assert/strict";
import { buildListListingsClauses } from "../src/db.js";

// astra6 §2：身分契約 —— 「清單狀態 flags」以**觀看者 uid** 為身分；
// 「配對／同戶關係」（vote、match）以 **voteUid** 為身分。兩者在真實情境會不同
// （例如管理員以他人視角檢視投票結果），因此必須用 fixture 把角色鎖住。
const ARGS = {
  filter: "all",
  districts: ["士林區"],
  settings: {},
  context: { searchKeys: [], isolation: { sql: "1 = 1", params: [] } },
};

test("flags 子句一律綁 uid（不是 voteUid）：uid 命中數須 ≥ user_listing_flags 子句數", () => {
  const built = buildListListingsClauses({ ...ARGS, uid: 101, voteUid: 202 });
  const flagClauses = (String(built.where).match(/user_listing_flags/g) || []).length;
  assert.ok(flagClauses > 0, "應產生至少一個 flags 子句");
  const uidHits = built.params.filter((p) => Number(p) === 101).length;
  assert.ok(
    uidHits >= flagClauses,
    `每個 flags 子句都必須綁 uid：uid 命中 ${uidHits}、flags 子句 ${flagClauses}`,
  );
});

test("watched 篩選的 flags 子句同樣綁 uid（不是 voteUid）", () => {
  const built = buildListListingsClauses({ ...ARGS, filter: "watched", uid: 101, voteUid: 202 });
  const flagClauses = (String(built.where).match(/user_listing_flags/g) || []).length;
  assert.ok(flagClauses > 0, "watched 應以 user_listing_flags 判定");
  const uidHits = built.params.filter((p) => Number(p) === 101).length;
  assert.ok(uidHits >= flagClauses, `watched 的 flags 子句必須綁 uid（uid 命中 ${uidHits}）`);
});

test("未確認下架（unseen）亦綁 uid，且 SQL 結構不因 uid／voteUid 值而變", () => {
  const a = buildListListingsClauses({ ...ARGS, filter: "unseen", uid: 101, voteUid: 202 });
  const b = buildListListingsClauses({ ...ARGS, filter: "unseen", uid: 202, voteUid: 101 });
  assert.equal(a.where, b.where, "角色交換不得改變 SQL 結構");
  const flagClauses = (String(a.where).match(/user_listing_flags/g) || []).length;
  assert.ok(flagClauses > 0);
  assert.ok(
    a.params.filter((p) => Number(p) === 101).length >= flagClauses,
    "unseen 的 flags 子句必須綁 uid",
  );
});
