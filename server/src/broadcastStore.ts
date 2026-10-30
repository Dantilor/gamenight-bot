import { getConnection, initDb } from './db.js';
import { redact } from './log.js';
import type { SqlConnection, SqlQuery } from './premiumReader.js';

export type Audience = 'notify' | 'ads';
export type DraftStep = 'idle' | 'text' | 'photo' | 'confirm';

export type BroadcastDraft = {
  adminId: number;
  step: DraftStep;
  bodyHtml: string;
  photoFileId: string | null;
  includeButton: boolean;
  audience: Audience;
  confirmToken: string | null;
};

export type QueueResult =
  | { ok: true; id: number; recipients: number; duplicate: boolean }
  | { ok: false; reason: 'mismatch' | 'empty' | 'no-text' | 'busy' | 'missing' };

export type ClaimedDelivery = {
  deliveryId: number;
  campaignId: number;
  telegramId: number;
  attemptCount: number;
  bodyHtml: string;
  photoFileId: string | null;
  includeButton: boolean;
};

export type BroadcastStats = {
  pending: number;
  sent: number;
  blocked: number;
  failed: number;
  queuedCampaigns: number;
  runningCampaigns: number;
};

export type BroadcastStore = {
  tablesReady(): Promise<boolean>;
  touchContact(telegramId: number, chatId: number): Promise<void>;
  setNotifyOptOut(telegramId: number, chatId: number, optedOut: boolean): Promise<void>;
  setAdsOptIn(telegramId: number, chatId: number, optedIn: boolean): Promise<void>;
  markContactBlocked(telegramId: number): Promise<void>;
  countRecipients(audience: Audience): Promise<number>;
  getDraft(adminId: number): Promise<BroadcastDraft>;
  saveDraft(draft: BroadcastDraft): Promise<void>;
  queueTest(adminId: number, draft: BroadcastDraft): Promise<QueueResult>;
  queueMass(adminId: number, token: string): Promise<QueueResult>;
  stopActive(adminId: number): Promise<number>;
  stats(adminId: number): Promise<BroadcastStats>;
  releaseStaleSending(): Promise<number>;
  claimNext(maxAttempts: number): Promise<ClaimedDelivery | null>;
  campaignIsStopped(campaignId: number): Promise<boolean>;
  releaseClaim(deliveryId: number): Promise<void>;
  markSent(deliveryId: number, messageId: number): Promise<boolean>;
  markRetry(deliveryId: number, reason: string): Promise<void>;
  markFailed(deliveryId: number, reason: string): Promise<void>;
  markDeliveryBlocked(deliveryId: number, telegramId: number, reason: string): Promise<void>;
  finishCampaignIfDone(campaignId: number): Promise<void>;
};

type IdRow = { id: string | number };
type CountRow = { count: string | number };
type DraftRow = {
  admin_id: string | number;
  step: DraftStep;
  body_html: string;
  photo_file_id: string | null;
  include_button: boolean;
  audience: Audience;
  confirm_token: string | null;
};
type ClaimRow = {
  id: string | number;
  campaign_id: string | number;
  telegram_id: string | number;
  attempt_count: string | number;
  body_html: string;
  photo_file_id: string | null;
  include_button: boolean;
};

function asNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error('unexpected database id');
  return parsed;
}

function asCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function emptyDraft(adminId: number): BroadcastDraft {
  return {
    adminId,
    step: 'idle',
    bodyHtml: '',
    photoFileId: null,
    includeButton: true,
    audience: 'notify',
    confirmToken: null,
  };
}

function mapDraft(row: DraftRow): BroadcastDraft {
  return {
    adminId: asNumber(row.admin_id),
    step: row.step,
    bodyHtml: row.body_html ?? '',
    photoFileId: row.photo_file_id,
    includeButton: row.include_button,
    audience: row.audience,
    confirmToken: row.confirm_token,
  };
}

export function createBroadcastStore(connection: SqlConnection): BroadcastStore {
  const query = connection.query;

  return {
    async tablesReady() {
      const result = await query<{ name: string | null }>(
        `SELECT to_regclass('public.bot_broadcast_contacts') AS name`
      );
      return Boolean(result.rows[0]?.name);
    },
    async touchContact(telegramId, chatId) {
      await query(
        `INSERT INTO bot_broadcast_contacts (telegram_id, chat_id)
         VALUES ($1::bigint, $2::bigint)
         ON CONFLICT (telegram_id) DO UPDATE
           SET chat_id = EXCLUDED.chat_id, updated_at = now()`,
        [telegramId, chatId]
      );
    },
    async setNotifyOptOut(telegramId, chatId, optedOut) {
      await query(
        `INSERT INTO bot_broadcast_contacts (telegram_id, chat_id, notify_opt_out)
         VALUES ($1::bigint, $2::bigint, $3::boolean)
         ON CONFLICT (telegram_id) DO UPDATE
           SET chat_id = EXCLUDED.chat_id, notify_opt_out = EXCLUDED.notify_opt_out, updated_at = now()`,
        [telegramId, chatId, optedOut]
      );
    },
    async setAdsOptIn(telegramId, chatId, optedIn) {
      await query(
        `INSERT INTO bot_broadcast_contacts (telegram_id, chat_id, ads_opt_in)
         VALUES ($1::bigint, $2::bigint, $3::boolean)
         ON CONFLICT (telegram_id) DO UPDATE
           SET chat_id = EXCLUDED.chat_id, ads_opt_in = EXCLUDED.ads_opt_in, updated_at = now()`,
        [telegramId, chatId, optedIn]
      );
    },
    async markContactBlocked(telegramId) {
      await query(blockedContactSql, [telegramId]);
    },
    async countRecipients(audience) {
      const source = audienceSource(audience);
      if (!source) return 0;
      const result = await query<CountRow>(`SELECT count(*)::int AS count ${source.from}`);
      return asCount(result.rows[0]?.count);
    },
    async getDraft(adminId) {
      const result = await query<DraftRow>(`SELECT * FROM bot_broadcast_drafts WHERE admin_id = $1::bigint`, [adminId]);
      const row = result.rows[0];
      return row ? mapDraft(row) : emptyDraft(adminId);
    },
    async saveDraft(draft) {
      await query(
        `INSERT INTO bot_broadcast_drafts
           (admin_id, step, body_html, photo_file_id, include_button, audience, confirm_token)
         VALUES ($1::bigint, $2, $3, $4, $5::boolean, $6, $7)
         ON CONFLICT (admin_id) DO UPDATE SET
           step = EXCLUDED.step,
           body_html = EXCLUDED.body_html,
           photo_file_id = EXCLUDED.photo_file_id,
           include_button = EXCLUDED.include_button,
           audience = EXCLUDED.audience,
           confirm_token = EXCLUDED.confirm_token,
           updated_at = now()`,
        [draft.adminId, draft.step, draft.bodyHtml, draft.photoFileId, draft.includeButton, draft.audience, draft.confirmToken]
      );
    },
    async queueTest(adminId, draft) {
      if (!draft.bodyHtml.trim()) return { ok: false, reason: 'no-text' };
      return connection.withTransaction((tx) => insertTest(tx, adminId, draft));
    },
    async queueMass(adminId, token) {
      return connection.withTransaction((tx) => insertMass(tx, adminId, token));
    },
    async stopActive(adminId) {
      const result = await query(
        `UPDATE bot_broadcast_campaigns
         SET status = 'stopped', finished_at = now(), updated_at = now()
         WHERE admin_id = $1::bigint AND status IN ('queued', 'running')`,
        [adminId]
      );
      return result.rowCount;
    },
    async stats(adminId) {
      const deliveries = await query<BroadcastStats & CountRow>(
        `SELECT
           count(*) FILTER (WHERE d.status = 'pending')::int AS pending,
           count(*) FILTER (WHERE d.status = 'sent')::int AS sent,
           count(*) FILTER (WHERE d.status = 'blocked')::int AS blocked,
           count(*) FILTER (WHERE d.status = 'failed')::int AS failed
         FROM bot_broadcast_deliveries d
         JOIN bot_broadcast_campaigns c ON c.id = d.campaign_id
         WHERE c.admin_id = $1::bigint`,
        [adminId]
      );
      const campaigns = await query<{ queued: string | number; running: string | number }>(
        `SELECT
           count(*) FILTER (WHERE status = 'queued')::int AS queued,
           count(*) FILTER (WHERE status = 'running')::int AS running
         FROM bot_broadcast_campaigns
         WHERE admin_id = $1::bigint`,
        [adminId]
      );
      const row = deliveries.rows[0] as unknown as Record<string, unknown> | undefined;
      return {
        pending: asCount(row?.pending),
        sent: asCount(row?.sent),
        blocked: asCount(row?.blocked),
        failed: asCount(row?.failed),
        queuedCampaigns: asCount(campaigns.rows[0]?.queued),
        runningCampaigns: asCount(campaigns.rows[0]?.running),
      };
    },
    async releaseStaleSending() {
      const result = await query(
        `UPDATE bot_broadcast_deliveries
         SET status = 'pending', updated_at = now()
         WHERE status = 'sending'
           AND telegram_message_id IS NULL
           AND updated_at < now() - interval '2 minutes'`
      );
      return result.rowCount;
    },
    async claimNext(maxAttempts) {
      return connection.withTransaction((tx) => claimOne(tx, maxAttempts));
    },
    async campaignIsStopped(campaignId) {
      const result = await query<{ status: string }>(`SELECT status FROM bot_broadcast_campaigns WHERE id = $1::bigint`, [campaignId]);
      return result.rows[0]?.status === 'stopped';
    },
    async releaseClaim(deliveryId) {
      await query(
        `UPDATE bot_broadcast_deliveries
         SET status = 'pending', attempt_count = GREATEST(attempt_count - 1, 0), updated_at = now()
         WHERE id = $1::bigint AND status = 'sending' AND telegram_message_id IS NULL`,
        [deliveryId]
      );
    },
    async markSent(deliveryId, messageId) {
      if (!Number.isInteger(messageId) || messageId <= 0) return false;
      const result = await query(
        `UPDATE bot_broadcast_deliveries
         SET status = 'sent', telegram_message_id = $2::bigint, sent_at = now(), updated_at = now(), last_error = NULL
         WHERE id = $1::bigint AND status = 'sending' AND telegram_message_id IS NULL`,
        [deliveryId, messageId]
      );
      return result.rowCount === 1;
    },
    async markRetry(deliveryId, reason) {
      await query(
        `UPDATE bot_broadcast_deliveries
         SET status = 'pending', last_error = $2, updated_at = now()
         WHERE id = $1::bigint AND status = 'sending' AND telegram_message_id IS NULL`,
        [deliveryId, reason.slice(0, 500)]
      );
    },
    async markFailed(deliveryId, reason) {
      await query(
        `UPDATE bot_broadcast_deliveries
         SET status = 'failed', last_error = $2, updated_at = now()
         WHERE id = $1::bigint AND status = 'sending' AND telegram_message_id IS NULL`,
        [deliveryId, reason.slice(0, 500)]
      );
    },
    async markDeliveryBlocked(deliveryId, telegramId, reason) {
      await connection.withTransaction(async (tx) => {
        await tx(
          `UPDATE bot_broadcast_deliveries
           SET status = 'blocked', last_error = $2, updated_at = now()
           WHERE id = $1::bigint AND telegram_message_id IS NULL`,
          [deliveryId, reason.slice(0, 500)]
        );
        await tx(blockedContactSql, [telegramId]);
      });
    },
    async finishCampaignIfDone(campaignId) {
      await query(
        `UPDATE bot_broadcast_campaigns c
         SET status = 'completed', finished_at = now(), updated_at = now()
         WHERE c.id = $1::bigint
           AND c.status IN ('queued', 'running')
           AND NOT EXISTS (
             SELECT 1 FROM bot_broadcast_deliveries d
             WHERE d.campaign_id = c.id AND d.status IN ('pending', 'sending')
           )`,
        [campaignId]
      );
    },
  };
}

const blockedContactSql = `INSERT INTO bot_broadcast_contacts (telegram_id, chat_id, blocked_at)
  VALUES ($1::bigint, $1::bigint, now())
  ON CONFLICT (telegram_id) DO UPDATE
    SET blocked_at = now(), updated_at = now()`;

function audienceSource(audience: string): { idColumn: string; from: string } | null {
  if (audience === 'ads') {
    return {
      idColumn: 'c.telegram_id',
      from: `FROM bot_broadcast_contacts c
        WHERE c.ads_opt_in AND NOT c.notify_opt_out AND c.blocked_at IS NULL`,
    };
  }
  if (audience !== 'notify') return null;
  return {
    idColumn: 'u.telegram_id',
    from: `FROM users u
      WHERE NOT EXISTS (
        SELECT 1 FROM bot_broadcast_contacts c
        WHERE c.telegram_id = u.telegram_id
          AND (c.notify_opt_out OR c.blocked_at IS NOT NULL)
      )`,
  };
}

async function insertTest(query: SqlQuery, adminId: number, draft: BroadcastDraft): Promise<QueueResult> {
  const active = await query<IdRow>(
    `SELECT id FROM bot_broadcast_campaigns
     WHERE admin_id = $1::bigint AND kind = 'test' AND status IN ('queued', 'running')
     LIMIT 1`,
    [adminId]
  );
  const existing = active.rows[0];
  if (existing) return { ok: true, id: asNumber(existing.id), recipients: 1, duplicate: true };
  const created = await query<IdRow>(
    `INSERT INTO bot_broadcast_campaigns
       (admin_id, kind, audience, body_html, photo_file_id, include_button, status, recipient_count)
     VALUES ($1::bigint, 'test', 'notify', $2, $3, $4::boolean, 'queued', 1)
     RETURNING id`,
    [adminId, draft.bodyHtml, draft.photoFileId, draft.includeButton]
  );
  const id = asNumber(created.rows[0]?.id);
  await query(
    `INSERT INTO bot_broadcast_deliveries (campaign_id, telegram_id, status)
     VALUES ($1::bigint, $2::bigint, 'pending')`,
    [id, adminId]
  );
  return { ok: true, id, recipients: 1, duplicate: false };
}

async function insertMass(query: SqlQuery, adminId: number, token: string): Promise<QueueResult> {
  const existing = await query<IdRow>(`SELECT id FROM bot_broadcast_campaigns WHERE confirm_token = $1`, [token]);
  if (existing.rows[0]) {
    const id = asNumber(existing.rows[0].id);
    const count = await query<CountRow>(
      `SELECT count(*)::int AS count FROM bot_broadcast_deliveries WHERE campaign_id = $1::bigint`,
      [id]
    );
    return { ok: true, id, recipients: asCount(count.rows[0]?.count), duplicate: true };
  }
  const busy = await query<IdRow>(
    `SELECT id FROM bot_broadcast_campaigns
     WHERE admin_id = $1::bigint AND kind = 'mass' AND status IN ('queued', 'running')
     LIMIT 1`,
    [adminId]
  );
  if (busy.rows[0]) return { ok: false, reason: 'busy' };
  const draftResult = await query<DraftRow>(
    `SELECT * FROM bot_broadcast_drafts WHERE admin_id = $1::bigint FOR UPDATE`,
    [adminId]
  );
  const draft = draftResult.rows[0];
  if (!draft || draft.confirm_token !== token || draft.step !== 'confirm') return { ok: false, reason: 'mismatch' };
  if (!draft.body_html.trim()) return { ok: false, reason: 'no-text' };
  const source = audienceSource(draft.audience);
  if (!source) return { ok: false, reason: 'empty' };
  const recipients = await query<CountRow>(`SELECT count(*)::int AS count ${source.from}`);
  const count = asCount(recipients.rows[0]?.count);
  if (count === 0) return { ok: false, reason: 'empty' };
  const created = await query<IdRow>(
    `INSERT INTO bot_broadcast_campaigns
       (admin_id, kind, audience, body_html, photo_file_id, include_button, status, confirm_token, recipient_count)
     VALUES ($1::bigint, 'mass', $2, $3, $4, $5::boolean, 'queued', $6, $7::int)
     RETURNING id`,
    [adminId, draft.audience, draft.body_html, draft.photo_file_id, draft.include_button, token, count]
  );
  const id = asNumber(created.rows[0]?.id);
  await query(
    `INSERT INTO bot_broadcast_deliveries (campaign_id, telegram_id, status)
     SELECT $1::bigint, ${source.idColumn}, 'pending'
     ${source.from}`,
    [id]
  );
  await query(
    `UPDATE bot_broadcast_drafts
     SET step = 'idle', confirm_token = NULL, updated_at = now()
     WHERE admin_id = $1::bigint`,
    [adminId]
  );
  return { ok: true, id, recipients: count, duplicate: false };
}

async function claimOne(query: SqlQuery, maxAttempts: number): Promise<ClaimedDelivery | null> {
  const result = await query<ClaimRow>(
    `UPDATE bot_broadcast_deliveries d
     SET status = 'sending', attempt_count = d.attempt_count + 1, updated_at = now()
     WHERE d.id = (
       SELECT d2.id
       FROM bot_broadcast_deliveries d2
       JOIN bot_broadcast_campaigns c ON c.id = d2.campaign_id
       WHERE d2.status = 'pending'
         AND d2.attempt_count < $1::int
         AND c.status IN ('queued', 'running')
       ORDER BY d2.id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING d.id, d.campaign_id, d.telegram_id, d.attempt_count,
       (SELECT body_html FROM bot_broadcast_campaigns WHERE id = d.campaign_id) AS body_html,
       (SELECT photo_file_id FROM bot_broadcast_campaigns WHERE id = d.campaign_id) AS photo_file_id,
       (SELECT include_button FROM bot_broadcast_campaigns WHERE id = d.campaign_id) AS include_button`,
    [maxAttempts]
  );
  const row = result.rows[0];
  if (!row) return null;
  await query(
    `UPDATE bot_broadcast_campaigns
     SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
     WHERE id = $1::bigint AND status = 'queued'`,
    [row.campaign_id]
  );
  return {
    deliveryId: asNumber(row.id),
    campaignId: asNumber(row.campaign_id),
    telegramId: asNumber(row.telegram_id),
    attemptCount: asNumber(row.attempt_count),
    bodyHtml: row.body_html,
    photoFileId: row.photo_file_id,
    includeButton: row.include_button,
  };
}

export async function resolveBroadcastStore(databaseUrl: string, injected?: BroadcastStore | null): Promise<BroadcastStore | null> {
  if (injected) return injected;
  if (!databaseUrl) return null;
  try {
    if (!getConnection()) await initDb(process.env);
  } catch (error) {
    console.error('[broadcast] database is unavailable', redact(error));
    return null;
  }
  const connection = getConnection();
  return connection ? createBroadcastStore(connection) : null;
}
