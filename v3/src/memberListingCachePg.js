// 會員列表路徑（`GET /api/listings`／`GET /api/state` → `loadListingPage`）的版本化結果快取。
//
// 為什麼要這一層（2026-10-11，Owner「全做」清單第 4 項）：
//   訪客路徑早在 `publicListings.js` 就有一層 per-process 快取（generation＋20 秒新鮮窗口），
//   但**會員路徑完全沒有** ⇒ 同一個會員連按兩次重整都要重跑一次完整候選集
//   （今日實測 6.08 秒：`Server-Timing` list=3.37s／stats=2.03s）。
//   慢的根源是「`totalMatched` 必須由完整候選集合決定」這條不變式
//   （`listingSearchNodePg.js:9-11`），所以不能靠 LIMIT 或 SQL 化過濾鏈繞過 ⇒ 只能靠快取。
//
// 失效機制**沿用專案既有的 `data_revision`**（同 `db.js` 的 `storedSearchKeysFromPg`、
// `repository/listingStats.js` 的 `countProductListings`），不發明新的 TTL eviction。
// 與訪客快取同一個形狀：**generation（版本號）＋新鮮窗口**兩道閘同時成立才命中。
// 差別在嚴格度：訪客快取有 SWR（`MAX_STALE_MS=600s` 內先回舊值）；**會員快取一律不回舊代**
// ——版本一變就是硬性未命中，寧可重算也不讓會員看到過期的列表。
//
// ── key 的組成（每一項都必須在 key 裡，少一項就是回錯資料）──────────────────────────
//   ① `generation.revision`：`data_revision.MAX(id)`。爬蟲／同戶／配對／站內刊登的寫入
//      都會 bump（`crawlerWrites.js:83/90`、`sameHouseAsync.js:148/273/357`、
//      `listingMatchAsync.js:124`、`selfListingsAsync.js:267`）。這是**主要失效來源**。
//   ② `generation.dataVersion`：`pg_stat_user_tables` 對 `listings／route_cache／route_jobs／
//      mrt_cache／community_cache` 的 `n_tup_ins + n_tup_upd + n_tup_del` 總和。
//      為什麼 data_revision 不夠：**通勤路線與地圖／社區快取不是走 data_revision 的**
//      （`routeCacheAsync.js` 只寫 `route_cache`／`route_jobs`）。會員的 `commuteKm>0` 時
//      `applyListingFilter()`（`db.js:6899`）會用路線距離**決定這筆物件出不出的來**，
//      所以路線資料變了、列表成員就會變；沒有這個版本號就會回「已經被通勤條件刷掉」的舊列。
//      成本：一個 `pg_stat_user_tables` 聚合（實測 execution 0.5ms），不會掃表。
//   ③ 會員自己的狀態簽章（**`user_settings` 的 key=value 全集 ＋ `user_listing_flags`
//      （viewed／watched／hidden／watch_note／watch_group_id）＋ `user_same_house_members`
//      （同戶 fold）＋ `users.role/plan` ＋ 全域 `settings` ＋ `crawl_covers`**）：
//      這些表**不 bump data_revision**（`personalFlagsAsync.js` 沒有任何 bump），
//      所以「我剛把某筆按不再顯示」如果不進 key，下一次請求會把它又顯示回來。
//      每一項都用 `COUNT(*)`＋`md5(string_agg(... ORDER BY ...))` 做**有序集合雜湊**
//      （不是 `MAX(md5)`：後者抓不到刪除與部分更新）。
//   ④ 請求參數：filter／kind／sources／q／sort／limit／offset／cursor／districts（排序後）／
//      sameHouse／searchKeys（若呼叫端明確給）／`args.settings`（若呼叫端覆寫）／
//      **呼叫端明確傳入的 `asOf`**。刻意**不含** `listingRequestTime()` 自動產生的
//      `asOf`／`now`（那是每個請求都不同的時鐘，放進去等於永遠不命中）。
//   ⑤ `uid`：`/api/listings` 的候選集是**這個會員的** search_key 展開結果。
//
// ── 什麼時候作廢 ────────────────────────────────────────────────────────────────
//   • 上面 ①～④ 任何一項變動 ⇒ key 不同 ⇒ 未命中（舊 entry 只是留著，等容量淘汰）。
//   • 另外還有第二道閘：entry 年齡 > `MEMBER_LISTING_CACHE_FRESH_MS`（預設 30 秒）⇒ 未命中。
//     這是**上限**而不是失效機制：`pg_stat_user_tables` 的計數有約 1 秒的統計落後，
//     新鮮窗口讓「沒被版本號涵蓋到的周邊資料」的陳舊上限有界（比訪客快取的 600 秒嚴格）。
//
// ── 故意不快取的情況 ───────────────────────────────────────────────────────────
//   • `data_revision` 不存在／讀不到版本號 ⇒ **fail-closed**：不讀也不寫，直接現算
//     （同 `storedSearchKeysFromPg` 的契約）。
//   • 版本號或會員簽章查詢失敗（PG 半死、表被鎖）⇒ 同上，直接現算。
//   • 非 postgres driver（SQLite／測試替身）⇒ 完全不經過這一層。
//   • `MEMBER_LISTING_CACHE` 沒有開（**預設關閉**）⇒ 一行都不經過。
//   • 快取只存「單一快照算出來的整頁結果」；`timing` 每次重算（命中的 `query_ms/stats_ms`
//     是 0，不是照抄冷算的時間）⇒ 量測腳本不會把「快取命中」誤報成「伺服器算得快」。
//
// ── 記憶體 ─────────────────────────────────────────────────────────────────────
//   entry 上限 `MEMBER_LISTING_CACHE_ENTRIES`（預設 24）。一頁約 80 筆 lite 卡片
//   （`decorateListListingsPage` 不含內文／照片），單筆 entry 粗估 0.1～0.3MB ⇒ 上限約 3～8MB，
//   對 7.6GB 的機器是可控的；Map 以插入序淘汰最舊的一筆（同 `publicListings.js:114`）。
import { createHash } from "node:crypto";
import { MEMBER_LISTING_CACHE_ENV } from "./runtimeGuards.js";
import { toPostgresSql } from "./sqlDialect.js";

export { MEMBER_LISTING_CACHE_ENV };

/** 新鮮窗口（毫秒）。預設關閉的功能，開起來時這個值＝「同一個 generation 最多沿用多久」。 */
export const MEMBER_LISTING_CACHE_FRESH_MS_ENV = "MEMBER_LISTING_CACHE_FRESH_MS";
/** entry 上限（記憶體護欄）。 */
export const MEMBER_LISTING_CACHE_ENTRIES_ENV = "MEMBER_LISTING_CACHE_ENTRIES";
/** 全部 entry 合計的**物件筆數**上限（第二道記憶體護欄，見 writeEntry 的註解）。 */
export const MEMBER_LISTING_CACHE_LISTINGS_ENV = "MEMBER_LISTING_CACHE_MAX_LISTINGS";

export const DEFAULT_FRESH_MS = 30_000;
export const DEFAULT_MAX_ENTRIES = 24;
// 24 筆 entry 不是問題，「**每筆多大**」才是：`GET /api/state` 用 limit=500 走同一條路，
// 一頁 500 筆的裝飾後物件在隔離庫實測序列化 643KB／80 筆（≈8KB／筆）⇒ 24 頁 500 筆
// 最壞可以吃掉近百 MB。這裡用「合計筆數」當第二道上限（實測記憶體約為序列化的 1/2～1/3
// ⇒ 1200 筆約 3～5MB），單筆超過預算就整筆不存。
export const DEFAULT_MAX_LISTINGS = 1200;

// key 的格式版本。key 的組成一旦改變（例如多放一項簽章）就要 +1，
// 否則升級當下會拿舊格式的 key 去命中新格式寫進去的 entry。
export const MEMBER_LISTING_CACHE_KEY_VERSION = "member:v1";

export function memberListingCacheEnabled(env = process.env) {
  const raw = String(env?.[MEMBER_LISTING_CACHE_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "on" || raw === "true";
}

function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function memberListingCacheFreshMs(env = process.env) {
  return positiveInt(env?.[MEMBER_LISTING_CACHE_FRESH_MS_ENV], DEFAULT_FRESH_MS);
}

export function memberListingCacheMaxEntries(env = process.env) {
  return positiveInt(env?.[MEMBER_LISTING_CACHE_ENTRIES_ENV], DEFAULT_MAX_ENTRIES);
}

export function memberListingCacheMaxListings(env = process.env) {
  return positiveInt(env?.[MEMBER_LISTING_CACHE_LISTINGS_ENV], DEFAULT_MAX_LISTINGS);
}

/** 決定性序列化（物件鍵排序）——`args.settings` 這種物件要能穩定地進 key。 */
export function stableStringify(value, depth = 0) {
  if (depth > 8) return JSON.stringify(value) ?? "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item, depth + 1)).join(",")}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key], depth + 1)}`).join(",")}}`;
}

export function digestOf(value) {
  return createHash("sha1").update(stableStringify(value)).digest("hex");
}

/**
 * 請求參數 → key 的一部分。
 *
 * 只挑**會改變結果**的欄位。`asOf` 由呼叫端明確傳入的那一個為準（`explicitAsOf`）：
 * `loadListingPage` 會把 `listingRequestTime()` 產生的「每個請求都不同」的時鐘併進 args，
 * 那個**不可以**進 key，否則永遠不會命中。
 */
export function normalizeMemberListRequest(args = {}, { explicitAsOf = null } = {}) {
  const districts = (Array.isArray(args.districts) ? args.districts : String(args.districts || "").split(","))
    .map((name) => String(name || "").trim())
    .filter(Boolean)
    .sort();
  const searchKeys = Array.isArray(args.searchKeys)
    ? args.searchKeys.map((key) => String(key || "").trim()).filter(Boolean).slice().sort()
    : null;
  return stableStringify({
    filter: String(args.filter ?? "all"),
    kind: String(args.kind ?? ""),
    sources: String(args.sources ?? ""),
    q: String(args.q ?? ""),
    sort: String(args.sort ?? ""),
    limit: Number(args.limit) || 0,
    offset: Number(args.offset) || 0,
    cursor: args.cursor ?? null,
    districts,
    sameHouse: args.sameHouse !== false,
    searchKeys,
    // 呼叫端覆寫 settings（Benchmark／測試）時，結果取決於那一包物件，不能只用資料庫的簽章代表。
    settingsOverride: args.settings == null ? null : digestOf(args.settings),
    // 明確的 asOf（測試／回放）會改變「現在」的推導 ⇒ 進 key；自動產生的時鐘不進。
    asOf: explicitAsOf == null ? null : String(explicitAsOf),
  });
}

/**
 * 版本號＋會員狀態簽章查詢。
 *
 * 只讀**既有欄位**、不建新表；`pg_stat_user_tables` 是唯讀的統計檢視（不鎖表、不掃表）。
 * 全部放在**同一個 statement** 裡 ⇒ 一次 round trip（實測 3ms 上下）。
 */
export const MEMBER_LISTING_GENERATION_SQL = `
SELECT
  (SELECT MAX(id) FROM data_revision) AS revision,
  (SELECT COALESCE(SUM(n_tup_ins + n_tup_upd + n_tup_del), 0)
     FROM pg_stat_user_tables
    WHERE relname IN ('listings', 'route_cache', 'route_jobs', 'mrt_cache', 'community_cache')) AS data_version,
  (SELECT COUNT(*) FROM settings) AS global_settings_n,
  (SELECT COALESCE(md5(string_agg(key || '=' || value, '|' ORDER BY key)), '') FROM settings) AS global_settings_sig,
  (SELECT COUNT(*) FROM users) AS users_n,
  (SELECT COALESCE(md5(string_agg(id || ':' || COALESCE(role, '') || ':' || COALESCE(plan, '') || ':' || COALESCE(deleted_at, ''), '|' ORDER BY id)), '') FROM users) AS users_sig,
  (SELECT COUNT(*) FROM crawl_covers) AS covers_n,
  (SELECT COALESCE(md5(string_agg(id || ':' || region_id || ':' || COALESCE(section_ids, '') || ':' || price_min || ':' || price_max || ':' || COALESCE(last_run_at, ''), '|' ORDER BY id)), '') FROM crawl_covers) AS covers_sig,
  (SELECT COUNT(*) FROM user_settings WHERE user_id = ?) AS member_settings_n,
  (SELECT COALESCE(md5(string_agg(key || '=' || value, '|' ORDER BY key)), '') FROM user_settings WHERE user_id = ?) AS member_settings_sig,
  (SELECT COUNT(*) FROM user_listing_flags WHERE user_id = ?) AS flags_n,
  (SELECT COALESCE(md5(string_agg(post_id || ':' || viewed || watched || hidden || ':' || COALESCE(watch_note, '') || ':' || COALESCE(watch_group_id, ''), '|' ORDER BY post_id)), '') FROM user_listing_flags WHERE user_id = ?) AS flags_sig,
  (SELECT COUNT(*) FROM user_same_house_members WHERE user_id = ?) AS same_house_n,
  (SELECT COALESCE(md5(string_agg(post_id || ':' || group_key || ':' || system_agrees, '|' ORDER BY post_id)), '') FROM user_same_house_members WHERE user_id = ?) AS same_house_sig
`;

/** `data_revision` 存在嗎？（不 throw 的探測；延遲建表的環境／空表一律當成「沒有版本號」） */
export const DATA_REVISION_PROBE_SQL = "SELECT to_regclass('data_revision') IS NOT NULL AS has_revision";

/**
 * 讀出目前的 generation。**讀不到就回 null**（呼叫端必須據此 fail-closed，不得沿用舊值）。
 * `exec(sql, params)` 的契約與其他 repository 相同：回傳列陣列。
 */
export async function readMemberListingGeneration(exec, uid) {
  const id = Number(uid) || 0;
  const probe = await exec(DATA_REVISION_PROBE_SQL, []);
  const probeRow = Array.isArray(probe) ? probe[0] : probe;
  if (!probeRow?.has_revision) return null;
  const rows = await exec(MEMBER_LISTING_GENERATION_SQL, [id, id, id, id, id, id]);
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) return null;
  // ⚠️ 一定要先擋 `== null`：`Number(null) === 0` 而且 `Number.isFinite(0) === true`，
  // 只用 isFinite 會把「空表（MAX(id) IS NULL）」誤判成版本號 0，於是永遠命中同一代。
  if (row.revision == null || row.data_version == null) return null;
  const revision = Number(row.revision);
  const dataVersion = Number(row.data_version);
  // 空表或非數字 ⇒ 沒有可靠版本號 ⇒ 不缓存（同 storedSearchKeysFromPg 的註解）。
  if (!Number.isFinite(revision) || !Number.isFinite(dataVersion)) return null;
  return {
    revision,
    dataVersion,
    signature: [
      row.global_settings_n, row.global_settings_sig,
      row.users_n, row.users_sig,
      row.covers_n, row.covers_sig,
      row.member_settings_n, row.member_settings_sig,
      row.flags_n, row.flags_sig,
      row.same_house_n, row.same_house_sig,
    ].join(","),
  };
}

export function memberListingCacheKey({ generation, args, uid, explicitAsOf = null } = {}) {
  if (!generation) return null;
  const id = Number(uid) || 0;
  return [
    MEMBER_LISTING_CACHE_KEY_VERSION,
    `r${generation.revision}`,
    `d${generation.dataVersion}`,
    `u${id}`,
    generation.signature,
    normalizeMemberListRequest(args, { explicitAsOf }),
  ].join("|");
}

// ── per-process 儲存 ───────────────────────────────────────────────────────────
const cache = new Map();
// 進行中的計算（single-flight）：同一個 key 的併發請求共用同一次全量計算，只跑一次。
const inflight = new Map();
// 目前所有 entry 的物件筆數合計（記憶體護欄）。
let weightTotal = 0;
let counters = { hits: 0, misses: 0, joins: 0, stores: 0, bypasses: 0 };

export function resetMemberListingCache() {
  cache.clear();
  inflight.clear();
  counters = { hits: 0, misses: 0, joins: 0, stores: 0, bypasses: 0 };
  weightTotal = 0;
}

export function memberListingCacheSize() {
  return cache.size;
}

/** 目前快取的物件筆數合計（記憶體護欄的可觀測值）。 */
export function memberListingCacheWeight() {
  return weightTotal;
}

/** 量測／診斷用：命中／未命中／併流／寫入／繞過的次數。 */
export function memberListingCacheCounters() {
  return { ...counters };
}

export function memberListingCacheEntries() {
  return [...cache.keys()];
}

function readEntry(key, nowMs, freshMs) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (nowMs - entry.at > freshMs) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function writeEntry(key, payload, nowMs, maxEntries, maxListings) {
  const weight = Array.isArray(payload?.listings) ? payload.listings.length : 0;
  // 先刪再塞，讓 Map 的插入序真的等於「最近寫入」⇒ 淘汰的是最舊的那一筆。
  const previous = cache.get(key);
  cache.delete(key);
  if (previous) weightTotal -= previous.weight || 0;
  // 單筆就超過總預算（例如有人一次要 2000 筆）⇒ 整筆不存，不要讓它把整池擠掉。
  if (weight > maxListings) return;
  cache.set(key, { at: nowMs, payload, weight });
  weightTotal += weight;
  while (cache.size > maxEntries || weightTotal > maxListings) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    weightTotal -= cache.get(oldest)?.weight || 0;
    cache.delete(oldest);
  }
}

/**
 * 命中時回傳的回應：**只換掉 `timing`**（用新的物件，絕對不就地改到 entry 裡那一份
 * ——`server.js:4939` 會 `page.timing.total_ms = …`，共用同一個物件會污染快取）。
 * `query_ms/stats_ms` 一律 0：這一頁沒有真的算，量測腳本與 `Server-Timing` 才不會說謊。
 */
export function memberListingCacheHitResponse(entry, { startedMs, nowMs }) {
  const payload = entry.payload || {};
  const timing = payload.timing || {};
  const ageMs = Math.max(0, Math.round(nowMs - entry.at));
  return {
    ...payload,
    // 頂層容器一律換成新的（stats 是小型物件、listings 只複製陣列）：
    // 呼叫端若就地改動（例如 server.js 改 timing、或未來有人排序 listings），
    // 不可以改到快取裡那一份。
    stats: payload.stats && typeof payload.stats === "object" ? { ...payload.stats } : payload.stats,
    listings: Array.isArray(payload.listings) ? payload.listings.slice() : payload.listings,
    timing: {
      ...timing,
      query_ms: 0,
      stats_ms: 0,
      total_ms: Math.max(0, Math.round(nowMs - startedMs)),
      stages: { ...(timing.stages || {}), cache_hit: true, cache_age_ms: ageMs },
      stats_stages: { ...(timing.stats_stages || {}), cache_hit: true },
    },
  };
}

/**
 * 快取入口。`load()` 是「完全沒快取時」的那條路（`computeListingPage`）；
 * 任何一項前置條件不成立都直接呼叫它，回傳值與今天逐字相同。
 *
 * deps 只用來注入測試替身（`readGeneration`／`now`／`freshMs`／`maxEntries`），正式路徑不傳。
 */
export async function loadMemberListingPage({ pgDriver, args = {}, load, deps = {} } = {}) {
  if (typeof load !== "function") throw new Error("loadMemberListingPage requires load()");
  const now = deps.now || Date.now;
  const uid = Number(args.userId) || 0;
  const explicitAsOf = deps.explicitAsOf ?? null;
  const freshMs = deps.freshMs ?? memberListingCacheFreshMs();
  const maxEntries = deps.maxEntries ?? memberListingCacheMaxEntries();
  const maxListings = deps.maxListings ?? memberListingCacheMaxListings();
  const exec = deps.exec || ((sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows));
  const readGeneration = deps.readGeneration || ((id) => readMemberListingGeneration(exec, id));
  const startedMs = now();

  let generation = null;
  try {
    generation = await readGeneration(uid);
  } catch {
    generation = null;
  }
  const key = memberListingCacheKey({ generation, args, uid, explicitAsOf });
  if (!key) {
    counters.bypasses += 1;
    return load();
  }

  const hit = readEntry(key, startedMs, freshMs);
  if (hit) {
    counters.hits += 1;
    return memberListingCacheHitResponse(hit, { startedMs, nowMs: now() });
  }
  if (inflight.has(key)) {
    counters.joins += 1;
    return inflight.get(key);
  }

  counters.misses += 1;
  const pending = (async () => {
    const payload = await load();
    // 寫入前**再確認一次**版本沒變：算這一頁的期間若剛好有寫入，這份結果就可能已經過期，
    // 寧可只服務這一個請求、不要掛上新的版本號給後面的請求用。
    let confirm = null;
    try {
      confirm = await readGeneration(uid);
    } catch {
      confirm = null;
    }
    if (confirm && memberListingCacheKey({ generation: confirm, args, uid, explicitAsOf }) === key) {
      writeEntry(key, payload, now(), maxEntries, maxListings);
      counters.stores += 1;
    }
    return payload;
  })();
  inflight.set(key, pending);
  const clear = () => inflight.delete(key);
  pending.then(clear, clear);
  return pending;
}
