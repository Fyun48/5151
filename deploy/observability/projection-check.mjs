// 投影完整性查核（唯讀）。PR-B 用；也可由 systemd timer 定時執行。
//
// 全程在同一個 REPEATABLE READ READ ONLY 交易內，只有 SELECT，立即結束。
// 環境變數 SUMMARY=1 → 只印一行摘要（給監控用；不需在 host 端解析 JSON）。
import { createPostgresDriver } from "/app/src/dbDriverPostgres.js";

const drv = await createPostgresDriver({ env: process.env });
const out = { at: new Date().toISOString() };
const client = await drv.pool.connect();
try {
  await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const q = async (sql) => (await client.query(sql)).rows;

  out.totals = (await q(
    "SELECT (SELECT COUNT(*) FROM listings)::int AS listings, (SELECT COUNT(*) FROM listing_search_projection)::int AS projection",
  ))[0];

  out.missing = (await q(`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE COALESCE(l.hidden, 0) = 0)::int AS not_hidden,
           COUNT(*) FILTER (WHERE COALESCE(l.offline, 0) = 0)::int AS not_offline,
           COUNT(*) FILTER (WHERE COALESCE(l.hidden, 0) = 0 AND COALESCE(l.offline, 0) = 0)::int AS visible
    FROM listings l
    WHERE NOT EXISTS (SELECT 1 FROM listing_search_projection p WHERE p.post_id = l.post_id)
  `))[0];

  out.orphaned = (await q(`
    SELECT COUNT(*)::int AS n FROM listing_search_projection p
    WHERE NOT EXISTS (SELECT 1 FROM listings l WHERE l.post_id = p.post_id)
  `))[0];

  out.duplicates = (await q(
    "SELECT COUNT(*)::int AS dup_groups FROM (SELECT post_id FROM listing_search_projection GROUP BY post_id HAVING COUNT(*) > 1) t",
  ))[0];

  out.nullPostIds = (await q(
    "SELECT COUNT(*)::int AS n FROM listing_search_projection WHERE post_id IS NULL",
  ))[0];

  await client.query("COMMIT");
} catch (error) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // rollback 失敗不掩蓋原錯誤
  }
  out.error = String(error?.message || error);
} finally {
  client.release();
}

if (process.env.SUMMARY === "1") {
  const ok = !out.error && out.orphaned?.n === 0 && out.duplicates?.dup_groups === 0 && out.nullPostIds?.n === 0;
  console.log(
    `missing=${out.missing?.total ?? "?"} missing_visible=${out.missing?.visible ?? "?"} orphan=${out.orphaned?.n ?? "?"}`
    + ` dup=${out.duplicates?.dup_groups ?? "?"} nulls=${out.nullPostIds?.n ?? "?"}`
    + ` listings=${out.totals?.listings ?? "?"} projection=${out.totals?.projection ?? "?"}`
    + ` ok=${ok ? 1 : 0}${out.error ? ` error=${out.error}` : ""}`,
  );
} else {
  console.log(JSON.stringify(out, null, 2));
}
await drv.pool.end();
