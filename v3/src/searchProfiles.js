/** 每位使用者同一時間只能有一個 active 搜尋設定檔；切換在同一交易內完成。 */

export function ensureSearchProfileSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_search_profiles (
      id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      data_json TEXT NOT NULL DEFAULT '{}',
      active INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 1,
      last_used_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_search_profiles_one_active
      ON user_search_profiles(user_id) WHERE active = 1;
  `);
}

export function repairMultipleActiveProfiles(db, userId, now = new Date()) {
  const uid = Number(userId);
  const rows = db.prepare(
    "SELECT id, last_used_at, updated_at FROM user_search_profiles WHERE user_id = ? AND active = 1 ORDER BY last_used_at DESC, updated_at DESC, id DESC",
  ).all(uid);
  if (rows.length <= 1) return rows[0]?.id || "";
  const keep = rows[0].id;
  const stamp = (now instanceof Date ? now : new Date(now)).toISOString();
  db.prepare("UPDATE user_search_profiles SET active = 0, updated_at = ? WHERE user_id = ? AND id != ?")
    .run(stamp, uid, keep);
  return keep;
}

function runInTransaction(db, fn) {
  if (typeof db.transaction === "function") return db.transaction(fn)();
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  }
}

export function activateSearchProfile(db, userId, profileId, { data, name, now = new Date() } = {}) {
  const uid = Number(userId);
  const id = String(profileId || "").trim();
  if (!uid || !id) throw Object.assign(new Error("search profile id required"), { status: 400 });
  const stamp = (now instanceof Date ? now : new Date(now)).toISOString();
  return runInTransaction(db, () => {
    repairMultipleActiveProfiles(db, uid, now);
    db.prepare("UPDATE user_search_profiles SET active = 0, updated_at = ? WHERE user_id = ? AND active = 1")
      .run(stamp, uid);
    const existing = db.prepare("SELECT version FROM user_search_profiles WHERE user_id = ? AND id = ?").get(uid, id);
    if (existing) {
      db.prepare(`
        UPDATE user_search_profiles
        SET active = 1, version = version + 1, last_used_at = ?, updated_at = ?,
            name = COALESCE(?, name),
            data_json = COALESCE(?, data_json)
        WHERE user_id = ? AND id = ?
      `).run(stamp, stamp, name || null, data ? JSON.stringify(data) : null, uid, id);
    } else {
      db.prepare(`
        INSERT INTO user_search_profiles(id, user_id, name, data_json, active, version, last_used_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?)
      `).run(id, uid, name || "暫存", JSON.stringify(data || {}), stamp, stamp, stamp);
    }
    return db.prepare("SELECT * FROM user_search_profiles WHERE user_id = ? AND id = ?").get(uid, id);
  });
}

export function getActiveSearchProfile(db, userId) {
  const uid = Number(userId);
  repairMultipleActiveProfiles(db, uid);
  return db.prepare("SELECT * FROM user_search_profiles WHERE user_id = ? AND active = 1").get(uid) || null;
}

export function notifySnapshotFromProfile(row) {
  if (!row) return { notify_profile_id: "", notify_profile_version: 0, data: {} };
  let data = {};
  try { data = JSON.parse(row.data_json || "{}"); } catch { data = {}; }
  return {
    notify_profile_id: row.id,
    notify_profile_version: Number(row.version) || 1,
    data,
  };
}
