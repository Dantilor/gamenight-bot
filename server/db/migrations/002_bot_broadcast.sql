-- Broadcast registry owned by the bot. Apply once as the database owner:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/db/migrations/002_bot_broadcast.sql
--
-- Then grant the bot role least privilege:
--   GRANT SELECT, INSERT, UPDATE ON
--     bot_broadcast_contacts, bot_broadcast_drafts,
--     bot_broadcast_campaigns, bot_broadcast_deliveries
--     TO gamenight_bot;
--   GRANT USAGE, SELECT ON SEQUENCE
--     bot_broadcast_campaigns_id_seq, bot_broadcast_deliveries_id_seq
--     TO gamenight_bot;
--
-- Informational broadcasts only read existing user ids:
--   GRANT SELECT (telegram_id) ON users TO gamenight_bot;
-- Do not grant write access to plans, subscriptions, payments, or users.
-- This script does not read or change those tables.

CREATE TABLE IF NOT EXISTS bot_broadcast_contacts (
  telegram_id BIGINT PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  notify_opt_out BOOLEAN NOT NULL DEFAULT false,
  ads_opt_in BOOLEAN NOT NULL DEFAULT false,
  blocked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bot_broadcast_drafts (
  admin_id BIGINT PRIMARY KEY,
  step TEXT NOT NULL CHECK (step IN ('idle', 'text', 'photo', 'confirm')),
  body_html TEXT NOT NULL DEFAULT '',
  photo_file_id TEXT,
  include_button BOOLEAN NOT NULL DEFAULT true,
  audience TEXT NOT NULL DEFAULT 'notify' CHECK (audience IN ('notify', 'ads')),
  confirm_token TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bot_broadcast_campaigns (
  id BIGSERIAL PRIMARY KEY,
  admin_id BIGINT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('test', 'mass')),
  audience TEXT NOT NULL CHECK (audience IN ('notify', 'ads')),
  body_html TEXT NOT NULL,
  photo_file_id TEXT,
  include_button BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'stopped', 'completed')),
  confirm_token TEXT,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS bot_broadcast_campaigns_confirm_token_idx
  ON bot_broadcast_campaigns (confirm_token);

CREATE TABLE IF NOT EXISTS bot_broadcast_deliveries (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES bot_broadcast_campaigns (id),
  telegram_id BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'blocked', 'failed')),
  telegram_message_id BIGINT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  CONSTRAINT bot_broadcast_deliveries_once UNIQUE (campaign_id, telegram_id)
);

CREATE INDEX IF NOT EXISTS bot_broadcast_deliveries_pending_idx
  ON bot_broadcast_deliveries (status, id);
