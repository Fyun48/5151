// 租屋目錄（rental catalog）與其範本／草稿的 driver-aware 入口（PG 島嶼，2026-09-27）。
//
// 涵蓋的路由：
//   GET    /api/admin/rental-catalog                （已發布 ＋ 草稿 ＋ diff ＋ 範本 ＋ 開關）
//   PUT    /api/admin/rental-catalog
//   POST   /api/admin/rental-catalog/mutate
//   POST   /api/admin/rental-catalog/templates
//   PATCH  /api/admin/rental-catalog/templates/:id
//   DELETE /api/admin/rental-catalog/templates/:id
//   POST   /api/admin/rental-catalog/templates/:id/apply
//   POST   /api/admin/rental-catalog/draft/publish
//   GET    /api/admin/rental-match-rules
//
// **這個模組幾乎沒有 SQL**：目錄本身是存在 `settings` 表裡的一個 JSON blob，所以儲存層直接用
// 已移植的 `settingsKvAsync`（`getSiteSettingAsync`／`setSiteSettingAsync`）。真正的邏輯
// （normalize／assert／diff／upsert／範本正規化／各種衍生視圖）**全部重用 `rentalCatalog.js`
// 的純函式**，這裡只把 db.js 的同步版本（`db.js:1437-1628`）逐條改成 async。
// SQLite 分支照 `sameHouseAsync.js` 的既有寫法：延遲 `await import("./db.js")` 呼叫同步版。
//
// ⚠️ 一個**一定要處理**的耦合：db.js 那幾個函式除了寫 settings，還會同步**行程內快取**
// （`setRentalCatalogCache`／`setSelfListingCatalog`／`setRentalMatchHydrate`／
// `setWishOfferHydrate`／`setRentalNotifyHydrate`／`setRentalMarketplaceFlags`）。
// 那些快取是同步路徑（selfListings／wishOffers／rentalMatch）在讀的。PG 分支若只寫 DB
// 不更新快取，**同一台節點**的同步路徑就會拿到舊目錄 ⇒ 立刻「後台改完、前台沒變」。
// 所以 `hydrateCaches()` 會用 PG 的內容重跑同一組 setter，而**每個讀取動作也會呼叫它**
// ——節點的快取因此會自動收斂到 PG 的版本，而不是只在寫入時更新。
import { resolveDbDriver } from "./dbDriver.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";
import { getSiteSettingAsync, setSiteSettingAsync } from "./settingsKvAsync.js";
import { setRentalCatalogCache, setRentalMarketplaceFlags } from "./demand.js";
import { setSelfListingCatalog } from "./selfListings.js";
import { setRentalMatchHydrate, matchRulesForAdmin } from "./rentalMatchQuery.js";
import { setWishOfferHydrate } from "./wishOffers.js";
import { setRentalNotifyHydrate } from "./rentalNotify.js";
import { normalizeRentalMarketplaceFlags, publicRentalMarketplaceFlags } from "./rentalMarketplaceFlags.js";
import {
  applyTemplateDraft,
  assertCatalogSafe,
  catalogDiff,
  countCatalogReferences,
  defaultCatalog,
  defaultTemplates,
  deleteOrDisableCondition,
  isSystemCatalogTemplate,
  mergeDefaultCatalog,
  moveCondition,
  normalizeCatalog,
  normalizeTemplate,
  publicAdminCatalog,
  upsertCategory,
  upsertCondition,
} from "./rentalCatalog.js";

export { publicRentalMarketplaceFlags };

const KEYS = Object.freeze({
  catalog: "rentalCatalog",
  draft: "rentalCatalogDraft",
  templates: "rentalCatalogTemplates",
  flags: "rentalMarketplaceFlags",
});

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";
const badRequest = (message, status = 400) => Object.assign(new Error(message), { status });

// SQLite 分支：延遲載入 db.js 的同步版（不要頂層 import，db.js 會反過來 import 這個模組的
// 兄弟模組，延遲載入可避免循環）。
const syncDb = () => import("./db.js");

// 讀取預設 fail-open、寫入預設 fail-closed（與其他島嶼同一政策）。
async function withFallback(options, { read = false }, runPostgres, runSqlite) {
  if (!isPg(options)) return runSqlite();
  try {
    return await runPostgres();
  } catch (error) {
    if (!sqliteFallbackAllowed(options, { write: !read })) throw error;
    return runSqlite();
  }
}

const readPg = (key, options) => getSiteSettingAsync(key, { ...options, driver: "postgres" });
const writePg = (key, value, options) => setSiteSettingAsync(key, value, { ...options, driver: "postgres" });

async function readFlagsPg(options) {
  return normalizeRentalMarketplaceFlags((await readPg(KEYS.flags, options)) || {});
}

// 對應 db.js:1426 `hydrateRentalMarketplace()`——把所有行程內快取換成指定內容。
export function hydrateCaches(catalog, flags) {
  setRentalMarketplaceFlags(flags);
  setRentalCatalogCache(catalog);
  setSelfListingCatalog(catalog, flags);
  setRentalMatchHydrate(catalog, flags);
  setWishOfferHydrate(catalog, flags);
  setRentalNotifyHydrate(flags);
}

// 讀一組「已發布目錄 ＋ 開關」，順便把快取收斂過去。PG 分支的每個讀取都會經過這裡。
async function readStatePg(options) {
  const flags = await readFlagsPg(options);
  const stored = await readPg(KEYS.catalog, options);
  const catalog = stored == null ? defaultCatalog() : mergeDefaultCatalog(stored);
  hydrateCaches(catalog, flags);
  return { catalog, flags };
}

async function readDraftPg(options) {
  const stored = await readPg(KEYS.draft, options);
  return stored ? normalizeCatalog(stored) : null;
}

async function readTemplatesPg(options) {
  const stored = await readPg(KEYS.templates, options);
  const list = Array.isArray(stored?.items) ? stored.items : defaultTemplates();
  return list.map((row, index) => normalizeTemplate(row, list.map((item) => item.id).filter((_, i) => i !== index)));
}

// ---- 讀取 ----

export async function getRentalMarketplaceFlagsAsync(options = {}) {
  return withFallback(options, { read: true },
    () => readFlagsPg(options),
    async () => (await syncDb()).getRentalMarketplaceFlags());
}

/** 已發布目錄；同時把行程內快取收斂到 PG 的版本。 */
export async function getRentalCatalogAsync(options = {}) {
  return withFallback(options, { read: true },
    async () => (await readStatePg(options)).catalog,
    async () => {
      const catalog = (await syncDb()).getRentalCatalog();
      hydrateCaches(catalog, (await syncDb()).getRentalMarketplaceFlags());
      return catalog;
    });
}

export async function getRentalCatalogDraftAsync(options = {}) {
  return withFallback(options, { read: true },
    () => readDraftPg(options),
    async () => (await syncDb()).getRentalCatalogDraft());
}

export async function getRentalCatalogTemplatesAsync(options = {}) {
  return withFallback(options, { read: true },
    () => readTemplatesPg(options),
    async () => (await syncDb()).getRentalCatalogTemplates());
}

/** 對應 db.js:2073 `rentalMatchAdminRules()`：hydrate 之後讀純函式。 */
export async function rentalMatchAdminRulesAsync(options = {}) {
  if (!isPg(options)) return (await syncDb()).rentalMatchAdminRules();
  await readStatePg(options);
  return matchRulesForAdmin();
}

/** 對應 db.js:1556 `catalogConditionReferences()`——這裡有真的 SQL（兩個 SELECT）。 */
export async function catalogConditionReferencesAsync(conditionId, options = {}) {
  const { catalog } = await readStatePgOrSync(options);
  return withFallback(options, { read: true },
    async () => {
      const exec = await pgExec(options);
      let wish = 0;
      let listing = 0;
      try {
        wish = countCatalogReferences(await exec("SELECT must_have, nice_to_have, avoid, condition_choices FROM demand_posts"), conditionId, catalog);
      } catch { /* 隔離測試沒有那個欄位 */ }
      try {
        listing = countCatalogReferences(await exec("SELECT self_traits, listing_condition_values FROM listings"), conditionId, catalog);
      } catch { /* 沒有 listings 表 */ }
      return { wish, listing, historical: wish + listing };
    },
    async () => (await syncDb()).catalogConditionReferences(conditionId));
}

// catalogConditionReferences 在 SQLite 分支不需要先讀 PG 的目錄，但 PG 分支要。
async function readStatePgOrSync(options) {
  if (!isPg(options)) return { catalog: (await syncDb()).getRentalCatalog() };
  return readStatePg(options);
}

async function pgExec(options = {}) {
  if (options.exec) return options.exec;
  const pgDriver = options.pgDriver || (await (await import("./pgSharedDriver.js")).sharedPgDriver());
  const { toPostgresSql } = await import("./sqlDialect.js");
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

// ---- 寫入（逐條對應 db.js:1480-1628）----

export async function saveRentalCatalogDraftAsync(catalogInput, options = {}) {
  if (!isPg(options)) return (await syncDb()).saveRentalCatalogDraft(catalogInput);
  const next = normalizeCatalog(catalogInput);
  assertCatalogSafe(next);
  return withFallback(options, {}, async () => {
    await writePg(KEYS.draft, next, options);
    const { catalog } = await readStatePg(options);
    return { draft: next, diff: catalogDiff(catalog, next) };
  }, async () => (await syncDb()).saveRentalCatalogDraft(catalogInput));
}

export async function saveRentalCatalogAsync(partial = {}, options = {}) {
  if (!isPg(options)) return (await syncDb()).saveRentalCatalog(partial);
  const src = partial && typeof partial === "object" ? partial : {};
  if (src.reset === true) return saveRentalCatalogDraftAsync(defaultCatalog(), options);
  const next = normalizeCatalog(src.catalog || src);
  assertCatalogSafe(next);
  return withFallback(options, {}, async () => {
    await writePg(KEYS.catalog, next, options);
    await writePg(KEYS.draft, null, options);
    hydrateCaches(next, await readFlagsPg(options));
    return publicAdminCatalog(next);
  }, async () => (await syncDb()).saveRentalCatalog(partial));
}

export async function publishRentalCatalogDraftAsync(options = {}) {
  if (!isPg(options)) return (await syncDb()).publishRentalCatalogDraft();
  return withFallback(options, {}, async () => {
    const draft = await readDraftPg(options);
    if (!draft) throw badRequest("沒有待確認的目錄草稿");
    await writePg(KEYS.catalog, draft, options);
    await writePg(KEYS.draft, null, options);
    hydrateCaches(draft, await readFlagsPg(options));
    return publicAdminCatalog(draft);
  }, async () => (await syncDb()).publishRentalCatalogDraft());
}

export async function applyRentalCatalogTemplateAsync(templateId, options = {}) {
  if (!isPg(options)) return (await syncDb()).applyRentalCatalogTemplate(templateId);
  return withFallback(options, {}, async () => {
    const template = (await readTemplatesPg(options)).find((row) => row.id === templateId);
    if (!template) throw Object.assign(new Error("找不到這個範本"), { status: 404 });
    const { catalog } = await readStatePg(options);
    const applied = applyTemplateDraft(catalog, template);
    await writePg(KEYS.draft, applied.draft, options);
    return applied;
  }, async () => (await syncDb()).applyRentalCatalogTemplate(templateId));
}

export async function mutateRentalCatalogAsync(action, payload = {}, options = {}) {
  if (!isPg(options)) return (await syncDb()).mutateRentalCatalog(action, payload);
  return withFallback(options, {}, async () => {
    const { catalog: published } = await readStatePg(options);
    let catalog = (await readDraftPg(options)) || published;
    if (action === "upsert_category") catalog = upsertCategory(catalog, payload);
    else if (action === "upsert_condition") catalog = upsertCondition(catalog, payload);
    else if (action === "move_condition") catalog = moveCondition(catalog, payload.id, payload.category_id);
    else if (action === "delete_condition") {
      const refs = await catalogConditionReferencesAsync(payload.id, options);
      const result = deleteOrDisableCondition(catalog, payload.id, refs);
      await writePg(KEYS.draft, result.catalog, options);
      return { ...result, draft: true, diff: catalogDiff(published, result.catalog) };
    } else {
      throw badRequest("不支援的目錄操作");
    }
    await writePg(KEYS.draft, catalog, options);
    return { catalog, draft: true, diff: catalogDiff(published, catalog) };
  }, async () => (await syncDb()).mutateRentalCatalog(action, payload));
}

export async function saveRentalCatalogTemplateAsync(input = {}, options = {}) {
  if (!isPg(options)) return (await syncDb()).saveRentalCatalogTemplate(input);
  return withFallback(options, {}, async () => {
    const items = await readTemplatesPg(options);
    const next = normalizeTemplate(input, items.map((row) => row.id).filter((id) => id !== input.id));
    if (isSystemCatalogTemplate(next.id) || isSystemCatalogTemplate(input.id)) {
      throw badRequest("系統範本只能套用，不能改名或覆寫");
    }
    const idx = items.findIndex((row) => row.id === next.id);
    if (idx >= 0) items[idx] = next;
    else items.push(next);
    await writePg(KEYS.templates, { items }, options);
    return { ...next, system: false };
  }, async () => (await syncDb()).saveRentalCatalogTemplate(input));
}

export async function renameRentalCatalogTemplateAsync(id, label, options = {}) {
  if (!isPg(options)) return (await syncDb()).renameRentalCatalogTemplate(id, label);
  return withFallback(options, {}, async () => {
    if (isSystemCatalogTemplate(id)) throw badRequest("系統範本不能改名稱");
    const items = await readTemplatesPg(options);
    const row = items.find((item) => item.id === id);
    if (!row) throw Object.assign(new Error("找不到這個範本"), { status: 404 });
    const next = normalizeTemplate({ ...row, id: row.id, label }, items.map((item) => item.id).filter((item) => item !== id));
    const idx = items.findIndex((item) => item.id === id);
    items[idx] = { ...next, id: row.id };
    await writePg(KEYS.templates, { items }, options);
    return { ...items[idx], system: false };
  }, async () => (await syncDb()).renameRentalCatalogTemplate(id, label));
}

export async function deleteRentalCatalogTemplateAsync(id, options = {}) {
  if (!isPg(options)) return (await syncDb()).deleteRentalCatalogTemplate(id);
  return withFallback(options, {}, async () => {
    if (isSystemCatalogTemplate(id)) throw badRequest("系統範本不能刪除");
    const items = await readTemplatesPg(options);
    if (!items.some((item) => item.id === id)) throw Object.assign(new Error("找不到這個範本"), { status: 404 });
    const next = items.filter((item) => item.id !== id);
    await writePg(KEYS.templates, { items: next }, options);
    return {
      ok: true,
      items: next.map((row) => ({ id: row.id, label: row.label, system: isSystemCatalogTemplate(row.id) })),
    };
  }, async () => (await syncDb()).deleteRentalCatalogTemplate(id));
}
