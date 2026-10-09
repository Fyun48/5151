#!/usr/bin/env node
/**
 * 5151 PG agent-check responder（角色感知）
 *
 * 每個 PG 節點跑一份：本行程固定 poll「本機」PG 的 `select pg_is_in_recovery()`，
 * 把結果快取成兩個純字串狀態，再開兩個 TCP server 讓 HAProxy 的 agent-check 讀：
 *   - primary 埠（預設 25436）：本節點是 primary ⇒ `up`，否則 `down`
 *   - standby 埠（預設 25437）：本節點是 standby ⇒ `up`，否則 `down`
 *
 * HAProxy `backend pg_primary` 每台 server 加 `agent-check agent-port 25436 …`，
 * 就由「人工對調 backend 順序」變成「角色自動判定」；連線性的 `check`（pgsql-check）
 * 留著當雙保險。
 *
 * 語意（見 roleStatus）：
 *   recovery = f ⇒ primary 埠 up、standby 埠 down
 *   recovery = t ⇒ 反之
 *   查不到（連線失敗／逾時）⇒ 連續失敗未達 FAIL_LIMIT 維持上次狀態，達門檻兩個埠都 down
 *
 * 韌性：
 *   - poll 迴圈一律 try/catch，任何單次失敗都不會讓行程掛掉
 *   - 日誌節流（相同狀態每 30 秒最多一行），且**絕不出現 URI／密碼**（只出 host:port）
 *   - SIGTERM／SIGINT 優雅關閉（關 server、pool.end()、exit 0）
 *
 * 掛載位置必須在 /app 子樹下（例如 /app/pg-agent/agent.mjs）：本檔在執行期才
 * `await import("pg")`，ESM 會沿目錄樹往上找 /app/node_modules/pg；掛到 /tmp 就會
 * `Cannot find package 'pg'`（2026-10 實測）。
 */
import net from "node:net";
import { pathToFileURL } from "node:url";

const DEFAULT = {
  primaryPort: 25436,
  standbyPort: 25437,
  intervalMs: 2000,
  queryTimeoutMs: 1500,
  connectTimeoutMs: 1000,
  failLimit: 2,
};

const LOG_THROTTLE_MS = 30000;
const FORBIDDEN_LOOP_PORT = "25433";

/**
 * 根據最近一次探測結果，決定兩個 agent-check 埠要回報的狀態。
 * 純函式：不碰網路、不碰環境，方便單測。
 *
 * @param {object}  opts
 * @param {boolean} opts.error       本次探測是否失敗（連線失敗／逾時）
 * @param {boolean|null} opts.inRecovery pg_is_in_recovery() 的結果（error 時可忽略）
 * @param {number}  opts.failures    目前連續失敗次數
 * @param {number}  opts.failLimit   連續失敗門檻（達門檻兩個埠都 down）
 * @param {{primary:'up'|'down',standby:'up'|'down'}|undefined} opts.last 上次狀態
 * @returns {{primary:'up'|'down',standby:'up'|'down'}}
 */
export function roleStatus({ error, inRecovery, failures = 0, failLimit = DEFAULT.failLimit, last } = {}) {
  const prev =
    last && typeof last === "object"
      ? {
          primary: last.primary === "up" ? "up" : "down",
          standby: last.standby === "up" ? "up" : "down",
        }
      : { primary: "down", standby: "down" };

  if (error) {
    // 瞬斷：連續失敗未達門檻就維持上次狀態，避免整個寫入路由翻掉。
    // 達門檻（failures >= failLimit）＝節點角色不可知 ⇒ fail-closed，兩個埠都 down。
    return failures >= failLimit ? { primary: "down", standby: "down" } : prev;
  }

  // 探測成功：以 recovery 判定角色。
  return inRecovery
    ? { primary: "down", standby: "up" }
    : { primary: "up", standby: "down" };
}

function closeServers(...servers) {
  return new Promise((resolve) => {
    if (!servers.length) return resolve();
    let left = servers.length;
    for (const srv of servers) {
      srv.close(() => {
        left -= 1;
        if (left === 0) resolve();
      });
    }
  });
}

/**
 * 起兩個 TCP server（primary／standby 各一）。每個連線只寫一行 `up\n`／`down\n` 後
 * `end()`——這是 HAProxy agent-check 的契約（第一行 up/down，其後關閉）。
 *
 * @param {object} opts
 * @param {number} opts.primaryPort  0 = 隨機埠（測試用）
 * @param {number} opts.standbyPort  0 = 隨機埠（測試用）
 * @param {() => ({primary:'up'|'down',standby:'up'|'down'})} opts.getState 每次連線即時取狀態
 * @returns {Promise<{primaryServer:import('node:net').Server,standbyServer:import('node:net').Server,primaryPort:number,standbyPort:number,close:()=>Promise<void>}>}
 */
export function startServers({ primaryPort = 0, standbyPort = 0, getState }) {
  const serve = (key) =>
    net.createServer((socket) => {
      let line = "down\n";
      try {
        const st = getState && getState();
        line = st && st[key] === "up" ? "up\n" : "down\n";
      } catch {
        line = "down\n"; // 讀狀態出錯也 fail-closed，絕不讓行程掛掉
      }
      // HAProxy 讀完第一行就會 RST 連線；這個 handler 吞掉 ECONNRESET，避免行程被打掛。
      socket.on("error", () => {});
      socket.end(line);
    });

  const primaryServer = serve("primary");
  const standbyServer = serve("standby");

  return new Promise((resolve, reject) => {
    let started = 0;
    let settled = false;

    for (const srv of [primaryServer, standbyServer]) {
      srv.on("error", (err) => {
        if (!settled) {
          settled = true;
          primaryServer.close(() => {});
          standbyServer.close(() => {});
          reject(err);
        }
        // 已上線後的非致命錯誤：吞掉，不讓行程掛掉。
      });
      srv.once("listening", () => {
        started += 1;
        if (started === 2 && !settled) {
          settled = true;
          resolve({
            primaryServer,
            standbyServer,
            primaryPort: primaryServer.address().port,
            standbyPort: standbyServer.address().port,
            close: () => closeServers(primaryServer, standbyServer),
          });
        }
      });
    }

    primaryServer.listen(primaryPort);
    standbyServer.listen(standbyPort);
  });
}

// ---------------------------------------------------------------------------
// 以下為「直接執行本檔」時的 responder 主流程；被 import（測試）時不執行。
// ---------------------------------------------------------------------------

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** 只回傳 host:port，絕不出現 user/password。 */
function redactUrl(url) {
  const host = url.hostname || "?";
  const port = url.port || "5432";
  return `${host}:${port}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms, message) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

function createThrottledLogger(intervalMs) {
  let lastKey = null;
  let lastAt = 0;
  return function log(key, line) {
    const now = Date.now();
    if (key !== lastKey || now - lastAt >= intervalMs) {
      lastKey = key;
      lastAt = now;
      console.log(line);
    }
  };
}

async function probeRecovery(pool, queryTimeoutMs) {
  const client = await pool.connect();
  try {
    const result = await withTimeout(
      client.query("select pg_is_in_recovery() as in_recovery"),
      queryTimeoutMs,
      `query timeout after ${queryTimeoutMs}ms`
    );
    const row = result && result.rows && result.rows[0];
    if (!row) throw new Error("empty result from pg_is_in_recovery()");
    return row.in_recovery === true;
  } finally {
    client.release();
  }
}

async function main() {
  const directUrlRaw = (process.env.PG_AGENT_DIRECT_URL || "").trim();
  if (!directUrlRaw) {
    console.error(
      "PG_AGENT_DIRECT_URL 未設定（必填）：直連本機 PG 的 URI，例如 postgresql://postgres:***@127.0.0.1:15432/postgres"
    );
    process.exit(2);
  }

  let url;
  try {
    url = new URL(directUrlRaw);
  } catch (e) {
    console.error(`PG_AGENT_DIRECT_URL 不是合法 URL：${e.message}`);
    process.exit(2);
  }

  // 防迴路：經 HAProxy 25433 會自己探測自己，直接拒絕啟動。
  if (
    url.port === FORBIDDEN_LOOP_PORT ||
    url.hostname === FORBIDDEN_LOOP_PORT ||
    directUrlRaw.includes(`:${FORBIDDEN_LOOP_PORT}`)
  ) {
    console.error(
      `PG_AGENT_DIRECT_URL 必須直連本機 PG（${FORBIDDEN_LOOP_PORT} 是 HAProxy，會形成探測迴路）→ 拒絕啟動`
    );
    process.exit(2);
  }

  // 資料庫固定用 postgres（不要連 5151_shadow，避免還原／redo 期間探測失敗造成誤判）。
  url.pathname = "/postgres";

  // 日誌脱敏：任何輸出都不准出現 URI 或密碼（只出 host:port）。
  const scrub = (text) => {
    let s = String(text);
    if (url.password) s = s.split(url.password).join("***");
    return s;
  };

  const cfg = {
    primaryPort: intEnv("PG_AGENT_PRIMARY_PORT", DEFAULT.primaryPort),
    standbyPort: intEnv("PG_AGENT_STANDBY_PORT", DEFAULT.standbyPort),
    intervalMs: intEnv("PG_AGENT_INTERVAL_MS", DEFAULT.intervalMs),
    queryTimeoutMs: intEnv("PG_AGENT_QUERY_TIMEOUT_MS", DEFAULT.queryTimeoutMs),
    connectTimeoutMs: intEnv("PG_AGENT_CONNECT_TIMEOUT_MS", DEFAULT.connectTimeoutMs),
    failLimit: intEnv("PG_AGENT_FAIL_LIMIT", DEFAULT.failLimit),
  };

  console.log(
    `pg-agent starting: target=${redactUrl(url)} primary_port=${cfg.primaryPort} standby_port=${cfg.standbyPort} interval=${cfg.intervalMs}ms query_timeout=${cfg.queryTimeoutMs}ms connect_timeout=${cfg.connectTimeoutMs}ms fail_limit=${cfg.failLimit}`
  );

  const { default: pg } = await import("pg");

  const pool = new pg.Pool({
    connectionString: url.toString(),
    connectionTimeoutMillis: cfg.connectTimeoutMs,
    statement_timeout: cfg.queryTimeoutMs, // server 端 statement_timeout（連線 startup 帶入）
    max: 1,
    idleTimeoutMillis: 0,
  });

  let state = { primary: "down", standby: "down" };
  let failures = 0;
  let shuttingDown = false;

  const log = createThrottledLogger(LOG_THROTTLE_MS);

  const { close } = await startServers({
    primaryPort: cfg.primaryPort,
    standbyPort: cfg.standbyPort,
    getState: () => state,
  });

  async function pollOnce() {
    let error = null;
    let inRecovery = null;
    try {
      inRecovery = await probeRecovery(pool, cfg.queryTimeoutMs);
    } catch (e) {
      error = e;
    }

    if (error) failures += 1;
    else failures = 0;

    state = roleStatus({
      error: Boolean(error),
      inRecovery,
      failures,
      failLimit: cfg.failLimit,
      last: state,
    });

    const sig = `primary=${state.primary} standby=${state.standby}`;
    if (error) {
      log(sig, `${new Date().toISOString()} probe failed (${failures}/${cfg.failLimit}) → ${sig}（${scrub(error.message).slice(0, 200)}）`);
    } else {
      log(sig, `${new Date().toISOString()} role=${inRecovery ? "standby" : "primary"} → ${sig}`);
    }
  }

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`shutdown: ${signal}`);
    try {
      await close();
    } catch {}
    try {
      await pool.end();
    } catch {}
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  // 兜底：HAProxy 讀完第一行就會 RST 連線，若任何 socket 漏掛 error handler 會以
  // ECONNRESET 打掛行程。responder 是韌性元件，任何意外都只記 log、不退出。
  process.on("uncaughtException", (err) => {
    console.error(`${new Date().toISOString()} uncaughtException: ${scrub(err && err.stack ? err.stack : String(err))}`);
  });
  process.on("unhandledRejection", (reason) => {
    console.error(`${new Date().toISOString()} unhandledRejection: ${scrub(reason && reason.stack ? reason.stack : String(reason))}`);
  });

  // 首次立即探測，之後每 intervalMs 一次（setTimeout 式迴圈，探測慢也不會重疊）。
  while (!shuttingDown) {
    await pollOnce();
    await sleep(cfg.intervalMs);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((e) => {
    console.error(`fatal: ${e && e.stack ? e.stack : e}`);
    process.exit(3);
  });
}
