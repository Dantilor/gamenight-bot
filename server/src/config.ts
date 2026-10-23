import path from 'node:path';

const DEFAULT_WEBHOOK_PATH = '/telegram/webhook-9f3k2lQp';

export type TelegramReplyMode = 'api' | 'webhook';

export type AppConfig = {
  botToken: string;
  miniAppUrl: string;
  publicUrl: string;
  webhookPath: string;
  webhookSecret: string;
  databaseUrl: string;
  apiUrl: string;
  enableWebhookRegistration: boolean;
  enableSubscriptionNotifications: boolean;
  replyMode: TelegramReplyMode;
  healthcheckToken: string;
  port: number;
  heroImagePath: string;
};

export function isEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

export function isValidWebhookPath(webhookPath: string): boolean {
  if (!webhookPath.startsWith('/')) return false;
  if (webhookPath.length < 2 || webhookPath.length > 128) return false;
  if (webhookPath.endsWith('/')) return false;
  if (webhookPath.includes('//')) return false;
  if (webhookPath === '/health' || webhookPath === '/health/db') return false;
  return /^\/[A-Za-z0-9/_-]+$/.test(webhookPath);
}

export function isValidWebhookSecret(secret: string): boolean {
  return /^[A-Za-z0-9_-]{1,256}$/.test(secret);
}

export function readReplyMode(value: string | undefined): TelegramReplyMode {
  const mode = (value ?? '').trim().toLowerCase();
  if (mode === '' || mode === 'api') return 'api';
  if (mode === 'webhook') return 'webhook';
  throw new Error('TELEGRAM_REPLY_MODE must be api or webhook');
}

export function readPort(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 3000;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT is invalid');
  }
  return port;
}

export function readConfig(env: NodeJS.ProcessEnv, cwd = process.cwd()): AppConfig {
  const webhookPath = (env.BOT_WEBHOOK_PATH || DEFAULT_WEBHOOK_PATH).trim().replace(/\/+$/, '');
  if (!isValidWebhookPath(webhookPath)) {
    throw new Error('BOT_WEBHOOK_PATH is invalid');
  }
  const webhookSecret = (env.TELEGRAM_WEBHOOK_SECRET || '').trim();
  if (webhookSecret && !isValidWebhookSecret(webhookSecret)) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET is invalid');
  }
  return {
    botToken: (env.BOT_TOKEN || '').trim(),
    miniAppUrl: (env.MINI_APP_URL || env.WEBAPP_URL || '').trim(),
    publicUrl: (env.PUBLIC_URL || '').trim(),
    webhookPath,
    webhookSecret,
    databaseUrl: (env.DATABASE_URL || '').trim(),
    apiUrl: (env.API_URL || '').trim(),
    enableWebhookRegistration: isEnabled(env.ENABLE_WEBHOOK_REGISTRATION),
    enableSubscriptionNotifications: isEnabled(env.ENABLE_SUBSCRIPTION_NOTIFICATIONS),
    replyMode: readReplyMode(env.TELEGRAM_REPLY_MODE),
    healthcheckToken: (env.HEALTHCHECK_TOKEN || '').trim(),
    port: readPort(env.PORT),
    heroImagePath: path.join(cwd, 'server', 'public', 'hero-new.png'),
  };
}

export function buildWebhookUrl(publicUrl: string, webhookPath: string): string {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new Error('PUBLIC_URL is invalid');
  }
  if (url.protocol !== 'https:') {
    throw new Error('PUBLIC_URL must use https');
  }
  url.pathname = webhookPath;
  url.search = '';
  url.hash = '';
  return url.toString();
}
