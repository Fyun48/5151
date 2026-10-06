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
import { ensureFeedbackMediaSchema } from "./feedbackMedia.js";
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
import { ensureListingShareSchema } from "./listingShare.js";

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
  {
    // C3：意見回饋附圖。獨立一張表（與 OPS 服務同名的表無關），只寫本機檔案、
    // 只由 requireAdminApi 的路由讀取，不掛 express.static。
    version: 6,
    name: "feedback_attachment_schema",
    up(db) {
      ensureFeedbackMediaSchema(db);
    },
  },
  {
    // R2：站內刊登的費用三態（`fee_includes`）與步行捷運查證（`self_mrt_*`）。
    // ⚠️ 一定要「新增一個版本」而不是只改 `ensureSelfListingSchema()`：migration runner
    // 只跑沒跑過的版本，既有的資料庫不會重跑 version 3，欄位就永遠不會被加上去
    // （本機實測：刊登時回 `no such column: fee_includes`）。`ensureSelfListingSchema()` 內是
    // 幂等的 try/catch ALTER，重跑安全。
    version: 7,
    name: "self_listing_fee_mrt_schema",
    up(db) {
      ensureSelfListingSchema(db);
    },
  },
  {
    // R2（第二輪）：捷運查證的**狀態**（within／outside）與「最近但超過」的距離。
    // 只存「符合的距離」會讓「已查證超過 1 公里」掉回未確認 ⇒ 配對少了硬衝突。
    version: 8,
    name: "self_listing_mrt_state_schema",
    up(db) {
      ensureSelfListingSchema(db);
    },
  },
  {
    // 物件一鍵分享（Phase 1）：分享 token 與分享事件兩張獨立新表。
    // 純新增，不碰既有的 `rental_share_events`。
    version: 9,
    name: "listing_share_schema",
    up(db) {
      ensureListingShareSchema(db);
    },
  },
  {
    // 分享事件去重升級：cta 依「管道」各自保留歸因（v9 的唯一索引未含 channel）。
    // 已跑過 v9 的庫（含開發庫）靠這版重建索引；新庫跑完 v9 再跑這版結果相同（冪等）。
    version: 10,
    name: "listing_share_dedup_channel",
    up(db) {
      db.exec(`
        DROP INDEX IF EXISTS idx_listing_share_dedup_user;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_listing_share_dedup_user
          ON listing_share_events(share_token, event_type, channel, user_id, created_at)
          WHERE user_id IS NOT NULL;
      `);
    },
  },
];
