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
      diagnostics.record(`${label}.wall`, performance.now() - started, result.rowCount || 0, started);
      return result;
    });
  };
  // 2026-09-27：pg 的 Client 是 EventEmitter，而**未處理的 'error' 事件會直接讓行程崩潰**
  // （實測：`throw er; // Unhandled 'error' event`、exit code 1），不是可 catch 的 rejection。
  //
  // 這條路徑真的會遇到：讀取快照為了整個請求持有這條連線，而 App 經由 HAProxy 連 PG，
  // HAProxy 設 `timeout client 30s`；只要閒置超過 30 秒就會被切斷，屆時 pg 會在 client 上
  // 發出 'error'。crawlOwnership.js 已經有同樣的防護（client.on('error', …)），這裡先前漏了。
  // 掛上監聽後，同樣情況會變成「下一次查詢正常地 reject」，而不是把整個 process 帶走。
  //
  // 註：實測正常搜尋讀取的快照總持有約 330ms、兩次 DB 呼叫最大間隔約 43ms，
  // 距離 30 秒有極大餘裕；這裡修的是「萬一真的超過」時的爆炸半徑。
  let clientError = null;
  const onClientError = (error) => { clientError = error; };
  if (typeof client.on === 'function') client.on('error', onClientError);

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
    const readRows = async (sql, params = [], { arrayRows = false, consumeValues = null } = {}) => {
      // Bound decoded cells per parser turn. Narrow ID/version reads can carry
      // more rows per transfer than the full 42-field shape. Retain every row.
      const name = `listing_read_${++cursorId}`;
      await query(`DECLARE ${name} NO SCROLL CURSOR WITHOUT HOLD FOR ${sql}`, params);
      const rows = [];
      let rowFromValues;
      let batchSize = 512;
      while (true) {
        const text = `FETCH FORWARD ${batchSize} FROM ${name}`;
        const batch = await query(arrayRows || consumeValues ? { text, rowMode: 'array' } : text);
        const started = diagnostics ? performance.now() : 0;
        if (consumeValues) {
          // Internal streaming consumer: release this reply before fetching the
          // next. Never retain both all version rows and all hydrated candidates.
          await consumeValues(batch.rows, batch.fields);
        } else if (arrayRows) {
          if (!rowFromValues) {
            const names = batch.fields.map(field => field.name);
            rowFromValues = names.length === LIST_CANDIDATE_KEYS.length
              && names.every((name, i) => name === LIST_CANDIDATE_KEYS[i])
              ? candidateRowFromValues
              : values => Object.fromEntries(names.map((name, i) => [name, values[i]]));
          }
          for (const values of batch.rows) rows.push(rowFromValues(values));
        } else rows.push(...batch.rows);
        diagnostics?.record(consumeValues ? 'pg.consumeValues.wall' : 'pg.appendRows.sync', performance.now() - started, batch.rows.length);
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
    // 先移除監聽再收尾，避免收尾期間的錯誤又走回同一個 handler。
    if (typeof client.removeListener === 'function') client.removeListener('error', onClientError);
    try { await query('ROLLBACK'); }
    catch (error) { broken=error; }
    // clientError 代表這條連線已經在閒置中被切斷（例如超過 HAProxy 的 timeout client）。
    // 這種連線必須銷毀、不可還給連線池，否則下一個使用者會拿到一條已死的連線。
    client.release(broken || clientError || undefined);
  }
}

export async function readPgRows(driver, sql, params = [], options = {}) {
  return typeof driver.readRows === 'function'
    ? driver.readRows(sql, params, options)
    : (await driver.query(sql, params)).rows;
}
