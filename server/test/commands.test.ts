import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import type { Express } from 'express';
import type { Telegraf } from 'telegraf';
import { HERO_CAPTION, OPEN_PREMIUM_BUTTON_TEXT, PLAY_BUTTON_TEXT, START_BUTTON_TEXT } from '../src/bot.js';
import { readConfig, type AppConfig } from '../src/config.js';
import { createApp } from '../src/main.js';

const TOKEN = '123456789:AAFakeTokenForTestsOnly000';

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...readConfig({
      BOT_TOKEN: TOKEN,
      MINI_APP_URL: 'https://dantilor-telegram-card-game-a2cc.twc1.net',
      API_URL: 'https://dantilor-telegram-card-game-3706.twc1.net',
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

type ApiCall = { method: string; body: string };

async function mockTelegram(bot: Telegraf): Promise<{ calls: ApiCall[]; close: () => Promise<void> }> {
  const calls: ApiCall[] = [];
  let messageId = 1;
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const method = decodeURIComponent((req.url ?? '').split('/').filter(Boolean).pop() ?? '');
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({ method, body });
      const result = method === 'getMe'
        ? { id: 900, is_bot: true, first_name: 'GameNight', username: 'gamenight_test' }
        : { message_id: messageId++, date: 1, chat: { id: 7, type: 'private' } };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock telegram port missing');
  const telegram = bot.telegram as unknown as { options: { apiRoot: string; webhookReply: boolean; agent?: unknown } };
  telegram.options.apiRoot = `http://127.0.0.1:${address.port}`;
  telegram.options.webhookReply = false;
  telegram.options.agent = undefined;
  return {
    calls,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function command(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      chat: { id: 7, type: 'private' },
      from: { id: 7, is_bot: false, first_name: 'Test' },
      text,
      entities: [{ offset: 0, length: text.length, type: 'bot_command' }],
    },
  };
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

async function post(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/telegram/test-hook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': 'hook_secret',
    },
    body: JSON.stringify(body),
  });
}

test('start, play, and ping keep the current welcome and WebApp buttons', async () => {
  const { app, bot } = createApp(config());
  const telegram = await mockTelegram(bot);
  const server = await listen(app);
  try {
    const start = await post(server.base, command(1, '/start'));
    assert.equal(start.status, 200);
    const play = await post(server.base, command(2, '/play'));
    assert.equal(play.status, 200);
    const ping = await post(server.base, command(3, '/ping'));
    assert.equal(ping.status, 200);

    const rendered = telegram.calls.map((call) => `${call.method}\n${call.body}`).join('\n');
    assert.equal(rendered.includes('start ok'), false);
    assert.equal(rendered.includes('api.telegram.org'), false);
    assert.equal(telegram.calls.some((call) => call.method === 'sendPhoto' && call.body.includes(HERO_CAPTION) && call.body.includes(START_BUTTON_TEXT) && call.body.includes('https://dantilor-telegram-card-game-a2cc.twc1.net')), true);
    assert.equal(telegram.calls.some((call) => call.method === 'sendPhoto' && call.body.includes(HERO_CAPTION) && call.body.includes(PLAY_BUTTON_TEXT)), true);
    assert.equal(telegram.calls.some((call) => call.method === 'sendMessage' && call.body.includes('"text":"pong"')), true);
    assert.equal(rendered.includes('remove_keyboard'), true);
  } finally {
    await server.close();
    await telegram.close();
  }
});

test('renew opens the live Premium page and shows API prices', async () => {
  const plans = {
    ok: true,
    plans: [
      { id: 'premium_3m', title: 'Premium на 3 месяца', priceRub: 399, durationDays: 90 },
      { id: 'premium_lifetime', title: 'Premium навсегда', priceRub: 990, durationDays: 36500 },
      { id: 'premium_1m', title: 'Premium на 1 месяц', priceRub: 259, durationDays: 30 },
    ],
  };
  let requested = '';
  const { app, bot } = createApp(config(), {
    fetchImpl: async (input) => {
      requested = String(input);
      return new Response(JSON.stringify(plans), { status: 200 });
    },
  });
  const telegram = await mockTelegram(bot);
  const server = await listen(app);
  try {
    const response = await post(server.base, {
      update_id: 4,
      callback_query: {
        id: 'cb-1',
        data: 'renew_subscription',
        chat_instance: 'chat',
        from: { id: 7, is_bot: false, first_name: 'Test' },
        message: {
          message_id: 9,
          date: 1_700_000_000,
          chat: { id: 7, type: 'private' },
          text: 'old',
        },
      },
    });
    assert.equal(response.status, 200);
    assert.equal(requested, 'https://dantilor-telegram-card-game-3706.twc1.net/api/plans');
    const rendered = telegram.calls.map((call) => call.body).join('\n');
    assert.match(rendered, /1 месяц — 259 ₽/);
    assert.match(rendered, /3 месяца — 399 ₽/);
    assert.match(rendered, /Навсегда — 990 ₽/);
    assert.equal(rendered.includes('Год'), false);
    assert.equal(rendered.includes(OPEN_PREMIUM_BUTTON_TEXT), true);
    assert.equal(rendered.includes('https://dantilor-telegram-card-game-a2cc.twc1.net/premium'), true);
  } finally {
    await server.close();
    await telegram.close();
  }
});

test('renew still opens Premium when the plans API is down', async () => {
  const { app, bot } = createApp(config(), {
    fetchImpl: async () => new Response('nope', { status: 500 }),
  });
  const telegram = await mockTelegram(bot);
  const server = await listen(app);
  try {
    const response = await post(server.base, {
      update_id: 5,
      callback_query: {
        id: 'cb-2',
        data: 'renew_subscription',
        chat_instance: 'chat',
        from: { id: 7, is_bot: false, first_name: 'Test' },
        message: {
          message_id: 10,
          date: 1_700_000_000,
          chat: { id: 7, type: 'private' },
          text: 'old',
        },
      },
    });
    assert.equal(response.status, 200);
    const rendered = telegram.calls.map((call) => call.body).join('\n');
    assert.equal(rendered.includes('Год'), false);
    assert.equal(rendered.includes('259'), false);
    assert.equal(rendered.includes(OPEN_PREMIUM_BUTTON_TEXT), true);
    assert.equal(rendered.includes('https://dantilor-telegram-card-game-a2cc.twc1.net/premium'), true);
  } finally {
    await server.close();
    await telegram.close();
  }
});
