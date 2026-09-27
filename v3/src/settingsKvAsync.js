// 站台／會員「單一設定鍵」的 driver-aware 存取器（2026-09-27）。
//
// 為什麼需要：`settingKey`／`writeSettingKey`／`userSettingKey`／`writeUserSettingKey` 只在
// `db.js`（同步 SQLite），而 **PG 這邊一直沒有通用存取器**——每一處要用的人（例如
// `coveringBookkeepingAsync`）都得自己手寫一段 UPSERT SQL。
//
// 後果：對照表顯示有 **94 處** SQLite 路由用到 `settings`、16 處用到 `user_settings`。
// 若一條一條做，每條都要重寫一次幾乎相同的 SQL，既慢又容易寫出不一致的格式。
// 這個模組把那段收斂成一個地方，後續轉換就變成機械性改動。
//
// 設計與其它島嶼一致：SQLite 分支直接呼叫 db.js 的同步函式（行為完全不變），
// PG 分支用 repository/memberSettings.js 的語句 ＋ pgSharedDriver。
// 值的格式一律 JSON.stringify，與 db.js 完全相同。
import { resolveDbDriver } from "./dbDriver.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import {
  SITE_SETTING_UPSERT_SQL,
  USER_SETTING_UPSERT_SQL,
} from "./repository/memberSettings.js";
import {
  settingKey as settingKeySync,
  userSettingKey as userSettingKeySync,
  writeSettingKey as writeSettingKeySync,
  writeUserSettingKey as writeUserSettingKeySync,
} from "./db.js";

const SITE_SETTING_SELECT_SQL = "SELECT value FROM settings WHERE key = ?";
const USER_SETTING_SELECT_SQL = "SELECT value FROM user_settings WHERE user_id = ? AND key = ?";

async function pgExec(options = {}) {
  if (options.exec) return options.exec;
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

// 與 db.js settingKey()／userSettingKey() 相同的解析語意：JSON.parse，壞掉就當作沒有值。
function parseValue(raw) {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const isPg = (options = {}) => (options.driver || resolveDbDriver()) === "postgres";

// ---- 站台層級（settings 表）----

export async function getSiteSettingAsync(key, options = {}) {
  if (!isPg(options)) return settingKeySync(key);
  const exec = await pgExec(options);
  const rows = await exec(SITE_SETTING_SELECT_SQL, [key]);
  return parseValue(rows[0]?.value);
}

export async function setSiteSettingAsync(key, value, options = {}) {
  if (!isPg(options)) {
    writeSettingKeySync(key, value);
    return value;
  }
  const exec = await pgExec(options);
  await exec(SITE_SETTING_UPSERT_SQL, [key, JSON.stringify(value)]);
  return value;
}

// ---- 會員層級（user_settings 表）----

export async function getUserSettingAsync(userId, key, options = {}) {
  const uid = Number(userId) || 0;
  if (!isPg(options)) return userSettingKeySync(uid, key);
  if (!uid) return undefined;
  const exec = await pgExec(options);
  const rows = await exec(USER_SETTING_SELECT_SQL, [uid, key]);
  return parseValue(rows[0]?.value);
}

export async function setUserSettingAsync(userId, key, value, options = {}) {
  const uid = Number(userId) || 0;
  if (!uid) return undefined;
  if (!isPg(options)) {
    writeUserSettingKeySync(uid, key, value);
    return value;
  }
  const exec = await pgExec(options);
  await exec(USER_SETTING_UPSERT_SQL, [uid, key, JSON.stringify(value)]);
  return value;
}
