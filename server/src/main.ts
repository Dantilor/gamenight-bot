import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import cron, { type ScheduledTask } from 'node-cron';
import express, { type ErrorRequestHandler, type Express, type Response } from 'express';
import type { Telegraf } from 'telegraf';
import { createBot, sendExpiryNotice, type BotDeps } from './bot.js';
import { buildWebhookUrl, readConfig, type AppConfig } from './config.js';
import { closeDb, getConnection, initDb, pingDb } from './db.js';
import { redact } from './log.js';
import { createPremiumReader } from './premiumReader.js';
import { runSubscriptionExpiryJob } from './subscriptionJob.js';
import { logWebhookRejection, parseTelegramUpdate, readSecretHeader, rejectWebhook, safeEqual, webhookSecretFailure } from './webhook.js';
import { buildWebhookReply, publicHeroPhotoUrl } from './webhookReply.js';

export type TelegramRegistrar = {
  setWebhook(url: string, extra?: { secret_token?: string }): Promise<unknown>;
};

export function createApp(config: AppConfig, deps: Pick<BotDeps, 'fetchImpl'> = {}): { app: Express; bot: ReturnType<typeof createBot> } {
  const bot = createBot({ config, fetchImpl: deps.fetchImpl });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use('/public', express.static(path.join(process.cwd(), 'server', 'public')));

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true, ready: true });
  });

  app.get('/health/db', async (req, res) => {
    if (!config.healthcheckToken) {
      res.status(404).end();
      return;
    }
    const provided = req.get('X-Health-Token') ?? '';
    if (!safeEqual(provided, config.healthcheckToken)) {
      res.status(404).end();
      return;
    }
    if (!config.databaseUrl) {
      res.status(503).json({ ok: false, reason: 'not_configured' });
      return;
    }
    try {
      await pingDb();
      res.status(200).json({ ok: true });
    } catch (error) {
      console.error('[db] health failed', redact(error));
      res.status(503).json({ ok: false });
    }
  });

  let warnedMissingSecret = false;
  app.post(config.webhookPath, async (req, res) => {
    const failure = webhookSecretFailure(config.webhookSecret, readSecretHeader(req));
    if (failure) {
      logWebhookRejection(failure);
      rejectWebhook(res, 401);
      return;
    }
    if (!config.webhookSecret && !warnedMissingSecret) {
      warnedMissingSecret = true;
      console.warn('[webhook] TELEGRAM_WEBHOOK_SECRET is empty; incoming updates are not authenticated');
    }
    const update = parseTelegramUpdate(req.body);
    if (!update) {
      logWebhookRejection('invalid_update');
      rejectWebhook(res, 400);
      return;
    }
    console.log('[telegram] update', update.update_id);
    if (config.replyMode === 'webhook') {
      // One Bot API method is written to this HTTP response. handleUpdate is not used:
      // it calls getMe first, and Telegraf's webhookReply allowlist excludes sendMessage and sendPhoto.
      await answerByWebhook(res, update, config, deps.fetchImpl);
      return;
    }
    try {
      await bot.handleUpdate(update as never, res);
    } catch (error) {
      console.error('[webhook] handler error', redact(error), { updateId: update.update_id });
    }
    if (!res.headersSent) res.status(200).end();
  });

  const jsonError: ErrorRequestHandler = (error, _req, res, next) => {
    if (error instanceof SyntaxError && 'type' in error && (error as { type?: string }).type === 'entity.parse.failed') {
      rejectWebhook(res, 400);
      return;
    }
    next(error);
  };
  app.use(jsonError);
  return { app, bot };
}

export async function registerWebhook(telegram: TelegramRegistrar, config: AppConfig): Promise<'disabled' | 'registered' | 'skipped' | 'failed'> {
  if (config.replyMode === 'webhook') {
    if (config.enableWebhookRegistration) {
      console.error('[webhook] ENABLE_WEBHOOK_REGISTRATION=true is incompatible with TELEGRAM_REPLY_MODE=webhook; cannot call setWebhook; existing Telegram webhook was not changed');
      return 'skipped';
    }
    console.log('[webhook] registration disabled (ENABLE_WEBHOOK_REGISTRATION is not true); existing Telegram webhook was not changed');
    return 'disabled';
  }
  if (!config.enableWebhookRegistration) {
    console.log('[webhook] registration disabled (ENABLE_WEBHOOK_REGISTRATION is not true); existing Telegram webhook was not changed');
    return 'disabled';
  }
  if (!config.publicUrl) {
    console.error('[webhook] registration enabled but PUBLIC_URL is missing; Telegram was not changed');
    return 'skipped';
  }
  let webhookUrl = '';
  try {
    webhookUrl = buildWebhookUrl(config.publicUrl, config.webhookPath);
  } catch (error) {
    console.error('[webhook] registration skipped', redact(error));
    return 'skipped';
  }
  try {
    const extra = config.webhookSecret ? { secret_token: config.webhookSecret } : undefined;
    if (!config.webhookSecret) {
      console.warn('[webhook] TELEGRAM_WEBHOOK_SECRET is empty; registration will proceed without a secret token');
    }
    await telegram.setWebhook(webhookUrl, extra);
    console.log('[webhook] registration succeeded', { host: new URL(webhookUrl).host });
    return 'registered';
  } catch (error) {
    console.error('[webhook] registration failed', redactWebhookError(error, webhookUrl, config.webhookSecret));
    return 'failed';
  }
}

export type RunningServer = {
  server: http.Server;
  shutdown: (signal?: string) => Promise<void>;
};

export async function startListening(config: AppConfig, app: Express, bot: Telegraf): Promise<RunningServer> {
  const server = await listen(app, config.port);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  console.log('[health] listening on', port);
  console.log('[webhook] route mounted');

  let scheduler: ScheduledTask | null = null;
  let stopped = false;
  const startup = bootstrap(config, bot, () => stopped, (task) => {
    scheduler = task;
  }).catch((error) => {
    console.error('[startup] background init failed', redact(error));
  });

  return {
    server,
    shutdown: async (signal?: string) => {
      if (stopped) return;
      stopped = true;
      console.log('[shutdown] signal', signal ?? 'manual', '; webhook left unchanged');
      await startup;
      try {
        scheduler?.stop();
      } catch (error) {
        console.error('[shutdown] scheduler stop failed', redact(error));
      }
      await closeServer(server);
      await closeDb();
    },
  };
}

async function bootstrap(
  config: AppConfig,
  bot: Telegraf,
  stopped: () => boolean,
  setScheduler: (task: ScheduledTask) => void
): Promise<void> {
  await registerWebhook(bot.telegram, config);
  if (stopped()) return;

  if (config.databaseUrl) {
    try {
      await initDb(process.env);
      await pingDb();
      console.log('[db] ping ok');
    } catch (error) {
      console.error('[db] unavailable', redact(error));
    }
  } else {
    console.log('[db] DATABASE_URL is not set');
  }
  if (stopped()) return;

  if (config.replyMode === 'webhook') {
    if (!publicHeroPhotoUrl(config.publicUrl) || !fs.existsSync(config.heroImagePath)) {
      console.warn('[webhook] hero photo is not available; /start and /play will use sendMessage');
    }
    if (config.enableSubscriptionNotifications) {
      console.error('[subscription] ENABLE_SUBSCRIPTION_NOTIFICATIONS=true is incompatible with TELEGRAM_REPLY_MODE=webhook; cannot send subscription notices; no messages sent');
      return;
    }
    console.log('[subscription] notifications disabled');
    return;
  }

  if (!config.enableSubscriptionNotifications) {
    console.log('[subscription] notifications disabled');
    return;
  }
  const connection = getConnection();
  if (!connection) {
    console.error('[subscription] notifications enabled but database is unavailable; no messages sent');
    return;
  }
  const reader = createPremiumReader(connection);
  const notifier = { send: (telegramId: number) => sendExpiryNotice(bot, telegramId) };
  const report = await runSubscriptionExpiryJob(reader, notifier, { enabled: true });
  console.log('[subscription] startup run', {
    sent: report.sent,
    historicalSkipped: report.historicalSkipped,
    migrationMissing: report.migrationMissing,
  });
  if (stopped()) return;
  const task = cron.schedule(
    '0 * * * *',
    () =>
      runSubscriptionExpiryJob(reader, notifier, { enabled: true }).catch((error) => {
        console.error('[subscription] scheduler error', redact(error));
      }),
    { timezone: 'UTC', noOverlap: true }
  );
  setScheduler(task);
  if (stopped()) task.stop();
  console.log('[subscription] hourly scheduler started');
}

async function answerByWebhook(
  res: Response,
  update: NonNullable<ReturnType<typeof parseTelegramUpdate>>,
  config: AppConfig,
  fetchImpl: BotDeps['fetchImpl']
): Promise<void> {
  try {
    const reply = await buildWebhookReply(update, config, { fetchImpl });
    console.log('[webhook] reply', { updateId: update.update_id, method: reply?.method ?? 'none' });
    if (reply) {
      res.status(200).json(reply);
      return;
    }
  } catch (error) {
    console.error('[webhook] reply error', redact(error), { updateId: update.update_id });
  }
  if (!res.headersSent) res.status(200).end();
}

function listen(app: Express, port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0');
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server);
    };
    server.once('error', onError);
    server.once('listening', onListening);
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 8_000);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    server.closeAllConnections?.();
  });
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const file = path.resolve(entry);
  return file.endsWith(`${path.sep}main.ts`) || file.endsWith(`${path.sep}main.js`);
}

function redactWebhookError(error: unknown, webhookUrl: string, secret: string): string {
  let text = redact(error);
  if (webhookUrl) text = text.split(webhookUrl).join('[redacted-webhook]');
  if (secret) text = text.split(secret).join('[redacted]');
  return text;
}

async function main(): Promise<void> {
  loadEnv();
  const config = readConfig(process.env);
  if (!config.botToken) {
    console.error('[bot] Missing required env BOT_TOKEN');
    process.exit(1);
  }
  const { app, bot } = createApp(config);
  const running = await startListening(config, app, bot);
  const onSignal = (signal: NodeJS.Signals) => {
    void running
      .shutdown(signal)
      .then(() => process.exit(0))
      .catch((error) => {
        console.error('[shutdown] failed', redact(error));
        process.exit(1);
      });
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.on('unhandledRejection', (error) => {
    console.error('[process] unhandledRejection', redact(error));
  });
}

if (isDirectRun()) {
  void main().catch((error) => {
    console.error('[startup] failed', redact(error));
    process.exit(1);
  });
}
