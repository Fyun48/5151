// 三個清單（一般／特別關注／已隱藏）的 `totalMatched` 實測 ＋ 可解得開的算式（唯讀）。
//
// 用法：
//   set -a; . /home/cline/.secrets/postgres/5151-live-repro.env; set +a
//   PG_URL="$PG_LIVE_REPRO_URL" MEMBER_UID=1 node v3/scripts/fold-lists-totalmatched.mjs
//
// 算式（Owner 2026-10-12 裁示③之後）：
//   totalMatched(filter) = 自己旗標就符合的列 ＋ 因「群內任一成員符合」而由主卡代表的列
// 前者＝該列自己的 watched／hidden（例：filter=watched 且 row.watched=1）；
// 後者＝主卡那一列本身旗標不符，但 `same_house_group_watched/hidden=1`。次卡一律不列。
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { buildListRequestContextFromPg } from "../src/db.js";
import { loadListingPage } from "../src/listingSearchPage.js";

assertPgTargetAllowed("fold-lists-totalmatched", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });
const drv = await createPostgresDriver({ env: process.env });
const uid = Number(process.env.MEMBER_UID || 1) || 1;
const exec = (sql, params = []) => drv.pool.query(sql, params).then((r) => r.rows);

const probe = await buildListRequestContextFromPg(exec, { asOf: null });
const settings = probe.settingsForUser(uid);

const out = [];
for (const filter of ["all", "watched", "hidden"]) {
  const page = await loadListingPage(
    { filter, kind: "", sources: "", q: "", limit: 20000, offset: 0, userId: uid, matchVoteUserId: uid, sameHouse: true, settings },
    { driver: "postgres", pgDriver: drv },
  );
  const rows = page.listings || [];
  const ownKey = filter === "hidden" ? "hidden" : filter === "watched" ? "watched" : null;
  let own = 0;
  let groupOnly = 0;
  let dupForced = 0;
  for (const row of rows) {
    const dup = String(row.match_verdict || "") === "yes";
    if (ownKey && Number(row[ownKey]) === 1) own += 1;
    else if (filter !== "all" && dup) dupForced += 1;
    else groupOnly += 1;
  }
  out.push({
    filter,
    totalMatched: Number(page.timing?.dataset) || null,
    statsTotal: page.stats?.total ?? null,
    rowsReturned: rows.length,
    arithmetic: filter === "all"
      ? { formula: "自己旗標符合（未看過且未關注）", own }
      : { formula: "自己旗標符合 ＋ 群主卡代表（群內任一成員符合） ＋ dup（系統重複）", own, groupOnly, dupForced },
    affiliateRows: rows.filter((r) => String(r.same_house_role || "") === "affiliate").length,
  });
  console.log(`── ${filter}: totalMatched=${out.at(-1).totalMatched} statsTotal=${out.at(-1).statsTotal} returned=${rows.length}`);
}

console.log(JSON.stringify({ uid, out }, null, 2));
await drv.pool.end();
