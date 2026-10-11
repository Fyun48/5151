// 會員列表「唯讀快照」的待機（standby）路由：`PG_RO_URL`（2026-10-12）。
//
// 背景（正式機 2026-10-12 06:01–06:02 實測，數據見
// `docs/runbooks/member-read-replica-routing.md`）：兩個節點的所有請求都壓在 casa 的
// primary 上，兩台 HAProxy 雖然都發布了 `pg_ro`（25434）但沒有人用。同一份資料、同一條 SQL：
//   area_name 分面 373ms → 248ms、price_num 區間 318ms → 114ms、offline/hidden 聚合
//   463ms → 172ms、kind_name 分面 354ms → 128ms、42 欄取 11k 列 220ms → 65ms，
//   待機複製延遲 0.88 秒（`pg_is_in_recovery()=true`、replay 已追平 receive）。
//
// 契約（紅線）：
//   1. **未設 `PG_RO_URL` ⇒ 完全走原路**：連這裡的池都不會建立，`loadListingPage` 的連線
//      字串與行為逐字相同。
//   2. 只在「會員列表的唯讀快照」這條路用（`listingSearchPage.js` →
//      `withPgReadSnapshot(..., {memberReadSnapshot:true})`）；其他快照（公開搜尋、
//      `/api/state`）不受影響。
//   3. 「進快照之前一次決定」：ro 池拿不到連線 ⇒ **整趟**退回 `PG_URL`，
//      絕不出現一半 primary、一半待機的混合快照。
//   4. 會員自己剛寫的狀態不能看到舊的：5 秒內寫過的 uid 一律走 primary
//      （路由提示，不是資料快取；見 `memberWriteRecency.js`）。
import { createPostgresDriver, describeConnection, resolvePostgresConfig } from "./dbDriverPostgres.js";

export const READ_REPLICA_URL_ENV = "PG_RO_URL";
/** 待機池的 `application_name` 後綴：`pg_stat_activity` 上一眼就能分辨讀在 primary 還是待機。 */
export const READ_REPLICA_APPLICATION_NAME_SUFFIX = "-ro";
/** 連不上待機時可搜尋的 warning 開頭（runbook 的開閘指標之一就是 grep 這一行）。 */
export const READ_REPLICA_FALLBACK_WARNING = `[pg-read] ${READ_REPLICA_URL_ENV} unavailable`;
/** 待機成功啟用時，每個行程只記一次的訊息（正向訊號）。 */
export const READ_REPLICA_ACTIVE_LOG = `[pg-read] 會員列表唯讀快照改走 ${READ_REPLICA_URL_ENV} 待機節點`;
export const READ_REPLICA_COOLDOWN_ENV = "PG_RO_RETRY_COOLDOWN_MS";
export const READ_REPLICA_CONNECT_TIMEOUT_ENV = "PG_RO_CONNECT_TIMEOUT_MS";
export const READ_REPLICA_POOL_MAX_ENV = "PG_RO_POOL_MAX";

/**
 * 待機連不上之後的冷卻時間：這段期間**不再嘗試**待機，直接走 primary。
 *
 * 為什麼需要：`pool.connect()` 逾時（預設 5 秒）會讓每一個會員列表請求都先卡一次。
 * 待機掛掉時「每次都嘗試」比「3 秒內不再嘗試」糟得多，而方向是保守的（走 primary）。
 */
export const DEFAULT_READ_REPLICA_COOLDOWN_MS = 3000;
/** 待機連線自己的逾時上限（LAN 內待機；比一般 5 秒短，縮小待機故障時的尾巴）。 */
export const DEFAULT_READ_REPLICA_CONNECT_TIMEOUT_MS = 2000;

export const SNAPSHOT_SOURCE_PRIMARY = "primary";
export const SNAPSHOT_SOURCE_REPLICA = "replica";

export class ReadReplicaUnavailableError extends Error {
  constructor(message, { cause = null, cooldown = false } = {}) {
    super(message);
    this.name = "ReadReplicaUnavailableError";
    this.code = "READ_REPLICA_UNAVAILABLE";
    this.cooldown = cooldown === true;
    if (cause) this.cause = cause;
  }
}

/** `PG_RO_URL` 的值（未設＝空字串）。值本身**不得**出現在 log／PR／錯誤訊息裡。 */
export function readReplicaUrl(env = process.env) {
  return String(env?.[READ_REPLICA_URL_ENV] || "").trim();
}

export function readReplicaConfigured(env = process.env) {
  return readReplicaUrl(env) !== "";
}

/** 純函式：這個快照要走哪一條路。優先序＝未開關/未設定 → primary；會員剛寫過 → primary。 */
export function planSnapshotRoute({ memberReadSnapshot = false, replicaConfigured = false, memberWriteFresh = false } = {}) {
  if (!memberReadSnapshot || !replicaConfigured) return SNAPSHOT_SOURCE_PRIMARY;
  if (memberWriteFresh) return SNAPSHOT_SOURCE_PRIMARY;
  return SNAPSHOT_SOURCE_REPLICA;
}

/** 待機池的池參數：application_name 加後綴；可選的 `PG_RO_*` 覆寫。 */
export function readReplicaPoolOptions(env = process.env) {
  const resolved = resolvePostgresConfig(env);
  const options = {
    application_name: `${resolved.options.application_name}${READ_REPLICA_APPLICATION_NAME_SUFFIX}`,
  };
  const max = Number(env?.[READ_REPLICA_POOL_MAX_ENV]);
  if (Number.isFinite(max) && max > 0) options.max = Math.floor(max);
  const connect = Number(env?.[READ_REPLICA_CONNECT_TIMEOUT_ENV]);
  options.connectionTimeoutMillis = Number.isFinite(connect) && connect > 0
    ? Math.floor(connect)
    : Math.min(resolved.options.connectionTimeoutMillis, DEFAULT_READ_REPLICA_CONNECT_TIMEOUT_MS);
  return options;
}

function cooldownMsFrom(env = process.env) {
  const raw = Number(env?.[READ_REPLICA_COOLDOWN_ENV]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_READ_REPLICA_COOLDOWN_MS;
}

/** 只印 host:port/db（`describeConnection()` 會把帳密遮掉），錯誤訊息截短。 */
function describeTarget(url, env) {
  const described = describeConnection(url, readReplicaPoolOptions(env));
  return described?.host ? `${described.host}:${described.port || "5432"}/${described.database || ""}` : "(unparsable connection string)";
}

/**
 * 待機路由（可注入 env／時鐘／driver 工廠 ⇒ 離線測試能完整覆蓋）。
 *
 * `connect()` 成功回 `{client, driver}`；失敗丟 `ReadReplicaUnavailableError`，
 * 並在**進入快照之前**把錯誤記成 warning（呼叫端此時整趟退回 primary）。
 */
export function createReadReplicaRouter({
  env = process.env,
  now = () => Date.now(),
  createDriver = createPostgresDriver,
  log = console,
} = {}) {
  let driver = null;
  let pending = null;
  let coolingUntil = 0;
  let lastError = "";
  let announced = false;
  const stats = { replicaReads: 0, primaryReads: 0, fallbacks: 0, cooldownSkips: 0 };

  async function ensureDriver() {
    const url = readReplicaUrl(env);
    if (!url) throw new ReadReplicaUnavailableError(`${READ_REPLICA_URL_ENV} 未設定`);
    if (!driver) {
      if (!pending) {
        pending = createDriver({ connectionString: url, env, poolOptions: readReplicaPoolOptions(env) })
          .then((created) => { driver = created; return created; })
          .finally(() => { pending = null; });
      }
      driver = await pending;
    }
    return driver;
  }

  function noteFailure(error) {
    lastError = String(error?.message || error || "").slice(0, 200);
    coolingUntil = now() + cooldownMsFrom(env);
    stats.fallbacks += 1;
    // 冷卻期間不再嘗試 ⇒ 這一行最多每 `PG_RO_RETRY_COOLDOWN_MS` 記一次，不會洗版。
    log?.warn?.(`${READ_REPLICA_FALLBACK_WARNING}（整趟退回 ${env?.PG_URL ? "PG_URL" : "預設連線"}，不會混用）：`
      + `${describeTarget(readReplicaUrl(env), env)} :: ${lastError}`);
  }

  return {
    /** 取一條待機連線；任何失敗都在這裡記 warning 並丟錯（呼叫端整趟退回 primary）。 */
    async connect() {
      if (now() < coolingUntil) {
        stats.cooldownSkips += 1;
        throw new ReadReplicaUnavailableError(`${READ_REPLICA_URL_ENV} 冷卻中（上次失敗：${lastError}）`, { cooldown: true });
      }
      const failure = (error) => {
        noteFailure(error);
        return new ReadReplicaUnavailableError(
          `${READ_REPLICA_FALLBACK_WARNING} :: ${String(error?.message || error).slice(0, 200)}`,
          { cause: error, cooldown: true },
        );
      };
      let ro;
      try {
        ro = await ensureDriver();
      } catch (error) {
        throw failure(error);
      }
      try {
        const client = await ro.pool.connect();
        if (!announced) {
          announced = true;
          log?.log?.(`${READ_REPLICA_ACTIVE_LOG}（application_name=${readReplicaPoolOptions(env).application_name}）`);
        }
        return { client, driver: ro };
      } catch (error) {
        throw failure(error);
      }
    },
    noteRoute(source) {
      if (source === SNAPSHOT_SOURCE_REPLICA) stats.replicaReads += 1;
      else stats.primaryReads += 1;
    },
    stats() { return { ...stats }; },
    lastError() { return lastError; },
    coolingDown() { return now() < coolingUntil; },
    cooldownUntil() { return coolingUntil; },
    /** 測試用：丟掉池的參照（不關閉），讓下一次 `connect()` 重新建立。 */
    reset() { driver = null; pending = null; coolingUntil = 0; lastError = ""; announced = false; },
    async close() {
      const current = driver;
      driver = null;
      pending = null;
      if (current && typeof current.close === "function") await current.close();
    },
  };
}

/** 正式路徑的共用路由（env 每次讀取 ⇒ 開閘／關閘不需要重啟程式也能生效於新請求）。 */
export const sharedReadReplica = createReadReplicaRouter();

export function sharedReadReplicaStats() { return sharedReadReplica.stats(); }
