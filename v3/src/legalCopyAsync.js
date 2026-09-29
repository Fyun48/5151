// 法律文案（免責聲明／個資說明）的 driver-aware 入口（PG 島嶼，2026-09-28，第五十批）。
//
// 涵蓋的路由：
//   GET /api/disclaimer          訪客／會員的免責聲明＋個資說明
//   GET /api/admin/legal-copy    後台同一份（含 check_label、version）
//   PUT /api/admin/legal-copy    後台儲存（settings ＋ 內容文件同步）
//
// 📌 這一支的價值在「**一份文案、兩個 store**」：`db.js` 的 `getLegalCopy()` 是
//   1. 先看內容文件（`content_documents` 的 registration_terms／privacy_notice）
//   2. 否則回退 `settings.legalCopy`
//   而 `saveLegalCopy()` 會**兩邊都寫**（settings 是舊讀者的來源，文件是 CMS 的來源）。
//   在 PG 站上，同步版兩邊都讀寫本機 SQLite ⇒ 後台改文案「看起來成功」，
//   但實際上改的是節點本機、**PG 站的訪客與其它節點都看不到**（靜默失效，沒有錯誤）。
//
// 🚨 **實測更正（第五十批）**：`settings.legalCopy` 其實是「**種子**」，不是回退來源。
//   `legalCopyFromDocuments()`（contentDocuments.js:441）**永遠不會回 null**：文件不在時它回
//   `defaultLegalCopy()` 的欄位；而 `getLegalCopy()` 的條件 `fromDocs?.disclaimer && fromDocs?.privacy`
//   因此恆真 ⇒ `?? settingKey("legalCopy")` 那一路**只有文件讀取丟例外時才到得了**。
//   真正生效的來源是 `content_documents`；settings 只在 bootstrap 種文件時被讀
//   （`seedDefaultDocuments(db, { legalCopy: settingKey("legalCopy") ?? defaultLegalCopy() })`）。
//   這一支照抄同樣的順序（parity 測試釘住），沒有自己發明語意。
//
// 這支刻意**不自己寫 SQL**：讀寫都走已經移植好的兩個島嶼
// （`contentDocumentsAsync` 的內容文件、`settingsKvAsync` 的站台設定），
// 這樣「JSON 語意」「不可變性」這些規則只會有一份實作。
import { resolveDbDriver } from "./dbDriver.js";
import { getLegalCopy as getLegalCopySync, saveLegalCopy as saveLegalCopySync } from "./db.js";
import {
  createDraftAsync,
  getEffectiveDocumentAsync,
  legalCopyFromDocumentsAsync,
  publishDocumentAsync,
} from "./contentDocumentsAsync.js";
import { getSiteSettingAsync, setSiteSettingAsync } from "./settingsKvAsync.js";
import { defaultLegalCopy, normalizeLegalCopy, publicLegalCopy } from "./legalCopy.js";
import { sqliteFallbackAllowed } from "./sqliteFallback.js";

// 與 db.js:864／872 同一個鍵名與 JSON 語意（settings 表、值為 JSON 物件）。
export const LEGAL_COPY_KEY = "legalCopy";

// `saveLegalCopy()` 會把這兩份文案同步成內容文件（db.js:1755 的同一張表）。
export const LEGAL_COPY_DOCUMENTS = [
  ["registration_terms", "disclaimer", "免責聲明", "disclaimerCheck"],
  ["privacy_notice", "privacy", "個資說明", "privacyCheck"],
];

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

// 讀取失敗可以回退（fail-open，與其它島嶼一致）；寫入預設**不**回退，
// 否則一次 PG 失敗會變成「表面成功、實際寫在節點本機」——正是這一支要修掉的病。
async function withFallback(options, runPostgres, runSqlite, { write = false } = {}) {
  if (!isPg(options)) return runSqlite();
  try {
    return await runPostgres();
  } catch (error) {
    if (!sqliteFallbackAllowed(options, write ? { write: true } : {})) throw error;
    return runSqlite();
  }
}

// `db.js:1739 getLegalCopy()` 的 PG 分支，順序逐條對應：
//   文件優先（兩份都要在）→ 否則 settings → 否則預設值 → `publicLegalCopy()` 投影。
export async function getLegalCopyAsync(options = {}) {
  return withFallback(options, async () => {
    try {
      const fromDocs = await legalCopyFromDocumentsAsync(options);
      if (fromDocs?.disclaimer && fromDocs?.privacy) return publicLegalCopy(fromDocs);
    } catch {
      // 回退 settings（同步版同義）
    }
    const stored = await getSiteSettingAsync(LEGAL_COPY_KEY, options);
    return publicLegalCopy(stored ?? defaultLegalCopy());
  }, () => getLegalCopySync());
}

// `db.js:1749 saveLegalCopy()` 的 PG 分支。**兩邊都寫**，而且：
//   - settings 先寫（同步版順序相同）：舊讀者（原生 SQL 讀 settings 的人）才看得到
//   - 內容文件那段失敗**不擋**（同步版就是 try/catch 吞掉），但 settings 的失敗要往外丟
//   - `reset: true` 回預設值，其餘欄位走 `normalizeLegalCopy()`
export async function saveLegalCopyAsync(partial = {}, options = {}) {
  const write = () => saveLegalCopySync(partial);
  if (!isPg(options)) return write();
  const src = partial && typeof partial === "object" ? partial : {};
  return withFallback(options, async () => {
    const current = await getLegalCopyAsync(options);
    const next = src.reset === true ? defaultLegalCopy() : normalizeLegalCopy({ ...current, ...src });
    await setSiteSettingAsync(LEGAL_COPY_KEY, next, options);
    // 兩店紀律：PG 是來源，但**還沒移植的同步讀者**（`db.js` 的 `updateUserProfile()` →
    // `withLegalProfile()`，PATCH /api/profile 用）讀的是節點本機 ⇒ 在同一台節點上把本機那份
    // 也寫成同一個值。`next` 是完整物件，所以同步版的 `{...本機目前值, ...next}` 會等於 `next`。
    // 盡力而為：本機鏡射失敗不影響 PG 的結果（其它節點仍要等 PATCH /api/profile 移植才會一致）。
    try { saveLegalCopySync(next); } catch { /* 本機鏡射失敗不擋 */ }
    try {
      const now = new Date();
      for (const [type, bodyKey, title, checkKey] of LEGAL_COPY_DOCUMENTS) {
        const body = next[bodyKey];
        const check = next[checkKey];
        const effective = await getEffectiveDocumentAsync(type, { now, ...options });
        if (effective && effective.body === body && effective.check_label === check) continue;
        const draft = await createDraftAsync({
          document_type: type,
          title: effective?.title || title,
          body,
          check_label: check,
          format: "plain",
          requires_reacceptance: false,
          supersedes_id: effective?.id,
        }, { actorId: 0, now, ...options });
        await publishDocumentAsync(draft.id, { actorId: 0, now, ...options });
      }
    } catch {
      // 舊路徑仍寫 settings；CMS 寫入失敗不擋（同步版同義）
    }
    return getLegalCopyAsync(options);
  }, write, { write: true });
}
