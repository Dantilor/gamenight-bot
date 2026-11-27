-- Least-privilege role for the broadcast worker. Not a migration: run once as the database owner,
-- after migrations 002 and 003 are applied and after a pg_dump backup.
-- Replace the password before running; never commit the real one.
--
--   psql "$OWNER_DATABASE_URL" -v ON_ERROR_STOP=1 -f deploy/broadcast-worker/grants.sql
--
-- The worker can: read the queue, mark deliveries sent/blocked/failed, finish or resume campaigns,
-- record that a user blocked the bot, read users.telegram_id for the informational audience.
-- It cannot: create campaigns, edit drafts, touch payments, Premium, plans or any other table.

CREATE ROLE gamenight_broadcast_worker LOGIN PASSWORD 'replace-with-long-random-password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 3;

GRANT CONNECT ON DATABASE gnh_supabase TO gamenight_broadcast_worker;
GRANT USAGE ON SCHEMA public TO gamenight_broadcast_worker;

GRANT SELECT, UPDATE ON bot_broadcast_deliveries TO gamenight_broadcast_worker;
GRANT SELECT, UPDATE ON bot_broadcast_campaigns TO gamenight_broadcast_worker;
GRANT SELECT, INSERT, UPDATE ON bot_broadcast_contacts TO gamenight_broadcast_worker;
GRANT SELECT (telegram_id) ON users TO gamenight_broadcast_worker;

ALTER ROLE gamenight_broadcast_worker SET statement_timeout = '15s';
ALTER ROLE gamenight_broadcast_worker SET idle_in_transaction_session_timeout = '60s';
