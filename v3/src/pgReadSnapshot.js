import { setImmediate as yieldToIO } from 'node:timers/promises';
import { candidateRowFromValues, LIST_CANDIDATE_KEYS } from './listingCandidateRow.js';

// A complete read uses one connection and one database snapshot. Lightweight
// driver doubles without a pool can still exercise the pure repository tests.
export async function withPgReadSnapshot(driver, run) {
  if (typeof driver?.pool?.connect !== 'function') return run(driver);
  const client = await driver.pool.connect();
  let broken = null;
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // This interactive workload spent ~815ms compiling a ~80ms query in the
    // fixed fixture. Scope the setting to this transaction, never the pool or
    // server. PostgreSQL restores it on ROLLBACK, including failures.
    await client.query('SET LOCAL jit = off');
    let cursorId = 0;
    return await run({
      query:(sql,params=[])=>client.query(sql,params),
      async readRows(sql, params = [], { arrayRows = false } = {}) {
        // Fixed-size transfers bound each pg parser turn. Every row is retained;
        // this is not a candidate LIMIT and does not alter grouping or totals.
        const name = `listing_read_${++cursorId}`;
        await client.query(`DECLARE ${name} NO SCROLL CURSOR WITHOUT HOLD FOR ${sql}`, params);
        const rows = [];
        let rowFromValues;
        while (true) {
          const text = `FETCH FORWARD 512 FROM ${name}`;
          const batch = await client.query(arrayRows ? { text, rowMode: 'array' } : text);
          if (arrayRows) {
            if (!rowFromValues) {
              const names = batch.fields.map(field => field.name);
              rowFromValues = names.length === LIST_CANDIDATE_KEYS.length
                && names.every((name, i) => name === LIST_CANDIDATE_KEYS[i])
                ? candidateRowFromValues
                : values => Object.fromEntries(names.map((name, i) => [name, values[i]]));
            }
            for (const values of batch.rows) rows.push(rowFromValues(values));
          } else rows.push(...batch.rows);
          if (batch.rows.length < 512) break;
          await yieldToIO();
        }
        await client.query(`CLOSE ${name}`);
        return rows;
      },
    });
  } finally {
    try { await client.query('ROLLBACK'); }
    catch (error) { broken=error; }
    client.release(broken || undefined);
  }
}

export async function readPgRows(driver, sql, params = [], options = {}) {
  return typeof driver.readRows === 'function'
    ? driver.readRows(sql, params, options)
    : (await driver.query(sql, params)).rows;
}
