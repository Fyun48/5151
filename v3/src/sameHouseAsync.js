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
// 測試：`v3/test/admin-same-house-async.test.js`（2026-09-27 補上）。
// 比對兩邊實際落地的 listing_group_members、listings.match_post_id 與 listing_group_audits。
// 已用變異測試確認非空：跳過 match_post_id 更新 → 失敗；不寫群組稽核 → 失敗
// （第一次寫這個測試時漏了稽核那一項，是變異測試抓出來的）。
//
// 仍涵蓋範圍（2026-09-27 第二批）：
//   - `mergeSameHouseForUserAsync()`   會員併入／管理員確認
//   - `confirmSuspectedMatchAsync()`   確認配對（先取 peer 再走同一個 merge）
//   - `confirmSameHouseAsAdminAsync()` 管理員確認同房源
//   - `rejectSuspectedMatchAsync()`    拆開配對（本批新增）
//   - `adminSplitSameHouseAsync()`     管理員拆開（本批新增）
//
// `/api/listings/:id/reject-match` 為什麼重要：它寫的 `user_match_votes`／`user_match_signals`
// 是**全站**拆開判定的來源（`shouldPromoteGlobalSplit` 數到門檻就把 match_verdict 改成 'no'），
// 而先前只有 SQLite 在寫。在兩節點輪流的正式站上，同一個會員的兩次拆開可能落在不同節點，
// 票數永遠湊不到門檻——這是活的正确性問題，不只是收尾債。
import { resolveDbDriver } from "./dbDriver.js";
import { mergeSameHouseForUser as mergeSameHouseForUserSync, notifyEnqueueBuildContext } from "./db.js";
import { normalizeMergeIds } from "./userSameHouse.js";
import {
  loadRawListingsAsync,
  mergePersonalSameHouse as mergePersonalSameHousePg,
  pgExec,
  splitPersonalSameHouseAsync,
} from "./userSameHouseAsync.js";
import {
  bindListingsToGroup,
  groupIdForPost,
  isAdminConfirmedGroup,
  unbindListingFromGroup,
  writeGroupAudit,
} from "./listingGroupsAsync.js";
import { CONFIRM_ADMIN } from "./listingGroups.js";
import { getListingAsync } from "./listingDetailAsync.js";
import { bumpRevisionPgExec } from "./revisionBumpAsync.js";
import { refreshListingProjection } from "./listingSearchProjection.js";
import { refreshFoldColumns } from "./match.js";
import { bumpAnalyticsAsync } from "./rentalAnalyticsAsync.js";
import { noteRefreshFailure } from "./listingRefreshHealth.js";
import {
  MATCH_SPLIT_DAILY_LIMIT,
  pairConfidence,
  shouldPromoteGlobalSplit,
  votePair,
} from "./matchVotes.js";

function countRefreshFailure(exec, metric, error) {
  // 先記行程內計數器（不碰 DB，同交易 aborted 也不失效）——唯一可靠的失敗訊號。
  noteRefreshFailure(metric === "fold_refresh_failed" ? "fold" : "projection", error);
  // 再盡力寫 rental_analytics_daily（第二副本）。⚠️ 不得依賴它：主寫入／刷新失敗常使同一個
  // PG 交易進入 aborted（25P02），同交易的 bumpAnalytics 也會被擋；這裡允許失敗並吞掉。
  return bumpAnalyticsAsync(metric, new Date(), 1, { exec, driver: "postgres" }).catch(() => {});
}

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
  // 配對會改 match_post_id（投影 primary_listing_id 的來源）⇒ 逐筆刷新投影與 fold，避免 stored 值過時。
  // best-effort：隔離夾具可能沒有投影表，失敗不擋確認，但失敗要計數。
  try {
    for (const row of listings) await refreshListingProjection(exec, row.post_id);
  } catch (error) { await countRefreshFailure(exec, "projection_refresh_failed", error); }
  try {
    for (const row of listings) await refreshFoldColumns(exec, row.post_id);
  } catch (error) { await countRefreshFailure(exec, "fold_refresh_failed", error); }
  await writeGroupAudit(exec, {
    action: "admin_confirm_same_house",
    adminUserId,
    postIds: ids,
    previousGroupIds: previous,
    resultingGroupId: groupId,
    now,
  });
  await bumpRevisionPgExec(exec, {
    entityType: "listing",
    eventType: "same_house_merge",
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

// ---------------------------------------------------------------------------
// db.js rejectSuspectedMatch() / adminSplitSameHouse() 的 PG 分支（2026-09-27）。
//
// 語句與同步版逐字對應。刻意**不**包交易：同步版也沒有 BEGIN，每一句各自 autocommit，
// 這裡照抄同樣的原子性（改語意會讓 parity 測試失去意義）。
//
// 方言檢查（已對真 PG 實測，見 v3/test/reject-match-async.test.js）：
//   - `IFNULL(match_verdict,'')` → toPostgresSql 轉成 COALESCE，安全
//   - `LIMIT 1` 兩邊都合法（**不是** SQLite 的 `LIMIT -1`，那個 PG 會直接拋錯）
//   - `COUNT(DISTINCT user_id) ... GROUP BY vote` 兩邊同義，PG 的 MIN() 聚合陷阱不適用
//   - `ON CONFLICT(user_id, post_id, peer_id)` 對應 PG 上實測存在的主鍵
//   - user_events／user_match_signals 的 `id` 在 PG 是 GENERATED BY DEFAULT AS IDENTITY
//     （已查 information_schema 確認），所以 INSERT 省略 id 是對的，不會踩到 NOT NULL

// ⚠️ 這裡刻意寫 `COALESCE`，**不是**同步版的 `IFNULL`。
//
// `pgExec(options)` 在 `options.exec` 被注入時會**原封不動**回傳它，不經過 `toPostgresSql`；
// 只有走真 pgDriver 的分支才會轉譯。所以兩邊看到的 SQL 文字不一樣：
//   正式站（真 pgDriver）→ 跑 toPostgresSql → `IFNULL` 變 `COALESCE`、`?` 變 `$1`
//   注入式 exec（測試）  → 拿到原始碼裡的字面文字（含 `?`）
// 測試夾具把「原始碼字面文字」當成「PG 會收到的東西」來驗。這個假設只有在
// **PG 分支的語句本身就是 PG 合法**時才成立（佔位符風格的差異由 sqlDialect 自己的測試負責）。
// 若這裡寫 IFNULL：正式站會過（轉譯器救了它），但夾具會直接拋
//   "function ifnull(text, unknown) does not exist"
// ——也就是測試守的**不是**正式站真正送出的那句 SQL。
// `COALESCE` 在 SQLite／PG 都合法，且 `toPostgresSql` 不會再改它，因此三條路徑
// （正式站 PG、注入式 exec、SQLite 回退）看到同一句。這一項是變異測試抓出來的。
const INCOMING_PEER_SQL = `SELECT post_id FROM listings
   WHERE match_post_id = ? AND COALESCE(match_verdict, '') != 'no'
   LIMIT 1`;
const EXISTING_VOTE_SQL =
  "SELECT vote FROM user_match_votes WHERE user_id = ? AND post_id = ? AND peer_id = ?";
const SPLIT_USED_SQL = `SELECT COUNT(*) AS n FROM user_match_votes
   WHERE user_id = ? AND vote = 'split' AND created_at >= ?`;
const PEER_LEVEL_SQL = "SELECT match_level FROM listings WHERE post_id = ?";
const UPSERT_VOTE_SQL = `INSERT INTO user_match_votes (user_id, post_id, peer_id, vote, confidence, created_at, updated_at)
   VALUES (?, ?, ?, 'split', ?, ?, ?)
   ON CONFLICT(user_id, post_id, peer_id) DO UPDATE SET
     vote = 'split',
     confidence = excluded.confidence,
     updated_at = excluded.updated_at`;
const INSERT_SIGNAL_SQL = `INSERT INTO user_match_signals (user_id, post_id, peer_id, type, weight, created_at)
   VALUES (?, ?, ?, 'split', 1, ?)`;
const PAIR_VOTES_SQL = `SELECT vote, COUNT(DISTINCT user_id) AS n
   FROM user_match_votes
   WHERE post_id = ? AND peer_id = ?
   GROUP BY vote`;
// 個人拆開的升級：清掉 hidden 讓那兩筆重新出現在全站列表。
const PROMOTE_SPLIT_SQL = `UPDATE listings
   SET match_verdict = 'no', match_rejected = 1, hidden = 0
   WHERE post_id IN (?, ?)`;
// 管理員拆開不同：**不動** hidden（與 db.js adminSplitSameHouse 逐字相同）。
const ADMIN_SPLIT_SQL = `UPDATE listings
   SET match_verdict = 'no', match_rejected = 1
   WHERE post_id IN (?, ?)`;

// db.js dayStartIso() 的逐字複本。刻意用**伺服器本地時區**的當日 0 點，
// 與同步版一致；兩條路徑在同一個行程裡，所以「今天」的定義不會分歧。
function dayStartIso(now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

// db.js countPairVotes() 的 PG 分支（純彙總，語句兩邊通用）。
async function countPairVotesAsync(exec, lo, hi) {
  const rows = await exec(PAIR_VOTES_SQL, [lo, hi]);
  const out = { split: 0, same: 0 };
  for (const row of rows) {
    if (row.vote === "split") out.split = Number(row.n) || 0;
    if (row.vote === "keep" || row.vote === "same") out.same = Number(row.n) || 0;
  }
  return out;
}

// db.js addUserEvent() 的 PG 分支：語句重用 notifyEnqueueQueries() 的同一份文字，
// 不另寫一份會漂移的 SQL。`id` 只有在要回報給呼叫端時才需要 RETURNING（PG 支援，SQLite 用 lastInsertRowid）。
async function addUserEventAsync(exec, event) {
  const queries = notifyEnqueueBuildContext();
  const insert = queries.insertUserEvent(event, { returning: true });
  const rows = await exec(insert.sql, insert.params);
  const id = Number(rows?.[0]?.id) || 0;
  if (event.group_id || event.notify_profile_id) {
    try {
      const update = queries.eventProfileStatement(event, id);
      await exec(update.sql, update.params);
    } catch {
      // 舊 fixture 沒有這幾個欄位；同步版也吞掉同一個失敗
    }
  }
  return id;
}

// db.js adminSplitSameHouse() 的 PG 分支。
export async function adminSplitSameHouseAsync(adminUserId, postId, peerId, { now = new Date(), ...options } = {}) {
  const a = Number(postId) || 0;
  const b = Number(peerId) || 0;
  if (!a || !b) return { ok: false, code: "need_two", error: "缺少要比對的物件" };
  const exec = await pgExec(options);
  const gid = await groupIdForPost(exec, a);
  if (!gid || !(await isAdminConfirmedGroup(exec, gid))) {
    return { ok: false, code: "not_admin_group", error: "這組不是管理員確認的同房源" };
  }
  const previous = [gid];
  // 順序照抄同步版：先 a 再 b。a 拆完若群組只剩 1 人會被整組刪掉，b 的查詢屆時回空字串。
  await unbindListingFromGroup(exec, a, { now });
  await unbindListingFromGroup(exec, b, { now });
  await exec(ADMIN_SPLIT_SQL, [a, b]);
  await bumpRevisionPgExec(exec, {
    entityType: "listing",
    eventType: "same_house_split",
  });
  await writeGroupAudit(exec, {
    action: "admin_split_same_house",
    adminUserId,
    postIds: [a, b],
    previousGroupIds: previous,
    resultingGroupId: "",
    now,
  });
  return {
    ok: true,
    personal: false,
    shared: true,
    listing: await getListingAsync(a, adminUserId, { ...options, driver: "postgres" }),
  };
}

// db.js rejectSuspectedMatch() 的 PG 分支。步驟與同步版逐條對應，回傳形狀相同。
export async function rejectSuspectedMatchAsync(postId, userId, { peerId, admin = false, ...options } = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    const { rejectSuspectedMatch } = await import("./db.js");
    return rejectSuspectedMatch(postId, userId, { peerId, admin });
  }
  const uid = Number(userId) || 0;
  if (!uid) {
    return { ok: false, code: "guest", error: "請先登入才能拆開同屋源" };
  }
  const listing = (await loadRawListingsAsync([postId], options))[0];
  if (!listing) return { ok: false, code: "not_found", error: "找不到這筆物件" };

  const exec = await pgExec(options);
  let otherId = Number(peerId) || Number(listing.match_post_id) || 0;
  if (!otherId) {
    const incoming = await exec(INCOMING_PEER_SQL, [Number(postId) || 0]);
    otherId = Number(incoming[0]?.post_id) || 0;
  }
  if (!otherId || otherId === Number(postId)) {
    return { ok: false, code: "no_peer", error: "找不到要拆開的同屋源" };
  }
  if (admin && (await isAdminConfirmedGroup(exec, await groupIdForPost(exec, postId)))) {
    return adminSplitSameHouseAsync(uid, postId, otherId, options);
  }

  const [lo, hi] = votePair(postId, otherId);
  const existing = (await exec(EXISTING_VOTE_SQL, [uid, lo, hi]))[0];
  const used = Number((await exec(SPLIT_USED_SQL, [uid, dayStartIso()]))[0]?.n) || 0;
  if (existing?.vote !== "split" && used >= MATCH_SPLIT_DAILY_LIMIT) {
    return {
      ok: false,
      code: "rate_limit",
      error: "今天拆開次數已達上限。請先看展開列的差異再決定，明天再試。",
    };
  }

  const now = new Date().toISOString();
  if (existing?.vote !== "split") {
    const peer = (await exec(PEER_LEVEL_SQL, [otherId]))[0];
    await exec(UPSERT_VOTE_SQL, [uid, lo, hi, pairConfidence(listing, peer), now, now]);
    await exec(INSERT_SIGNAL_SQL, [uid, lo, hi, now]);
    await addUserEventAsync(exec, {
      user_id: uid,
      post_id: Number(postId),
      type: "match_split",
      title: listing.title || `刊登 #${postId}`,
      detail: `個人拆開 #${postId} 與 #${otherId}`,
      source_key: listing.source_key || "",
      created_at: now,
      notified: 1,
    });
    // 與同步版相同：個人併入表可能尚未建立，失敗不得擋住拆開。
    try { await splitPersonalSameHouseAsync(exec, uid, postId, otherId); } catch { /* 個人併入表可能尚未建立 */ }
  }

  const peer = (await exec(PEER_LEVEL_SQL, [otherId]))[0];
  const tally = await countPairVotesAsync(exec, lo, hi);
  const promoted = shouldPromoteGlobalSplit({
    ...tally,
    confidence: pairConfidence(listing, peer),
  });
  if (promoted) {
    await exec(PROMOTE_SPLIT_SQL, [lo, hi]);
    await bumpRevisionPgExec(exec, {
      entityType: "listing",
      eventType: "same_house_split",
    });
  }

  return {
    ok: true,
    listing: await getListingAsync(postId, uid, { ...options, driver: "postgres" }),
    personal: true,
    promoted,
    remaining: Math.max(0, MATCH_SPLIT_DAILY_LIMIT - (existing?.vote === "split" ? used : used + 1)),
    already: existing?.vote === "split",
  };
}

// ---- 歷史 reconciliation 的進度狀態 ----
//
// 對應 `db.js:7851 sameHouseBackfillStatus()`。它只讀**兩個 settings 鍵**：
//   * `BACKFILL_SETTING_KEY` 存的是 `String(cursor)`（`writeSettingKey` 會 JSON.stringify）
//   * `BACKFILL_STATUS_KEY`  存的是 `JSON.stringify({...})`（等於被 stringify 兩次）
// 所以 `getSiteSettingAsync()`（JSON.parse 一次）在這裡是 `settingKey()` 的**直接替代**——
// 兩邊取到的都是「再 parse 一次才拿到物件」的字串。判斷與回傳形狀完全照抄。
import { getSiteSettingAsync, setSiteSettingAsync } from "./settingsKvAsync.js";
import {
  BACKFILL_SETTING_KEY,
  NEXT_BACKFILL_BATCH_SQL,
  RECONCILE_BATCH,
  summarizeReconciliationBatch,
} from "./sameHouseReconcile.js";
import { reconcileListingByIdAsync } from "./listingMatchAsync.js";
import { BACKFILL_STATUS_KEY } from "./db.js";

// `db.js runSameHouseBackfill()` 的 PG 版（`POST /api/admin/same-house/reconcile`）。
//
// ⚠️ 為什麼一定要有：那個端點是管理員的「同房源重掃」，原本只寫本機 SQLite
//（`reconcileListingById()` → `listing_groups`／`match_post_id`／稽核列都在本機）
// ⇒ PG 模式下後台按了、站上（讀 PG）看不到任何變化，而且游標也只前進本機那一份。
// 逐列的重掃本身已經是島嶼（`listingMatchAsync.reconcileListingByIdAsync`），這裡只補
// 「挑批次 ＋ 游標 ＋ 摘要」——語句與摘要函式都逐字重用同步版。
export async function runSameHouseBackfillAsync({ limit = RECONCILE_BATCH, cursor } = {}, options = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    const { runSameHouseBackfill } = await import("./db.js");
    return runSameHouseBackfill({ limit, cursor });
  }
  const exec = await pgExec(options);
  const readSetting = (key) => getSiteSettingAsync(key, { ...options, driver: "postgres" });
  const writeSetting = (key, value) => setSiteSettingAsync(key, value, { ...options, driver: "postgres" });
  const startCursor = cursor == null ? Number((await readSetting(BACKFILL_SETTING_KEY)) || 0) : Number(cursor) || 0;
  const cap = Math.max(1, Math.min(Number(limit) || RECONCILE_BATCH, 200));
  const batch = await exec(NEXT_BACKFILL_BATCH_SQL, [startCursor, cap]);
  const results = [];
  for (const row of batch) {
    try {
      const reconciled = await reconcileListingByIdAsync(row.post_id, { reason: "backfill" }, options);
      results.push({ post_id: row.post_id, ...reconciled });
    } catch (error) {
      results.push({ post_id: row.post_id, error: error.message });
    }
  }
  const nextCursor = batch.length ? Number(batch[batch.length - 1].post_id) : startCursor;
  // 落地格式與同步版**逐字相同**：`writeSettingKey()` 會 JSON.stringify 一次，
  // 所以 `setSiteSettingAsync()`（同一件事）直接吃同樣的值。
  await writeSetting(BACKFILL_SETTING_KEY, String(nextCursor));
  const summary = {
    ...summarizeReconciliationBatch(results),
    cursor: startCursor,
    next_cursor: nextCursor,
    done: batch.length < cap,
    results: results.map((row) => ({
      post_id: row.post_id,
      skipped: row.skipped || false,
      reason: row.reason || "",
      level: row.best?.level || "",
      error: row.error || "",
    })),
  };
  await writeSetting(BACKFILL_STATUS_KEY, JSON.stringify({
    cursor: summary.cursor,
    next_cursor: summary.next_cursor,
    done: summary.done,
    scanned: summary.scanned,
    candidate_pairs: summary.candidate_pairs,
    auto_confirmed: summary.auto_confirmed,
    suspected: summary.suspected,
    no_match: summary.no_match,
    skipped: summary.skipped,
    errors: summary.errors,
  }));
  return summary;
}

export async function sameHouseBackfillStatusAsync(options = {}) {
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    const { sameHouseBackfillStatus } = await import("./db.js");
    return sameHouseBackfillStatus();
  }
  const read = (key) => getSiteSettingAsync(key, { ...options, driver: "postgres" });
  const cursor = Number((await read(BACKFILL_SETTING_KEY)) || 0);
  try {
    const last = JSON.parse((await read(BACKFILL_STATUS_KEY)) || "{}");
    return { cursor, batch: RECONCILE_BATCH, last: last && typeof last === "object" ? last : {} };
  } catch {
    return { cursor, batch: RECONCILE_BATCH, last: {} };
  }
}
