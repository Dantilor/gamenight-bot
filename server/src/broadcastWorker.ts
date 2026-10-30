import { BROADCAST_OPEN_BUTTON } from './broadcastPanel.js';
import type { BroadcastStore, ClaimedDelivery } from './broadcastStore.js';
import { redact } from './log.js';
import { classifySendError, retryDelayMs } from './subscriptionJob.js';

export type OutboundMessage = {
  chatId: number;
  text: string;
  photoFileId: string | null;
  buttonUrl: string | null;
};

export type OutboundSender = {
  send(message: OutboundMessage): Promise<number>;
};

export type WorkerOptions = {
  buttonUrl: string | null;
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
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runBroadcastWorker(
  store: BroadcastStore,
  sender: OutboundSender,
  options: WorkerOptions
): Promise<WorkerReport> {
  const report: WorkerReport = { migrationMissing: false, sent: 0, blocked: 0, failed: 0, retried: 0, stopped: 0 };
  if (!(await store.tablesReady())) {
    console.error('[broadcast] tables are missing; no messages sent');
    return { ...report, migrationMissing: true };
  }
  await store.releaseStaleSending();
  const maxAttempts = options.maxAttempts ?? 5;
  const maxSends = options.maxSends ?? Number.POSITIVE_INFINITY;
  const sleep = options.sleep ?? defaultSleep;
  let processed = 0;
  let nextSlot = 0;

  while (processed < maxSends) {
    const claimed = await store.claimNext(maxAttempts);
    if (!claimed) break;
    processed += 1;
    if (await store.campaignIsStopped(claimed.campaignId)) {
      await store.releaseClaim(claimed.deliveryId);
      report.stopped += 1;
      continue;
    }
    const wait = Math.max(0, nextSlot - Date.now());
    nextSlot = Math.max(Date.now(), nextSlot) + (options.minIntervalMs ?? 50);
    if (wait > 0) await sleep(wait);
    await deliverOne(store, sender, claimed, options.buttonUrl, maxAttempts, sleep, report);
    await store.finishCampaignIfDone(claimed.campaignId);
  }
  return report;
}

async function deliverOne(
  store: BroadcastStore,
  sender: OutboundSender,
  claimed: ClaimedDelivery,
  buttonUrl: string | null,
  maxAttempts: number,
  sleep: (ms: number) => Promise<void>,
  report: WorkerReport
): Promise<void> {
  try {
    const messageId = await sender.send({
      chatId: claimed.telegramId,
      text: claimed.bodyHtml,
      photoFileId: claimed.photoFileId,
      buttonUrl: claimed.includeButton ? buttonUrl : null,
    });
    const stored = await store.markSent(claimed.deliveryId, messageId);
    if (!stored) {
      report.failed += 1;
      console.error('[broadcast] Telegram result was not stored because message_id was not confirmed', { deliveryId: claimed.deliveryId });
      return;
    }
    report.sent += 1;
  } catch (error) {
    const reason = redact(error);
    if (classifySendError(error) === 'blocked') {
      await store.markDeliveryBlocked(claimed.deliveryId, claimed.telegramId, reason);
      report.blocked += 1;
      return;
    }
    if (claimed.attemptCount >= maxAttempts) {
      await store.markFailed(claimed.deliveryId, reason);
      report.failed += 1;
      return;
    }
    await store.markRetry(claimed.deliveryId, reason);
    report.retried += 1;
    const delay = retryDelayMs(error, claimed.attemptCount);
    if (delay > 0) await sleep(delay);
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
      if (message.buttonUrl) {
        payload.reply_markup = { inline_keyboard: [[{ text: BROADCAST_OPEN_BUTTON, web_app: { url: message.buttonUrl } }]] };
      }
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
