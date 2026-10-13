// 行政區聯通閉包（`districtClosureIds`）結果的**進程內 TTL 記憶**（策略 H-A，Owner 2026-10-13 11:15 裁決選 A）。
//
// 要解的問題：`districtClosureIds()` 是會員列表／訪客搜尋前置的主要延遲（正式站即時算
// 869–927ms），而同一個行政區組合（＋同一個 `userId`／`relatedOnly`）在數秒內會被反覆問到
// （同一個請求內 list 與 stats 兩側、以及連續的翻頁／重整請求）。這一層把那段重算換成
// 「時間上界的記憶」：**最多沿用 TTL 毫秒，過了就重算**。
//
// ── 開關（照 repo 慣例登記在此；**不動 compose／.env**）──────────────────────────────
//   * `MEMBER_DISTRICT_CLOSURE_MEMO`：預設 **ON**；`=0`（或 `false`／`off`／`no`）⇒ 每次都即時算
//     （這就是 A/B 等價證據用的開關）。
//   * `MEMBER_DISTRICT_CLOSURE_MEMO_TTL_MS`：預設 **15_000**；一律 **clamp 到 [0, 20_000]**
//     （20 秒是 Owner 批的過期上限，**硬寫死**，環境變數調不上去）；`0` 視同關閉（每次重算）。
//   * 兩個開關都是**每次呼叫時讀**，所以 A/B 可以在同一個行程內切換，不必重啟。
//
// ── 語意（逐條對應 Owner 的裁決）────────────────────────────────────────────────────
//   1. 命中規則：`age <= TTL` 就回傳；**回傳淺拷貝**，呼叫端拿不到內部陣列。
//   2. 過期＝重算（await 到底）。**沒有 SWR**：「過期後先給舊值再背景更新」明確不做——
//      TTL 就是過期硬上限，這是 Owner 批的語意。
//   3. **`null` 不進快取**：`null`＝「不需過濾」的**便宜路徑**（`!allowed.length ||
//      allowed.length === allKeys.length` 在昂貴查詢**之前**就 return），快取它只會浪費記憶體。
//   4. LRU、（預設）上限 32 筆，每筆 `{value, expiresAt}`；存取時清過期。
//   5. 單飛（single-flight）：同 key 的併發呼叫共享同一個 in-flight promise（不會打兩次）。
//
// ── 為什麼是「時間上界」而不是「版本化快取」（別把這條設計退回去）──────────────────
//   `listingDistrictPrefilter.js:368-386` 已經用正式站待機庫實測論證過：一個依
//   `data_revision` 版本化的 closure 快取，在爬蟲活躍時命中率是 **0/9（0%）**
//   （revision 約 +1.3 次/秒，但 closure 的真輸入＝match 圖那段時間只變 1 次），
//   而便宜的圖指紋查詢本身要 203ms ⇒ 既要不到命中、也無法證明不多算。**H-A 選的是另一條路**：
//   不假裝知道資料有沒有變，而是明確承認「可能沿用最多 TTL 毫秒」，讓上界可量測、可關閉。
//
// ── 紅線 ────────────────────────────────────────────────────────────────────────────
//   這一層**不得對 DB 寫任何東西**（沒有任何 INSERT／UPDATE／DELETE／DDL）：記憶只在
//   本行程的記憶體裡。正式庫只有 SELECT——這正是選 H-A 的價值。
//
// 工廠形式（`createClosureMemo(compute, {now, maxEntries, ttlMs})`）刻意**不在本模組 import
// `listingSearchNodePg.js`**：避免循環 import，也讓測試能注入假 `compute`／假時鐘。
const SEP = "\x1f";
const TRUTHY_OFF = ["0", "false", "off", "no"];

/** 預設 TTL（毫秒）：15 秒。 */
export const CLOSURE_MEMO_DEFAULT_TTL_MS = 15_000;
/** TTL 硬上界（毫秒）：20 秒（Owner 批的過期上限，任何來源都不得超過）。 */
export const CLOSURE_MEMO_MAX_TTL_MS = 20_000;
/** LRU 預設上限（筆）。 */
export const CLOSURE_MEMO_DEFAULT_MAX_ENTRIES = 32;

/** 記憶層開關（預設 ON）。 */
export function closureMemoEnabled(env = process.env) {
  const raw = env.MEMBER_DISTRICT_CLOSURE_MEMO;
  if (raw == null || String(raw).trim() === "") return true;
  return !TRUTHY_OFF.includes(String(raw).trim().toLowerCase());
}

/** 把任何來源的 TTL 收斂到 [0, 20_000]；非數值一律回預設（不得靜默變成 0＝關閉）。 */
export function clampClosureMemoTtlMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return CLOSURE_MEMO_DEFAULT_TTL_MS;
  return Math.min(Math.max(Math.trunc(n), 0), CLOSURE_MEMO_MAX_TTL_MS);
}

/** 環境變數 TTL（預設 15_000，clamp 到 [0, 20_000]；空字串＝沒設）。 */
export function closureMemoTtlMs(env = process.env) {
  const raw = env.MEMBER_DISTRICT_CLOSURE_MEMO_TTL_MS;
  if (raw == null || String(raw).trim() === "") return CLOSURE_MEMO_DEFAULT_TTL_MS;
  return clampClosureMemoTtlMs(raw);
}

/**
 * 記憶的鍵：**行政區名單排序＋去重**後以 `\x1f` 連接，再帶上 `userId`（整數）與
 * `relatedOnly`（布林）。⇒ 同一組行政區不同順序＝同一個鍵（closure 的結果是 id **集合**，
 * 與名單順序無關）；`userId`／`relatedOnly` 不同則一定是不同的鍵（會員與訪客兩條路共用同一份
 * 記憶，靠這兩個欄位分開，不會串）。
 *
 * 欄位以 `u`／`r` 前綴標明邊界，避免「名單本身含有分隔符」時把兩個不同輸入拼成同一個鍵。
 */
export function closureMemoKey({ districtNames = [], userId = 0, relatedOnly = false } = {}) {
  const list = Array.isArray(districtNames) ? districtNames : [districtNames];
  const names = [...new Set(list.map(name => String(name ?? "")).filter(name => name !== ""))].sort();
  const uid = Math.trunc(Number(userId) || 0);
  return `${names.join(SEP)}${SEP}u${uid}${SEP}r${relatedOnly ? 1 : 0}`;
}

function shallowCopy(value) {
  return Array.isArray(value) ? value.slice() : value;
}

/**
 * 建立一個 closure 記憶包裝。回傳的函式與 `districtClosureIds(exec, {districtNames, userId, relatedOnly})`
 * **同一個簽名與回傳契約**（`number[]` 或 `null`）。
 *
 * @param compute 真正的計算函式（本模組不 import 它，由呼叫端注入）。
 * @param now 取得現在時間（毫秒）；注入假時鐘後測試不必靠真實時間。
 * @param maxEntries LRU 上限（預設 32）。
 * @param ttlMs 固定 TTL；不給（`null`）則每次呼叫時讀環境變數（A/B 可在同一行程內切換）。
 */
export function createClosureMemo(compute, { now = () => Date.now(), maxEntries = CLOSURE_MEMO_DEFAULT_MAX_ENTRIES, ttlMs = null } = {}) {
  if (typeof compute !== "function") throw new Error("createClosureMemo 需要一個 compute 函式（注入以避開循環 import）");
  const limit = Math.max(1, Math.trunc(Number(maxEntries) || CLOSURE_MEMO_DEFAULT_MAX_ENTRIES));
  const fixedTtl = ttlMs == null ? null : clampClosureMemoTtlMs(ttlMs);
  const entries = new Map();      // key -> { value, expiresAt }
  const inflight = new Map();     // key -> Promise<number[]|null>
  const counters = { computes: 0, hits: 0, misses: 0, shared: 0, evictions: 0, expirations: 0 };

  const effectiveTtl = () => (fixedTtl == null ? closureMemoTtlMs() : fixedTtl);

  /** 所有路徑（含關閉／TTL=0 的即時算）都經過這裡 ⇒ `computes` 是「真的算了幾次」的計數。 */
  async function runCompute(exec, options) {
    counters.computes += 1;
    return compute(exec, options);
  }

  /** 存取時清過期（`expiresAt < now` 才算過期；`now === expiresAt` 仍是命中）。 */
  function pruneExpired(nowMs) {
    for (const [key, entry] of entries) {
      if (entry.expiresAt < nowMs) {
        entries.delete(key);
        counters.expirations += 1;
      }
    }
  }

  async function memoized(exec, options = {}) {
    const ttl = effectiveTtl();
    // 關閉（或 TTL=0）＝純即時算，連 key 都不用算。
    if (!closureMemoEnabled() || ttl <= 0) return runCompute(exec, options);

    const key = closureMemoKey(options);
    const nowMs = now();
    pruneExpired(nowMs);
    const hit = entries.get(key);
    if (hit) {
      // LRU：命中即移到尾端（Map 的插入順序就是新舊順序）。
      entries.delete(key);
      entries.set(key, hit);
      counters.hits += 1;
      return shallowCopy(hit.value);
    }
    const running = inflight.get(key);
    if (running) {
      counters.shared += 1;
      return shallowCopy(await running);
    }
    counters.misses += 1;
    const pending = (async () => {
      const value = await runCompute(exec, options);
      // `null`＝不需過濾的便宜路徑 ⇒ 不進快取（只會浪費記憶體）。
      if (Array.isArray(value)) {
        entries.delete(key);
        entries.set(key, { value, expiresAt: now() + ttl });
        while (entries.size > limit) {
          entries.delete(entries.keys().next().value);
          counters.evictions += 1;
        }
      }
      return value;
    })();
    inflight.set(key, pending);
    try {
      return shallowCopy(await pending);
    } finally {
      if (inflight.get(key) === pending) inflight.delete(key);
    }
  }

  /** 測試／A-B 腳本用：清空記憶與 in-flight（不動計數器）。 */
  memoized.clear = () => { entries.clear(); inflight.clear(); };
  /** 目前快取的筆數。 */
  memoized.size = () => entries.size;
  memoized.inflightSize = () => inflight.size;
  /** 事實計數（A/B 證據用）：`computes` 含關閉路徑的即時算。 */
  memoized.stats = () => ({ ...counters, size: entries.size, inflight: inflight.size, maxEntries: limit });
  memoized.resetStats = () => { for (const key of Object.keys(counters)) counters[key] = 0; };
  memoized.key = closureMemoKey;
  return memoized;
}
