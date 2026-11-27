-- Per-campaign button choice for the broadcast panel. Apply as the database owner after 002:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/db/migrations/003_bot_broadcast_buttons.sql
--
-- Only the bot-owned bot_broadcast_* tables are altered. Existing rows keep working:
-- the default 'miniapp' is the single Mini App button that earlier campaigns used.
-- No new tables, so the grants from 002 already cover these columns.
-- Do not grant write access to plans, payments, or users.

ALTER TABLE bot_broadcast_drafts
  ADD COLUMN IF NOT EXISTS button_mode TEXT NOT NULL DEFAULT 'miniapp'
    CHECK (button_mode IN ('web', 'miniapp', 'both'));

ALTER TABLE bot_broadcast_drafts
  ADD COLUMN IF NOT EXISTS web_url TEXT;

ALTER TABLE bot_broadcast_campaigns
  ADD COLUMN IF NOT EXISTS button_mode TEXT NOT NULL DEFAULT 'miniapp'
    CHECK (button_mode IN ('web', 'miniapp', 'both'));

ALTER TABLE bot_broadcast_campaigns
  ADD COLUMN IF NOT EXISTS web_url TEXT;
