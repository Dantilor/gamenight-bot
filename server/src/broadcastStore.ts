import { isButtonMode, type ButtonMode } from './broadcastButtons.js';
import { evaluateMassSendGate } from './broadcastPresets.js';
import { getConnection, initDb } from './db.js';
import { redact } from './log.js';
import type { SqlConnection, SqlQuery } from './premiumReader.js';

export type Audience = 'notify' | 'ads';
export type DraftStep = 'idle' | 'text' | 'photo' | 'confirm';
export type CampaignKind = 'test' | 'mass';

export type BroadcastDraft = {
  adminId: number;
  step: DraftStep;
  bodyHtml: string;
  photoFileId: string | null;
  includeButton: boolean;
  buttonMode: ButtonMode;
  webUrl: string | null;
  audience: Audience;
  confirmToken: string | null;
};

export type QueueResult =
  | { ok: true; id: number; recipients: number; duplicate: boolean }
  | { ok: false; reason: 'mismatch' | 'empty' | 'no-text' | 'busy' | 'missing' | 'refused' };

export type ClaimedDelivery = {
  deliveryId: number;
  campaignId: number;
  telegramId: number;
  attemptCount: number;
  kind: CampaignKind;
  audience: Audience;
  bodyHtml: string;
  photoFileId: string | null;
  includeButton: boolean;
  buttonMode: ButtonMode;
  webUrl: string | null;
};

export type ClaimPolicy = {
  /** Queued campaigns older than this are left alone (running ones always resume). Null disables the limit. */
  maxQueuedAgeHours?: number | null;
  /** Mass deliveries are claimed only after a test of identical content reached the admin. */
  requireDeliveredTest?: boolean;
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
  /** With bodyHtml, people who already received this exact mass text are not counted. */
  countRecipients(audience: Audience, bodyHtml?: string): Promise<number>;
  getDraft(adminId: number): Promise<BroadcastDraft>;
  saveDraft(draft: BroadcastDraft): Promise<void>;
  queueTest(adminId: number, draft: BroadcastDraft): Promise<QueueResult>;
  queueMass(adminId: number, token: string): Promise<QueueResult>;
  stopActive(adminId: number): Promise<number>;
  stats(adminId: number): Promise<BroadcastStats>;
  /**
   * A row left in 'sending' by a crash may already be in the recipient's chat. It is marked
   * failed (outcome unknown) instead of being sent again, so a restart never duplicates.
   */
  failStaleSending(): Promise<number>;
  claimNext(maxAttempts: number, kind?: CampaignKind, policy?: ClaimPolicy): Promise<ClaimedDelivery | null>;
  /** True when a test copy of exactly this content has reached the admin (status sent). */
  hasDeliveredTest(adminId: number, draft: BroadcastDraft): Promise<boolean>;
  /** Missing migrations and privileges, in plain words. Empty means the worker can run. */
  schemaProblems(): Promise<string[]>;
  queueDepth(kind?: CampaignKind): Promise<number>;
  /** Re-check consent / opt-out / block right before a real send. */
  isStillEligible(telegramId: number, audience: Audience): Promise<boolean>;
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
  button_mode?: string | null;
  web_url?: string | null;
  audience: Audience;
  confirm_token: string | null;
};
type ClaimRow = {
  id: string | number;
  campaign_id: string | number;
  telegram_id: string | number;
  attempt_count: string | number;
  kind: string;
  audience: string;
  body_html: string;
  photo_file_id: string | null;
  include_button: boolean;
  button_mode: string | null;
  web_url: string | null;
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
    buttonMode: 'miniapp',
    webUrl: null,
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
    buttonMode: isButtonMode(row.button_mode) ? row.button_mode : 'miniapp',
    webUrl: row.web_url ?? null,
    audience: row.audience,
    confirmToken: row.confirm_token,
  };
}

export function createBroadcastStore(connection: SqlConnection): BroadcastStore {
  const query = connection.query;

  return {
    async tablesReady() {
      // Migration 002 creates the tables, migration 003 adds the per-campaign button columns.
      // pg_attribute, unlike information_schema, also shows columns of tables this role cannot read
      // (the worker role has no access to drafts).
      const result = await query<{ name: string | null; columns: string | number }>(
        `SELECT to_regclass('public.bot_broadcast_contacts') AS name,
                (SELECT count(*) FROM pg_attribute
                 WHERE attrelid IN (to_regclass('public.bot_broadcast_drafts'), to_regclass('public.bot_broadcast_campaigns'))
                   AND attname IN ('button_mode', 'web_url') AND NOT attisdropped)::int AS columns`
      );
      return Boolean(result.rows[0]?.name) && asCount(result.rows[0]?.columns) === 4;
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
    async countRecipients(audience, bodyHtml) {
      const source = audienceSource(audience);
      if (!source) return 0;
      const result =
        bodyHtml === undefined
          ? await query<CountRow>(`SELECT count(*)::int AS count ${source.from}`)
          : await query<CountRow>(`SELECT count(*)::int AS count ${source.from} ${notYetDeliveredSql(source.idColumn, '$1')}`, [bodyHtml]);
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
           (admin_id, step, body_html, photo_file_id, include_button, button_mode, web_url, audience, confirm_token)
         VALUES ($1::bigint, $2, $3, $4, $5::boolean, $6, $7, $8, $9)
         ON CONFLICT (admin_id) DO UPDATE SET
           step = EXCLUDED.step,
           body_html = EXCLUDED.body_html,
           photo_file_id = EXCLUDED.photo_file_id,
           include_button = EXCLUDED.include_button,
           button_mode = EXCLUDED.button_mode,
           web_url = EXCLUDED.web_url,
           audience = EXCLUDED.audience,
           confirm_token = EXCLUDED.confirm_token,
           updated_at = now()`,
        [
          draft.adminId,
          draft.step,
          draft.bodyHtml,
          draft.photoFileId,
          draft.includeButton,
          draft.buttonMode,
          draft.webUrl,
          draft.audience,
          draft.confirmToken,
        ]
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
    async failStaleSending() {
      const result = await query(
        `UPDATE bot_broadcast_deliveries
         SET status = 'failed',
             last_error = 'outcome unknown: worker stopped during the send; not resent to avoid a duplicate',
             updated_at = now()
         WHERE status = 'sending'
           AND telegram_message_id IS NULL
           AND updated_at < now() - interval '2 minutes'`
      );
      return result.rowCount;
    },
    async claimNext(maxAttempts, kind, policy) {
      return connection.withTransaction((tx) => claimOne(tx, maxAttempts, kind ?? null, policy ?? {}));
    },
    async hasDeliveredTest(adminId, draft) {
      const result = await query<{ ok: number }>(
        `SELECT 1 AS ok
         FROM bot_broadcast_campaigns t
         JOIN bot_broadcast_deliveries td ON td.campaign_id = t.id
         WHERE t.kind = 'test'
           AND t.admin_id = $1::bigint
           AND td.status = 'sent'
           AND t.body_html = $2::text
           AND t.photo_file_id IS NOT DISTINCT FROM $3::text
           AND t.include_button = $4::boolean
           AND t.button_mode = $5::text
           AND t.web_url IS NOT DISTINCT FROM $6::text
         LIMIT 1`,
        [adminId, draft.bodyHtml, draft.photoFileId, draft.includeButton, draft.buttonMode, draft.webUrl]
      );
      return result.rows.length > 0;
    },
    async schemaProblems() {
      const tables = await query<Record<string, boolean | number>>(
        `SELECT
           to_regclass('public.bot_broadcast_contacts') IS NOT NULL AS contacts,
           to_regclass('public.bot_broadcast_drafts') IS NOT NULL AS drafts,
           to_regclass('public.bot_broadcast_campaigns') IS NOT NULL AS campaigns,
           to_regclass('public.bot_broadcast_deliveries') IS NOT NULL AS deliveries,
           to_regclass('public.users') IS NOT NULL AS users,
           (SELECT count(*) FROM pg_attribute
            WHERE attrelid = to_regclass('public.bot_broadcast_campaigns')
              AND attname IN ('button_mode', 'web_url') AND NOT attisdropped)::int AS campaign_columns,
           (SELECT count(*) FROM pg_attribute
            WHERE attrelid = to_regclass('public.bot_broadcast_drafts')
              AND attname IN ('button_mode', 'web_url') AND NOT attisdropped)::int AS draft_columns`
      );
      const row = tables.rows[0] ?? {};
      const problems: string[] = [];
      for (const name of ['contacts', 'drafts', 'campaigns', 'deliveries']) {
        if (!row[name]) problems.push(`migration 002 missing: table bot_broadcast_${name}`);
      }
      if (!row.users) problems.push('table users is missing or not visible to this role');
      if (problems.length > 0) return problems;
      if (asCount(row.campaign_columns) !== 2 || asCount(row.draft_columns) !== 2) {
        problems.push('migration 003 missing: button_mode / web_url columns');
        return problems;
      }
      const needed: Array<[string, string]> = [
        ['bot_broadcast_deliveries', 'SELECT'],
        ['bot_broadcast_deliveries', 'UPDATE'],
        ['bot_broadcast_campaigns', 'SELECT'],
        ['bot_broadcast_campaigns', 'UPDATE'],
        ['bot_broadcast_contacts', 'SELECT'],
        ['bot_broadcast_contacts', 'INSERT'],
        ['bot_broadcast_contacts', 'UPDATE'],
      ];
      for (const [table, privilege] of needed) {
        const granted = await query<{ ok: boolean }>(`SELECT has_table_privilege($1::text, $2::text) AS ok`, [`public.${table}`, privilege]);
        if (!granted.rows[0]?.ok) problems.push(`privilege missing: ${privilege} on ${table}`);
      }
      const users = await query<{ ok: boolean }>(`SELECT has_column_privilege('public.users', 'telegram_id', 'SELECT') AS ok`);
      if (!users.rows[0]?.ok) problems.push('privilege missing: SELECT (telegram_id) on users');
      return problems;
    },
    async isStillEligible(telegramId, audience) {
      if (audience === 'ads') {
        const result = await query<{ ok: number }>(
          `SELECT 1 AS ok FROM bot_broadcast_contacts
           WHERE telegram_id = $1::bigint
             AND ads_opt_in
             AND NOT notify_opt_out
             AND blocked_at IS NULL
           LIMIT 1`,
          [telegramId]
        );
        return result.rows.length > 0;
      }
      if (audience !== 'notify') return false;
      const result = await query<{ ok: number }>(
        `SELECT 1 AS ok FROM users u
         WHERE u.telegram_id = $1::bigint
           AND NOT EXISTS (
             SELECT 1 FROM bot_broadcast_contacts c
             WHERE c.telegram_id = u.telegram_id
               AND (c.notify_opt_out OR c.blocked_at IS NOT NULL)
           )
         LIMIT 1`,
        [telegramId]
      );
      return result.rows.length > 0;
    },
    async queueDepth(kind) {
      const result = await query<CountRow>(
        `SELECT count(*)::int AS count
         FROM bot_broadcast_deliveries d
         JOIN bot_broadcast_campaigns c ON c.id = d.campaign_id
         WHERE d.status IN ('pending', 'sending')
           AND c.status IN ('queued', 'running')
           AND ($1::text IS NULL OR c.kind = $1::text)`,
        [kind ?? null]
      );
      return asCount(result.rows[0]?.count);
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

/**
 * Across campaigns: nobody who already received (or is being sent) this exact mass text
 * is queued again, even under a new confirmation token or after a stop and restart.
 */
function notYetDeliveredSql(idColumn: string, bodyParam: string): string {
  return `AND NOT EXISTS (
    SELECT 1 FROM bot_broadcast_deliveries pd
    JOIN bot_broadcast_campaigns pc ON pc.id = pd.campaign_id
    WHERE pc.kind = 'mass'
      AND pc.body_html = ${bodyParam}::text
      AND pd.telegram_id = ${idColumn}
      AND pd.status IN ('sent', 'sending')
  )`;
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
       (admin_id, kind, audience, body_html, photo_file_id, include_button, button_mode, web_url, status, recipient_count)
     VALUES ($1::bigint, 'test', $2, $3, $4, $5::boolean, $6, $7, 'queued', 1)
     RETURNING id`,
    [adminId, draft.audience, draft.bodyHtml, draft.photoFileId, draft.includeButton, draft.buttonMode, draft.webUrl]
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
  const gate = evaluateMassSendGate({ audience: draft.audience, bodyHtml: draft.body_html });
  if (!gate.ok) return { ok: false, reason: 'refused' };
  const source = audienceSource(draft.audience);
  if (!source) return { ok: false, reason: 'empty' };
  const recipients = await query<CountRow>(
    `SELECT count(*)::int AS count ${source.from} ${notYetDeliveredSql(source.idColumn, '$1')}`,
    [draft.body_html]
  );
  const count = asCount(recipients.rows[0]?.count);
  if (count === 0) return { ok: false, reason: 'empty' };
  const created = await query<IdRow>(
    `INSERT INTO bot_broadcast_campaigns
       (admin_id, kind, audience, body_html, photo_file_id, include_button, button_mode, web_url, status, confirm_token, recipient_count)
     VALUES ($1::bigint, 'mass', $2, $3, $4, $5::boolean, $6, $7, 'queued', $8, $9::int)
     RETURNING id`,
    [
      adminId,
      draft.audience,
      draft.body_html,
      draft.photo_file_id,
      draft.include_button,
      isButtonMode(draft.button_mode) ? draft.button_mode : 'miniapp',
      draft.web_url ?? null,
      token,
      count,
    ]
  );
  const id = asNumber(created.rows[0]?.id);
  await query(
    `INSERT INTO bot_broadcast_deliveries (campaign_id, telegram_id, status)
     SELECT $1::bigint, ${source.idColumn}, 'pending'
     ${source.from}
     ${notYetDeliveredSql(source.idColumn, '$2')}`,
    [id, draft.body_html]
  );
  await query(
    `UPDATE bot_broadcast_drafts
     SET step = 'idle', confirm_token = NULL, updated_at = now()
     WHERE admin_id = $1::bigint`,
    [adminId]
  );
  return { ok: true, id, recipients: count, duplicate: false };
}

async function claimOne(
  query: SqlQuery,
  maxAttempts: number,
  kindFilter: CampaignKind | null,
  policy: ClaimPolicy
): Promise<ClaimedDelivery | null> {
  const maxAge = policy.maxQueuedAgeHours ?? null;
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
         AND ($2::text IS NULL OR c.kind = $2::text)
         AND ($3::int IS NULL OR c.status = 'running' OR c.created_at >= now() - make_interval(hours => $3::int))
         AND (c.kind = 'test' OR NOT $4::boolean OR EXISTS (
           SELECT 1
           FROM bot_broadcast_campaigns t
           JOIN bot_broadcast_deliveries td ON td.campaign_id = t.id
           WHERE t.kind = 'test'
             AND t.admin_id = c.admin_id
             AND td.status = 'sent'
             AND t.body_html = c.body_html
             AND t.photo_file_id IS NOT DISTINCT FROM c.photo_file_id
             AND t.include_button = c.include_button
             AND t.button_mode = c.button_mode
             AND t.web_url IS NOT DISTINCT FROM c.web_url
         ))
       ORDER BY d2.id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING d.id, d.campaign_id, d.telegram_id, d.attempt_count,
       (SELECT kind FROM bot_broadcast_campaigns WHERE id = d.campaign_id) AS kind,
       (SELECT audience FROM bot_broadcast_campaigns WHERE id = d.campaign_id) AS audience,
       (SELECT body_html FROM bot_broadcast_campaigns WHERE id = d.campaign_id) AS body_html,
       (SELECT photo_file_id FROM bot_broadcast_campaigns WHERE id = d.campaign_id) AS photo_file_id,
       (SELECT include_button FROM bot_broadcast_campaigns WHERE id = d.campaign_id) AS include_button,
       (SELECT button_mode FROM bot_broadcast_campaigns WHERE id = d.campaign_id) AS button_mode,
       (SELECT web_url FROM bot_broadcast_campaigns WHERE id = d.campaign_id) AS web_url`,
    [maxAttempts, kindFilter, maxAge, policy.requireDeliveredTest ?? false]
  );
  const row = result.rows[0];
  if (!row) return null;
  await query(
    `UPDATE bot_broadcast_campaigns
     SET status = 'running', started_at = COALESCE(started_at, now()), updated_at = now()
     WHERE id = $1::bigint AND status = 'queued'`,
    [row.campaign_id]
  );
  const campaignKind: CampaignKind = row.kind === 'mass' ? 'mass' : 'test';
  const campaignAudience: Audience = row.audience === 'ads' ? 'ads' : 'notify';
  return {
    deliveryId: asNumber(row.id),
    campaignId: asNumber(row.campaign_id),
    telegramId: asNumber(row.telegram_id),
    attemptCount: asNumber(row.attempt_count),
    kind: campaignKind,
    audience: campaignAudience,
    bodyHtml: row.body_html,
    photoFileId: row.photo_file_id,
    includeButton: row.include_button,
    buttonMode: isButtonMode(row.button_mode) ? row.button_mode : 'miniapp',
    webUrl: row.web_url ?? null,
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
