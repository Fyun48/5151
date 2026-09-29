/** 約兩個月未登入：暫停爬蟲與通知；再登入恢復且不寄信。一年刪帳尚未執行。 */

export function shouldSkipIdlePause(settings) {
  return settings?.notificationsPaused === true;
}

export function shouldResumeIdle(settings) {
  return settings?.inactivityPaused === true;
}

export function idlePauseFlags() {
  return { notificationsPaused: true, inactivityPaused: true };
}

export function idleResumeFlags() {
  return { notificationsPaused: false, inactivityPaused: false };
}

export function applyIdlePauseToMembers(ids, { getSettings, saveSettings } = {}) {
  let n = 0;
  for (const id of ids) {
    const settings = typeof getSettings === "function" ? getSettings(id) : null;
    if (shouldSkipIdlePause(settings)) continue;
    if (typeof saveSettings === "function") saveSettings(id, idlePauseFlags());
    n += 1;
  }
  return n;
}

/** 恢復閒置暫停。不寄信；呼叫端也不該為此排隊系統信。 */
/** `applyIdleResume()` 的 async 版（PG 島嶼用）：規則完全相同，只是每一步可以 await。
 *  兩份務必同步修改——`v3/test/idle-verify.test.js` 會比對兩邊的結果。 */
export async function applyIdleResumeAsync(userId, { getSettings, saveSettings, armFetch } = {}) {
  const uid = Number(userId) || 0;
  const current = typeof getSettings === "function" ? await getSettings(uid) : null;
  if (!uid || !shouldResumeIdle(current)) {
    return { resumed: false, mailed: false, settings: current };
  }
  let settings = typeof saveSettings === "function" ? await saveSettings(uid, idleResumeFlags()) : current;
  if (settings?.notificationsPaused !== true && typeof armFetch === "function") {
    settings = (await armFetch(uid)) || settings;
  }
  return { resumed: true, mailed: false, settings };
}

export function applyIdleResume(userId, { getSettings, saveSettings, armFetch } = {}) {
  const uid = Number(userId) || 0;
  const current = typeof getSettings === "function" ? getSettings(uid) : null;
  if (!uid || !shouldResumeIdle(current)) {
    return { resumed: false, mailed: false, settings: current };
  }
  let settings = typeof saveSettings === "function" ? saveSettings(uid, idleResumeFlags()) : current;
  if (settings?.notificationsPaused !== true && typeof armFetch === "function") {
    settings = armFetch(uid) || settings;
  }
  return { resumed: true, mailed: false, settings };
}
