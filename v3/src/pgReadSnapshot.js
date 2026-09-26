// A complete read uses one connection and one database snapshot. Lightweight
// driver doubles without a pool can still exercise the pure repository tests.
export async function withPgReadSnapshot(driver, run) {
  if (typeof driver?.pool?.connect !== 'function') return run(driver);
  const client = await driver.pool.connect();
  let broken = null;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    return await run({query:(sql,params=[])=>client.query(sql,params)});
  } finally {
    try { await client.query('ROLLBACK'); }
    catch (error) { broken=error; }
    client.release(broken || undefined);
  }
}
