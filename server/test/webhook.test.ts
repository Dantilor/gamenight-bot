import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import type { Express } from 'express';
import type { Telegraf } from 'telegraf';
import { readConfig, type AppConfig } from '../src/config.js';
import { createApp, registerWebhook, startListening } from '../src/main.js';

const TOKEN = '123456789:AAFakeTokenForTestsOnly000';

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...readConfig({
      BOT_TOKEN: TOKEN,
      MINI_APP_URL: 'https://mini.example',
      API_URL: 'https://api.example',
      PUBLIC_URL: 'https://bot.example',
      BOT_WEBHOOK_PATH: '/telegram/test-hook',
      TELEGRAM_WEBHOOK_SECRET: 'hook_secret',
      ENABLE_WEBHOOK_REGISTRATION: 'false',
      ENABLE_SUBSCRIPTION_NOTIFICATIONS: 'false',
      PORT: '0',
    }),
    ...overrides,
  };
}

type ApiCall = { method: string; payload: Record<string, unknown> };

function capture(bot: Telegraf): ApiCall[] {
  const calls: ApiCall[] = [];
  const telegram = bot.telegram as unknown as {
    callApi: (method: string, payload?: Record<string, unknown>) => Promise<unknown>;
  };
  telegram.callApi = async (method: string, payload: Record<string, unknown> = {}) => {
    calls.push({ method, payload });
    return { message_id: calls.length, chat: { id: 1 }, date: 1, text: payload.text ?? '' };
  };
  return calls;
}

async function listen(app: Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('port missing');
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test('health is ready and the old duplicate webhook path is gone', async () => {
  const { app, bot } = createApp(config());
  capture(bot);
  const server = await listen(app);
  try {
    const health = await fetch(`${server.base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, ready: true });
    const missing = await fetch(`${server.base}/telegram/webhook-9f3k2lQp`, { method: 'POST', body: '{}' });
    assert.equal(missing.status, 404);
    const image = await fetch(`${server.base}/public/hero-new.png`);
    assert.equal(image.status, 200);
    assert.match(image.headers.get('content-type') ?? '', /image\/png/);
  } finally {
    await server.close();
  }
});

test('webhook secret rejects bad requests before Telegraf', async () => {
  const { app, bot } = createApp(config());
  const calls = capture(bot);
  const server = await listen(app);
  try {
    const headers = { 'content-type': 'application/json' };
    const missing = await fetch(`${server.base}/telegram/test-hook`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ update_id: 1, message: { text: '/ping' } }),
    });
    assert.equal(missing.status, 401);
    const wrong = await fetch(`${server.base}/telegram/test-hook`, {
      method: 'POST',
      headers: { ...headers, 'x-telegram-bot-api-secret-token': 'other' },
      body: JSON.stringify({ update_id: 1 }),
    });
    assert.equal(wrong.status, 401);
    const invalid = await fetch(`${server.base}/telegram/test-hook`, {
      method: 'POST',
      headers: { ...headers, 'x-telegram-bot-api-secret-token': 'hook_secret' },
      body: JSON.stringify({ hello: 'world' }),
    });
    assert.equal(invalid.status, 400);
    const broken = await fetch(`${server.base}/telegram/test-hook`, {
      method: 'POST',
      headers: { ...headers, 'x-telegram-bot-api-secret-token': 'hook_secret' },
      body: '{',
    });
    assert.equal(broken.status, 400);
    assert.equal(calls.length, 0);
  } finally {
    await server.close();
  }
});

test('database health stays private', async () => {
  const { app } = createApp(config({ healthcheckToken: 'health-token', databaseUrl: '' }));
  const server = await listen(app);
  try {
    const hidden = await fetch(`${server.base}/health/db`);
    assert.equal(hidden.status, 404);
    const wrong = await fetch(`${server.base}/health/db`, { headers: { 'x-health-token': 'nope' } });
    assert.equal(wrong.status, 404);
    const open = await fetch(`${server.base}/health/db`, { headers: { 'x-health-token': 'health-token' } });
    assert.equal(open.status, 503);
    assert.deepEqual(await open.json(), { ok: false, reason: 'not_configured' });
  } finally {
    await server.close();
  }
});

test('webhook registration does nothing while the flag is off and never removes a webhook', async () => {
  let calls = 0;
  const disabled = await registerWebhook({
    setWebhook: async () => {
      calls += 1;
    },
  }, config());
  assert.equal(disabled, 'disabled');
  assert.equal(calls, 0);

  const insecure = await registerWebhook({
    setWebhook: async () => {
      calls += 1;
    },
  }, config({ enableWebhookRegistration: true, publicUrl: 'http://bot.example' }));
  assert.equal(insecure, 'skipped');
  assert.equal(calls, 0);

  const secret = 'hook_secret';
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  try {
    const failed = await registerWebhook({
      async setWebhook(url) {
        throw new Error(`telegram rejected ${url} secret_token=${secret}`);
      },
    }, config({ enableWebhookRegistration: true, webhookSecret: secret }));
    assert.equal(failed, 'failed');
  } finally {
    console.error = original;
  }
  assert.equal(errors.join('\n').includes(secret), false);
  assert.equal(errors.join('\n').includes('/telegram/test-hook'), false);

  const seen: { url?: string; secret?: string } = {};
  const registered = await registerWebhook({
    async setWebhook(url, extra) {
      seen.url = url;
      seen.secret = extra?.secret_token;
    },
  }, config({ enableWebhookRegistration: true }));
  assert.equal(registered, 'registered');
  assert.equal(seen.url, 'https://bot.example/telegram/test-hook');
  assert.equal(seen.secret, secret);

  const appConfig = config();
  const { app, bot } = createApp(appConfig);
  let webhookCalls = 0;
  bot.telegram.setWebhook = async () => {
    webhookCalls += 1;
    return true;
  };
  const running = await startListening(appConfig, app, bot);
  const logs: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  try {
    await running.shutdown('SIGTERM');
  } finally {
    console.log = log;
  }
  const text = logs.join('\n');
  assert.match(text, /webhook left unchanged/);
  assert.equal(text.includes('deleteWebhook'), false);
  assert.equal(webhookCalls, 0);
});
