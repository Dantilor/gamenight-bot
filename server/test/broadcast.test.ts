import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import type { Express } from 'express';
import type { Telegraf } from 'telegraf';
import { BROADCAST_OPEN_BUTTON, handleBroadcastTurn } from '../src/broadcastPanel.js';
import { createBroadcastStore, type BroadcastStore } from '../src/broadcastStore.js';
import { checkTelegramApi, createTelegramSender, runBroadcastWorker, type OutboundSender } from '../src/broadcastWorker.js';
import { PLAY_BUTTON_TEXT } from '../src/bot.js';
import { readConfig, type AppConfig } from '../src/config.js';
import { createApp } from '../src/main.js';
import { assertMigrationIsSafe } from '../src/migrationSql.js';
import type { SqlConnection, SqlQuery } from '../src/premiumReader.js';

const ADMIN = 434230321;
const OTHER = 77;
const MINI_APP = 'https://mini.example/app';

function person(id: number) {
  return { id, is_bot: false, first_name: 'Test' };
}

function privateChat(id: number) {
  return { id, type: 'private' };
}

function textUpdate(updateId: number, fromId: number, text: string, chat = privateChat(fromId)) {
  const command = text.startsWith('/') ? text.split(/\s/, 1)[0] : '';
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      text,
      from: person(fromId),
      chat,
      ...(command ? { entities: [{ offset: 0, length: command.length, type: 'bot_command' }] } : {}),
    },
  };
}

function callbackUpdate(updateId: number, fromId: number, data: string, chat = privateChat(fromId)) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cb-${updateId}`,
      data,
      from: person(fromId),
      message: { message_id: 1, date: 1, chat },
    },
  };
}

async function withStore(fn: (store: BroadcastStore, query: SqlQuery) => Promise<void>): Promise<void> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  await pg.exec("SET TIME ZONE 'UTC'");
  await pg.exec(`
    CREATE TABLE users (telegram_id BIGINT PRIMARY KEY);
    CREATE TABLE subscriptions (
      telegram_id BIGINT,
      plan_id TEXT,
      active_until TIMESTAMP,
      PRIMARY KEY (telegram_id, plan_id)
    );
    INSERT INTO users (telegram_id) VALUES (999);
    INSERT INTO subscriptions (telegram_id, plan_id, active_until) VALUES (999, 'premium_1m', now() + interval '30 days');
  `);
  await pg.exec(fs.readFileSync(path.join(process.cwd(), 'server', 'db', 'migrations', '002_bot_broadcast.sql'), 'utf8'));
  const asQuery = (target: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number; affectedRows?: number }> }): SqlQuery => {
    return async (sql, params) => {
      const result = await target.query(sql, params);
      return { rows: result.rows as Record<string, unknown>[], rowCount: result.rowCount ?? result.affectedRows ?? result.rows.length };
    };
  };
  const connection: SqlConnection = {
    query: asQuery(pg),
    withTransaction: (callback) => pg.transaction(async (tx) => callback(asQuery(tx))),
  };
  try {
    await fn(createBroadcastStore(connection), connection.query);
  } finally {
    await pg.close();
  }
}

async function keepUsers(query: SqlQuery, ids: number[]): Promise<void> {
  await query('DELETE FROM subscriptions');
  await query('DELETE FROM users');
  for (const id of ids) await query('INSERT INTO users (telegram_id) VALUES ($1::bigint)', [id]);
}

function deps(store: BroadcastStore | null) {
  return { adminId: ADMIN, miniAppUrl: MINI_APP, store };
}

function menuText(reply: { text?: string; reply_markup?: { inline_keyboard?: Array<Array<{ text?: string }>> } } | null): string {
  const labels = reply?.reply_markup?.inline_keyboard?.flat().map((button) => button.text ?? '') ?? [];
  return `${reply?.text ?? ''}\n${labels.join('\n')}`;
}

test('broadcast migration does not touch premium tables', () => {
  const sql = fs.readFileSync(path.join(process.cwd(), 'server', 'db', 'migrations', '002_bot_broadcast.sql'), 'utf8');
  const storeSource = fs.readFileSync(path.join(process.cwd(), 'server', 'src', 'broadcastStore.ts'), 'utf8');
  assertMigrationIsSafe(sql);
  assert.equal(fs.readFileSync(path.join(process.cwd(), 'server', 'src', 'main.ts'), 'utf8').includes('runBroadcastWorker'), false);
  assert.equal(BROADCAST_OPEN_BUTTON, PLAY_BUTTON_TEXT);
  assert.equal(/\b(insert\s+into|update|delete\s+from)\s+users\b/i.test(storeSource), false);
  assert.match(storeSource, /FROM users u/);
  assert.match(sql, /notify_opt_out/);
});

test('only the configured admin sees the panel', async () => {
  await withStore(async (store) => {
    const stranger = await handleBroadcastTurn(textUpdate(1, OTHER, '/admin'), deps(store));
    assert.equal(stranger?.text, 'Команда недоступна.');
    assert.equal(menuText(stranger).includes('Создать рассылку'), false);

    const group = await handleBroadcastTurn(textUpdate(2, ADMIN, '/admin', { id: -100, type: 'group' }), deps(store));
    assert.equal(group?.text, 'Команда недоступна.');

    const forged = await handleBroadcastTurn(callbackUpdate(3, OTHER, 'ba:menu'), deps(store));
    assert.equal(forged?.text, 'Команда недоступна.');
    assert.equal(menuText(forged).includes('Отправить пользователям'), false);

    const admin = await handleBroadcastTurn(textUpdate(4, ADMIN, '/admin'), deps(store));
    assert.match(menuText(admin), /Создать рассылку/);
    assert.match(menuText(admin), /Отправить тест себе/);
    assert.match(menuText(admin), /Остановить рассылку/);
  });
});

test('informational recipients come from users except refusals and blocked chats', async () => {
  await withStore(async (store, query) => {
    assert.equal(await store.countRecipients('notify'), 1);
    assert.equal(await store.countRecipients('ads'), 0);
    await handleBroadcastTurn(textUpdate(1, OTHER, '/start'), deps(store));
    await store.touchContact(OTHER, OTHER);
    assert.equal(await store.countRecipients('notify'), 1);
    await query('INSERT INTO users (telegram_id) VALUES ($1::bigint)', [OTHER]);
    assert.equal(await store.countRecipients('notify'), 2);
    await handleBroadcastTurn(textUpdate(2, OTHER, '/subscribe'), deps(store));
    assert.equal(await store.countRecipients('notify'), 2);
    assert.equal(await store.countRecipients('ads'), 0);
    await handleBroadcastTurn(callbackUpdate(3, OTHER, 'bc:ads:on'), deps(store));
    assert.equal(await store.countRecipients('ads'), 1);
    await handleBroadcastTurn(textUpdate(4, OTHER, '/unsubscribe'), deps(store));
    assert.equal(await store.countRecipients('notify'), 1);
    assert.equal(await store.countRecipients('ads'), 0);
    await store.markContactBlocked(999);
    assert.equal(await store.countRecipients('notify'), 0);
    const rows = await query<{ telegram_id: string | number }>('SELECT telegram_id FROM subscriptions');
    assert.equal(Number(rows.rows[0]?.telegram_id), 999);
  });
});

test('draft preview and test queue stay with the admin', async () => {
  await withStore(async (store, query) => {
    await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:new'), deps(store));
    await handleBroadcastTurn(textUpdate(2, ADMIN, '<b>Добрый вечер</b>'), deps(store));
    const preview = await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:preview'), deps(store));
    assert.equal(preview?.method, 'sendMessage');
    assert.equal(preview?.text, '<b>Добрый вечер</b>');
    assert.equal(preview?.parse_mode, 'HTML');
    assert.equal(preview?.reply_markup?.inline_keyboard?.[0]?.[0]?.text, PLAY_BUTTON_TEXT);
    const queued = await handleBroadcastTurn(callbackUpdate(4, ADMIN, 'ba:test'), deps(store));
    assert.match(queued?.text ?? '', /только для Telegram ID 434230321/);
    const again = await handleBroadcastTurn(callbackUpdate(5, ADMIN, 'ba:test'), deps(store));
    assert.match(again?.text ?? '', /уже стоит в очереди/);
    const deliveries = await query<{ telegram_id: string | number; status: string }>(
      'SELECT telegram_id, status FROM bot_broadcast_deliveries'
    );
    assert.equal(deliveries.rows.length, 1);
    assert.equal(Number(deliveries.rows[0]?.telegram_id), ADMIN);
    assert.equal(deliveries.rows[0]?.status, 'pending');
  });
});

test('mass send requires confirmation and does not duplicate', async () => {
  await withStore(async (store, query) => {
    await keepUsers(query, [OTHER, 8]);
    await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:new'), deps(store));
    await handleBroadcastTurn(textUpdate(2, ADMIN, 'Текст'), deps(store));
    const before = await query<{ count: string | number }>('SELECT count(*)::int AS count FROM bot_broadcast_campaigns');
    assert.equal(Number(before.rows[0]?.count), 0);
    const ask = await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:send'), deps(store));
    assert.match(ask?.text ?? '', /Получателей: 2/);
    const afterAsk = await query<{ count: string | number }>('SELECT count(*)::int AS count FROM bot_broadcast_campaigns');
    assert.equal(Number(afterAsk.rows[0]?.count), 0);
    const token = ask?.reply_markup?.inline_keyboard?.[0]?.[0] && 'callback_data' in ask.reply_markup.inline_keyboard[0][0]
      ? ask.reply_markup.inline_keyboard[0][0].callback_data
      : '';
    assert.match(token, /^ba:go:[a-f0-9]{12}$/);
    const stale = await handleBroadcastTurn(callbackUpdate(4, ADMIN, 'ba:go:aaaaaaaaaaaa'), deps(store));
    assert.match(stale?.text ?? '', /не создана|не принято/);
    const confirmed = await handleBroadcastTurn(callbackUpdate(5, ADMIN, token), deps(store));
    assert.match(confirmed?.text ?? '', /2 сообщений/);
    const repeated = await handleBroadcastTurn(callbackUpdate(6, ADMIN, token), deps(store));
    assert.match(repeated?.text ?? '', /Повторно получатели не добавлены/);
    const deliveries = await query<{ count: string | number }>('SELECT count(*)::int AS count FROM bot_broadcast_deliveries');
    assert.equal(Number(deliveries.rows[0]?.count), 2);
    const campaigns = await query<{ count: string | number }>('SELECT count(*)::int AS count FROM bot_broadcast_campaigns');
    assert.equal(Number(campaigns.rows[0]?.count), 1);
  });
});

test('stopping a campaign prevents delivery and a timeout is not success', async () => {
  await withStore(async (store, query) => {
    await keepUsers(query, [OTHER]);
    await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:new'), deps(store));
    await handleBroadcastTurn(textUpdate(2, ADMIN, 'Текст'), deps(store));
    const ask = await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:send'), deps(store));
    const token = ask?.reply_markup?.inline_keyboard?.[0]?.[0] && 'callback_data' in ask.reply_markup.inline_keyboard[0][0]
      ? ask.reply_markup.inline_keyboard[0][0].callback_data
      : '';
    await handleBroadcastTurn(callbackUpdate(4, ADMIN, token), deps(store));
    const stopped = await handleBroadcastTurn(callbackUpdate(5, ADMIN, 'ba:stop'), deps(store));
    assert.match(stopped?.text ?? '', /остановлена/);
    const sender: OutboundSender = { async send() { throw new Error('sender must not be called'); } };
    const report = await runBroadcastWorker(store, sender, { buttonUrl: MINI_APP, minIntervalMs: 0, sleep: async () => undefined });
    assert.equal(report.sent, 0);
    const rows = await query<{ status: string; telegram_message_id: number | null }>(
      'SELECT status, telegram_message_id FROM bot_broadcast_deliveries'
    );
    assert.equal(rows.rows[0]?.status, 'pending');
    assert.equal(rows.rows[0]?.telegram_message_id, null);

    await query("UPDATE bot_broadcast_campaigns SET status = 'queued', finished_at = NULL");
    let calls = 0;
    const failing: OutboundSender = {
      async send() {
        calls += 1;
        throw new Error('connect ETIMEDOUT');
      },
    };
    const failed = await runBroadcastWorker(store, failing, { buttonUrl: MINI_APP, minIntervalMs: 0, maxAttempts: 1, sleep: async () => undefined });
    assert.equal(failed.sent, 0);
    assert.equal(calls, 1);
    const after = await query<{ status: string; telegram_message_id: number | null }>(
      'SELECT status, telegram_message_id FROM bot_broadcast_deliveries'
    );
    assert.notEqual(after.rows[0]?.status, 'sent');
    assert.equal(after.rows[0]?.telegram_message_id, null);
  });
});

test('worker records a blocked user without a message id', async () => {
  await withStore(async (store, query) => {
    await keepUsers(query, [OTHER]);
    await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:new'), deps(store));
    await handleBroadcastTurn(textUpdate(2, ADMIN, 'Текст'), deps(store));
    const ask = await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:send'), deps(store));
    const token = ask?.reply_markup?.inline_keyboard?.[0]?.[0] && 'callback_data' in ask.reply_markup.inline_keyboard[0][0]
      ? ask.reply_markup.inline_keyboard[0][0].callback_data
      : '';
    await handleBroadcastTurn(callbackUpdate(4, ADMIN, token), deps(store));
    const sender: OutboundSender = {
      async send() {
        const error = new Error('Forbidden: bot was blocked by the user');
        (error as { response?: unknown }).response = { error_code: 403, description: 'Forbidden: bot was blocked by the user' };
        throw error;
      },
    };
    const report = await runBroadcastWorker(store, sender, { buttonUrl: MINI_APP, minIntervalMs: 0, sleep: async () => undefined });
    assert.equal(report.sent, 0);
    assert.equal(report.blocked, 1);
    const delivery = await query<{ status: string; telegram_message_id: number | null }>('SELECT status, telegram_message_id FROM bot_broadcast_deliveries');
    assert.equal(delivery.rows[0]?.status, 'blocked');
    assert.equal(delivery.rows[0]?.telegram_message_id, null);
    const contact = await query<{ blocked_at: string | null }>('SELECT blocked_at FROM bot_broadcast_contacts WHERE telegram_id = $1::bigint', [OTHER]);
    assert.ok(contact.rows[0]?.blocked_at);
    await query('INSERT INTO users (telegram_id) VALUES (8)');
    assert.equal(await store.countRecipients('notify'), 1);
    await handleBroadcastTurn(callbackUpdate(10, ADMIN, 'ba:new'), deps(store));
    await handleBroadcastTurn(textUpdate(11, ADMIN, 'Ещё'), deps(store));
    const nextAsk = await handleBroadcastTurn(callbackUpdate(12, ADMIN, 'ba:send'), deps(store));
    const nextToken = nextAsk?.reply_markup?.inline_keyboard?.[0]?.[0] && 'callback_data' in nextAsk.reply_markup.inline_keyboard[0][0]
      ? nextAsk.reply_markup.inline_keyboard[0][0].callback_data
      : '';
    await handleBroadcastTurn(callbackUpdate(13, ADMIN, nextToken), deps(store));
    const pending = await query<{ telegram_id: string | number }>("SELECT telegram_id FROM bot_broadcast_deliveries WHERE status = 'pending'");
    assert.equal(pending.rows.length, 1);
    assert.equal(Number(pending.rows[0]?.telegram_id), 8);
  });
});

test('worker records a message only after Telegram confirms it once', async () => {
  await withStore(async (store, query) => {
    await keepUsers(query, [OTHER]);
    await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:new'), deps(store));
    await handleBroadcastTurn(textUpdate(2, ADMIN, 'Текст'), deps(store));
    const ask = await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:send'), deps(store));
    const token = ask?.reply_markup?.inline_keyboard?.[0]?.[0] && 'callback_data' in ask.reply_markup.inline_keyboard[0][0]
      ? ask.reply_markup.inline_keyboard[0][0].callback_data
      : '';
    await handleBroadcastTurn(callbackUpdate(4, ADMIN, token), deps(store));
    let attempts = 0;
    const seen: number[] = [];
    const sender: OutboundSender = {
      async send(message) {
        seen.push(message.chatId);
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('Too Many Requests');
          (error as { response?: unknown }).response = { error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } };
          throw error;
        }
        return 501;
      },
    };
    const report = await runBroadcastWorker(store, sender, { buttonUrl: MINI_APP, minIntervalMs: 0, maxAttempts: 5, sleep: async () => undefined });
    assert.equal(report.sent, 1);
    assert.deepEqual(seen, [OTHER, OTHER]);
    const row = await query<{ status: string; telegram_message_id: string | number }>('SELECT status, telegram_message_id FROM bot_broadcast_deliveries');
    assert.equal(row.rows[0]?.status, 'sent');
    assert.equal(Number(row.rows[0]?.telegram_message_id), 501);
    const second = await runBroadcastWorker(store, sender, { buttonUrl: MINI_APP, minIntervalMs: 0, sleep: async () => undefined });
    assert.equal(second.sent, 0);
    assert.equal(seen.length, 2);
  });
});

test('webhook mode keeps start and answers admin without calling Telegram', async () => {
  await withStore(async (store) => {
    const appConfig = config();
    const { app, bot } = createApp(appConfig, { broadcastStore: store, fetchImpl: forbidFetch() });
    const telegram = arm(bot);
    const server = await listen(app);
    try {
      const start = await post(server.base, textUpdate(1, OTHER, '/start'));
      assert.equal(start.status, 200);
      const startBody = await start.json();
      assert.equal(startBody.method, 'sendMessage');
      assert.equal('photo' in startBody, false);
      assert.equal(JSON.stringify(startBody).includes('/subscribe'), false);

      const stranger = await post(server.base, textUpdate(2, OTHER, '/admin'));
      assert.equal((await stranger.json()).text, 'Команда недоступна.');

      const admin = await post(server.base, textUpdate(3, ADMIN, '/admin'));
      const adminBody = await admin.json();
      assert.equal(adminBody.method, 'sendMessage');
      assert.match(JSON.stringify(adminBody), /Создать рассылку/);
      assert.deepEqual(telegram.calls, []);
    } finally {
      await server.close();
    }
  });
});

test('api mode keeps start as text and limits the test send to the admin', async () => {
  await withStore(async (store) => {
    const { app, bot } = createApp(config({ replyMode: 'api' }), { broadcastStore: store });
    const telegram = await mockTelegram(bot);
    const server = await listen(app);
    try {
      const start = await post(server.base, textUpdate(1, OTHER, '/start'));
      assert.equal(start.status, 200);
      const admin = await post(server.base, textUpdate(2, ADMIN, '/admin'));
      assert.equal(admin.status, 200);
      const rendered = telegram.calls.map((call) => `${call.method}\n${call.body}`).join('\n');
      assert.equal(telegram.calls.some((call) => call.method === 'sendPhoto'), false);
      const adminCall = telegram.calls.find((call) => call.body.includes('Создать рассылку'));
      assert.ok(adminCall, telegram.calls.map((call) => call.method).join(','));
      assert.match(adminCall.body, new RegExp(`"chat_id":${ADMIN}`));
      assert.equal(adminCall.body.includes(`"chat_id":${OTHER}`), false);
      assert.match(rendered, /Ваш вечер начинается прямо сейчас/);
      assert.equal(rendered.includes('/subscribe'), false);
    } finally {
      await server.close();
      await telegram.close();
    }
  });
});

test('telegram sender rejects a result without message_id', async () => {
  const sender = createTelegramSender('123456789:AAFakeTokenForTestsOnly000', async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }));
  await assert.rejects(() => sender.send({ chatId: ADMIN, text: 'Текст', photoFileId: null, buttonUrl: null }), /did not confirm/);
});

test('telegram access check calls getMe and does not send', async () => {
  const token = '123456789:AAFakeTokenForTestsOnly000';
  let pathName = '';
  const result = await checkTelegramApi(token, async (input, init) => {
    pathName = new URL(String(input)).pathname;
    assert.equal(init?.method, undefined);
    return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, username: 'GameNightHostBot' } }), { status: 200 });
  });
  assert.equal(pathName.endsWith('/getMe'), true);
  assert.equal(pathName.includes('sendMessage'), false);
  assert.deepEqual(result, { ok: true, username: 'GameNightHostBot' });
  assert.equal(JSON.stringify(result).includes(token), false);
  const failed = await checkTelegramApi(token, async () => {
    throw new Error(`connect ETIMEDOUT https://api.telegram.org/bot${token}/getMe`);
  });
  assert.deepEqual(failed, { ok: false });
});

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...readConfig({
      BOT_TOKEN: '123456789:AAFakeTokenForTestsOnly000',
      MINI_APP_URL: MINI_APP,
      PUBLIC_URL: 'https://bot.example',
      BOT_WEBHOOK_PATH: '/telegram/test-hook',
      TELEGRAM_WEBHOOK_SECRET: 'hook_secret',
      ENABLE_WEBHOOK_REGISTRATION: 'false',
      ENABLE_SUBSCRIPTION_NOTIFICATIONS: 'false',
      TELEGRAM_REPLY_MODE: 'webhook',
      BROADCAST_ADMIN_ID: String(ADMIN),
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
  const telegram = bot.telegram as unknown as Record<string, () => Promise<unknown>>;
  for (const name of ['callApi', 'getMe', 'setWebhook', 'sendMessage', 'sendPhoto', 'deleteMessage']) telegram[name] = note(name);
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

async function post(base: string, body: unknown): Promise<Response> {
  return fetch(`${base}/telegram/test-hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'hook_secret' },
    body: JSON.stringify(body),
  });
}

async function mockTelegram(bot: Telegraf): Promise<{ calls: Array<{ method: string; body: string }>; close: () => Promise<void> }> {
  const calls: Array<{ method: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const method = decodeURIComponent((req.url ?? '').split('/').filter(Boolean).pop() ?? '');
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({ method, body });
      const result = method === 'getMe'
        ? { id: 900, is_bot: true, first_name: 'GameNight', username: 'gamenight_test' }
        : { message_id: calls.length, date: 1, chat: { id: ADMIN, type: 'private' } };
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
