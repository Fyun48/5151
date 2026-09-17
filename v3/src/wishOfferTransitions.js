/** Wish Offer state machine。transaction + version compare，禁止 read-then-write 無鎖競態。 */

import {
  assertOfferBurst,
  assertWishOfferEnabled,
  createOfferReport,
  insertUserBlock,
  liveMatchEligible,
  loadFreshOffer,
  loadVisibleOffer,
  offerHttpError,
  projectOfferContact,
  recordOfferFail,
  terminalizeOffers,
  tenantBlocksOwner,
  transitionOffer,
  withImmediate,
  writeOfferEvent,
} from "./wishOffers.js";
import { getSelfRow } from "./selfListings.js";

function conflict(offer) {
  return offerHttpError("這筆提案狀態已變更", 409, "offer_conflict", {
    current_status: offer?.status || "",
  });
}

function requireOffer(db, offerRef, userId) {
  const offer = loadVisibleOffer(db, offerRef, userId);
  if (!offer) throw offerHttpError("找不到這筆提案", 404, "offer_not_found");
  return offer;
}

function recheckAcceptable(db, offer, now) {
  if (tenantBlocksOwner(db, offer.tenant_user_id, offer.owner_user_id)) {
    terminalizeOffers(db, {
      ownerUserId: offer.owner_user_id,
      tenantUserId: offer.tenant_user_id,
      toStatus: "blocked",
      now,
    });
    return { ok: false, code: "offer_unavailable" };
  }
  const wishRow = db.prepare("SELECT * FROM demand_posts WHERE id = ?").get(offer.wish_id);
  const listingRow = getSelfRow(db, offer.listing_id);
  const live = wishRow && listingRow ? liveMatchEligible(db, listingRow, wishRow, now) : { eligible: false };
  if (!live.eligible) {
    transitionOffer(db, offer.id, {
      fromStatus: "pending",
      toStatus: "expired",
      version: offer.version,
      stampField: "expired_at",
      now,
    });
    return { ok: false, code: "match_no_longer_eligible" };
  }
  return { ok: true };
}

export function acceptWishOffer(db, userId, offerRef, { now = new Date(), actorKey = "" } = {}) {
  assertWishOfferEnabled();
  if (actorKey) assertOfferBurst(actorKey, now);
  let denied = "";
  const result = withImmediate(db, () => {
    const offer = requireOffer(db, offerRef, userId);
    if (Number(offer.tenant_user_id) !== Number(userId)) {
      throw offerHttpError("找不到這筆提案", 404, "offer_not_found");
    }
    if (offer.status !== "pending") throw conflict(offer);
    const check = recheckAcceptable(db, offer, now);
    if (!check.ok) {
      denied = check.code;
      return loadFreshOffer(db, offer.id);
    }
    const changed = transitionOffer(db, offer.id, {
      fromStatus: "pending",
      toStatus: "accepted",
      version: offer.version,
      stampField: "accepted_at",
      now,
    });
    if (!changed) {
      const fresh = loadFreshOffer(db, offer.id);
      throw conflict(fresh);
    }
    writeOfferEvent(db, {
      offerId: offer.id,
      actorUserId: userId,
      eventType: "offer_accepted",
      now,
    });
    return loadFreshOffer(db, offer.id);
  });
  if (denied) {
    recordOfferFail(actorKey || `tenant:${userId}`, now);
    throw offerHttpError("目前無法接受這筆提案", 409, denied);
  }
  return result;
}

export function declineWishOffer(db, userId, offerRef, { now = new Date(), actorKey = "" } = {}) {
  assertWishOfferEnabled();
  if (actorKey) assertOfferBurst(actorKey, now);
  return withImmediate(db, () => {
    const offer = requireOffer(db, offerRef, userId);
    if (Number(offer.tenant_user_id) !== Number(userId)) {
      throw offerHttpError("找不到這筆提案", 404, "offer_not_found");
    }
    if (offer.status !== "pending") throw conflict(offer);
    const changed = transitionOffer(db, offer.id, {
      fromStatus: "pending",
      toStatus: "declined",
      version: offer.version,
      stampField: "declined_at",
      now,
    });
    if (!changed) throw conflict(loadFreshOffer(db, offer.id));
    writeOfferEvent(db, {
      offerId: offer.id,
      actorUserId: userId,
      eventType: "offer_declined",
      now,
    });
    return loadFreshOffer(db, offer.id);
  });
}

export function withdrawWishOffer(db, userId, offerRef, { now = new Date(), actorKey = "" } = {}) {
  assertWishOfferEnabled();
  if (actorKey) assertOfferBurst(actorKey, now);
  return withImmediate(db, () => {
    const offer = requireOffer(db, offerRef, userId);
    if (Number(offer.owner_user_id) !== Number(userId)) {
      throw offerHttpError("找不到這筆提案", 404, "offer_not_found");
    }
    if (offer.status !== "pending") throw conflict(offer);
    const changed = transitionOffer(db, offer.id, {
      fromStatus: "pending",
      toStatus: "withdrawn",
      version: offer.version,
      stampField: "withdrawn_at",
      now,
    });
    if (!changed) throw conflict(loadFreshOffer(db, offer.id));
    writeOfferEvent(db, {
      offerId: offer.id,
      actorUserId: userId,
      eventType: "offer_withdrawn",
      now,
    });
    return loadFreshOffer(db, offer.id);
  });
}

export function blockOwnerFromOffer(db, userId, offerRef, { now = new Date(), actorKey = "" } = {}) {
  assertWishOfferEnabled();
  if (actorKey) assertOfferBurst(actorKey, now);
  return withImmediate(db, () => {
    const offer = requireOffer(db, offerRef, userId);
    if (Number(offer.tenant_user_id) !== Number(userId)) {
      throw offerHttpError("找不到這筆提案", 404, "offer_not_found");
    }
    const block = insertUserBlock(db, {
      blockerUserId: userId,
      blockedUserId: offer.owner_user_id,
      context: "wish_offer",
      offerId: offer.id,
      listingId: offer.listing_id,
      now,
    });
    terminalizeOffers(db, {
      ownerUserId: offer.owner_user_id,
      tenantUserId: userId,
      toStatus: "blocked",
      now,
    });
    return {
      ok: true,
      block_ref: block?.public_token || "",
      offer: loadFreshOffer(db, offer.id),
    };
  });
}

export function reportWishOffer(db, userId, offerRef, input = {}, extra = {}) {
  const offer = requireOffer(db, offerRef, userId);
  if (Number(offer.tenant_user_id) !== Number(userId)) {
    throw offerHttpError("找不到這筆提案", 404, "offer_not_found");
  }
  return createOfferReport(db, userId, offer, { ...input, ...extra });
}

export function readOfferContact(db, userId, offerRef, { now = new Date(), actorKey = "" } = {}) {
  assertWishOfferEnabled();
  if (actorKey) assertOfferBurst(`contact:${actorKey}`, now);
  const offer = requireOffer(db, offerRef, userId);
  try {
    return projectOfferContact(db, offer, userId, now);
  } catch (error) {
    recordOfferFail(actorKey || `contact:${userId}`, now);
    throw error;
  }
}

export function getWishOffer(db, userId, offerRef) {
  assertWishOfferEnabled();
  const offer = requireOffer(db, offerRef, userId);
  return offer;
}
