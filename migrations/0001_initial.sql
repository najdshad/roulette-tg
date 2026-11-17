PRAGMA foreign_keys = ON;

CREATE TABLE users (
  telegram_id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 2 AND 24),
  gender TEXT NOT NULL CHECK(gender IN ('M','F','O')),
  age INTEGER NOT NULL CHECK(age BETWEEN 18 AND 99),
  location_mode TEXT NOT NULL CHECK(location_mode IN ('EXACT_COARSE','CITY')),
  location_label TEXT NOT NULL,
  geohash TEXT NOT NULL CHECK(length(geohash) = 5),
  photo_files TEXT NOT NULL,
  credits INTEGER NOT NULL DEFAULT 10 CHECK(credits >= 0),
  vip_until INTEGER NOT NULL DEFAULT 0,
  daily_free_waves INTEGER NOT NULL DEFAULT 3,
  waves_reset_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'IDLE' CHECK(state IN ('IDLE','QUEUED','IN_CHAT','INACTIVE')),
  active_session_id TEXT,
  last_partner_id INTEGER,
  filter_gender TEXT NOT NULL DEFAULT 'ANY' CHECK(filter_gender IN ('ANY','M','F','O')),
  filter_min_age INTEGER NOT NULL DEFAULT 18 CHECK(filter_min_age BETWEEN 18 AND 99),
  filter_max_age INTEGER NOT NULL DEFAULT 99 CHECK(filter_max_age BETWEEN filter_min_age AND 99),
  filter_location TEXT NOT NULL DEFAULT 'ANY' CHECK(filter_location IN ('ANY','CITY','NEARBY')),
  reports_count INTEGER NOT NULL DEFAULT 0,
  photo_suspended_until INTEGER NOT NULL DEFAULT 0,
  is_banned INTEGER NOT NULL DEFAULT 0,
  last_active_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_users_nearby ON users(geohash, is_banned, last_active_at DESC);

CREATE TABLE drafts (
  telegram_id INTEGER PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(telegram_id),
  blocked_id INTEGER NOT NULL REFERENCES users(telegram_id),
  is_report INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  created_at INTEGER NOT NULL,
  reported_at INTEGER,
  PRIMARY KEY(blocker_id, blocked_id),
  CHECK(blocker_id != blocked_id)
);
CREATE INDEX idx_reports ON blocks(blocked_id, reported_at) WHERE is_report = 1;

-- The balance change and the idempotency key commit together, including under concurrency.
CREATE TABLE credit_ledger (
  id TEXT PRIMARY KEY,
  telegram_id INTEGER NOT NULL REFERENCES users(telegram_id),
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER credit_guard BEFORE INSERT ON credit_ledger
WHEN (SELECT credits + NEW.delta FROM users WHERE telegram_id = NEW.telegram_id) < 0
BEGIN SELECT RAISE(ABORT, 'INSUFFICIENT_CREDITS'); END;
CREATE TRIGGER credit_apply AFTER INSERT ON credit_ledger
BEGIN UPDATE users SET credits = credits + NEW.delta WHERE telegram_id = NEW.telegram_id; END;

CREATE TABLE chat_requests (
  id TEXT PRIMARY KEY,
  sender_id INTEGER NOT NULL REFERENCES users(telegram_id),
  recipient_id INTEGER NOT NULL REFERENCES users(telegram_id),
  icebreaker_text TEXT,
  is_super_wave INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'STANDARD' CHECK(kind IN ('STANDARD','SUPER','RECONNECT')),
  cost INTEGER NOT NULL DEFAULT 0,
  uses_free INTEGER NOT NULL DEFAULT 0,
  delivery_phase INTEGER NOT NULL DEFAULT 0,
  delivered_at INTEGER,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','ACCEPTED','DECLINED','EXPIRED','FAILED')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK(sender_id != recipient_id)
);
CREATE UNIQUE INDEX idx_pending_pair ON chat_requests(sender_id, recipient_id) WHERE status = 'PENDING';
CREATE INDEX idx_request_expiry ON chat_requests(status, expires_at);
CREATE TRIGGER request_charge AFTER INSERT ON chat_requests
BEGIN
  INSERT INTO credit_ledger VALUES ('request:' || NEW.id, NEW.sender_id, -NEW.cost, NEW.kind, NEW.created_at);
  UPDATE users SET daily_free_waves = daily_free_waves - NEW.uses_free WHERE telegram_id = NEW.sender_id;
END;

CREATE TABLE star_transactions (
  charge_id TEXT PRIMARY KEY,
  telegram_id INTEGER NOT NULL REFERENCES users(telegram_id),
  package_id TEXT NOT NULL,
  stars_paid INTEGER NOT NULL,
  credits_granted INTEGER NOT NULL,
  vip_days INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TRIGGER payment_grant AFTER INSERT ON star_transactions
BEGIN
  INSERT INTO credit_ledger VALUES ('payment:' || NEW.charge_id, NEW.telegram_id, NEW.credits_granted, 'STARS', NEW.created_at);
  UPDATE users SET vip_until = CASE WHEN NEW.vip_days > 0 THEN MAX(vip_until, NEW.created_at) + NEW.vip_days * 86400000 ELSE vip_until END WHERE telegram_id = NEW.telegram_id;
END;

-- Only receipt IDs are kept here, never update payloads or chat content.
CREATE TABLE update_receipts (
  update_id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('PROCESSING','DONE')),
  lease_until INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
