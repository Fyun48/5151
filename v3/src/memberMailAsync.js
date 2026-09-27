// 會員郵件設定（SMTP／範本／preset）的 driver-aware 入口（PG 島嶼移植，2026-09-27）。
//
// 為什麼需要：`getMemberMailSettings／saveMemberMailSettings／getMemberMailBundle` 原本只有同步
// SQLite 版本，所以 `DB_DRIVER=postgres` 時，公開站「通知設定 → 自己的郵件 SMTP」讀寫的是
// **該節點自己的 SQLite**。實測（2026-09-27，同一台生產、同一個使用者）：
//   CasaOS `591-tracker-v3`（web-A）→ host 空的、寄件名稱「吉比租房物件追蹤」
//   Synology `5151-web-B`        → host 有值、寄件名稱「11吉比租房物件追蹤」
// 公開站經 HAProxy 在兩台之間輪流，所以同一頁重新整理就會看到不同結果。
// 而且 watcher 寄送會員通知時也用 `getMemberMailBundle`，所以「由哪一台寄」也會影響用哪個帳號。
//
// 與其它島嶼同一個設計：純判斷留在 siteMail.js／memberMail.js（兩個 driver 共用），
// PG 只換「跑語句的人」。
//   - SQLite 分支：直接呼叫 db.js 的同步函式（行為完全不變）
//   - PostgreSQL 分支：repository/memberSettings.js 的語句 ＋ pgSharedDriver 的連線／交易
import { resolveDbDriver } from "./dbDriver.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import * as repo from "./repository/memberSettings.js";
import { normalizeMailTemplates, normalizeSmtp } from "./siteMail.js";
import {
  listingMailPresetById,
  normalizeMemberMailTemplates,
  publicMemberMail,
  smtpReady,
} from "./memberMail.js";
import {
  getMemberMailBundle as getMemberMailBundleSync,
  getMemberMailSettings as getMemberMailSettingsSync,
  saveMemberMailSettings as saveMemberMailSettingsSync,
} from "./db.js";

// 注入式 exec（測試）優先；否則借用共用 PG pool。PG 分支的每個入口都吃 options。
async function pgExec(options = {}) {
  if (options.exec) return options.exec;
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

// 與 db.js 的寫入對應；注入式 exec（離線測試）沒有交易，就照同一條連線的順序跑。
async function runInTransaction(options, fn) {
  if (options.exec) return fn(options.exec);
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return pgDriver.withTransaction(async (client) => {
    const tx = (sql, params = []) => client.query(toPostgresSql(sql), params).then((res) => res.rows);
    return fn(tx);
  });
}

// 與 db.js userSettingKey() 相同的解析語意：JSON.parse，壞掉就當作沒有值。
function parseValue(raw) {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function toMap(rows) {
  const map = new Map();
  for (const row of rows || []) map.set(row.key, parseValue(row.value));
  return map;
}

async function readUserSettings(exec, uid) {
  return toMap(await exec(repo.USER_SETTINGS_SQL, [uid]));
}

// 站台範本在 PG 的 settings 表（key=mailTemplates）。SQLite 分支走 db.js 的 getMailTemplates()。
async function readSiteTemplates(exec) {
  return normalizeMailTemplates(toMap(await exec(repo.GLOBAL_SETTINGS_SQL, [])).get("mailTemplates"));
}

// db.js getMemberMailSettings() 的 PG 分支。
export async function getMemberMailSettingsAsync(userId, options = {}) {
  const uid = Number(userId) || 0;
  if ((options.driver || resolveDbDriver()) !== "postgres") return getMemberMailSettingsSync(uid);
  const exec = await pgExec(options);
  const stored = await readUserSettings(exec, uid);
  const smtp = normalizeSmtp(stored.get("memberSmtp") || {}, {});
  const templates = normalizeMemberMailTemplates(stored.get("memberMailTemplates"));
  const preset = String(stored.get("mailPreset") || "detailed");
  return publicMemberMail(smtp, templates, preset);
}

// db.js getMemberMailBundle() 的 PG 分支（watcher 寄送會員通知時使用）。
export async function getMemberMailBundleAsync(userId, options = {}) {
  const uid = Number(userId) || 0;
  if ((options.driver || resolveDbDriver()) !== "postgres") return getMemberMailBundleSync(uid);
  const exec = await pgExec(options);
  const stored = await readUserSettings(exec, uid);
  const smtp = normalizeSmtp(stored.get("memberSmtp") || {}, {});
  const templates = normalizeMemberMailTemplates(stored.get("memberMailTemplates"));
  const siteTemplates = await readSiteTemplates(exec);
  const ready = smtpReady(smtp);
  return {
    smtp: ready ? smtp : null,
    templates: {
      listing_notify: templates.listing_notify || siteTemplates.listing_notify,
    },
    configured: ready,
  };
}

// db.js saveMemberMailSettings() 的 PG 分支。步驟與同步版逐條對應：
// smtp → memberSmtp、templates → memberMailTemplates、preset → mailPreset（且沒帶 templates 時
// 一併把該 preset 寫進 memberMailTemplates）。值一律 JSON.stringify，與 db.js 的寫入格式一致。
export async function saveMemberMailSettingsAsync(userId, partial = {}, options = {}) {
  const uid = Number(userId) || 0;
  if (!uid) {
    const err = new Error("請先登入");
    err.status = 401;
    throw err;
  }
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    return saveMemberMailSettingsSync(uid, partial);
  }
  const src = partial && typeof partial === "object" ? partial : {};
  const exec = await pgExec(options);
  const stored = await readUserSettings(exec, uid);
  const writes = [];
  if (src.smtp && typeof src.smtp === "object") {
    const previous = normalizeSmtp(stored.get("memberSmtp") || {}, {});
    writes.push(["memberSmtp", normalizeSmtp(src.smtp, previous)]);
  }
  if (src.templates && typeof src.templates === "object") {
    writes.push(["memberMailTemplates", normalizeMemberMailTemplates(src.templates)]);
  }
  if (Object.prototype.hasOwnProperty.call(src, "preset")) {
    const preset = listingMailPresetById(src.preset);
    writes.push(["mailPreset", preset.id]);
    if (!src.templates) writes.push(["memberMailTemplates", normalizeMemberMailTemplates(preset)]);
  }
  if (writes.length) {
    await runInTransaction(options, async (tx) => {
      for (const [key, value] of writes) {
        await tx(repo.USER_SETTING_UPSERT_SQL, [uid, key, JSON.stringify(value)]);
      }
    });
  }
  return getMemberMailSettingsAsync(uid, { ...options, exec });
}
