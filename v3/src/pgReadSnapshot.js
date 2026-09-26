import { setImmediate as yieldToIO } from 'node:timers/promises';
import { candidateRowFromValues, LIST_CANDIDATE_KEYS } from './listingCandidateRow.js';
import { readCandidateContent } from './pgCandidateContent.js';

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
    // Every cursor below is exhausted. Plan for total time, not the default
    // assumption that a consumer fetches only its first ten percent.
    await client.query('SET LOCAL cursor_tuple_fraction = 1');
    let cursorId = 0;
    const readRows = async (sql, params = [], { arrayRows = false } = {}) => {
      // Bound decoded cells per parser turn. Narrow ID/version reads can carry
      // more rows per transfer than the full 42-field shape. Retain every row.
      const name = `listing_read_${++cursorId}`;
      await client.query(`DECLARE ${name} NO SCROLL CURSOR WITHOUT HOLD FOR ${sql}`, params);
      const rows = [];
      let rowFromValues;
      let batchSize = 512;
      while (true) {
        const text = `FETCH FORWARD ${batchSize} FROM ${name}`;
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
        if (batch.rows.length < batchSize) break;
        batchSize = Math.max(512, Math.min(4096, Math.floor(512 * 42 / Math.max(1, batch.fields.length))));
        await yieldToIO();
      }
      await client.query(`CLOSE ${name}`);
      return rows;
    };
    return await run({
      query:(sql,params=[])=>client.query(sql,params),
      readRows:(sql,params=[],options={})=>readCandidateContent({client,readRows,
        store:driver.candidateContent,sql,params,options}),
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
