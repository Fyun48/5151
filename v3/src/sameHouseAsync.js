// 同房源「會員確認／拆開」的 driver-aware 入口（PG 島嶼，2026-09-27）。
//
// 為什麼放在獨立模組而不放 db.js：這個入口需要 `getListingAsync`（listingDetailAsync.js），
// 而 listingDetailAsync.js 本身會匯入 db.js——放在 db.js 會形成循環匯入。獨立模組最乾淨。
//
// 目前涵蓋範圍（誠實標註）：
//   - 非 postgres            → 現有同步路徑，行為完全不變
//   - postgres + **會員**    → PG（userSameHouseAsync 的 mergePersonalSameHouse）
//   - postgres + **管理員**  → `confirmSameHouseAsAdminAsync()`（本檔），走 listingGroupsAsync
//                              既有的 PG 積木（bindListingsToGroup／groupIdForPost／writeGroupAudit）。
//
// ⚠️ **測試缺口（明確標示，不假裝）**：管理員路徑 `confirmSameHouseAsAdminAsync()` 目前
// **沒有專屬的 parity 測試**。它用的積木（bindListingsToGroup／groupIdForPost／writeGroupAudit）
// 已被 listingMatchAsync 的路徑測過，但**這個組合本身沒有**——要測得先建 listings ＋
// listing_groups／listing_group_members／listing_group_audits 的完整夾具。
// 在補上之前，不要把它當成「已驗證」。
//
// 仍未涵蓋：`rejectSuspectedMatch()`（拆開）另外會寫 user_match_votes 與 user_match_signals，
// 尚未移植，所以 `/api/listings/:id/reject-match` 仍是 SQLite。
import { resolveDbDriver } from "./dbDriver.js";
import { mergeSameHouseForUser as mergeSameHouseForUserSync } from "./db.js";
import { normalizeMergeIds } from "./userSameHouse.js";
import {
  loadRawListingsAsync,
  mergePersonalSameHouse as mergePersonalSameHousePg,
  pgExec,
} from "./userSameHouseAsync.js";
import { bindListingsToGroup, groupIdForPost, writeGroupAudit } from "./listingGroupsAsync.js";
import { CONFIRM_ADMIN } from "./listingGroups.js";
import { getListingAsync } from "./listingDetailAsync.js";

export async function mergeSameHouseForUserAsync(userId, postIds, { admin = false, ...options } = {}) {
  // 明確要求走某個 driver（測試用）時要尊重它，不要被環境變數蓋掉。
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    return mergeSameHouseForUserSync(userId, postIds, { admin });
  }
  const ids = normalizeMergeIds(postIds);
  if (admin) return confirmSameHouseAsAdminAsync(userId, ids, options);

  const listings = await loadRawListingsAsync(ids, options);
  const result = await mergePersonalSameHousePg(userId, listings, options);
  if (!result.ok) return result;
  // 與同步版相同：成功後回傳裝飾過的 listing（失敗時不回）。
  return { ...result, listing: await getListingAsync(ids[0], userId, { ...options, driver: "postgres" }) };
}

// db.js confirmSuspectedMatch() 的 PG 分支：先取該筆的 peer，再走同一個 merge。
// 與同步版相同：找不到 listing 或沒有 peer 就回 null。
export async function confirmSuspectedMatchAsync(postId, userId, { admin = false, ...options } = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    const { confirmSuspectedMatch } = await import("./db.js");
    return confirmSuspectedMatch(postId, userId, { admin });
  }
  const rows = await loadRawListingsAsync([postId], options);
  const listing = rows[0];
  if (!listing) return null;
  const peerId = Number(listing.match_post_id) || 0;
  if (!peerId) return null;
  const result = await mergeSameHouseForUserAsync(userId, [postId, peerId], { admin, ...options });
  return result?.ok ? result : null;
}

// db.js confirmSameHouseAsAdmin() 的 PG 分支。
// 與同步版逐條對應：取原始資料列 → 找既有群組 → bindListingsToGroup（管理員可合併）→
// 兩兩互指 match_post_id → 寫群組稽核 → 回傳。
const SET_MATCH_SQL = `UPDATE listings
   SET match_post_id = ?, match_level = 'high', match_detail = ?, match_rejected = 0
   WHERE post_id = ?`;

export async function confirmSameHouseAsAdminAsync(adminUserId, postIds, { now = new Date(), ...options } = {}) {
  const ids = normalizeMergeIds(postIds);
  const listings = await loadRawListingsAsync(ids, options);
  if (listings.length < 2) {
    return { ok: false, code: "need_two", error: "請至少選 2 筆才能確認同房源" };
  }
  const exec = await pgExec(options);
  const previous = [...new Set((await Promise.all(
    listings.map((row) => groupIdForPost(exec, row.post_id)),
  )).filter(Boolean))];
  const stamp = now instanceof Date ? now.toISOString() : String(now);
  const groupId = await bindListingsToGroup(exec, listings, {
    evidence: {
      signals: ["admin_confirm"],
      matcher_version: "admin",
      evaluated_at: stamp,
      admin_user_id: Number(adminUserId) || 0,
    },
    confidence: 1,
    confirmationLevel: CONFIRM_ADMIN,
    adminUserId,
    allowAdminMerge: true,
    now,
  });
  for (let i = 0; i < listings.length; i += 1) {
    const peer = listings[i === 0 ? 1 : 0];
    await exec(SET_MATCH_SQL, [peer.post_id, `管理員確認同房源 #${peer.post_id}`, listings[i].post_id]);
  }
  await writeGroupAudit(exec, {
    action: "admin_confirm_same_house",
    adminUserId,
    postIds: ids,
    previousGroupIds: previous,
    resultingGroupId: groupId,
    now,
  });
  return {
    ok: true,
    personal: false,
    shared: true,
    admin_confirmed: true,
    group_id: groupId,
    post_ids: ids,
    previous_group_ids: previous,
    message: `已確認 ${ids.length} 筆為同一房源，全站共用`,
    listing: await getListingAsync(ids[0], adminUserId, { ...options, driver: "postgres" }),
  };
}
