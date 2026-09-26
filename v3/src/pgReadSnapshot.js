import { candidateRowFromValues, LIST_CANDIDATE_KEYS } from './listingCandidateRow.js';
import { readCandidateContent } from './pgCandidateContent.js';
import { currentWorkDiagnostics, yieldWork } from './workDiagnostics.js';

// A complete read uses one connection and one database snapshot. Lightweight
// driver doubles without a pool can still exercise the pure repository tests.
export async function withPgReadSnapshot(driver, run) {
  if (typeof driver?.pool?.connect !== 'function') return run(driver);
  const client = await driver.pool.connect();
  const diagnostics = currentWorkDiagnostics();
  const query = (sql, params = []) => {
    if (!diagnostics) return client.query(sql, params);
    const text = typeof sql === 'string' ? sql : sql.text;
    const label = /^FETCH\b/.test(text) ? 'pg.fetch' : /^DECLARE\b/.test(text) ? 'pg.declare'
      : /^SELECT COUNT\(\*\) AS n FROM listings WHERE/.test(text) ? 'pg.countListings' : 'pg.query';
    const started = performance.now();
    const pending = client.query(sql, params);
    diagnostics.record(`${label}.submitSync`, performance.now() - started);
    return pending.then(result => {
      // Includes server, transport and response parsing. Not a synchronous span.
      diagnostics.record(`${label}.wall`, performance.now() - started, result.rowCount || 0);
      return result;
    });
  };
  let broken = null;
  try {
    await query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    // This interactive workload spent ~815ms compiling a ~80ms query in the
    // fixed fixture. Scope the setting to this transaction, never the pool or
    // server. PostgreSQL restores it on ROLLBACK, including failures.
    await query('SET LOCAL jit = off');
    // Every cursor below is exhausted. Plan for total time, not the default
    // assumption that a consumer fetches only its first ten percent.
    await query('SET LOCAL cursor_tuple_fraction = 1');
    let cursorId = 0;
    const readRows = async (sql, params = [], { arrayRows = false } = {}) => {
      // Bound decoded cells per parser turn. Narrow ID/version reads can carry
      // more rows per transfer than the full 42-field shape. Retain every row.
      const name = `listing_read_${++cursorId}`;
      await query(`DECLARE ${name} NO SCROLL CURSOR WITHOUT HOLD FOR ${sql}`, params);
      const rows = [];
      let rowFromValues;
      let batchSize = 512;
      while (true) {
        const text = `FETCH FORWARD ${batchSize} FROM ${name}`;
        const batch = await query(arrayRows ? { text, rowMode: 'array' } : text);
        const started = diagnostics ? performance.now() : 0;
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
        diagnostics?.record('pg.appendRows.sync', performance.now() - started, batch.rows.length);
        if (batch.rows.length < batchSize) break;
        // Bound row dispatch as well as decoded cells. Four simultaneous narrow
        // 4096-row replies can monopolize a slow NAS event loop despite few cells.
        batchSize = Math.max(512, Math.min(1024, Math.floor(512 * 42 / Math.max(1, batch.fields.length))));
        await yieldWork('pg.fetch');
      }
      await query(`CLOSE ${name}`);
      return rows;
    };
    return await run({
      query,
      readRows:(sql,params=[],options={})=>readCandidateContent({client:{query},readRows,
        store:driver.candidateContent,sql,params,options}),
    });
  } finally {
    try { await query('ROLLBACK'); }
    catch (error) { broken=error; }
    client.release(broken || undefined);
  }
}

export async function readPgRows(driver, sql, params = [], options = {}) {
  return typeof driver.readRows === 'function'
    ? driver.readRows(sql, params, options)
    : (await driver.query(sql, params)).rows;
}
