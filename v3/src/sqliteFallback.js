// PG 模式下的「SQLite fallback」政策（2026-09-23）。
//
// 背景：每個 `*Async` 模組的 `withFallback()` / `write()` / `withFallbackTx()` 原本在 PostgreSQL
// 失敗時**一律** fail-open 回本機 SQLite：
//
//   - 對「讀取」那是有意的（寧可回舊資料也不要讓整個站 500）。
//   - 對「**寫入**」是有害的：寫進去的 SQLite 沒有任何人讀（站讀 PostgreSQL）＝無聲的資料分歧。
//     2026-09-23 的 HA 演練就出現過寫入失敗的窗口，只是剛好沒有真的寫進 SQLite。
//
// 政策：
//   - 寫入（`options.write === true`）：**fail-closed** —— 把 PG 的錯誤往上丟，讓呼叫端回報或之後重試。
//   - 讀取：維持 fail-open。
//   - `options.strict === true`：一律往上丟（原本就有；測試與 live 探針在用）。
//   - `options.fallback === "open"` 或環境變數 `PG_SQLITE_FALLBACK=open`：緊急回退成舊行為
//     （真實故障、需要「先讓站活著」時用；用完記得關掉）。
export const PG_SQLITE_FALLBACK_ENV = "PG_SQLITE_FALLBACK";

export function fallbackMode(env = process.env) {
  const raw = String(env?.[PG_SQLITE_FALLBACK_ENV] || "").trim().toLowerCase();
  return raw === "open" || raw === "all" || raw === "1" || raw === "true" ? "open" : "closed";
}

// `write` 由呼叫端標記（helper 讀 `options.write`）：true = 這個操作會寫入。
export function sqliteFallbackAllowed(options = {}, { write = false, env = process.env } = {}) {
  if (options.strict === true) return false;
  if (options.fallback === "open") return true;
  if (fallbackMode(env) === "open") return true;
  return !write;
}