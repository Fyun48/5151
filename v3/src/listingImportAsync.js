// 匯入功能說明（`listingImportMeta`）的 driver-aware 入口（PG 島嶼，2026-09-27）。
//
// `importMeta(db, {plan, now})` 全段只有**一句** DB 存取（取「匯入聲明」目前生效的那一版），
// 其餘是純組裝。所以移植很小：那句改用 `getEffectiveDocumentAsync()`（第十六批已移植），
// 組裝重用 `importMetaShape()`（本次從 `importMeta()` 抽出來，同步版照用同一份）。
//
// 涵蓋的路由：`GET /api/listing-imports/meta`。
import { resolveDbDriver } from "./dbDriver.js";
import { getEffectiveDocumentAsync } from "./contentDocumentsAsync.js";
import { IMPORT_DECLARATION_TYPE, importMetaShape } from "./listingImport.js";

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

export async function importMetaAsync({ plan = "free", now = new Date(), ...options } = {}) {
  if (!isPg(options)) return (await import("./db.js")).listingImportMeta({ plan, now });
  const doc = await getEffectiveDocumentAsync(IMPORT_DECLARATION_TYPE, { now, ...options });
  return importMetaShape(doc, { plan });
}
