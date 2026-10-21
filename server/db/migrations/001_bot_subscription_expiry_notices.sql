-- Bot-owned notice log. Apply once as the database owner, not as the bot role:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/db/migrations/001_bot_subscription_expiry_notices.sql
--
-- Then grant the bot role least privilege. Replace gamenight_bot with the real role:
--   GRANT SELECT ON plans, subscriptions TO gamenight_bot;
--   GRANT SELECT, INSERT, UPDATE ON bot_subscription_expiry_notices, bot_notification_state TO gamenight_bot;
--   GRANT USAGE, SELECT ON SEQUENCE bot_subscription_expiry_notices_id_seq TO gamenight_bot;
--
-- Do not grant INSERT, UPDATE, or DELETE on plans, subscriptions, payments, or users.
-- This script does not read or change premium dates.

CREATE TABLE IF NOT EXISTS bot_subscription_expiry_notices (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NOT NULL,
  active_until TIMESTAMP NOT NULL,
  plan_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'blocked', 'failed', 'skipped_historical', 'superseded')),
  telegram_message_id BIGINT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  CONSTRAINT bot_subscription_expiry_notices_event UNIQUE (telegram_id, active_until)
);

CREATE INDEX IF NOT EXISTS bot_subscription_expiry_notices_status_idx
  ON bot_subscription_expiry_notices (status, updated_at);

CREATE TABLE IF NOT EXISTS bot_notification_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
