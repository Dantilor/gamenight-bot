import { buildBroadcastMarkup, httpsUrl, type BroadcastMarkup } from './broadcastButtons.js';
import type { BroadcastStore, CampaignKind, ClaimedDelivery } from './broadcastStore.js';
import { redact } from './log.js';
import { classifySendError, isPermanentRequestError, retryAfterMs, retryDelayMs } from './subscriptionJob.js';

export type OutboundMessage = {
  chatId: number;
  text: string;
  photoFileId: string | null;
  replyMarkup: BroadcastMarkup | null;
};

export type OutboundSender = {
  send(message: OutboundMessage): Promise<number>;
};

// 60 ms between sends is about 16.7 messages per second, inside the 15-20 per second target
// and below Telegram's documented ~30 per second broadcast limit.
export const DEFAULT_MIN_INTERVAL_MS = 60;
// Telegram sometimes asks to wait minutes. Wait for it, but never longer than this in one go.
const MAX_FLOOD_WAIT_MS = 15 * 60_000;
// Stop the run instead of hammering Telegram when it keeps answering 429.
const MAX_CONSECUTIVE_RATE_LIMITS = 25;

export type WorkerOptions = {
  miniAppUrl: string | null;
  /** Restrict the run to one campaign kind. 'test' makes it impossible to touch a mass queue. */
  kind?: CampaignKind;
  minIntervalMs?: number;
  maxSends?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type WorkerReport = {
  migrationMissing: boolean;
  sent: number;
  blocked: number;
  failed: number;
  retried: number;
  stopped: number;
  skipped: number;
  rateLimited: number;
  aborted: boolean;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runBroadcastWorker(
  store: BroadcastStore,
  sender: OutboundSender,
  options: WorkerOptions
): Promise<WorkerReport> {
  const report: WorkerReport = {
    migrationMissing: false,
    sent: 0,
    blocked: 0,
    failed: 0,
    retried: 0,
    stopped: 0,
    skipped: 0,
    rateLimited: 0,
    aborted: false,
  };
  if (!(await store.tablesReady())) {
    console.error('[broadcast] tables are missing; no messages sent');
    return { ...report, migrationMissing: true };
  }
  await store.releaseStaleSending();
  const maxAttempts = options.maxAttempts ?? 5;
  const maxSends = options.maxSends ?? Number.POSITIVE_INFINITY;
  const sleep = options.sleep ?? defaultSleep;
  const interval = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  let processed = 0;
  let nextSlot = 0;
  let consecutiveRateLimits = 0;

  while (processed < maxSends) {
    const claimed = await store.claimNext(maxAttempts, options.kind);
    if (!claimed) break;
    processed += 1;
    if (await store.campaignIsStopped(claimed.campaignId)) {
      await store.releaseClaim(claimed.deliveryId);
      report.stopped += 1;
      continue;
    }
    const wait = Math.max(0, nextSlot - Date.now());
    nextSlot = Math.max(Date.now(), nextSlot) + interval;
    if (wait > 0) await sleep(wait);
    const outcome = await deliverOne(store, sender, claimed, options.miniAppUrl, maxAttempts, sleep, report);
    if (outcome === 'rate-limited') {
      consecutiveRateLimits += 1;
      nextSlot = 0;
      if (consecutiveRateLimits >= MAX_CONSECUTIVE_RATE_LIMITS) {
        report.aborted = true;
        console.error('[broadcast] Telegram keeps rate limiting; run stopped, the queue is kept');
        break;
      }
    } else {
      consecutiveRateLimits = 0;
    }
    await store.finishCampaignIfDone(claimed.campaignId);
  }
  return report;
}

async function deliverOne(
  store: BroadcastStore,
  sender: OutboundSender,
  claimed: ClaimedDelivery,
  miniAppUrl: string | null,
  maxAttempts: number,
  sleep: (ms: number) => Promise<void>,
  report: WorkerReport
): Promise<'done' | 'rate-limited'> {
  // Mass campaigns re-check consent / opt-out / block right before the Telegram call.
  // Test campaigns always go to the admin and skip this gate so a preview still works.
  if (claimed.kind === 'mass') {
    const eligible = await store.isStillEligible(claimed.telegramId, claimed.audience);
    if (!eligible) {
      await store.markFailed(claimed.deliveryId, 'recipient no longer eligible');
      report.skipped += 1;
      return 'done';
    }
  }
  try {
    const messageId = await sender.send({
      chatId: claimed.telegramId,
      text: claimed.bodyHtml,
      photoFileId: claimed.photoFileId,
      replyMarkup: buildBroadcastMarkup(claimed.buttonMode, claimed.includeButton, {
        miniAppUrl: httpsUrl(miniAppUrl),
        webUrl: claimed.webUrl,
      }),
    });
    const stored = await store.markSent(claimed.deliveryId, messageId);
    if (!stored) {
      report.failed += 1;
      console.error('[broadcast] Telegram result was not stored because message_id was not confirmed', { deliveryId: claimed.deliveryId });
      return 'done';
    }
    report.sent += 1;
    return 'done';
  } catch (error) {
    const reason = redact(error);
    const flood = retryAfterMs(error);
    if (flood !== null) {
      // A rate limit is not the recipient's fault: give the attempt back and wait as long as Telegram asks.
      await store.releaseClaim(claimed.deliveryId);
      report.rateLimited += 1;
      await sleep(Math.min(flood, MAX_FLOOD_WAIT_MS));
      return 'rate-limited';
    }
    if (classifySendError(error) === 'blocked') {
      await store.markDeliveryBlocked(claimed.deliveryId, claimed.telegramId, reason);
      report.blocked += 1;
      return 'done';
    }
    if (isPermanentRequestError(error) || claimed.attemptCount >= maxAttempts) {
      await store.markFailed(claimed.deliveryId, reason);
      report.failed += 1;
      return 'done';
    }
    await store.markRetry(claimed.deliveryId, reason);
    report.retried += 1;
    const delay = retryDelayMs(error, claimed.attemptCount);
    if (delay > 0) await sleep(delay);
    return 'done';
  }
}

export async function checkTelegramApi(
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: true; username: string } | { ok: false }> {
  const trimmed = token.trim();
  if (!trimmed) return { ok: false };
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${trimmed}/getMe`, {
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await response.json().catch(() => null)) as { ok?: boolean; result?: { is_bot?: boolean; username?: unknown } } | null;
    const username = data?.result?.username;
    if (!data?.ok || data.result?.is_bot !== true || typeof username !== 'string') return { ok: false };
    return { ok: true, username };
  } catch {
    return { ok: false };
  }
}

export function createTelegramSender(token: string, fetchImpl: typeof fetch = fetch): OutboundSender {
  const trimmed = token.trim();
  if (!trimmed) throw new Error('Missing required env BOT_TOKEN');
  return {
    async send(message) {
      const method = message.photoFileId ? 'sendPhoto' : 'sendMessage';
      const payload: Record<string, unknown> = message.photoFileId
        ? { chat_id: message.chatId, photo: message.photoFileId, caption: message.text, parse_mode: 'HTML' }
        : { chat_id: message.chatId, text: message.text, parse_mode: 'HTML' };
      if (message.replyMarkup) payload.reply_markup = message.replyMarkup;
      let response: Response;
      try {
        response = await fetchImpl(`https://api.telegram.org/bot${trimmed}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new Error('Telegram connection failed');
      }
      const data = (await response.json().catch(() => null)) as {
        ok?: boolean;
        description?: string;
        error_code?: number;
        parameters?: { retry_after?: number };
        result?: { message_id?: unknown };
      } | null;
      if (!data?.ok) {
        const failure = new Error(data?.description || 'Telegram rejected the message');
        (failure as { response?: unknown }).response = {
          error_code: data?.error_code ?? response.status,
          description: data?.description || response.statusText,
          parameters: data?.parameters,
        };
        throw failure;
      }
      const messageId = data.result?.message_id;
      if (typeof messageId !== 'number' || !Number.isInteger(messageId) || messageId <= 0) {
        throw new Error('Telegram did not confirm the message');
      }
      return messageId;
    },
  };
}
