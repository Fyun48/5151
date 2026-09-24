// 會員設定／搜尋設定檔的 driver-aware 入口（PG 島嶼移植，2026-09-24）。
//
// 為什麼需要：`getSettings／saveSettings／saveAsProfile／loadProfile／deleteProfile` 原本只有同步
// SQLite 版本，所以 `DB_DRIVER=postgres` 時，線上的「儲存設定／儲存為設定檔」寫進的是**該節點自己的
// SQLite**（公開站在 web-A／web-B 輪流時，設定就會「看哪一台回答」而不一致——2026-09-23 的
// 「設定檔不見、列表全空」就是這個）。
//
// 與其它島嶼同一個設計：純判斷留在 settingsState.js／db.js（兩個 driver 共用），PG 只換「跑語句的人」。
//   - SQLite 分支：直接呼叫 db.js 的同步函式（行為完全不變）
//   - PostgreSQL 分支：repository/memberSettings.js 的語句 ＋ pgSharedDriver 的連線／交易
import { resolveDbDriver } from "./dbDriver.js";
import { sharedPgDriver } from "./pgSharedDriver.js";
import { toPostgresSql } from "./sqlDialect.js";
import * as repo from "./repository/memberSettings.js";
import { ACTIVE_PROFILE_ORDER_SQL, DEACTIVATE_PROFILES_SQL, activateSearchProfile } from "./searchProfiles.js";
import {
  ADMIN_MAX_PROFILES,
  MEMBER_MAX_PROFILES,
  applySettingPatch,
  planIntervalMinutes,
  profileNameOrDraft,
  resolveSaveAsProfileAction,
  snapshotSettings,
} from "./settingsState.js";
import {
  DEFAULTS,
  armMemberExternalFetch,
  deleteProfile as deleteProfileSync,
  getSettings as getSettingsSync,
  loadProfile as loadProfileSync,
  planSettingWrites,
  saveAsProfile as saveAsProfileSync,
  saveSettings as saveSettingsSync,
  settingsFromRows,
  systemCrawlFromRows,
  sqliteHandle,
} from "./db.js";

// 注入式 exec（測試）優先；否則借用共用 PG pool。PG 分支的每個入口都吃 options。
async function pgExec(options = {}) {
  if (options.exec) return options.exec;
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return (sql, params = []) => pgDriver.query(toPostgresSql(sql), params).then((res) => res.rows);
}

// 與 db.js 的寫入交易對應；注入式 exec（離線測試）沒有交易，就照同一條連線的順序跑。
async function runInTransaction(options, fn) {
  if (options.exec) return fn(options.exec);
  const pgDriver = options.pgDriver || (await sharedPgDriver());
  return pgDriver.withTransaction(async (client) => {
    const tx = (sql, params = []) => client.query(toPostgresSql(sql), params).then((res) => res.rows);
    return fn(tx);
  });
}

async function userRowAsync(exec, uid) {
  const rows = await exec(repo.USER_BY_ID_SQL, [uid]);
  return rows[0] || null;
}

// db.js getSettings()（PG 分支）。
export async function getSettingsAsync(userId, options = {}) {
  const uid = Number(userId) || 0;
  if ((options.driver || resolveDbDriver()) !== "postgres") return getSettingsSync(uid);
  const exec = await pgExec(options);
  const globalRows = await exec(repo.GLOBAL_SETTINGS_SQL, []);
  const system = systemCrawlFromRows(globalRows);
  if (!uid) return settingsFromRows({ globalRows, system });
  const userRows = await exec(repo.USER_SETTINGS_SQL, [uid]);
  const user = await userRowAsync(exec, uid);
  return settingsFromRows({ globalRows, userRows, user, system });
}

// db.js saveSettings()（PG 分支）：同一個 applySettingPatch ＋ planSettingWrites，寫進 PG。
export async function saveSettingsAsync(partial, userId, { forceAdmin = false, ...options } = {}) {
  const uid = Number(userId) || 0;
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    return saveSettingsSync(partial, uid, { forceAdmin });
  }
  const exec = await pgExec(options);
  const current = await getSettingsAsync(uid, { ...options, exec });
  const user = await userRowAsync(exec, uid);
  const admin = forceAdmin || user?.role === "admin";
  const plan = user?.plan || "free";
  const next = applySettingPatch(current, partial, { admin, plan });
  const { userWrites, siteWrites } = planSettingWrites(next);
  await runInTransaction(options, async (tx) => {
    for (const [key, value] of siteWrites) await tx(repo.SITE_SETTING_UPSERT_SQL, [key, value]);
    for (const [key, value] of userWrites) await tx(repo.USER_SETTING_UPSERT_SQL, [uid, key, value]);
  });
  await persistSearchProfileAsync(uid, next, options);
  return next;
}

// db.js persistSearchProfileFromSettings()（PG 分支）：把目前設定快照成 active 搜尋設定檔。
export async function persistSearchProfileAsync(userId, settings, options = {}) {
  const uid = Number(userId) || 0;
  if (!uid || !settings) return null;
  const profileId = String(settings.activeProfileId || settings.settingProfiles?.[0]?.id || "live");
  const profile = (settings.settingProfiles || []).find((item) => String(item.id) === profileId);
  try {
    return await activateSearchProfileAsync(uid, profileId, {
      name: profile?.name || "目前搜尋",
      data: snapshotSettings(settings),
    }, options);
  } catch {
    // 隔離 fixture 沒有 profile 表（與 SQLite 分支的 catch 一致）
    return null;
  }
}

// searchProfiles.js activateSearchProfile()（PG 分支）：repair → 取消 active → upsert → 讀回。
export async function activateSearchProfileAsync(userId, profileId, { data, name, now = new Date() } = {}, options = {}) {
  const uid = Number(userId);
  const id = String(profileId || "").trim();
  if (!uid || !id) throw Object.assign(new Error("search profile id required"), { status: 400 });
  const stamp = (now instanceof Date ? now : new Date(now)).toISOString();
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    return activateSearchProfile(sqliteHandle(), uid, id, { data, name, now });
  }
  return runInTransaction(options, async (tx) => {
    const activeRows = await tx(ACTIVE_PROFILE_ORDER_SQL, [uid]);
    if (activeRows.length > 1) {
      await tx(DEACTIVATE_PROFILES_SQL, [stamp, uid, activeRows[0].id]);
    }
    await tx(repo.PROFILE_DEACTIVATE_ALL_SQL, [stamp, uid]);
    const existing = await tx(repo.PROFILE_VERSION_SQL, [uid, id]);
    if (existing.length) {
      await tx(repo.PROFILE_UPDATE_SQL, [stamp, stamp, name || null, data ? JSON.stringify(data) : null, uid, id]);
    } else {
      await tx(repo.PROFILE_INSERT_SQL, [id, uid, name || "暫存", JSON.stringify(data || {}), stamp, stamp, stamp]);
    }
    const rows = await tx(repo.PROFILE_BY_ID_SQL, [uid, id]);
    return rows[0] || null;
  });
}

// db.js saveAsProfile()（PG 分支）。
export async function saveAsProfileAsync(name, livePatch, userId, { overwrite = false, ...options } = {}) {
  const uid = Number(userId) || 0;
  if ((options.driver || resolveDbDriver()) !== "postgres") {
    return saveAsProfileSync(name, livePatch, uid, { overwrite });
  }
  const admin = (await userRowAsync(await pgExec(options), uid))?.role === "admin";
  const current = livePatch && typeof livePatch === "object"
    ? await saveSettingsAsync(livePatch, uid, options)
    : await getSettingsAsync(uid, options);
  const profiles = [...(current.settingProfiles || [])];
  const label = profileNameOrDraft(name);
  const decision = resolveSaveAsProfileAction(profiles, label, { overwrite, admin });
  if (decision.action === "empty") {
    const err = new Error("請先填設定檔名稱");
    err.status = 400;
    throw err;
  }
  if (decision.action === "full") {
    const err = new Error(
      admin
        ? `設定檔已滿，最多 ${ADMIN_MAX_PROFILES} 個`
        : `設定檔已滿，最多 ${MEMBER_MAX_PROFILES} 個。請先刪除一個，或覆蓋現有同名設定檔。`,
    );
    err.status = 400;
    err.code = "full";
    throw err;
  }
  if (decision.action === "overwrite") {
    const id = decision.existing.id;
    const next = profiles.map((item) => (
      item.id === id
        ? { ...item, name: label, saved_at: new Date().toISOString(), data: snapshotSettings(current) }
        : item
    ));
    await saveSettingsAsync({ settingProfiles: next, activeProfileId: id }, uid, options);
    return armMemberExternalFetchAsync(uid, {}, options);
  }
  const id = `p-${Date.now()}`;
  profiles.push({ id, name: label, saved_at: new Date().toISOString(), data: snapshotSettings(current) });
  await saveSettingsAsync({ settingProfiles: profiles, activeProfileId: id }, uid, options);
  return armMemberExternalFetchAsync(uid, {}, options);
}

// db.js loadProfile()（PG 分支）。
export async function loadProfileAsync(id, userId, options = {}) {
  const uid = Number(userId) || 0;
  if ((options.driver || resolveDbDriver()) !== "postgres") return loadProfileSync(id, uid);
  const current = await getSettingsAsync(uid, options);
  const profile = (current.settingProfiles || []).find((item) => item.id === id);
  if (!profile) {
    const err = new Error("找不到這個設定檔");
    err.status = 404;
    throw err;
  }
  await saveSettingsAsync({
    ...snapshotSettings({ ...DEFAULTS, ...profile.data }),
    settingProfiles: current.settingProfiles,
    activeProfileId: profile.id,
  }, uid, options);
  return armMemberExternalFetchAsync(uid, {}, options);
}

// db.js deleteProfile()（PG 分支）。
export async function deleteProfileAsync(id, userId, options = {}) {
  const uid = Number(userId) || 0;
  if ((options.driver || resolveDbDriver()) !== "postgres") return deleteProfileSync(id, uid);
  const current = await getSettingsAsync(uid, options);
  const profiles = (current.settingProfiles || []).filter((item) => item.id !== id);
  const active = current.activeProfileId === id ? (profiles[0]?.id || "") : current.activeProfileId;
  return saveSettingsAsync({ settingProfiles: profiles, activeProfileId: active }, uid, options);
}

// db.js armMemberExternalFetch()（PG 分支）：排下一次會員端抓取時間。
export async function armMemberExternalFetchAsync(userId, { from = Date.now() } = {}, options = {}) {
  const uid = Number(userId) || 0;
  if ((options.driver || resolveDbDriver()) !== "postgres") return armMemberExternalFetch(uid, { from });
  if (!uid) return getSettingsAsync(uid, options);
  const current = await getSettingsAsync(uid, options);
  if (current.notificationsPaused === true) {
    if (current.memberFetchDueAt) return saveSettingsAsync({ memberFetchDueAt: "" }, uid, options);
    return current;
  }
  const user = await userRowAsync(await pgExec(options), uid);
  const minutes = planIntervalMinutes(user?.plan);
  const due = new Date(Number(from) + minutes * 60 * 1000).toISOString();
  return saveSettingsAsync({ memberFetchDueAt: due }, uid, options);
}
