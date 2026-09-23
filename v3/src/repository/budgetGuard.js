// provider／budget 這個 store 的 PostgreSQL 側（2.4）。語句文字與 budgetGuard.js 逐字相同。
//
// 有兩件事 PG 端不能照抄 SQLite，都在 budgetGuardAsync.js 的 schema 準備裡處理：
//   1. **UNIQUE 表約束不會被 pgSchema 鏡射**（SQLite 的 UNIQUE 是隱式索引，不在 sqlite_master 裡），
//      所以 PG 端要自己建唯一索引，否則 `ON CONFLICT(...)` 會回 42P10。
//   2. **identity 序號不會被「帶 id 的匯入」推進**（影子站 provider_usage_logs 有 24705 列、序號還在 1）
//      → 要跑 pgSchema.resyncIdentitySequences()。
export const BUDGET_TABLES = [
  "system_provider_configs",
  "provider_secrets",
  "budget_limits",
  "call_reservations",
  "provider_usage_logs",
];

// ON CONFLICT 的目標（＝ SQLite 端宣告的 UNIQUE 表約束）。
export const BUDGET_UNIQUE_INDEXES = [
  { name: "budget_limits_scope_uniq", table: "budget_limits", columns: ["scope_kind", "scope_key", "period_kind", "period_key"] },
  { name: "call_reservations_request_uniq", table: "call_reservations", columns: ["request_id", "attempt_id"] },
  { name: "system_provider_configs_provider_uniq", table: "system_provider_configs", columns: ["category", "provider_code", "region", "model_id"] },
];

export function uniqueIndexStatement({ name, table, columns }) {
  return { sql: `CREATE UNIQUE INDEX IF NOT EXISTS ${name} ON ${table} (${columns.join(", ")})` };
}

// ---- 讀取 ------------------------------------------------------------------

export function providerConfigQuery(category) {
  return {
    sql: `SELECT * FROM system_provider_configs
    WHERE category = ?
    ORDER BY is_enabled DESC, sort_order ASC, id ASC
    LIMIT 1`,
    params: [String(category || "")],
  };
}

export function providerConfigByIdQuery(id) {
  return { sql: "SELECT * FROM system_provider_configs WHERE id = ?", params: [Number(id) || 0] };
}

export function providerCategoryQuery(configId) {
  return { sql: "SELECT category FROM system_provider_configs WHERE id = ?", params: [Number(configId) || 0] };
}

export function providerSecretRefQuery(credentialRef) {
  return {
    sql: "SELECT credential_ref FROM provider_secrets WHERE credential_ref = ?",
    params: [String(credentialRef)],
  };
}

export function providerSecretQuery(credentialRef) {
  return {
    sql: "SELECT nonce, ciphertext FROM provider_secrets WHERE credential_ref = ?",
    params: [String(credentialRef)],
  };
}

export function reservationByRequestQuery(requestId, attemptId) {
  return {
    sql: "SELECT * FROM call_reservations WHERE request_id = ? AND attempt_id = ?",
    params: [String(requestId), String(attemptId)],
  };
}

export function reservationByIdQuery(id) {
  return { sql: "SELECT * FROM call_reservations WHERE id = ?", params: [Number(id) || 0] };
}

export function bucketQuery(spec) {
  return {
    sql: `SELECT * FROM budget_limits
    WHERE scope_kind = ? AND scope_key = ? AND period_kind = ? AND period_key = ?`,
    params: [spec.scopeKind, spec.scopeKey, spec.periodKind, spec.periodKey],
  };
}

export function usageLogsQuery(limit = 50) {
  return {
    sql: `SELECT id, created_at, category, provider_code, event_kind, amount_minor, job_state
    FROM provider_usage_logs
    ORDER BY id DESC
    LIMIT ?`,
    params: [Math.max(1, Number(limit) || 50)],
  };
}

export function settingValueQuery(key) {
  return { sql: "SELECT value FROM settings WHERE key = ?", params: [String(key)] };
}

// ---- 寫入 ------------------------------------------------------------------
//
// 兩個 SQLite 專屬寫法在這裡就消掉了（node:sqlite 兩者都支援，PG 也支援，所以兩邊共用同一份文字）：
//   - `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`
//   - `info.lastInsertRowid` → `INSERT … RETURNING id`
export function insertUsageLogQuery() {
  return {
    sql: `INSERT INTO provider_usage_logs(created_at, category, provider_code, reservation_id, event_kind, amount_minor, job_state, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  };
}

export function seedProviderConfigQuery() {
  return {
    sql: `INSERT INTO system_provider_configs(
      category, provider_code, region, model_id, endpoint, is_enabled, credential_ref,
      price_version, fallback_policy, daily_limit_minor, monthly_limit_minor, ceiling_minor,
      sort_order, created_at, updated_at
    ) VALUES (?, ?, '', '', '', 0, NULL, 'v1', '{"max_fallback":1}', 0, 0, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING`,
  };
}

export function ensureBucketQuery(spec) {
  return {
    sql: `INSERT INTO budget_limits(scope_kind, scope_key, period_kind, period_key, timezone, limit_minor, settled_minor, reserved_minor)
    VALUES (?, ?, ?, ?, 'Asia/Taipei', ?, 0, 0)
    ON CONFLICT(scope_kind, scope_key, period_kind, period_key) DO UPDATE SET
      limit_minor = excluded.limit_minor`,
    params: [
      spec.scopeKind,
      spec.scopeKey,
      spec.periodKind,
      spec.periodKey,
      Math.max(0, Number(spec.limitMinor) || 0),
    ],
  };
}

export function bumpBucketsQuery(bucketId, deltaReserved, deltaSettled) {
  return {
    sql: `UPDATE budget_limits
    SET reserved_minor = reserved_minor + ?, settled_minor = settled_minor + ?
    WHERE id = ?`,
    params: [Number(deltaReserved) || 0, Number(deltaSettled) || 0, Number(bucketId) || 0],
  };
}

export function insertReservationQuery({ requestId, attemptId, configId = null, priceVersion = "v1", ceilingMinor, createdAt }) {
  return {
    sql: `INSERT INTO call_reservations(request_id, attempt_id, config_id, price_version, ceiling_minor, job_state, created_at)
    VALUES (?, ?, ?, ?, ?, 'reserved', ?)
    RETURNING id`,
    params: [
      String(requestId),
      String(attemptId),
      configId ?? null,
      String(priceVersion || "v1"),
      Math.max(0, Math.round(Number(ceilingMinor) || 0)),
      String(createdAt),
    ],
  };
}

export function setReservationStateQuery({ id, state, settledAt = null }) {
  return {
    sql: "UPDATE call_reservations SET job_state = ?, settled_at = ? WHERE id = ?",
    params: [String(state), settledAt, Number(id) || 0],
  };
}

export function upsertSettingQuery(key, value) {
  return {
    sql: "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    params: [String(key), String(value)],
  };
}

export function insertProviderSecretQuery({ credentialRef, nonce, ciphertext, createdAt }) {
  return {
    sql: "INSERT INTO provider_secrets(credential_ref, nonce, ciphertext, created_at) VALUES (?, ?, ?, ?)",
    params: [String(credentialRef), String(nonce), String(ciphertext), String(createdAt)],
  };
}

export function updateProviderConfigQuery({
  id,
  providerCode,
  enabled,
  credentialRef = null,
  daily,
  monthly,
  ceiling,
  endpoint = "",
  modelId = "",
  stamp,
}) {
  return {
    sql: `UPDATE system_provider_configs
    SET provider_code = ?, is_enabled = ?, credential_ref = ?, daily_limit_minor = ?,
        monthly_limit_minor = ?, ceiling_minor = ?, endpoint = ?, model_id = ?, updated_at = ?
    WHERE id = ?`,
    params: [
      String(providerCode),
      enabled ? 1 : 0,
      credentialRef,
      Number(daily) || 0,
      Number(monthly) || 0,
      Number(ceiling) || 0,
      String(endpoint || ""),
      String(modelId || ""),
      String(stamp),
      Number(id) || 0,
    ],
  };
}

export function insertProviderConfigQuery({
  category,
  providerCode,
  enabled,
  credentialRef = null,
  daily,
  monthly,
  ceiling,
  stamp,
}) {
  return {
    sql: `INSERT INTO system_provider_configs(
      category, provider_code, is_enabled, credential_ref, daily_limit_minor, monthly_limit_minor,
      ceiling_minor, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    params: [
      String(category),
      String(providerCode),
      enabled ? 1 : 0,
      credentialRef,
      Number(daily) || 0,
      Number(monthly) || 0,
      Number(ceiling) || 0,
      String(stamp),
      String(stamp),
    ],
  };
}