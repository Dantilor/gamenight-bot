import { redact } from './log.js';
import type { PremiumReader } from './premiumReader.js';
import { MAX_DELIVERY_ATTEMPTS } from './premiumReader.js';

export const EXPIRED_TEXT = `🔔 Ваша подписка завершена.
Доступ к премиум-функциям временно приостановлен.

Продлите подписку, чтобы продолжить пользоваться всеми возможностями без ограничений.`;

export type ExpiryNotifier = {
  send(telegramId: number): Promise<number>;
};

export type JobOptions = {
  enabled: boolean;
  minIntervalMs?: number;
  maxPerRun?: number;
  maxDeliveryAttempts?: number;
  maxTelegramAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type JobReport = {
  disabled: boolean;
  migrationMissing: boolean;
  baselineCreated: boolean;
  historicalSkipped: number;
  sent: number;
  blocked: number;
  failed: number;
  superseded: number;
};

type SendFailure = { response?: { error_code?: number; description?: string; parameters?: { retry_after?: number } }; description?: string; message?: string };

export function classifySendError(error: unknown): 'blocked' | 'retry' {
  const details = telegramDetails(error);
  const description = details.description;
  if (details.code === 403) return 'blocked';
  if (/bot was blocked by the user|user is deactivated|chat not found|bot was kicked|have no rights to send/i.test(description)) {
    return 'blocked';
  }
  if (details.code === 400 && /forbidden/i.test(description)) return 'blocked';
  return 'retry';
}

export function retryDelayMs(error: unknown, attempt: number): number {
  const retryAfter = telegramDetails(error).retryAfter;
  if (retryAfter !== null) return Math.min(retryAfter * 1000, 30_000);
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 8_000);
}

function telegramDetails(error: unknown): { code: number | null; description: string; retryAfter: number | null } {
  const record = (error ?? {}) as SendFailure;
  const response = record.response;
  const code = typeof response?.error_code === 'number' ? response.error_code : null;
  const description = response?.description || record.description || record.message || (error instanceof Error ? error.message : '');
  const retryAfter = response?.parameters?.retry_after;
  return {
    code,
    description,
    retryAfter: typeof retryAfter === 'number' && retryAfter >= 0 ? retryAfter : null,
  };
}

function emptyReport(partial: Partial<JobReport> = {}): JobReport {
  return {
    disabled: false,
    migrationMissing: false,
    baselineCreated: false,
    historicalSkipped: 0,
    sent: 0,
    blocked: 0,
    failed: 0,
    superseded: 0,
    ...partial,
  };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runSubscriptionExpiryJob(
  reader: PremiumReader,
  notifier: ExpiryNotifier,
  options: JobOptions
): Promise<JobReport> {
  if (!options.enabled) return emptyReport({ disabled: true });
  const minIntervalMs = options.minIntervalMs ?? 50;
  const maxPerRun = options.maxPerRun ?? 200;
  const maxDeliveryAttempts = options.maxDeliveryAttempts ?? MAX_DELIVERY_ATTEMPTS;
  const maxTelegramAttempts = options.maxTelegramAttempts ?? 3;
  const sleep = options.sleep ?? defaultSleep;
  let nextSlot = 0;

  const pace = async () => {
    const wait = Math.max(0, nextSlot - Date.now());
    nextSlot = Math.max(Date.now(), nextSlot) + minIntervalMs;
    if (wait > 0) await sleep(wait);
  };

  try {
    if (!(await reader.tablesReady())) {
      console.error('[subscription] notice tables are missing; apply the bot migration before enabling notifications; no messages sent');
      return emptyReport({ migrationMissing: true });
    }
    const baseline = await reader.ensureBaseline();
    if (baseline.created) {
      console.log('[subscription] historical expirations stored without sending', { skipped: baseline.skipped });
    }
    const ids = await reader.listCandidateIds(maxPerRun, maxDeliveryAttempts);
    const report = emptyReport({
      baselineCreated: baseline.created,
      historicalSkipped: baseline.created ? baseline.skipped : 0,
    });

    for (const telegramId of ids) {
      try {
        const claim = await reader.claim(telegramId, maxDeliveryAttempts);
        if (!claim) continue;
        if (!(await reader.stillExpired(claim.id))) {
          await reader.markSuperseded(claim.id);
          report.superseded += 1;
          continue;
        }
        const delivery = await deliver(notifier, telegramId, {
          pace,
          sleep,
          maxTelegramAttempts,
        });
        if (delivery.ok) {
          await reader.markSent(claim.id, delivery.messageId);
          report.sent += 1;
          continue;
        }
        if (delivery.kind === 'blocked') {
          await reader.markBlocked(claim.id, delivery.error);
          report.blocked += 1;
          continue;
        }
        if (claim.attemptCount >= maxDeliveryAttempts) {
          await reader.markFailed(claim.id, delivery.error);
        } else {
          await reader.markRetry(claim.id, delivery.error);
        }
        report.failed += 1;
        console.error('[subscription] notify failed', { telegramId, kind: delivery.kind });
      } catch (error) {
        report.failed += 1;
        console.error('[subscription] user failed', { telegramId, error: redact(error) });
      }
    }

    if (ids.length > 0 || baseline.created) {
      console.log('[subscription] run complete', {
        sent: report.sent,
        blocked: report.blocked,
        failed: report.failed,
        superseded: report.superseded,
        historicalSkipped: report.historicalSkipped,
      });
    }
    return report;
  } catch (error) {
    console.error('[subscription] run failed', redact(error));
    return emptyReport({ failed: 1 });
  }
}

async function deliver(
  notifier: ExpiryNotifier,
  telegramId: number,
  options: { pace: () => Promise<void>; sleep: (ms: number) => Promise<void>; maxTelegramAttempts: number }
): Promise<{ ok: true; messageId: number } | { ok: false; kind: 'blocked' | 'retry'; error: string }> {
  let lastError = 'telegram send failed';
  for (let attempt = 1; attempt <= options.maxTelegramAttempts; attempt += 1) {
    try {
      await options.pace();
      const messageId = await notifier.send(telegramId);
      if (!Number.isInteger(messageId) || messageId <= 0) {
        throw new Error('Telegram did not confirm the message');
      }
      return { ok: true, messageId };
    } catch (error) {
      lastError = redact(error);
      const kind = classifySendError(error);
      if (kind === 'blocked') return { ok: false, kind, error: lastError };
      if (attempt === options.maxTelegramAttempts) return { ok: false, kind, error: lastError };
      await options.sleep(retryDelayMs(error, attempt));
    }
  }
  return { ok: false, kind: 'retry', error: lastError };
}
