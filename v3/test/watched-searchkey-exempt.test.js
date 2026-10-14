// 特別關注（watched）候選**豁免 search_key 子句**（Owner 2026-10-14 裁決）。
//
// 背景（2026-10-14 唯讀調查）：`buildListListingsClauses()` 以前把 `searchWhere()`
// （`(search_key IN (…) OR source='self')`）放在**所有 filter 之前**先跑，於是「特別關注」
// 這條**配額管理清單**也被 search_key 篩過一次：正式站實測 83 筆 watched 旗標有 61 筆（73%）
// 落在當時的 request-time key 集合之外 ⇒ 會員看得到配額被佔用，卻看不到那一列、也無法取消
// （個案：uid=2 / post 2458719926，它的 search_key 是已退役的 crawler URL
//  `region=1&section=2,3,8,9`，不在 `expandSearchKeysAgainst()` 展開出來的清單裡）。
//
// 這與「特別關注不被行政區／類型／樓層／來源再篩空」的既有契約相衝 ⇒ Owner 裁決：watched
// 豁免 search_key 子句；其餘 filter（all／unseen／viewed／hidden／offline／suspected）逐字不變。
//
// 改動前這支測試會紅（watched 只回得到在 search_key 範圍內的那一筆）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const src = (name) => JSON.stringify(pathToFileURL(path.join(dir, "../src", name)).href);

test("watched 候選不受 search_key 限制；其餘 filter 逐字不變", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "v3-watch-exempt-"));
  const script = `
    import { listListings, upsertListing, setFlags, defaultUserId, getSettings } from ${src("db.js")};
    const stamp = "2026-09-06T00:00:00.000Z";
    const uid = defaultUserId();
    // 使用者的搜尋 URL 與 crawler 實際落地的 search_key 必須「section 字串逐字相同」才會被
    // expandSearchKeysAgainst()＋sameSearch() 收進來（見 src/client591.js）。
    const IN_SCOPE = "https://rent.591.com.tw/list?region=1&section=8,9";
    const OUT_SCOPE = "https://rent.591.com.tw/list?region=1&section=2,3,8,9"; // 已退役的 crawler URL
    function mk(post_id, search_key, title) {
      upsertListing({ post_id, source: "591", source_key: "1|8|||台北市士林區中正路", search_key,
        title, url: "https://rent.591.com.tw/" + post_id, price: "20000元", price_num: 20000, extra_fees: [],
        address: "台北市士林區中正路" + post_id + "號", area_name: "20坪", layout: "2房1廳",
        floor_name: "5/12", kind_name: "整層住家", role_name: "", cover: "", tags: "[]",
        refresh_time: "", first_seen_at: stamp, last_seen_at: stamp, last_event: "new" });
    }
    mk(910001, IN_SCOPE, "範圍內／已特別關注");
    mk(910002, OUT_SCOPE, "範圍外／已特別關注");
    mk(910003, OUT_SCOPE, "範圍外／未特別關注");
    mk(910004, IN_SCOPE, "範圍內／未特別關注");
    setFlags(910001, { watched: true }, uid);
    setFlags(910002, { watched: true }, uid);
    const settings = { ...getSettings(uid), searchUrls: [IN_SCOPE], watchDistricts: [] };
    const ids = (r) => (r.listings || []).map((x) => x.post_id).sort((a, b) => a - b);
    console.log(JSON.stringify({
      watched: ids(listListings({ filter: "watched", sort: "newest", userId: uid, settings, districts: [], searchKeys: [IN_SCOPE] })),
      all: ids(listListings({ filter: "all", sort: "newest", userId: uid, settings, districts: [], searchKeys: [IN_SCOPE] })),
      unseen: ids(listListings({ filter: "unseen", sort: "newest", userId: uid, settings, districts: [], searchKeys: [IN_SCOPE] })),
    }));
  `;
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8",
      env: { ...process.env, DATA_DIR: dataDir },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const out = JSON.parse(result.stdout.trim().split("\n").filter((line) => line.startsWith("{")).at(-1));
    assert.deepEqual(out.watched, [910001, 910002],
      "特別關注是配額管理清單：兩筆關注都要看得到（含 search_key 在範圍外的那一筆），否則無法取消");
    assert.deepEqual(out.all, [910004],
      "「一般」不受影響：範圍外的列仍被 search_key 擋掉、已關注的仍被排除");
    assert.deepEqual(out.unseen, [910001, 910004],
      "「未看過」不受影響：範圍外（910002／910003）仍被 search_key 擋掉（兩筆都是 viewed=0 所以在）");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("watched 的 listScope 不再與 statsScope 共用 search_key 前綴 ⇒ 一趟掃描回 null（呼叫端走兩趟）", async () => {
  const { buildListListingsClauses, listingStatsBuildContext } = await import("../src/db.js");
  const { buildScopeScanQuery } = await import("../src/listingScopeScan.js");
  const { LIST_CANDIDATE_COLUMNS } = await import("../src/listingCandidateRow.js");

  const keys = ["https://rent.591.com.tw/list?region=1&section=8,9"];
  const context = {
    searchKeys: keys,
    isolation: { sql: "(fixture_namespace IS NULL OR fixture_namespace = '')", params: [] },
    crawlSources: { items: [] },
    asOf: "2026-10-14T14:00:00.000Z",
  };
  const settings = { searchUrls: keys, watchDistricts: [] };
  const build = (filter) => buildListListingsClauses(
    { filter, searchKeys: keys, settings, uid: 2, context },
    { sqliteDb: null },
  );
  // statsScope 沒有 filter 的概念：它永遠以 `searchWhere()` 那一條開頭（真函式算出來的）。
  const statsClauses = [];
  const statsParams = [];
  const ctx = listingStatsBuildContext();
  ctx.searchWhere(keys, statsClauses, statsParams, context);
  ctx.listingVisibilityClauses(statsClauses, statsParams, context, { sqliteDb: null });
  const statsScope = { clauses: statsClauses, params: statsParams };

  const watched = build("watched");
  assert.doesNotMatch(watched.where, /search_key IN/,
    "watched 的候選不得再帶 search_key 子句");
  assert.match(watched.where, /fixture_namespace/,
    "watched 仍要有隔離子句");
  assert.match(watched.where, /user_listing_flags/,
    "watched 仍要有 EXISTS 旗標子句");
  assert.equal(
    buildScopeScanQuery({ candidateColumns: LIST_CANDIDATE_COLUMNS, statsScope, listScope: watched }),
    null,
    "watched 的 listScope 少了 search_key 子句 ⇒ 共同前綴 0 條 ⇒ 必須回 null（走兩趟），不得硬湊",
  );

  const all = build("all");
  assert.match(all.where, /search_key IN/, "其餘 filter 仍要有 search_key 子句");
  const shared = buildScopeScanQuery({ candidateColumns: LIST_CANDIDATE_COLUMNS, statsScope, listScope: all });
  assert.ok(shared, "其餘 filter 的共同前綴仍在 ⇒ 一趟掃描照舊可用（不得因為本包退化成兩趟）");
  assert.ok(shared.commonClauses.length >= 1);
});
