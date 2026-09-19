// Ordered schema migrations for the domain modules (Phase 6). Each `ensureXxxSchema`
// is already idempotent (CREATE TABLE IF NOT EXISTS), so wrapping them in the
// migration runner tracks versions without re-applying on an existing DB.
import { ensurePersonalSchema } from "./personalSchema.js";
import { ensureUserSameHouseSchema } from "./userSameHouse.js";
import { ensureListingGroupSchema } from "./listingGroups.js";
import { ensureSearchProfileSchema } from "./searchProfiles.js";
import { ensureGeoCacheSchema } from "./geoQueue.js";
import { ensureListingPrepSchema } from "./listingEnrichQueue.js";
import { ensureDemandSchema } from "./demand.js";
import { ensureFeedbackSchema } from "./feedback.js";
import { ensureFeedbackOutboxSchema } from "./feedbackOutbox.js";
import { ensureCrmSchema } from "./crm.js";
import { ensureCrmOutboxSchema } from "./crmOutbox.js";
import { ensureBudgetSchema } from "./budgetGuard.js";
import { ensureListingSimilaritySchema } from "./listingSimilarity.js";
import { ensureSelfListingSchema } from "./selfListings.js";
import { ensureStage1FixtureSchema } from "./stage1FixtureRegistry.js";
import { ensureRentalMatchIndexes } from "./rentalMatchQuery.js";
import { ensureWishOfferSchema } from "./wishOffers.js";
import { ensureRentalNotifySchema } from "./rentalNotify.js";
import { ensureMemberMediaSchema } from "./memberMedia.js";
import { ensureContentDocumentSchema } from "./contentDocuments.js";
import { ensureMemberConsentSchema } from "./memberConsents.js";
import { ensureListingImportSchema } from "./listingImport.js";
import { ensureListingToolsSchema } from "./listingTools.js";
import { ensurePushSchema } from "./webPush.js";
import { ensureCommsSchema } from "./comms.js";
import { ensureSupportSchema } from "./supportSchema.js";

export const SCHEMA_MIGRATIONS = [
  {
    version: 1,
    name: "personal_search_schema",
    up(db) {
      ensurePersonalSchema(db);
      ensureUserSameHouseSchema(db);
      ensureListingGroupSchema(db);
      ensureSearchProfileSchema(db);
      ensureGeoCacheSchema(db);
      ensureListingPrepSchema(db);
    },
  },
  {
    version: 2,
    name: "demand_feedback_crm_schema",
    up(db) {
      ensureDemandSchema(db);
      ensureFeedbackSchema(db);
      ensureFeedbackOutboxSchema(db);
      ensureCrmSchema(db);
      ensureCrmOutboxSchema(db);
      ensureBudgetSchema(db);
    },
  },
  {
    version: 3,
    name: "marketplace_schema",
    up(db) {
      ensureListingSimilaritySchema(db);
      ensureSelfListingSchema(db);
      ensureStage1FixtureSchema(db);
      ensureRentalMatchIndexes(db);
      ensureWishOfferSchema(db);
      ensureRentalNotifySchema(db);
    },
  },
  {
    version: 4,
    name: "media_consent_tools_schema",
    up(db) {
      ensureMemberMediaSchema(db);
      ensureContentDocumentSchema(db);
      ensureMemberConsentSchema(db);
      ensureListingImportSchema(db);
      ensureListingToolsSchema(db);
      ensurePushSchema(db);
      ensureCommsSchema(db);
      ensureSupportSchema(db);
    },
  },
  {
    version: 5,
    name: "admin_audit_schema",
    up(db) {
      db.exec(`CREATE TABLE IF NOT EXISTS admin_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        actor_id INTEGER NOT NULL DEFAULT 0,
        actor_email TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL DEFAULT '',
        target TEXT NOT NULL DEFAULT '',
        before_json TEXT,
        after_json TEXT
      )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_admin_audit_at ON admin_audit(at DESC)");
    },
  },
];
