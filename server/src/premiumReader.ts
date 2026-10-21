import { LIFETIME_DURATION_DAYS } from './plans.js';

export const LIFETIME_PLAN_ID = 'premium_lifetime';
export const MAX_DELIVERY_ATTEMPTS = 5;

export type SqlResult<T> = { rows: T[]; rowCount: number };
export type SqlQuery = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<SqlResult<T>>;

export type SqlConnection = {
  query: SqlQuery;
  withTransaction: <T>(fn: (query: SqlQuery) => Promise<T>) => Promise<T>;
};

export type ClaimedNotice = {
  id: number;
  telegramId: number;
  attemptCount: number;
};

export type PremiumReader = {
  tablesReady(): Promise<boolean>;
  ensureBaseline(): Promise<{ created: boolean; skipped: number }>;
  listCandidateIds(limit: number, maxAttempts: number): Promise<number[]>;
  claim(telegramId: number, maxAttempts: number): Promise<ClaimedNotice | null>;
  stillExpired(noticeId: number): Promise<boolean>;
  markSent(noticeId: number, messageId: number): Promise<void>;
  markBlocked(noticeId: number, reason: string): Promise<void>;
  markFailed(noticeId: number, reason: string): Promise<void>;
  markSuperseded(noticeId: number): Promise<void>;
  markRetry(noticeId: number, reason: string): Promise<void>;
};

type IdRow = { telegram_id: string | number };
type NoticeRow = { id: string | number; telegram_id: string | number; attempt_count: string | number };
type ReadyRow = { notices: string | null; state: string | null };
type KeyRow = { key: string };

const LATEST = `
  SELECT DISTINCT ON (s.telegram_id)
    s.telegram_id,
    s.plan_id,
    s.active_until,
    p.duration_days
  FROM subscriptions s
  LEFT JOIN LATERAL (
    SELECT duration_days
    FROM plans
    WHERE plan_id = s.plan_id
    ORDER BY duration_days DESC
    LIMIT 1
  ) p ON true
`;

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function clipReason(reason: string): string {
  return reason.replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function createPremiumReader(connection: SqlConnection): PremiumReader {
  return {
    async tablesReady() {
      const result = await connection.query<ReadyRow>(
        `SELECT to_regclass('public.bot_subscription_expiry_notices') AS notices,
                to_regclass('public.bot_notification_state') AS state`
      );
      const row = result.rows[0];
      return Boolean(row?.notices && row?.state);
    },

    async ensureBaseline() {
      return connection.withTransaction(async (query) => {
        const flag = await query<KeyRow>(
          `INSERT INTO bot_notification_state (key, value, updated_at)
           VALUES ('expiry_baseline_initialized', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), now())
           ON CONFLICT (key) DO NOTHING
           RETURNING key`
        );
        if (flag.rows.length === 0) return { created: false, skipped: 0 };
        const skipped = await query(
          `INSERT INTO bot_subscription_expiry_notices (telegram_id, active_until, plan_id, status, attempt_count, updated_at)
           SELECT latest.telegram_id, latest.active_until, latest.plan_id, 'skipped_historical', 0, now()
           FROM (
             ${LATEST}
             ORDER BY s.telegram_id, s.active_until DESC
           ) latest
           WHERE latest.active_until <= now()
             AND latest.plan_id IS DISTINCT FROM $1
             AND COALESCE(latest.duration_days, 0) < $2::int
           ON CONFLICT (telegram_id, active_until) DO NOTHING
           RETURNING telegram_id`,
          [LIFETIME_PLAN_ID, LIFETIME_DURATION_DAYS]
        );
        return { created: true, skipped: skipped.rows.length };
      });
    },

    async listCandidateIds(limit, maxAttempts) {
      const result = await connection.query<IdRow>(
        `SELECT latest.telegram_id
         FROM (
           ${LATEST}
           ORDER BY s.telegram_id, s.active_until DESC
         ) latest
         WHERE latest.active_until <= now()
           AND latest.plan_id IS DISTINCT FROM $1
           AND COALESCE(latest.duration_days, 0) < $2::int
           AND NOT EXISTS (
             SELECT 1
             FROM bot_subscription_expiry_notices n
             WHERE n.telegram_id = latest.telegram_id
               AND n.active_until = latest.active_until
               AND (
                 n.status IN ('sent', 'blocked', 'failed', 'skipped_historical', 'superseded')
                 OR (n.status = 'pending' AND n.updated_at >= now() - make_interval(mins => 2))
                 OR (n.status = 'pending' AND n.attempt_count >= $3::int)
               )
           )
         ORDER BY latest.active_until ASC
         LIMIT $4::int`,
        [LIFETIME_PLAN_ID, LIFETIME_DURATION_DAYS, maxAttempts, limit]
      );
      return result.rows.flatMap((row) => {
        const id = asNumber(row.telegram_id);
        return id === null ? [] : [id];
      });
    },

    async claim(telegramId, maxAttempts) {
      const result = await connection.query<NoticeRow>(
        `WITH latest AS (
           ${LATEST}
           WHERE s.telegram_id = $1::bigint
           ORDER BY s.telegram_id, s.active_until DESC
         ),
         eligible AS (
           SELECT telegram_id, plan_id, active_until
           FROM latest
           WHERE active_until <= now()
             AND plan_id IS DISTINCT FROM $2
             AND COALESCE(duration_days, 0) < $3::int
         )
         INSERT INTO bot_subscription_expiry_notices (
           telegram_id, active_until, plan_id, status, attempt_count, updated_at
         )
         SELECT telegram_id, active_until, plan_id, 'pending', 1, now()
         FROM eligible
         ON CONFLICT (telegram_id, active_until) DO UPDATE
           SET status = 'pending',
               updated_at = now(),
               attempt_count = bot_subscription_expiry_notices.attempt_count + 1,
               last_error = NULL
           WHERE bot_subscription_expiry_notices.status = 'pending'
             AND bot_subscription_expiry_notices.updated_at < now() - make_interval(mins => 2)
             AND bot_subscription_expiry_notices.attempt_count < $4::int
         RETURNING id, telegram_id, attempt_count`,
        [telegramId, LIFETIME_PLAN_ID, LIFETIME_DURATION_DAYS, maxAttempts]
      );
      const row = result.rows[0];
      if (!row) return null;
      const id = asNumber(row.id);
      const claimedTelegramId = asNumber(row.telegram_id);
      const attemptCount = asNumber(row.attempt_count);
      if (id === null || claimedTelegramId === null || attemptCount === null) return null;
      return { id, telegramId: claimedTelegramId, attemptCount };
    },

    async stillExpired(noticeId) {
      const result = await connection.query(
        `SELECT n.id
         FROM bot_subscription_expiry_notices n
         JOIN LATERAL (
           SELECT s.plan_id, s.active_until, p.duration_days
           FROM subscriptions s
           LEFT JOIN LATERAL (
             SELECT duration_days
             FROM plans
             WHERE plan_id = s.plan_id
             ORDER BY duration_days DESC
             LIMIT 1
           ) p ON true
           WHERE s.telegram_id = n.telegram_id
           ORDER BY s.active_until DESC
           LIMIT 1
         ) latest ON true
         WHERE n.id = $1::bigint
           AND n.status = 'pending'
           AND latest.active_until = n.active_until
           AND latest.active_until <= now()
           AND latest.plan_id IS DISTINCT FROM $2
           AND COALESCE(latest.duration_days, 0) < $3::int`,
        [noticeId, LIFETIME_PLAN_ID, LIFETIME_DURATION_DAYS]
      );
      return result.rows.length > 0;
    },

    markSent(noticeId, messageId) {
      return mark(connection, noticeId, 'sent', messageId, null);
    },
    markBlocked(noticeId, reason) {
      return mark(connection, noticeId, 'blocked', null, reason);
    },
    markFailed(noticeId, reason) {
      return mark(connection, noticeId, 'failed', null, reason);
    },
    markSuperseded(noticeId) {
      return mark(connection, noticeId, 'superseded', null, null);
    },
    markRetry(noticeId, reason) {
      return mark(connection, noticeId, 'pending', null, reason);
    },
  };
}

async function mark(
  connection: SqlConnection,
  noticeId: number,
  status: 'sent' | 'blocked' | 'failed' | 'superseded' | 'pending',
  messageId: number | null,
  reason: string | null
): Promise<void> {
  const result = await connection.query(
    `UPDATE bot_subscription_expiry_notices
     SET status = $2,
         updated_at = now(),
         sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END,
         telegram_message_id = COALESCE($3::bigint, telegram_message_id),
         last_error = $4
     WHERE id = $1::bigint
       AND status = 'pending'
     RETURNING id`,
    [noticeId, status, messageId, reason ? clipReason(reason) : null]
  );
  if (result.rows.length === 0) {
    throw new Error(`notice ${noticeId} was not updated to ${status}`);
  }
}
