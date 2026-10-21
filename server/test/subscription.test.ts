import assert from 'node:assert/strict';
import test from 'node:test';
import { readMigrationSql } from '../src/migrationSql.js';
import { createPremiumReader, type PremiumReader, type SqlConnection, type SqlQuery } from '../src/premiumReader.js';
import { classifySendError, retryDelayMs, runSubscriptionExpiryJob, type ExpiryNotifier } from '../src/subscriptionJob.js';

const SCHEMA = `
CREATE TABLE users (
  telegram_id BIGINT PRIMARY KEY,
  created_at TIMESTAMP DEFAULT now()
);
CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  plan_id TEXT,
  title TEXT NOT NULL,
  price_rub INTEGER NOT NULL,
  duration_days INTEGER NOT NULL,
  is_active BOOLEAN DEFAULT true
);
CREATE TABLE subscriptions (
  telegram_id BIGINT REFERENCES users(telegram_id),
  plan_id TEXT NOT NULL,
  active_until TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT now(),
  PRIMARY KEY (telegram_id, plan_id)
);
INSERT INTO plans (id, plan_id, title, price_rub, duration_days, is_active) VALUES
  ('premium_1m', 'premium_1m', 'Premium на 1 месяц', 259, 30, true),
  ('premium_3m', 'premium_3m', 'Premium на 3 месяца', 399, 90, true),
  ('premium_lifetime', 'premium_lifetime', 'Premium навсегда', 990, 36500, true),
  ('premium_custom', 'premium_custom', 'Custom', 990, 36500, true);
`;

type QueryTarget = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number; affectedRows?: number }> };

function asQuery(target: QueryTarget): SqlQuery {
  return async (sql, params) => {
    const result = await target.query(sql, params);
    return {
      rows: result.rows as Record<string, unknown>[],
      rowCount: result.rowCount ?? result.affectedRows ?? result.rows.length,
    };
  };
}

async function withDb(fn: (ctx: { query: SqlQuery; reader: PremiumReader; raw: QueryTarget }) => Promise<void>): Promise<void> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  await pg.exec("SET TIME ZONE 'UTC'");
  await pg.exec(SCHEMA);
  await pg.exec(readMigrationSql());
  const connection: SqlConnection = {
    query: asQuery(pg),
    withTransaction: (callback) => pg.transaction(async (tx) => callback(asQuery(tx))),
  };
  try {
    await fn({ query: connection.query, reader: createPremiumReader(connection), raw: pg });
  } finally {
    await pg.close();
  }
}

async function addSubscription(query: SqlQuery, telegramId: number, planId: string, days: number): Promise<void> {
  await query('INSERT INTO users (telegram_id) VALUES ($1::bigint) ON CONFLICT DO NOTHING', [telegramId]);
  await query(
    `INSERT INTO subscriptions (telegram_id, plan_id, active_until)
     VALUES ($1::bigint, $2, now() + ($3::int || ' days')::interval)
     ON CONFLICT (telegram_id, plan_id) DO UPDATE SET active_until = EXCLUDED.active_until`,
    [telegramId, planId, days]
  );
}

const quiet = { enabled: true, minIntervalMs: 0, maxTelegramAttempts: 1, sleep: async () => undefined };

test('disabled notifications do not read premium data or send messages', async () => {
  let touched = false;
  const reader = {
    async tablesReady() {
      touched = true;
      return true;
    },
  } as PremiumReader;
  const notifier: ExpiryNotifier = {
    async send() {
      touched = true;
      return 1;
    },
  };
  const report = await runSubscriptionExpiryJob(reader, notifier, { enabled: false });
  assert.equal(report.disabled, true);
  assert.equal(report.sent, 0);
  assert.equal(touched, false);
});

test('historical expirations are stored once and are not sent', async () => {
  await withDb(async ({ query, reader }) => {
    await addSubscription(query, 101, 'premium_1m', -3);
    const calls: number[] = [];
    const report = await runSubscriptionExpiryJob(reader, {
      async send(id) {
        calls.push(id);
        return 10;
      },
    }, quiet);
    assert.equal(report.baselineCreated, true);
    assert.equal(report.historicalSkipped, 1);
    assert.equal(report.sent, 0);
    assert.deepEqual(calls, []);
    const notices = await query<{ status: string; telegram_message_id: number | null }>(
      'SELECT status, telegram_message_id FROM bot_subscription_expiry_notices WHERE telegram_id = 101'
    );
    assert.equal(notices.rows[0]?.status, 'skipped_historical');
    assert.equal(notices.rows[0]?.telegram_message_id, null);
    const again = await runSubscriptionExpiryJob(reader, {
      async send(id) {
        calls.push(id);
        return 10;
      },
    }, quiet);
    assert.equal(again.sent, 0);
    assert.deepEqual(calls, []);
  });
});

test('a later real expiry is sent once and a repeated run does not send again', async () => {
  await withDb(async ({ query, reader }) => {
    await runSubscriptionExpiryJob(reader, { async send() { return 1; } }, quiet);
    await addSubscription(query, 202, 'premium_1m', -1);
    const calls: number[] = [];
    const notifier: ExpiryNotifier = {
      async send(id) {
        calls.push(id);
        return 77;
      },
    };
    const first = await runSubscriptionExpiryJob(reader, notifier, quiet);
    assert.equal(first.sent, 1);
    assert.deepEqual(calls, [202]);
    const saved = await query<{ status: string; telegram_message_id: string | number | null }>(
      'SELECT status, telegram_message_id FROM bot_subscription_expiry_notices WHERE telegram_id = 202'
    );
    assert.equal(saved.rows[0]?.status, 'sent');
    assert.equal(Number(saved.rows[0]?.telegram_message_id), 77);
    const second = await runSubscriptionExpiryJob(reader, notifier, quiet);
    assert.equal(second.sent, 0);
    assert.deepEqual(calls, [202]);
  });
});

test('active, renewed, and lifetime subscriptions are not expiry notifications', async () => {
  await withDb(async ({ query, reader }) => {
    await runSubscriptionExpiryJob(reader, { async send() { return 1; } }, quiet);
    await addSubscription(query, 301, 'premium_1m', 20);
    await addSubscription(query, 302, 'premium_1m', -15);
    await addSubscription(query, 302, 'premium_3m', 40);
    await addSubscription(query, 303, 'premium_lifetime', -2);
    await addSubscription(query, 304, 'premium_custom', -2);
    const calls: number[] = [];
    const report = await runSubscriptionExpiryJob(reader, {
      async send(id) {
        calls.push(id);
        return 5;
      },
    }, quiet);
    assert.equal(report.sent, 0);
    assert.deepEqual(calls, []);
  });
});

test('a renewal that lands before the message is sent cancels the notice', async () => {
  await withDb(async ({ query, reader, raw }) => {
    await runSubscriptionExpiryJob(reader, { async send() { return 1; } }, quiet);
    await addSubscription(query, 401, 'premium_1m', -1);
    const wrapped: PremiumReader = {
      ...reader,
      async claim(telegramId, maxAttempts) {
        const claim = await reader.claim(telegramId, maxAttempts);
        await raw.query("UPDATE subscriptions SET active_until = now() + interval '30 days' WHERE telegram_id = $1", [telegramId]);
        return claim;
      },
    };
    const calls: number[] = [];
    const report = await runSubscriptionExpiryJob(wrapped, {
      async send(id) {
        calls.push(id);
        return 8;
      },
    }, quiet);
    assert.deepEqual(calls, []);
    assert.equal(report.sent, 0);
    assert.equal(report.superseded, 1);
    const notices = await query<{ status: string }>('SELECT status FROM bot_subscription_expiry_notices WHERE telegram_id = 401');
    assert.equal(notices.rows[0]?.status, 'superseded');
  });
});

test('an old expiry does not block a notice for a newer expired period', async () => {
  await withDb(async ({ query, reader }) => {
    await addSubscription(query, 501, 'premium_1m', -30);
    await runSubscriptionExpiryJob(reader, { async send() { throw new Error('historical'); } }, quiet);
    await query("UPDATE subscriptions SET active_until = now() + interval '10 days' WHERE telegram_id = 501");
    await query("UPDATE subscriptions SET active_until = now() - interval '1 minute' WHERE telegram_id = 501");
    const calls: number[] = [];
    const report = await runSubscriptionExpiryJob(reader, {
      async send(id) {
        calls.push(id);
        return 15;
      },
    }, quiet);
    assert.deepEqual(calls, [501]);
    assert.equal(report.sent, 1);
  });
});

test('a failed Telegram send is not stored as delivered and is not repeated immediately', async () => {
  await withDb(async ({ query, reader }) => {
    await runSubscriptionExpiryJob(reader, { async send() { return 1; } }, quiet);
    await addSubscription(query, 601, 'premium_3m', -1);
    let confirmed = false;
    const calls: number[] = [];
    const failing: ExpiryNotifier = {
      async send(id) {
        calls.push(id);
        throw new Error('network down');
      },
    };
    const readerGuard: PremiumReader = {
      ...reader,
      async markSent(id, messageId) {
        assert.equal(confirmed, true);
        await reader.markSent(id, messageId);
      },
    };
    const failed = await runSubscriptionExpiryJob(readerGuard, failing, quiet);
    assert.equal(failed.sent, 0);
    assert.equal(failed.failed, 1);
    assert.deepEqual(calls, [601]);
    const pending = await query<{ status: string; telegram_message_id: number | null }>(
      'SELECT status, telegram_message_id FROM bot_subscription_expiry_notices WHERE telegram_id = 601'
    );
    assert.equal(pending.rows[0]?.status, 'pending');
    assert.equal(pending.rows[0]?.telegram_message_id, null);
    const immediate = await runSubscriptionExpiryJob(readerGuard, failing, quiet);
    assert.equal(immediate.sent, 0);
    assert.deepEqual(calls, [601]);
    await query("UPDATE bot_subscription_expiry_notices SET updated_at = now() - interval '5 minutes' WHERE telegram_id = 601");
    const recovered = await runSubscriptionExpiryJob(reader, {
      async send(id) {
        calls.push(id);
        confirmed = true;
        return 91;
      },
    }, quiet);
    assert.equal(recovered.sent, 1);
    assert.deepEqual(calls, [601, 601]);
    const sent = await query<{ status: string; telegram_message_id: string | number }>(
      'SELECT status, telegram_message_id FROM bot_subscription_expiry_notices WHERE telegram_id = 601'
    );
    assert.equal(sent.rows[0]?.status, 'sent');
    assert.equal(Number(sent.rows[0]?.telegram_message_id), 91);
  });
});

test('a blocked user is recorded and is not retried', async () => {
  await withDb(async ({ query, reader }) => {
    await runSubscriptionExpiryJob(reader, { async send() { return 1; } }, quiet);
    await addSubscription(query, 701, 'premium_1m', -1);
    const calls: number[] = [];
    const report = await runSubscriptionExpiryJob(reader, {
      async send(id) {
        calls.push(id);
        throw { response: { error_code: 403, description: 'Forbidden: bot was blocked by the user' } };
      },
    }, quiet);
    assert.equal(report.blocked, 1);
    assert.equal(report.sent, 0);
    await runSubscriptionExpiryJob(reader, {
      async send(id) {
        calls.push(id);
        return 1;
      },
    }, quiet);
    assert.deepEqual(calls, [701]);
    const notices = await query<{ status: string }>('SELECT status FROM bot_subscription_expiry_notices WHERE telegram_id = 701');
    assert.equal(notices.rows[0]?.status, 'blocked');
  });
});

test('Telegram errors classify blocked users and retry delays', () => {
  assert.equal(classifySendError({ response: { error_code: 403, description: 'Forbidden: bot was blocked by the user' } }), 'blocked');
  assert.equal(classifySendError({ response: { error_code: 400, description: 'Bad Request: chat not found' } }), 'blocked');
  assert.equal(classifySendError(new Error('socket hang up')), 'retry');
  assert.equal(retryDelayMs({ response: { error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 2 } } }, 1), 2000);
});
