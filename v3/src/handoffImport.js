import { createFeedbackWithOutbox } from "./feedback.js";
import { restoreContactsFromHandoff } from "./crm.js";

export const LOCAL_HANDOFF_SCHEMA = 1;

// 把 OPS 交接包的回饋複本還原成本機 feedback 主本。不連 OPS、不帶金鑰。
export function importHandoffFeedback(db, payload, { userId = 0 } = {}) {
  if (!payload || Number(payload.schema_version) !== LOCAL_HANDOFF_SCHEMA) {
    throw new Error("unsupported handoff schema");
  }
  const rows = Array.isArray(payload.feedback) ? payload.feedback : [];
  const imported = [];
  for (const row of rows) {
    const body = String(row.content || "").trim() || "匯入的回饋內容";
    const res = createFeedbackWithOutbox(db, userId, {
      kind: row.kind || "other",
      body,
    });
    if (res.id > 0) imported.push(res.id);
  }
  const crm = restoreContactsFromHandoff(db, payload);
  return {
    imported: imported.length,
    crm_imported: crm.imported,
    product_id: payload.product?.id || null,
    sha256_in_manifest: payload.sha256 || null,
  };
}
