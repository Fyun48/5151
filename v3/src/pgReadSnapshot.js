import { candidateRowFromValues, LIST_CANDIDATE_KEYS } from './listingCandidateRow.js';
import { readCandidateContent } from './pgCandidateContent.js';
import { currentWorkDiagnostics, yieldWork } from './workDiagnostics.js';
import { isMemberWriteFresh } from './memberWriteRecency.js';
import {
  planSnapshotRoute, readReplicaConfigured, sharedReadReplica, standbyConflictCode,
  SNAPSHOT_SOURCE_REPLICA, READ_REPLICA_CONFLICT_WARNING,
} from './pgReadReplica.js';

// 每次 `FETCH FORWARD` 的批次大小上限。
//
// 契約：**cell 預算固定**（512 列 × 42 欄 ＝ 21,504 cells），所以寬讀取的行為逐字不變
// （42 欄 ⇒ 512、36 欄 ⇒ 597、20 欄 ⇒ 1,075）；只有 1–20 欄的**窄讀取**會放大，
// 上限 8,192 列（1 欄 ⇒ 8,192 cells，仍是原預算的 38%）。
//
// 為什麼要放寬：會員列表的 id-only 候選掃描（`SELECT post_id`）在舊上限下每個請求要
// 13 趟 `FETCH FORWARD 1024`；正式站 `pg_stat_statements` 量到 4,123 calls／avg 73ms／
// 合計 301s。這是**來回次數**的成本，不是掃描本身的成本。
export function cursorFetchBatchSize(fieldCount) {
  return Math.max(512, Math.min(8192, Math.floor(512 * 42 / Math.max(1, Number(fieldCount) || 1))));
}

// ── 讀快照裡的寫入守門（應用層，2026-10-12）────────────────────────────────
//
// 快照交易本來就是 `READ ONLY`（下面 `BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`），
// 待機節點也只收讀。但那樣擋下來的錯誤長這樣：
//   `cannot execute INSERT in a read-only transaction`
// 對看 log 的人完全沒有上下文：不知道是誰寫的、哪條路徑、該去哪裡寫。所以這裡先在應用層擋一次，
// 錯誤訊息直接說「這是會員列表的唯讀快照（PG_RO_URL 待機路由）」並附上被拒語句的開頭。
export const READ_ONLY_SNAPSHOT_CODE = "READ_ONLY_SNAPSHOT";

function statementSnippet(sql) {
  const text = typeof sql === "string" ? sql : (sql?.text ?? "");
  return String(text).replace(/\s+/g, " ").trim().slice(0, 120);
}

export class ReadOnlySnapshotViolationError extends Error {
  constructor(sql) {
    super(
      `會員列表的唯讀快照不得寫入（PG_RO_URL／待機路由）：拒絕執行「${statementSnippet(sql)}」。`
      + "寫入請走 driver.withTransaction() 或對應的 /api 寫入路徑，不要經過 withPgReadSnapshot()。",
    );
    this.name = "ReadOnlySnapshotViolationError";
    this.code = READ_ONLY_SNAPSHOT_CODE;
  }
}

export function isReadOnlySnapshotViolation(error) {
  return error?.code === READ_ONLY_SNAPSHOT_CODE || error?.name === "ReadOnlySnapshotViolationError";
}

// 快照內合法的語句：純讀 ＋ 交易控制 ＋ 游標（readRows 用 DECLARE／FETCH／CLOSE 逐批讀）。
const SNAPSHOT_ALLOWED_KEYWORDS = new Set([
  "SELECT", "WITH", "VALUES", "TABLE", "SHOW", "EXPLAIN",
  "BEGIN", "START", "SET", "RESET", "ROLLBACK", "COMMIT", "SAVEPOINT", "RELEASE", "DISCARD",
  "DECLARE", "FETCH", "MOVE", "CLOSE",
]);
// `SELECT … FOR UPDATE`／`FOR SHARE` 是寫入意圖的鎖，即使開頭是 SELECT 也要擋。
const LOCKING_READ = /\bFOR\s+(NO\s+KEY\s+)?(UPDATE|SHARE)\b/i;

function leadingKeyword(sql) {
  const text = String(typeof sql === "string" ? sql : (sql?.text ?? ""))
    .replace(/^(\s|\/\*[\s\S]*?\*\/|--[^\n]*\n)+/, "");
  const match = /^([A-Za-z_]+)/.exec(text);
  return match ? match[1].toUpperCase() : "";
}

/** 丟 `ReadOnlySnapshotViolationError`；合法語句回 undefined。 */
export function assertSnapshotStatementAllowed(sql) {
  const keyword = leadingKeyword(sql);
  if (!SNAPSHOT_ALLOWED_KEYWORDS.has(keyword)) throw new ReadOnlySnapshotViolationError(sql);
  if ((keyword === "SELECT" || keyword === "WITH") && LOCKING_READ.test(String(typeof sql === "string" ? sql : (sql?.text ?? "")))) {
    throw new ReadOnlySnapshotViolationError(sql);
  }
  // `DECLARE <name> … CURSOR … FOR <查詢>`：內層查詢同樣要過守門（例如 FOR INSERT 是寫入）。
  if (keyword === "DECLARE") {
    const text = String(typeof sql === "string" ? sql : (sql?.text ?? ""));
    const forAt = /\bFOR\b/i.exec(text);
    if (forAt) assertSnapshotStatementAllowed(text.slice(forAt.index + forAt[0].length));
  }
}

// A complete read uses one connection and one database snapshot. Lightweight
// driver doubles without a pool can still exercise the pure repository tests.
//
// 2026-10-12（會員讀待機路由包）：第三個參數只給**會員列表**那條路用
// （`listingSearchPage.js`）：
//   * `memberReadSnapshot: true` ⇒ `PG_RO_URL` 有值時這條快照可以走待機節點，且寫入語句在
//     應用層就被擋下（見上面的守門）。**未設 `PG_RO_URL` ⇒ 走原路**（連待機池都不會建立）。
//   * `userId` ⇒ 查「寫後新鮮期」路由提示（該會員剛寫過 ⇒ 整趟走 primary；見 memberWriteRecency.js）。
//   * `readReplicaRouter`／`env` ⇒ 測試注入；正式路徑用行程共用的那一個。
// 其他呼叫端（公開搜尋、`/api/state`、診斷腳本）不傳第三個參數 ⇒ 行為與加這包之前逐字相同。
export async function withPgReadSnapshot(driver, run, options = {}) {
  if (typeof driver?.pool?.connect !== 'function') return run(driver);
  const memberReadSnapshot = options.memberReadSnapshot === true;
  const env = options.env || process.env;
  const router = options.readReplicaRouter || sharedReadReplica;
  // 「進快照之前一次決定」：決定之後整條快照（list 段與 stats 段、含共趟掃描）只用這**一條**連線。
  const source = planSnapshotRoute({
    memberReadSnapshot,
    replicaConfigured: readReplicaConfigured(env),
    memberWriteFresh: memberReadSnapshot && isMemberWriteFresh(options.userId),
  });
  if (source !== SNAPSHOT_SOURCE_REPLICA) {
    router.noteRoute?.('primary');
    return runSnapshotOn(await driver.pool.connect(), driver, run, memberReadSnapshot);
  }
  let replicaClient = null;
  let replicaDriver = null;
  try {
    const routed = await router.connect();
    replicaClient = routed.client;
    replicaDriver = routed.driver;
  } catch {
    // 待機拿不到連線 ⇒ **整趟**退回 primary（router 已記一條可搜尋的 warning）。
    // 絕對不可以改成「一部分讀 primary、一部分讀待機」：那會是同一個請求兩個快照。
    router.noteRoute?.('primary');
    return runSnapshotOn(await driver.pool.connect(), driver, run, memberReadSnapshot);
  }
  router.noteRoute?.(SNAPSHOT_SOURCE_REPLICA);
  const started = performance.now();
  try {
    return await runSnapshotOn(replicaClient, replicaDriver, run, memberReadSnapshot);
  } catch (error) {
    // 待機的複製衝突（`hot_standby_feedback=off` ＋ `max_standby_streaming_delay=30s`：
    // 待機為了追上 WAL 會**直接砍掉**查詢）。對策是**整個快照退回 primary 重跑一次**，
    // 不是逐條重試（逐條重試又會變成同一個請求兩個 snapshot）；這一趟的結果一律丟棄。
    // 用 SQLSTATE 判（40001／25006／55006），不比對訊息字串；**不准**把它吞掉當成功。
    const code = standbyConflictCode(error);
    if (!code) throw error;
    const elapsed = Math.round(performance.now() - started);
    router.noteConflict?.({ code, userId: options.userId, elapsed });
    // 註：若有 work-diagnostics scope（benchmark），這裡會多出第一趟的 `pg.*` 觀測值與
    // `pg.declare`／`pg.fetch` 計數；回傳值本身一定來自第二趟（第一趟的結果被丟棄）。
    console.warn(`${READ_REPLICA_CONFLICT_WARNING}：整趟退回 PG_URL 重跑一次`
      + `（uid=${Number(options.userId) || 0}, sqlstate=${code}, 第一次嘗試 ${elapsed}ms）`);
    router.noteRoute?.('primary');
    return runSnapshotOn(await driver.pool.connect(), driver, run, memberReadSnapshot);
  }
}

/**
 * 在**一條**連線上跑完整條快照（一個交易、一個 snapshot）。
 *
 * 抽成獨立函式是為了讓「待機複製衝突 ⇒ 整趟退回 primary 重跑一次」能重跑同一段程式：
 * 兩次嘗試各自有自己的連線與交易，任一次內部都不會混到另一個來源。
 */
async function runSnapshotOn(client, storeDriver, run, memberReadSnapshot) {
  const diagnostics = currentWorkDiagnostics();
  const guard = (sql) => {
    // 只有會員列表那條路開守門；其他快照（公開搜尋／診斷腳本）維持原本的自由度。
    if (!memberReadSnapshot) return null;
    try {
      assertSnapshotStatementAllowed(sql);
      return null;
    } catch (error) {
      return Promise.reject(error);
    }
  };
  const query = (sql, params = []) => {
    const rejection = guard(sql);
    if (rejection) return rejection;
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
        //
        // 2026-10-11（會員列表效能包）：`min(1024, …)` 對**窄讀取**（`SELECT post_id` 這類
        // 1–3 欄）等於丟掉既有的 cell 預算，讓每次讀取都要 13 趟 `FETCH FORWARD 1024`
        // （正式站 `pg_stat_statements`：4,123 calls／avg 73ms／合計 301s）。這裡把上限改成
        // **8192 列**，但 cell 預算維持 512×42＝21,504 不變 ⇒ 42 欄讀取仍是 512、20 欄仍是
        // 1,075（都不變），只有 1–5 欄的窄讀取變大（1 欄 ⇒ 8192 列＝8,192 cells，
        // 仍是原預算的 38%）。列數上限仍遠低於註解所提的「4,096 列 × 4 併發」情境。
        batchSize = cursorFetchBatchSize(batch.fields.length);
        await yieldWork('pg.fetch');
      }
      await query(`CLOSE ${name}`);
      return rows;
    };
    return await run({
      query,
      readRows:(sql,params=[],options={})=>readCandidateContent({client:{query},readRows,
        store:storeDriver.candidateContent,sql,params,options}),
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
