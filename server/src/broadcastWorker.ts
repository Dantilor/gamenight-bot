import { buildBroadcastMarkup, httpsUrl, type BroadcastMarkup } from './broadcastButtons.js';
import type { BroadcastStore, CampaignKind, ClaimedDelivery, ClaimPolicy } from './broadcastStore.js';
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

/**
 * Telegram may already have delivered the message (the request left, the answer did not
 * come back, or the answer was unreadable). Bot API has no idempotency key, so the worker
 * never resends such a delivery: at most once is safer than a duplicate in someone's chat.
 */
export class OutcomeUnknownError extends Error {
  readonly outcomeUnknown = true;
}

/** The request never reached Telegram (DNS, refused, connect timeout). Safe to try later. */
export class TelegramUnreachableError extends Error {
  readonly telegramUnreachable = true;
}

export function isOutcomeUnknown(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { outcomeUnknown?: unknown }).outcomeUnknown === true);
}

export function isTelegramUnreachable(error: unknown): boolean {
  if (error && typeof error === 'object' && (error as { telegramUnreachable?: unknown }).telegramUnreachable === true) return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /^connect |ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ETIMEDOUT|Telegram connection failed/i.test(message);
}

/** 401 means BOT_TOKEN is wrong or revoked: no recipient is at fault, so nothing is spent. */
export function isTokenRejected(error: unknown): boolean {
  const response = error && typeof error === 'object' ? (error as { response?: { error_code?: unknown } }).response : undefined;
  return response?.error_code === 401;
}

const CONNECT_PHASE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

/** True only when the error proves the request did not leave this machine. */
export function failedBeforeSending(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    const item = current as { code?: unknown; syscall?: unknown; message?: unknown; cause?: unknown };
    if (typeof item.code === 'string' && CONNECT_PHASE_CODES.has(item.code)) return true;
    if (item.code === 'ETIMEDOUT' && item.syscall === 'connect') return true;
    if (typeof item.message === 'string' && /^connect (ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)/.test(item.message)) return true;
    current = item.cause;
  }
  return false;
}

export type WorkerOptions = {
  miniAppUrl: string | null;
  /** Restrict the run to one campaign kind. 'test' makes it impossible to touch a mass queue. */
  kind?: CampaignKind;
  minIntervalMs?: number;
  maxSends?: number;
  maxAttempts?: number;
  /** Defaults: mass needs a delivered test of the same content; queued campaigns older than 24 h are left alone. */
  policy?: ClaimPolicy;
  shouldStop?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Called after every handled delivery; the daemon uses it to keep the health check fresh. */
  onProgress?: () => void;
};

export const DEFAULT_CLAIM_POLICY: Required<ClaimPolicy> = { maxQueuedAgeHours: 24, requireDeliveredTest: true };

export type WorkerReport = {
  migrationMissing: boolean;
  processed: number;
  sent: number;
  blocked: number;
  failed: number;
  retried: number;
  stopped: number;
  skipped: number;
  unknown: number;
  rateLimited: number;
  networkDown: boolean;
  tokenRejected: boolean;
  aborted: boolean;
};

type Outcome = 'done' | 'rate-limited' | 'network-down' | 'token-rejected';

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runBroadcastWorker(
  store: BroadcastStore,
  sender: OutboundSender,
  options: WorkerOptions
): Promise<WorkerReport> {
  const report: WorkerReport = {
    migrationMissing: false,
    processed: 0,
    sent: 0,
    blocked: 0,
    failed: 0,
    retried: 0,
    stopped: 0,
    skipped: 0,
    unknown: 0,
    rateLimited: 0,
    networkDown: false,
    tokenRejected: false,
    aborted: false,
  };
  if (!(await store.tablesReady())) {
    console.error('[broadcast] tables are missing; no messages sent');
    return { ...report, migrationMissing: true };
  }
  const stale = await store.failStaleSending();
  if (stale > 0) console.error('[broadcast] deliveries interrupted mid-send were marked failed (outcome unknown, not resent)', { count: stale });
  const maxAttempts = options.maxAttempts ?? 5;
  const maxSends = options.maxSends ?? Number.POSITIVE_INFINITY;
  const sleep = options.sleep ?? defaultSleep;
  const interval = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  const policy = { ...DEFAULT_CLAIM_POLICY, ...options.policy };
  let nextSlot = 0;
  let consecutiveRateLimits = 0;

  while (report.processed < maxSends && !options.shouldStop?.()) {
    const claimed = await store.claimNext(maxAttempts, options.kind, policy);
    if (!claimed) break;
    report.processed += 1;
    if (await store.campaignIsStopped(claimed.campaignId)) {
      await store.releaseClaim(claimed.deliveryId);
      report.stopped += 1;
      continue;
    }
    const wait = Math.max(0, nextSlot - Date.now());
    nextSlot = Math.max(Date.now(), nextSlot) + interval;
    if (wait > 0) await sleep(wait);
    const outcome = await deliverOne(store, sender, claimed, options.miniAppUrl, maxAttempts, sleep, report);
    options.onProgress?.();
    if (outcome === 'network-down') {
      report.networkDown = true;
      break;
    }
    if (outcome === 'token-rejected') {
      report.tokenRejected = true;
      break;
    }
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
): Promise<Outcome> {
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
    if (isOutcomeUnknown(error)) {
      await store.markFailed(claimed.deliveryId, `outcome unknown, not resent: ${reason}`);
      report.unknown += 1;
      return 'done';
    }
    const flood = retryAfterMs(error);
    if (flood !== null) {
      // A rate limit is not the recipient's fault: give the attempt back and wait as long as Telegram asks.
      await store.releaseClaim(claimed.deliveryId);
      report.rateLimited += 1;
      await sleep(Math.min(flood, MAX_FLOOD_WAIT_MS));
      return 'rate-limited';
    }
    if (isTelegramUnreachable(error)) {
      // Nothing left this machine. Keep the attempt and let the caller pause the whole run.
      await store.releaseClaim(claimed.deliveryId);
      return 'network-down';
    }
    if (isTokenRejected(error)) {
      await store.releaseClaim(claimed.deliveryId);
      return 'token-rejected';
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

export type DaemonSettings = {
  miniAppUrl: string | null;
  /** false (default after deploy): only test campaigns are sent. */
  massEnabled: boolean;
  pollMs: number;
  maxQueuedAgeHours: number | null;
  batchSize: number;
  minIntervalMs?: number;
  /** After every completed cycle. */
  onHeartbeat?: () => void | Promise<void>;
  /** After every handled delivery inside a long cycle. */
  onProgress?: () => void;
};

export type DaemonDeps = {
  shouldStop: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string, details?: Record<string, unknown>) => void;
};

const SCHEMA_RETRY_MS = 60_000;
const MAX_NETWORK_BACKOFF_MS = 60_000;

/**
 * Long-running loop for a container with restart policy. It polls PostgreSQL, sends what is
 * allowed (tests only unless massEnabled), pauses on a Telegram outage without burning attempts,
 * and resumes after a restart because all state lives in the database.
 */
export async function runBroadcastDaemon(
  store: BroadcastStore,
  sender: OutboundSender,
  settings: DaemonSettings,
  deps: DaemonDeps
): Promise<{ cycles: number; sent: number }> {
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? ((message, details) => console.log(message, details ?? ''));
  const pause = async (ms: number) => {
    let left = ms;
    while (left > 0 && !deps.shouldStop()) {
      const step = Math.min(left, 1000);
      await sleep(step);
      left -= step;
    }
  };
  log('[broadcast] daemon started', {
    mode: settings.massEnabled ? 'test + mass (mass needs a delivered test of the same content)' : 'test only',
    pollMs: settings.pollMs,
    maxQueuedAgeHours: settings.maxQueuedAgeHours,
  });
  let cycles = 0;
  let sent = 0;
  let lastProblems = '';
  let backoff = settings.pollMs;
  while (!deps.shouldStop()) {
    cycles += 1;
    let problems: string[];
    try {
      problems = await store.schemaProblems();
    } catch (error) {
      problems = [`database unavailable: ${redact(error)}`];
    }
    const key = problems.join('; ');
    if (key !== lastProblems) {
      if (problems.length > 0) log('[broadcast] not sending; fix these first', { problems });
      else if (lastProblems) log('[broadcast] schema and privileges are ready');
      lastProblems = key;
    }
    if (problems.length > 0) {
      await pause(SCHEMA_RETRY_MS);
      continue;
    }
    let report: WorkerReport;
    try {
      report = await runBroadcastWorker(store, sender, {
        miniAppUrl: settings.miniAppUrl,
        kind: settings.massEnabled ? undefined : 'test',
        maxSends: settings.batchSize,
        minIntervalMs: settings.minIntervalMs,
        policy: { maxQueuedAgeHours: settings.maxQueuedAgeHours, requireDeliveredTest: true },
        shouldStop: deps.shouldStop,
        sleep: pause,
        onProgress: settings.onProgress,
      });
    } catch (error) {
      log('[broadcast] cycle failed; will retry', { error: redact(error) });
      await pause(backoff);
      backoff = Math.min(backoff * 2, MAX_NETWORK_BACKOFF_MS);
      continue;
    }
    sent += report.sent;
    await settings.onHeartbeat?.();
    if (report.processed > 0) {
      log('[broadcast] cycle', {
        sent: report.sent,
        blocked: report.blocked,
        failed: report.failed,
        unknown: report.unknown,
        skipped: report.skipped,
        retried: report.retried,
        stopped: report.stopped,
        rateLimited: report.rateLimited,
      });
    }
    if (report.networkDown || report.tokenRejected) {
      const why = report.tokenRejected
        ? '[broadcast] Telegram rejected BOT_TOKEN (401); queue kept, retrying later'
        : '[broadcast] Telegram API unreachable; queue kept, retrying later';
      log(why, { waitMs: backoff });
      await pause(backoff);
      backoff = Math.min(backoff * 2, MAX_NETWORK_BACKOFF_MS);
      continue;
    }
    backoff = settings.pollMs;
    if (report.processed === 0 || report.aborted) await pause(settings.pollMs);
  }
  log('[broadcast] daemon stopped', { cycles, sent });
  return { cycles, sent };
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
      } catch (error) {
        // The token is part of the URL, so the original error text is never rethrown.
        if (failedBeforeSending(error)) throw new TelegramUnreachableError('Telegram connection failed');
        throw new OutcomeUnknownError('Telegram response was lost; the message may have been delivered');
      }
      if (response.status >= 500) {
        throw new OutcomeUnknownError(`Telegram answered ${response.status}; the message may have been delivered`);
      }
      const data = (await response.json().catch(() => null)) as {
        ok?: boolean;
        description?: string;
        error_code?: number;
        parameters?: { retry_after?: number };
        result?: { message_id?: unknown };
      } | null;
      if (!data) {
        if (response.ok) throw new OutcomeUnknownError('Telegram answer was unreadable; the message may have been delivered');
        const failure = new Error(response.statusText || 'Telegram rejected the message');
        (failure as { response?: unknown }).response = { error_code: response.status, description: response.statusText };
        throw failure;
      }
      if (!data.ok) {
        const failure = new Error(data.description || 'Telegram rejected the message');
        (failure as { response?: unknown }).response = {
          error_code: data.error_code ?? response.status,
          description: data.description || response.statusText,
          parameters: data.parameters,
        };
        throw failure;
      }
      const messageId = data.result?.message_id;
      if (typeof messageId !== 'number' || !Number.isInteger(messageId) || messageId <= 0) {
        throw new OutcomeUnknownError('Telegram did not confirm the message');
      }
      return messageId;
    },
  };
}
