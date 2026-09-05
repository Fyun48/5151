/** 多人版個人資料表。591 原始刊登仍在 listings；標記與設定依 user_id 分開。 */
export function ensurePersonalSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'member',
      plan TEXT NOT NULL DEFAULT 'free',
      created_at TEXT NOT NULL,
      accepted_disclaimer_at TEXT,
      disclaimer_version TEXT NOT NULL DEFAULT '',
      signup_count INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT,
      deleted_by TEXT NOT NULL DEFAULT '',
      deleted_reason TEXT NOT NULL DEFAULT '',
      deleted_reason_code TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS user_settings (
      user_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (user_id, key),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS user_listing_flags (
      user_id INTEGER NOT NULL,
      post_id INTEGER NOT NULL,
      viewed INTEGER NOT NULL DEFAULT 0,
      watched INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      watch_note TEXT NOT NULL DEFAULT '',
      viewed_at TEXT,
      watched_at TEXT,
      hidden_at TEXT,
      PRIMARY KEY (user_id, post_id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS crawl_covers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      region_id INTEGER NOT NULL,
      section_ids TEXT NOT NULL DEFAULT '[]',
      price_min INTEGER NOT NULL DEFAULT 0,
      price_max INTEGER NOT NULL DEFAULT 0,
      last_run_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      post_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      source_key TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      notified INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS user_match_votes (
      user_id INTEGER NOT NULL,
      post_id INTEGER NOT NULL,
      peer_id INTEGER NOT NULL,
      vote TEXT NOT NULL,
      confidence TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, post_id, peer_id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS user_match_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      post_id INTEGER NOT NULL,
      peer_id INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_flags_watched ON user_listing_flags(user_id, watched);
    CREATE INDEX IF NOT EXISTS idx_user_flags_viewed ON user_listing_flags(user_id, viewed);
    CREATE INDEX IF NOT EXISTS idx_user_flags_post ON user_listing_flags(post_id);
    CREATE INDEX IF NOT EXISTS idx_user_events_user ON user_events(user_id, notified);
    CREATE INDEX IF NOT EXISTS idx_crawl_covers_region ON crawl_covers(region_id);
    CREATE INDEX IF NOT EXISTS idx_user_match_votes_pair ON user_match_votes(post_id, peer_id, vote);
    CREATE INDEX IF NOT EXISTS idx_user_match_signals_user ON user_match_signals(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_user_match_signals_pair ON user_match_signals(post_id, peer_id, type);
  `);
  for (const sql of [
    "ALTER TABLE users ADD COLUMN accepted_disclaimer_at TEXT",
    "ALTER TABLE users ADD COLUMN disclaimer_version TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN signup_count INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE users ADD COLUMN deleted_at TEXT",
    "ALTER TABLE users ADD COLUMN deleted_by TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN deleted_reason TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN deleted_reason_code TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE users ADD COLUMN verify_token TEXT",
    "ALTER TABLE users ADD COLUMN verify_expires_at TEXT",
    "ALTER TABLE users ADD COLUMN verify_expire_notified INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN nickname TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN self_ban_until TEXT",
    "ALTER TABLE users ADD COLUMN home_address TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN company_address TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN contact_phone TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN line_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN line_qr_url TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN contact_email TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN profile_privacy_at TEXT",
    "ALTER TABLE users ADD COLUMN last_login_at TEXT",
    "ALTER TABLE users ADD COLUMN verify_used_at TEXT",
    "ALTER TABLE users ADD COLUMN oauth_provider TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN oauth_subject TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE users ADD COLUMN profile_onboarded_at TEXT",
    "ALTER TABLE user_events ADD COLUMN source_key TEXT NOT NULL DEFAULT ''",
  ]) {
    try {
      db.exec(sql);
    } catch {
      // already migrated
    }
  }
}
