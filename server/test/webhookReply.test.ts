import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import type { Express } from 'express';
import type { Telegraf } from 'telegraf';
import { HERO_CAPTION, OPEN_PREMIUM_BUTTON_TEXT, PLAY_BUTTON_TEXT, START_BUTTON_TEXT } from '../src/bot.js';
import { readConfig, type AppConfig } from '../src/config.js';
import { createApp, startListening } from '../src/main.js';
import { formatTariffs, premiumPageUrl } from '../src/plans.js';
import { publicHeroPhotoUrl } from '../src/webhookReply.js';

const TOKEN = '123456789:AAFakeTokenForTestsOnly000';
const SECRET = 'hook_secret';
const MINI_APP = 'https://mini.example/app';
const PHOTO = 'https://bot.example/public/hero-new.png';

const PLANS = [
  { id: 'premium_1m', title: '1 месяц', priceRub: 259, durationDays: 30 },
  { id: 'premium_3m', title: '3 месяца', priceRub: 399, durationDays: 90 },
  { id: 'premium_lifetime', title: 'Навсегда', priceRub: 990, durationDays: 36500 },
];

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...readConfig({
      BOT_TOKEN: TOKEN,
      MINI_APP_URL: MINI_APP,
      API_URL: 'https://api.example',
      PUBLIC_URL: 'https://bot.example/ignored?token=secret#frag',
      BOT_WEBHOOK_PATH: '/telegram/test-hook',
      TELEGRAM_WEBHOOK_SECRET: SECRET,
      ENABLE_WEBHOOK_REGISTRATION: 'false',
      ENABLE_SUBSCRIPTION_NOTIFICATIONS: 'false',
      TELEGRAM_REPLY_MODE: 'webhook',
      PORT: '0',
    }),
    ...overrides,
  };
}

function forbidFetch(): typeof fetch {
  return async () => {
    throw new Error('outbound fetch is forbidden in this test');
  };
}

function arm(bot: Telegraf): { calls: string[] } {
  const calls: string[] = [];
  const note = (name: string) => async () => {
    calls.push(name);
    throw new Error(`unexpected Telegram call ${name}`);
  };
  const telegram = bot.telegram as unknown as {
    callApi: () => Promise<unknown>;
    getMe: () => Promise<unknown>;
    setWebhook: () => Promise<unknown>;
    sendMessage: () => Promise<unknown>;
    sendPhoto: () => Promise<unknown>;
    deleteMessage: () => Promise<unknown>;
  };
  telegram.callApi = note('callApi');
  telegram.getMe = note('getMe');
  telegram.setWebhook = note('setWebhook');
  telegram.sendMessage = note('sendMessage');
  telegram.sendPhoto = note('sendPhoto');
  telegram.deleteMessage = note('deleteMessage');
  bot.handleUpdate = note('handleUpdate') as Telegraf['handleUpdate'];
  return { calls };
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

function commandUpdate(updateId: number, text: string, chat: { id: number; type: string }) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      text,
      chat,
      from: { id: 7, is_bot: false, first_name: 'Test' },
    },
  };
}

async function post(base: string, body: unknown, secret: string | null = SECRET): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret !== null) headers['x-telegram-bot-api-secret-token'] = secret;
  return fetch(`${base}/telegram/test-hook`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function photoReply(chatId: number, buttonText: string | null) {
  return {
    method: 'sendPhoto',
    chat_id: chatId,
    photo: PHOTO,
    caption: HERO_CAPTION,
    parse_mode: 'HTML',
    ...(buttonText
      ? { reply_markup: { inline_keyboard: [[{ text: buttonText, web_app: { url: MINI_APP } }]] } }
      : {}),
  };
}

test('public hero URL is https and drops credentials, query, and hash', () => {
  assert.equal(publicHeroPhotoUrl('https://bot.example/ignored?token=secret#frag'), PHOTO);
  assert.equal(publicHeroPhotoUrl('http://bot.example'), null);
  assert.equal(publicHeroPhotoUrl('https://user:pw@bot.example'), null);
});

test('webhook commands return one Bot API method and do not call Telegram', async () => {
  const { app, bot } = createApp(config(), { fetchImpl: forbidFetch() });
  const telegram = arm(bot);
  const server = await listen(app);
  try {
    const ping = await post(server.base, commandUpdate(1, '/ping', { id: 7, type: 'private' }));
    assert.equal(ping.status, 200);
    assert.match(ping.headers.get('content-type') ?? '', /^application\/json/);
    assert.deepEqual(await ping.json(), {
      method: 'sendMessage',
      chat_id: 7,
      text: 'pong',
      reply_markup: { remove_keyboard: true },
    });

    const start = await post(server.base, commandUpdate(2, '/start start-payload-9f3', { id: 7, type: 'private' }));
    assert.equal(start.status, 200);
    const startBody = await start.json();
    assert.deepEqual(startBody, photoReply(7, START_BUTTON_TEXT));
    assert.equal(JSON.stringify(startBody).includes('start-payload-9f3'), false);
    assert.equal(JSON.stringify(startBody).includes('token=secret'), false);

    const named = await post(server.base, commandUpdate(3, '/start@GameNightHostBot', { id: 7, type: 'private' }));
    assert.deepEqual(await named.json(), photoReply(7, START_BUTTON_TEXT));

    const play = await post(server.base, commandUpdate(4, '/play', { id: 11, type: 'private' }));
    assert.deepEqual(await play.json(), photoReply(11, PLAY_BUTTON_TEXT));

    const group = await post(server.base, commandUpdate(5, '/start', { id: -100, type: 'group' }));
    const groupBody = await group.json();
    assert.deepEqual(groupBody, photoReply(-100, null));
    assert.equal('reply_markup' in groupBody, false);

    const foreign = await post(server.base, commandUpdate(6, '/ping@OtherBot', { id: -100, type: 'supergroup' }));
    assert.equal(foreign.status, 200);
    assert.equal(await foreign.text(), '');
    assert.deepEqual(telegram.calls, []);
  } finally {
    await server.close();
  }
});

test('webhook mode rejects a bad secret and a bad body before any reply', async () => {
  const { app, bot } = createApp(config(), { fetchImpl: forbidFetch() });
  const telegram = arm(bot);
  const server = await listen(app);
  try {
    const missing = await post(server.base, commandUpdate(1, '/ping', { id: 7, type: 'private' }), null);
    assert.equal(missing.status, 401);
    const wrong = await post(server.base, commandUpdate(2, '/ping', { id: 7, type: 'private' }), 'other');
    assert.equal(wrong.status, 401);
    const invalid = await post(server.base, { hello: 'world' });
    assert.equal(invalid.status, 400);
    const broken = await post(server.base, '{');
    assert.equal(broken.status, 400);
    assert.deepEqual(telegram.calls, []);
  } finally {
    await server.close();
  }
});

test('unknown webhook updates finish without a method or an outbound call', async () => {
  let fetches = 0;
  const fetchImpl: typeof fetch = async () => {
    fetches += 1;
    throw new Error('plans must not be requested');
  };
  const { app, bot } = createApp(config(), { fetchImpl });
  const telegram = arm(bot);
  const server = await listen(app);
  try {
    const help = await post(server.base, commandUpdate(7, '/help', { id: 7, type: 'private' }));
    assert.equal(help.status, 200);
    assert.equal(await help.text(), '');
    const text = await post(server.base, commandUpdate(8, 'hello', { id: 7, type: 'private' }));
    assert.equal(text.status, 200);
    assert.equal(await text.text(), '');
    const edited = await post(server.base, {
      update_id: 9,
      edited_message: { message_id: 9, date: 1, text: '/start', chat: { id: 7, type: 'private' } },
    });
    assert.equal(edited.status, 200);
    assert.equal(await edited.text(), '');
    const callback = await post(server.base, {
      update_id: 10,
      callback_query: {
        id: 'cq',
        data: 'other',
        from: { id: 7, is_bot: false, first_name: 'Test' },
        message: { message_id: 3, date: 1, chat: { id: 7, type: 'private' } },
      },
    });
    assert.equal(callback.status, 200);
    assert.equal(await callback.text(), '');
    const orphan = await post(server.base, {
      update_id: 11,
      callback_query: { id: 'cq2', data: 'renew_subscription', from: { id: 7, is_bot: false, first_name: 'Test' } },
    });
    assert.equal(orphan.status, 200);
    assert.equal(await orphan.text(), '');
    assert.equal(fetches, 0);
    assert.deepEqual(telegram.calls, []);
  } finally {
    await server.close();
  }
});

test('a missing image or unusable URL is a sendMessage prepared before any photo method', async () => {
  const { app, bot } = createApp(
    config({ heroImagePath: path.join(process.cwd(), 'server', 'public', 'missing-hero.png') }),
    { fetchImpl: forbidFetch() }
  );
  const missingCalls = arm(bot);
  const server = await listen(app);
  try {
    const missingImage = await post(server.base, commandUpdate(1, '/start', { id: 7, type: 'private' }));
    assert.deepEqual(await missingImage.json(), {
      method: 'sendMessage',
      chat_id: 7,
      text: HERO_CAPTION,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[{ text: START_BUTTON_TEXT, web_app: { url: MINI_APP } }]] },
    });
  } finally {
    await server.close();
  }

  const insecure = createApp(config({ publicUrl: 'http://bot.example' }), { fetchImpl: forbidFetch() });
  const insecureCalls = arm(insecure.bot);
  const insecureServer = await listen(insecure.app);
  try {
    const response = await post(insecureServer.base, commandUpdate(2, '/play', { id: 7, type: 'private' }));
    const body = await response.json();
    assert.equal(body.method, 'sendMessage');
    assert.equal(body.text, HERO_CAPTION);
    assert.equal('photo' in body, false);
  } finally {
    await insecureServer.close();
  }

  const unconfigured = createApp(config({ miniAppUrl: '' }), { fetchImpl: forbidFetch() });
  const unconfiguredCalls = arm(unconfigured.bot);
  const unconfiguredServer = await listen(unconfigured.app);
  try {
    const response = await post(unconfiguredServer.base, commandUpdate(3, '/start', { id: 7, type: 'private' }));
    assert.deepEqual(await response.json(), {
      method: 'sendMessage',
      chat_id: 7,
      text: `${HERO_CAPTION}\n\nMINI_APP_URL не задан`,
      parse_mode: 'HTML',
    });
    assert.deepEqual(missingCalls.calls, []);
    assert.deepEqual(insecureCalls.calls, []);
    assert.deepEqual(unconfiguredCalls.calls, []);
  } finally {
    await unconfiguredServer.close();
  }
});

test('renew_subscription is one sendMessage and records no message id', async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    requested.push(String(input));
    return new Response(JSON.stringify({ ok: true, plans: PLANS }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const { app, bot } = createApp(config(), { fetchImpl });
  const telegram = arm(bot);
  const server = await listen(app);
  try {
    const renewal = await post(server.base, {
      update_id: 20,
      callback_query: {
        id: 'cq',
        data: 'renew_subscription',
        from: { id: 7, is_bot: false, first_name: 'Test' },
        message: { message_id: 4, date: 1, chat: { id: 7, type: 'private' } },
      },
    });
    assert.equal(renewal.status, 200);
    assert.match(renewal.headers.get('content-type') ?? '', /^application\/json/);
    assert.deepEqual(await renewal.json(), {
      method: 'sendMessage',
      chat_id: 7,
      text: formatTariffs(PLANS),
      reply_markup: {
        inline_keyboard: [[{ text: OPEN_PREMIUM_BUTTON_TEXT, web_app: { url: premiumPageUrl(MINI_APP) } }]],
      },
    });

    const group = await post(server.base, {
      update_id: 21,
      callback_query: {
        id: 'cq2',
        data: 'renew_subscription',
        from: { id: 7, is_bot: false, first_name: 'Test' },
        message: { message_id: 5, date: 1, chat: { id: -100, type: 'group' } },
      },
    });
    const groupBody = await group.json();
    assert.equal(groupBody.method, 'sendMessage');
    assert.equal(groupBody.text, formatTariffs(PLANS));
    assert.equal('reply_markup' in groupBody, false);
    assert.equal(JSON.stringify(groupBody).includes('message_id'), false);
    assert.deepEqual(requested, ['https://api.example/api/plans', 'https://api.example/api/plans']);
    assert.deepEqual(telegram.calls, []);
  } finally {
    await server.close();
  }
});

test('renew uses the plans fallback and still does not call Telegram', async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    requested.push(String(input));
    return new Response('no', { status: 500 });
  };
  const { app, bot } = createApp(config(), { fetchImpl });
  const telegram = arm(bot);
  const server = await listen(app);
  try {
    const renewal = await post(server.base, {
      update_id: 30,
      callback_query: {
        id: 'cq',
        data: 'renew_subscription',
        from: { id: 7, is_bot: false, first_name: 'Test' },
        message: { message_id: 4, date: 1, chat: { id: 7, type: 'private' } },
      },
    });
    assert.equal(renewal.status, 200);
    assert.deepEqual(await renewal.json(), {
      method: 'sendMessage',
      chat_id: 7,
      text: formatTariffs(null),
      reply_markup: {
        inline_keyboard: [[{ text: OPEN_PREMIUM_BUTTON_TEXT, web_app: { url: premiumPageUrl(MINI_APP) } }]],
      },
    });
    assert.equal(requested.some((url) => url.includes('api.telegram.org')), false);
    assert.deepEqual(telegram.calls, []);
  } finally {
    await server.close();
  }
});

test('webhook mode does not register a webhook or send subscription notices', async () => {
  const appConfig = config({
    enableWebhookRegistration: true,
    enableSubscriptionNotifications: true,
    databaseUrl: '',
  });
  const { app, bot } = createApp(appConfig, { fetchImpl: forbidFetch() });
  const telegram = arm(bot);
  const logs: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  try {
    const running = await startListening(appConfig, app, bot);
    await running.shutdown('SIGTERM');
  } finally {
    console.log = log;
    console.error = error;
  }
  const text = logs.join('\n');
  assert.match(text, /cannot call setWebhook/);
  assert.match(text, /cannot send subscription notices/);
  assert.equal(text.includes('registration succeeded'), false);
  assert.equal(text.includes('hourly scheduler started'), false);
  assert.equal(text.includes('startup run'), false);
  assert.equal(text.includes('api.telegram.org'), false);
  assert.deepEqual(telegram.calls, []);
});
