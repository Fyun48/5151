// 投影重新同步（repro 實驗用）：以 listings 為來源，重算並 upsert 所有投影列。
// 目的是驗證「(乙) parity 的 kind/sort/display 殘差是否來自投影過時」。只寫 listing_search_projection。
import { createPostgresDriver } from "../src/dbDriverPostgres.js";
import { assertPgTargetAllowed } from "../src/domainToolGuards.js";
import { toPostgresSql } from "../src/sqlDialect.js";
import { computeListingProjection, listingProjectionUpsertSql, bindProjectionValues } from "../src/listingSearchProjection.js";

assertPgTargetAllowed("projection-resync", process.env.PG_URL || "", { allow: ["repro", "crawl_sandbox", "tracker_test", "repro2"] });
const drv = await createPostgresDriver({ env: process.env });

const FIELDS = `*`;

let offset = 0;
const BATCH = 5000;
let total = 0;
const t0 = Date.now();
while (true) {
  const rows = (await drv.pool.query(`SELECT ${FIELDS} FROM listings ORDER BY post_id LIMIT ${BATCH} OFFSET ${offset}`)).rows;
  if (!rows.length) break;
  const client = await drv.pool.connect();
  try {
    await client.query("BEGIN");
    for (const r of rows) {
      const p = computeListingProjection(r);
      await client.query(toPostgresSql(listingProjectionUpsertSql()), bindProjectionValues(p));
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }
  total += rows.length;
  offset += BATCH;
  console.log(`resynced=${total} elapsed=${Date.now() - t0}ms`);
}
console.log(JSON.stringify({ total, elapsedMs: Date.now() - t0 }));
await drv.pool.end();
