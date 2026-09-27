// 5151 crawl 即時性查核（唯讀）。在 v3 容器內以容器自己的 PG_URL 執行。
//
// 為什麼需要它（2026-09-26／27 兩次停擺的教訓）：
//   兩次 crawler 死掉都是「安靜地死」——一次約 5 小時、一次約 1.5 小時，沒有任何人知道。
//   單一指標 listings.last_seen_at 有沒有在前進，就能在幾分鐘內抓到這兩次。
//   這是整個事件裡投報率最高的一個檢查。
//
// 唯讀：只做 SELECT，不改任何資料。
// 輸出：單行摘要；ok=1 代表 lag 在門檻內。監控端只信任 ok 欄位，避免字串順序造成誤報。
//
// 注意：listings.last_seen_at 是 TEXT（ISO 字串），字典序等於時間序，所以 max() 可用。
import { Client } from "pg";

const THRESHOLD_SEC = Math.max(60, Number(process.env.STALE_ALERT_SECONDS || 1800));
const client = new Client({ connectionString: process.env.PG_URL });

try {
  await client.connect();
  // ⚠️ 2026-09-27 修正：`last_seen_at` 是 TEXT（ISO，`2026-09-27T…Z`），而
  // `(now() - interval '1 hour')::text` 產生的是 `2026-09-27 04:04:21+00`（空格而非 T）。
  // 字典序下 'T'(0x54) > ' '(0x20)，所以**每一列都會符合 `>`**，fresh_1h 會等於總數（假數字）。
  // 正確做法是轉成 timestamptz 再比。用 CASE 先擋掉格式不符的值，避免整條查詢因轉型失敗。
  // （ok／lag_s 是在 JS 用 Date.parse 算的，本來就正確，告警不受這個 bug 影響。）
  const { rows } = await client.query(`
    WITH parsed AS (
      SELECT CASE WHEN last_seen_at ~ '^\\d{4}-\\d{2}-\\d{2}T' THEN last_seen_at::timestamptz END AS ts
        FROM listings
    )
    SELECT
      (SELECT max(last_seen_at) FROM listings) AS newest,
      (SELECT count(*) FROM listings) AS total,
      (SELECT count(*) FROM parsed WHERE ts > now() - interval '1 hour') AS fresh_1h,
      (SELECT count(*) FROM parsed WHERE ts < now() - interval '7 days') AS stale_7d,
      (SELECT count(*) FROM parsed WHERE ts IS NULL) AS unparsable,
      (SELECT pg_is_in_recovery() AS r) AS r
  `);
  const row = rows[0] || {};
  const newest = row.newest ? Date.parse(row.newest) : NaN;
  const lagSec = Number.isFinite(newest) ? Math.round((Date.now() - newest) / 1000) : -1;
  const inRecovery = row.r === true;
  // 沒有資料（total=0）時不算失敗，避免空庫誤報；有資料但 lag 超標才是 ALERT。
  const total = Number(row.total) || 0;
  const ok = total === 0 || (lagSec >= 0 && lagSec <= THRESHOLD_SEC);
  console.log([
    `ok=${ok ? 1 : 0}`,
    `lag_s=${lagSec}`,
    `threshold_s=${THRESHOLD_SEC}`,
    `total=${total}`,
    `fresh_1h=${Number(row.fresh_1h) || 0}`,
    `stale_7d=${Number(row.stale_7d) || 0}`,
    `unparsable=${Number(row.unparsable) || 0}`,
    `in_recovery=${inRecovery ? 1 : 0}`,
  ].join(" "));
} catch (error) {
  // 查核本身失敗也要能被監控看到，且不得讓例外堆疊弄髒單行輸出。
  console.log(`ok=0 error=${String(error?.message || error).replace(/\s+/g, "_").slice(0, 160)}`);
} finally {
  try { await client.end(); } catch { /* 已經斷了就不用再處理 */ }
}
