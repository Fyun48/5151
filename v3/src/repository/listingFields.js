// The listing FIELD writes the background loops make (PostgreSQL side).
//
// Problem: with DB_DRIVER=postgres the crawler already reads its work from PostgreSQL
// (crawlerReads.js) and stores the listing row itself there (db.js persistListing ->
// repository/writePath.js) - but every *field* it then enriches (591 detail fees/contact/coords,
// the 5168 kit columns, the MRT and community caches, the listing_prep row) went through the
// synchronous SQLite helpers. The loop looked busy and the site never saw the result.
//
// Driver behaviour:
//   • sqlite   - unchanged: db.js keeps running the plans below against the synchronous handle,
//                including its SQLite-only side effects (change events, same-house reconcile).
//   • postgres - this module runs the SAME statements (built by the pure planners in
//                listingFieldsBuildContext()) through the injected exec, which already translates
//                the dialect (the SQLite `?` / IFNULL text is what the planners hand out).
//                Statements the original wrapped in try/catch are marked `tolerant`, so a store
//                that lacks the newer columns still gets the rest written.
async function applyStatement(exec, step) {
  if (!step) return false;
  try {
    await exec(step.sql, step.params || []);
    return true;
  } catch (error) {
    if (!step.tolerant) throw error;
    return false;
  }
}

// The chain rule of persistHpListingFields(): try the wide statement, fall back to the narrow ones,
// and only the last statement of the chain may throw.
async function applyChain(exec, statements) {
  for (const step of statements || []) {
    try {
      await exec(step.sql, step.params || []);
      return true;
    } catch (error) {
      if (!step.tolerant) throw error;
    }
  }
  return false;
}

// The row the pure planners need - they take the stored row, exactly like the SQLite functions do.
async function readListing(exec, postId) {
  const id = Number(postId) || 0;
  if (!id) return null;
  const rows = await exec("SELECT * FROM listings WHERE post_id = ?", [id]);
  const row = (rows || [])[0];
  return row ? { ...row } : null;
}

// db.js setListingDetail(): the 591 detail (fees, contact, coordinates, community, kit columns).
// The fee-change notification itself is not enqueued here: the event queue is a separate slice
// (POSTGRES_SWITCH_PLAN §2.6 ③), so the plan is returned to the caller for it.
export async function setListingDetail(exec, { deps, listing, input = {} } = {}) {
  const context = deps || {};
  const plan = context.listingDetailPlan(listing, input);
  for (const step of plan.updates) await applyStatement(exec, step);
  const saved = await readListing(exec, plan.postId);
  if (plan.location && saved) {
    const update = context.listingLocationUpdate(saved, plan.location, plan.postId);
    if (update) {
      await applyStatement(exec, update);
      // 座標變好之後，先前因距離被跳過的通知要重新排隊 - 這條 user_events 更新是冪等的，兩邊共用。
      await applyStatement(exec, context.notifyReopenQuery(plan.postId, update.coordVersion));
    }
  }
  return { feeChange: plan.feeChange ? { detail: plan.feeChange.detail, created_at: plan.feeChange.stamp } : null };
}

// db.js persistHpListingFields(): the 5168 field patch (row columns, kit columns, content_seq).
export async function persistHpListingFields(exec, { deps, listing, next = {}, locationChanged = false } = {}) {
  const plan = (deps || {}).hpFieldsPlan(listing, next, { locationChanged });
  await applyChain(exec, plan.attempts);
  for (const step of plan.followUps) await applyStatement(exec, step);
  return { applied: true, postId: plan.postId, invalidateSearchKey: plan.invalidateSearchKey };
}

// db.js setCachedMrt(): the MRT access cache the decoration layer reads.
export async function setCachedMrt(exec, { deps, lat, lng, access } = {}) {
  const upsert = (deps || {}).mrtCacheUpsert(lat, lng, access);
  if (!upsert) return { stored: false };
  await applyStatement(exec, upsert);
  return { stored: true, key: upsert.params[0] };
}

// db.js setCommunityCache(): the community pin cache (also what the 591 geo scan consults).
export async function setCommunityCache(exec, { deps, community } = {}) {
  const upsert = (deps || {}).communityCacheUpsert(community);
  if (!upsert) return { stored: false };
  await applyStatement(exec, upsert);
  return { stored: true, communityId: upsert.params[0] };
}
