-- Support / Sponsorship domain
-- Idempotent / rollback-safe: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- Does not alter listing ranking tables.

CREATE TABLE IF NOT EXISTS support_page_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  flags_json TEXT NOT NULL DEFAULT '{}',
  draft_json TEXT NOT NULL DEFAULT '{}',
  published_json TEXT NOT NULL DEFAULT '{}',
  published_at TEXT,
  goal_amount REAL NOT NULL DEFAULT 0,
  goal_label TEXT NOT NULL DEFAULT '',
  goal_display TEXT NOT NULL DEFAULT 'exact',
  wall_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS support_operating_cost (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL DEFAULT 'Other',
  name TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  billing_cycle TEXT NOT NULL DEFAULT 'monthly',
  start_date TEXT NOT NULL DEFAULT '',
  end_date TEXT,
  is_public INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_tier (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'TWD',
  icon TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_default INTEGER NOT NULL DEFAULT 0,
  provider_product_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_provider (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  page_url TEXT NOT NULL DEFAULT '',
  widget_url TEXT NOT NULL DEFAULT '',
  secret_ref TEXT NOT NULL DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_transaction (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL DEFAULT '',
  provider_transaction_id TEXT,
  supporter_user_id INTEGER,
  supporter_name TEXT,
  supporter_email TEXT,
  amount REAL NOT NULL DEFAULT 0,
  fee REAL NOT NULL DEFAULT 0,
  net_amount REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'TWD',
  status TEXT NOT NULL DEFAULT 'pending',
  anonymous INTEGER NOT NULL DEFAULT 1,
  message TEXT,
  channel TEXT NOT NULL DEFAULT 'personal',
  received_at TEXT NOT NULL,
  raw_reference TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_sponsor (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  logo TEXT NOT NULL DEFAULT '',
  website_url TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  start_at TEXT,
  end_at TEXT,
  amount REAL,
  show_amount INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',
  display_location TEXT NOT NULL DEFAULT 'support_page',
  sort_order INTEGER NOT NULL DEFAULT 0,
  disclosure_text TEXT NOT NULL DEFAULT '贊助',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_cta_rule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_type TEXT NOT NULL,
  threshold INTEGER NOT NULL DEFAULT 1,
  message TEXT NOT NULL DEFAULT '',
  cooldown_days INTEGER NOT NULL DEFAULT 7,
  enabled INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS support_prompt_state (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  last_shown_at TEXT,
  dismissed_until TEXT,
  shown_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id)
);

CREATE TABLE IF NOT EXISTS support_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  user_id INTEGER,
  guest_key TEXT NOT NULL DEFAULT '',
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_support_cost_public ON support_operating_cost(is_public, start_date);
CREATE INDEX IF NOT EXISTS idx_support_tier_active ON support_tier(is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_support_provider_kind ON support_provider(kind, is_active);
CREATE INDEX IF NOT EXISTS idx_support_tx_received ON support_transaction(received_at);
CREATE INDEX IF NOT EXISTS idx_support_tx_status ON support_transaction(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_tx_provider_id ON support_transaction(provider, provider_transaction_id);
CREATE INDEX IF NOT EXISTS idx_support_sponsor_window ON support_sponsor(status, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_support_cta_enabled ON support_cta_rule(enabled, priority);
CREATE INDEX IF NOT EXISTS idx_support_event_kind ON support_event(kind, created_at);
CREATE INDEX IF NOT EXISTS idx_support_event_created ON support_event(created_at);
