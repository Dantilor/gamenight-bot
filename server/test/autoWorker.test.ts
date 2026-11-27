import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handleBroadcastTurn } from '../src/broadcastPanel.js';
import { createBroadcastStore, type BroadcastStore } from '../src/broadcastStore.js';
import {
  OutcomeUnknownError,
  TelegramUnreachableError,
  createTelegramSender,
  failedBeforeSending,
  runBroadcastDaemon,
  runBroadcastWorker,
  type DaemonSettings,
  type OutboundMessage,
  type OutboundSender,
} from '../src/broadcastWorker.js';
import { heartbeatIsFresh, parseWorkerArgs, readDaemonSettings } from '../src/broadcastWorkerMain.js';
import type { SqlConnection, SqlQuery } from '../src/premiumReader.js';

const ADMIN = 434230321;
const MINI_APP = 'https://mini.example/app';
const TOKEN = '123456789:AAFakeTokenForTestsOnly000';

function person(id: number) {
  return { id, is_bot: false, first_name: 'Test' };
}

function textUpdate(updateId: number, fromId: number, text: string) {
  const command = text.startsWith('/') ? text.split(/\s/, 1)[0] : '';
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1,
      text,
      from: person(fromId),
      chat: { id: fromId, type: 'private' },
      ...(command ? { entities: [{ offset: 0, length: command.length, type: 'bot_command' }] } : {}),
    },
  };
}

function callbackUpdate(updateId: number, fromId: number, data: string) {
  return {
    update_id: updateId,
    callback_query: { id: `cb-${updateId}`, data, from: person(fromId), message: { message_id: 1, date: 1, chat: { id: fromId, type: 'private' } } },
  };
}

function photoUpdate(updateId: number, fileId: string) {
  return {
    update_id: updateId,
    message: { message_id: updateId, date: 1, from: person(ADMIN), chat: { id: ADMIN, type: 'private' }, photo: [{ file_id: fileId, width: 800, height: 600 }] },
  } as never;
}

async function withStore(
  fn: (store: BroadcastStore, query: SqlQuery) => Promise<void>,
  migrations = ['002_bot_broadcast.sql', '003_bot_broadcast_buttons.sql']
): Promise<void> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  await pg.exec("SET TIME ZONE 'UTC'");
  await pg.exec('CREATE TABLE users (telegram_id BIGINT PRIMARY KEY);');
  for (const file of migrations) {
    await pg.exec(fs.readFileSync(path.join(process.cwd(), 'server', 'db', 'migrations', file), 'utf8'));
  }
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

const deps = (store: BroadcastStore) => ({ adminId: ADMIN, miniAppUrl: MINI_APP, store });

type Reply = Awaited<ReturnType<typeof handleBroadcastTurn>>;

function tokenOf(reply: Reply): string {
  const button = (reply?.reply_markup?.inline_keyboard?.flat() ?? []).find((item) =>
    String((item as { callback_data?: string }).callback_data ?? '').startsWith('ba:go:')
  ) as { callback_data?: string } | undefined;
  return String(button?.callback_data ?? '');
}

async function addUsers(query: SqlQuery, ids: number[]): Promise<void> {
  for (const id of ids) await query('INSERT INTO users (telegram_id) VALUES ($1::bigint)', [id]);
}

async function draftText(store: BroadcastStore, text: string, start: number): Promise<void> {
  await handleBroadcastTurn(callbackUpdate(start, ADMIN, 'ba:new'), deps(store));
  await handleBroadcastTurn(textUpdate(start + 1, ADMIN, text), deps(store));
}

async function confirmMass(store: BroadcastStore, start: number): Promise<Reply> {
  const ask = await handleBroadcastTurn(callbackUpdate(start, ADMIN, 'ba:send'), deps(store));
  await handleBroadcastTurn(callbackUpdate(start + 1, ADMIN, tokenOf(ask)), deps(store));
  return ask;
}

function recordingSender(sent: OutboundMessage[], hook?: (message: OutboundMessage) => Promise<void> | void): OutboundSender {
  return {
    async send(message) {
      sent.push(message);
      await hook?.(message);
      return 1000 + sent.length;
    },
  };
}

function settings(overrides: Partial<DaemonSettings> = {}): DaemonSettings {
  return { miniAppUrl: MINI_APP, massEnabled: false, pollMs: 1000, maxQueuedAgeHours: 24, batchSize: 500, minIntervalMs: 0, ...overrides };
}

/** Runs the daemon for a fixed number of completed cycles with instant sleeps. */
async function runCycles(store: BroadcastStore, sender: OutboundSender, cycles: number, overrides: Partial<DaemonSettings> = {}) {
  let beats = 0;
  let sleeps = 0;
  const logs: string[] = [];
  const result = await runBroadcastDaemon(
    store,
    sender,
    settings({
      ...overrides,
      onHeartbeat: () => {
        beats += 1;
      },
    }),
    {
      shouldStop: () => beats >= cycles || sleeps > 2000,
      sleep: async () => {
        sleeps += 1;
      },
      log: (message, details) => logs.push(`${message} ${JSON.stringify(details ?? {})}`),
    }
  );
  return { ...result, logs };
}

async function statuses(query: SqlQuery): Promise<Record<number, string>> {
  const rows = await query<{ telegram_id: string | number; status: string }>('SELECT telegram_id, status FROM bot_broadcast_deliveries ORDER BY id');
  return Object.fromEntries(rows.rows.map((row) => [Number(row.telegram_id), row.status]));
}

test('first start is test-only: the owner test goes out, a confirmed mass campaign does not', async () => {
  await withStore(async (store, query) => {
    await addUsers(query, [11, 12]);
    await draftText(store, 'Обновление сервиса', 1);
    await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:test'), deps(store));
    await confirmMass(store, 4);
    const sent: OutboundMessage[] = [];
    await runCycles(store, recordingSender(sent), 3);
    assert.deepEqual(sent.map((message) => message.chatId), [ADMIN]);
    assert.equal(await store.queueDepth('mass'), 2);
  });
});

test('mass mode sends only after a test of the identical content reached the admin', async () => {
  await withStore(async (store, query) => {
    await addUsers(query, [21, 22]);
    await draftText(store, 'Обновление сервиса', 1);
    await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:photo'), deps(store));
    await handleBroadcastTurn(photoUpdate(4, 'AgACbanner'), deps(store));
    await confirmMass(store, 5);
    const sent: OutboundMessage[] = [];
    await runCycles(store, recordingSender(sent), 2, { massEnabled: true });
    assert.deepEqual(sent, [], 'no test yet, so no mass send');

    // A test with a different photo does not unlock the campaign.
    await handleBroadcastTurn(callbackUpdate(10, ADMIN, 'ba:photo'), deps(store));
    await handleBroadcastTurn(photoUpdate(11, 'AgACother'), deps(store));
    await handleBroadcastTurn(callbackUpdate(12, ADMIN, 'ba:test'), deps(store));
    await runCycles(store, recordingSender(sent), 2, { massEnabled: true });
    assert.deepEqual(sent.map((message) => message.chatId), [ADMIN]);

    // The exact variant (same text, same banner, same buttons) tested and delivered: now it goes out.
    await handleBroadcastTurn(callbackUpdate(20, ADMIN, 'ba:photo'), deps(store));
    await handleBroadcastTurn(photoUpdate(21, 'AgACbanner'), deps(store));
    await handleBroadcastTurn(callbackUpdate(22, ADMIN, 'ba:test'), deps(store));
    await runCycles(store, recordingSender(sent), 3, { massEnabled: true });
    assert.deepEqual(sent.map((message) => message.chatId), [ADMIN, ADMIN, 21, 22]);
    assert.deepEqual(sent.map((message) => message.photoFileId), ['AgACother', 'AgACbanner', 'AgACbanner', 'AgACbanner']);
    const status = await statuses(query);
    assert.equal(status[21], 'sent');
    assert.equal(status[22], 'sent');
  });
});

test('the confirm screen says whether this exact variant was tested', async () => {
  await withStore(async (store, query) => {
    await addUsers(query, [31]);
    await draftText(store, 'Обновление сервиса', 1);
    const before = await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:send'), deps(store));
    assert.match(before?.text ?? '', /Тест именно этого варианта ещё не доставлен/);
    await handleBroadcastTurn(callbackUpdate(4, ADMIN, 'ba:test'), deps(store));
    await runCycles(store, recordingSender([]), 1);
    const after = await handleBroadcastTurn(callbackUpdate(5, ADMIN, 'ba:send'), deps(store));
    assert.match(after?.text ?? '', /Тест этого варианта \(текст, фото, кнопки\) доставлен/);
  });
});

test('old queued campaigns are left alone at start; a running campaign resumes', async () => {
  await withStore(async (store, query) => {
    await draftText(store, 'Старый тест', 1);
    await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:test'), deps(store));
    await query("UPDATE bot_broadcast_campaigns SET created_at = now() - interval '48 hours'");
    const sent: OutboundMessage[] = [];
    await runCycles(store, recordingSender(sent), 2);
    assert.deepEqual(sent, []);
    await query("UPDATE bot_broadcast_campaigns SET status = 'running'");
    await runCycles(store, recordingSender(sent), 1);
    assert.deepEqual(sent.map((message) => message.chatId), [ADMIN]);
  });
});

test('restart resumes the queue and nobody gets the message twice', async () => {
  await withStore(async (store, query) => {
    await addUsers(query, [41, 42, 43, 44, 45]);
    await draftText(store, 'Обновление сервиса', 1);
    await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:test'), deps(store));
    await confirmMass(store, 4);
    const sent: OutboundMessage[] = [];
    // First process: tiny batches, stopped after two cycles (test + 1 recipient).
    await runCycles(store, recordingSender(sent), 2, { massEnabled: true, batchSize: 1 });
    assert.equal(sent.length, 2);
    // Second process after a "restart" finishes the rest.
    await runCycles(store, recordingSender(sent), 10, { massEnabled: true });
    const ids = sent.map((message) => message.chatId);
    assert.deepEqual(ids, [ADMIN, 41, 42, 43, 44, 45]);
    assert.equal(new Set(ids).size, ids.length);
    const campaigns = await query<{ status: string }>("SELECT status FROM bot_broadcast_campaigns WHERE kind = 'mass'");
    assert.equal(campaigns.rows[0]?.status, 'completed');
  });
});

test('a delivery interrupted mid-send is not resent after a restart', async () => {
  await withStore(async (store, query) => {
    await draftText(store, 'Тест', 1);
    await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:test'), deps(store));
    await query("UPDATE bot_broadcast_deliveries SET status = 'sending', attempt_count = 1, updated_at = now() - interval '10 minutes'");
    const sent: OutboundMessage[] = [];
    await runCycles(store, recordingSender(sent), 1);
    assert.deepEqual(sent, []);
    const row = await query<{ status: string; last_error: string }>('SELECT status, last_error FROM bot_broadcast_deliveries');
    assert.equal(row.rows[0]?.status, 'failed');
    assert.match(row.rows[0]?.last_error ?? '', /outcome unknown/);
  });
});

test('a lost Telegram answer is recorded once and never retried', async () => {
  await withStore(async (store, query) => {
    await draftText(store, 'Тест', 1);
    await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:test'), deps(store));
    let calls = 0;
    const sender: OutboundSender = {
      async send() {
        calls += 1;
        throw new OutcomeUnknownError('Telegram response was lost; the message may have been delivered');
      },
    };
    const report = await runBroadcastWorker(store, sender, { miniAppUrl: MINI_APP, minIntervalMs: 0, maxAttempts: 5, sleep: async () => undefined });
    await runBroadcastWorker(store, sender, { miniAppUrl: MINI_APP, minIntervalMs: 0, maxAttempts: 5, sleep: async () => undefined });
    assert.equal(calls, 1);
    assert.equal(report.unknown, 1);
    assert.equal((await statuses(query))[ADMIN], 'failed');
  });
});

test('sender tells "never left" from "may have been delivered" and never leaks the token', async () => {
  const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  const connectTimeout = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ETIMEDOUT', syscall: 'connect' } });
  const reset = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  assert.equal(failedBeforeSending(refused), true);
  assert.equal(failedBeforeSending(connectTimeout), true);
  assert.equal(failedBeforeSending(reset), false);
  assert.equal(failedBeforeSending(timeout), false);

  const message = { chatId: ADMIN, text: 'x', photoFileId: null, replyMarkup: null };
  const sendWith = (impl: () => Promise<Response>) => createTelegramSender(TOKEN, impl as unknown as typeof fetch).send(message);
  const throwing = (error: unknown) => async () => {
    throw error;
  };

  for (const [error, kind] of [
    [refused, TelegramUnreachableError],
    [connectTimeout, TelegramUnreachableError],
    [reset, OutcomeUnknownError],
    [timeout, OutcomeUnknownError],
  ] as const) {
    await assert.rejects(sendWith(throwing(error)), (thrown: Error) => {
      assert.ok(thrown instanceof kind);
      assert.equal(thrown.message.includes(TOKEN), false);
      return true;
    });
  }
  await assert.rejects(sendWith(async () => new Response('bad gateway', { status: 502 })), OutcomeUnknownError);
  await assert.rejects(sendWith(async () => new Response('not json', { status: 200 })), OutcomeUnknownError);
  await assert.rejects(sendWith(async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })), OutcomeUnknownError);
  await assert.rejects(
    sendWith(async () => new Response(JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }), { status: 403 })),
    (thrown: Error & { response?: { error_code?: number } }) => {
      assert.equal(thrown.response?.error_code, 403);
      return true;
    }
  );
});

test('a Telegram outage pauses the daemon without burning attempts, then it delivers', async () => {
  await withStore(async (store, query) => {
    await draftText(store, 'Тест', 1);
    await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:test'), deps(store));
    let down = 3;
    const sent: OutboundMessage[] = [];
    const sender: OutboundSender = {
      async send(message) {
        if (down > 0) {
          down -= 1;
          throw new TelegramUnreachableError('Telegram connection failed');
        }
        sent.push(message);
        return 77;
      },
    };
    const { logs } = await runCycles(store, sender, 4);
    assert.deepEqual(sent.map((message) => message.chatId), [ADMIN]);
    assert.ok(logs.some((line) => line.includes('Telegram API unreachable')));
    const row = await query<{ status: string; attempt_count: number; telegram_message_id: string | number }>(
      'SELECT status, attempt_count, telegram_message_id FROM bot_broadcast_deliveries'
    );
    assert.equal(row.rows[0]?.status, 'sent');
    assert.equal(Number(row.rows[0]?.attempt_count), 1);
    assert.equal(Number(row.rows[0]?.telegram_message_id), 77);
  });
});

test('a rejected BOT_TOKEN (401) pauses the queue instead of failing every recipient', async () => {
  await withStore(async (store, query) => {
    await addUsers(query, [81, 82]);
    await draftText(store, 'Обновление сервиса', 1);
    await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:test'), deps(store));
    let rejected = true;
    const sent: number[] = [];
    const sender: OutboundSender = {
      async send(message) {
        if (rejected) throw Object.assign(new Error('Unauthorized'), { response: { error_code: 401, description: 'Unauthorized' } });
        sent.push(message.chatId);
        return 1;
      },
    };
    const { logs } = await runCycles(store, sender, 2);
    assert.deepEqual(sent, []);
    assert.ok(logs.some((line) => line.includes('rejected BOT_TOKEN')));
    const row = await query<{ status: string; attempt_count: number }>('SELECT status, attempt_count FROM bot_broadcast_deliveries');
    assert.equal(row.rows[0]?.status, 'pending');
    assert.equal(Number(row.rows[0]?.attempt_count), 0);
    rejected = false;
    await runCycles(store, sender, 1);
    assert.deepEqual(sent, [ADMIN]);
  });
});

test('stop during a long retry or flood wait ends the daemon promptly', async () => {
  await withStore(async (store, query) => {
    await addUsers(query, [91]);
    await draftText(store, 'Обновление сервиса', 1);
    await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:test'), deps(store));
    let stopping = false;
    let waited = 0;
    const sender: OutboundSender = {
      async send() {
        stopping = true;
        throw Object.assign(new Error('Too Many Requests'), { response: { error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 600 } } });
      },
    };
    await runBroadcastDaemon(store, sender, settings(), {
      shouldStop: () => stopping,
      sleep: async (ms) => {
        waited += ms;
      },
      log: () => undefined,
    });
    assert.ok(waited <= 1000, `waited ${waited} ms after stop`);
    assert.equal((await statuses(query))[ADMIN], 'pending');
  });
});

test('403, 429 and network errors in the daemon keep their meaning', async () => {
  await withStore(async (store, query) => {
    await addUsers(query, [51, 52, 53]);
    await draftText(store, 'Обновление сервиса', 1);
    await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:test'), deps(store));
    await confirmMass(store, 4);
    const failure = (code: number, description: string, retryAfter?: number) =>
      Object.assign(new Error(description), { response: { error_code: code, description, parameters: retryAfter ? { retry_after: retryAfter } : undefined } });
    let rateLimited = false;
    const sent: number[] = [];
    const sender: OutboundSender = {
      async send(message) {
        if (message.chatId === 51) throw failure(403, 'Forbidden: bot was blocked by the user');
        if (message.chatId === 52 && !rateLimited) {
          rateLimited = true;
          throw failure(429, 'Too Many Requests: retry after 3', 3);
        }
        sent.push(message.chatId);
        return 500 + sent.length;
      },
    };
    await runCycles(store, sender, 4, { massEnabled: true });
    const status = await statuses(query);
    assert.equal(status[51], 'blocked');
    assert.equal(status[52], 'sent');
    assert.equal(status[53], 'sent');
    assert.deepEqual(sent, [ADMIN, 52, 53]);
    const contact = await query<{ blocked_at: string | null }>('SELECT blocked_at FROM bot_broadcast_contacts WHERE telegram_id = 51');
    assert.notEqual(contact.rows[0]?.blocked_at ?? null, null);
  });
});

test('stopping the campaign in /admin halts the daemon before the next recipient', async () => {
  await withStore(async (store, query) => {
    await addUsers(query, [61, 62, 63]);
    await draftText(store, 'Обновление сервиса', 1);
    await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:test'), deps(store));
    await confirmMass(store, 4);
    const sent: OutboundMessage[] = [];
    const sender = recordingSender(sent, async (message) => {
      if (message.chatId === 61) await handleBroadcastTurn(callbackUpdate(50, ADMIN, 'ba:stop'), deps(store));
    });
    await runCycles(store, sender, 3, { massEnabled: true });
    assert.deepEqual(sent.map((message) => message.chatId), [ADMIN, 61]);
    const status = await statuses(query);
    assert.equal(status[62], 'pending');
    assert.equal(status[63], 'pending');
  });
});

test('the daemon sends photo + HTML caption + both buttons for a banner test', async () => {
  await withStore(async (store) => {
    await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:update'), deps(store));
    await handleBroadcastTurn(callbackUpdate(2, ADMIN, 'ba:photo'), deps(store));
    await handleBroadcastTurn(photoUpdate(3, 'AgACbanner'), deps(store));
    await handleBroadcastTurn(callbackUpdate(4, ADMIN, 'ba:test'), deps(store));
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch = (async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 9001 } }), { status: 200 });
    }) as unknown as typeof fetch;
    await runCycles(store, createTelegramSender(TOKEN, fakeFetch), 2);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/sendPhoto$/);
    assert.equal(calls[0].body.photo, 'AgACbanner');
    assert.equal(calls[0].body.parse_mode, 'HTML');
    assert.match(String(calls[0].body.caption), /<b>GameNight Host теперь на отдельном сайте!<\/b>/);
    const rows = (calls[0].body.reply_markup as { inline_keyboard: Array<Array<Record<string, unknown>>> }).inline_keyboard;
    assert.equal(rows.length, 2);
    assert.equal(rows[0][0].text, '🌐 Открыть WEB-версию');
    assert.equal(typeof rows[0][0].url, 'string');
    assert.deepEqual(rows[1][0], { text: '🎮 Играть в Mini App', web_app: { url: MINI_APP } });
  });
});

test('missing migration 003 is diagnosed and nothing is sent', async () => {
  await withStore(
    async (store, query) => {
      assert.deepEqual(await store.schemaProblems(), ['migration 003 missing: button_mode / web_url columns']);
      await query(
        `INSERT INTO bot_broadcast_campaigns (admin_id, kind, audience, body_html, status, recipient_count)
         VALUES (${ADMIN}, 'test', 'notify', 'x', 'queued', 1)`
      );
      await query(`INSERT INTO bot_broadcast_deliveries (campaign_id, telegram_id, status) VALUES (1, ${ADMIN}, 'pending')`);
      const sent: OutboundMessage[] = [];
      let sleeps = 0;
      const logs: string[] = [];
      await runBroadcastDaemon(store, recordingSender(sent), settings(), {
        shouldStop: () => sleeps > 150,
        sleep: async () => {
          sleeps += 1;
        },
        log: (message, details) => logs.push(`${message} ${JSON.stringify(details ?? {})}`),
      });
      assert.deepEqual(sent, []);
      assert.ok(logs.some((line) => line.includes('migration 003 missing')));
    },
    ['002_bot_broadcast.sql']
  );
  await withStore(async (store) => {
    assert.deepEqual(await store.schemaProblems(), []);
  });
});

test('the least-privilege role from grants.sql is enough to run the worker', async () => {
  await withStore(async (store, query) => {
    await addUsers(query, [71]);
    await draftText(store, 'Обновление сервиса', 1);
    await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:test'), deps(store));
    await confirmMass(store, 4);
    const grants = fs
      .readFileSync(path.join(process.cwd(), 'deploy', 'broadcast-worker', 'grants.sql'), 'utf8')
      .split('\n')
      .filter((line) => /^\s*GRANT .* ON (bot_broadcast_|users)/.test(line))
      .join('\n');
    await query('CREATE ROLE gamenight_broadcast_worker');
    await query('GRANT USAGE ON SCHEMA public TO gamenight_broadcast_worker');
    for (const statement of grants.split(';').map((item) => item.trim()).filter(Boolean)) await query(statement);
    await query('SET ROLE gamenight_broadcast_worker');
    assert.equal(await store.tablesReady(), true);
    assert.deepEqual(await store.schemaProblems(), []);
    await assert.rejects(query('SELECT * FROM bot_broadcast_drafts'), /permission denied/);
    const sent: OutboundMessage[] = [];
    await runCycles(store, recordingSender(sent), 3, { massEnabled: true });
    assert.deepEqual(sent.map((message) => message.chatId), [ADMIN, 71]);
    await query('RESET ROLE');
  });
});

test('daemon settings default to test-only and validate numbers', () => {
  const defaults = readDaemonSettings({}, MINI_APP);
  assert.equal(defaults.massEnabled, false);
  assert.equal(defaults.pollMs, 5000);
  assert.equal(defaults.maxQueuedAgeHours, 24);
  assert.equal(defaults.minIntervalMs, 60);
  for (const value of ['1', 'TRUE', 'yes', ' true']) {
    assert.equal(readDaemonSettings({ BROADCAST_MASS_ENABLED: value }, MINI_APP).massEnabled, false, value);
  }
  assert.equal(readDaemonSettings({ BROADCAST_MASS_ENABLED: 'true' }, MINI_APP).massEnabled, true);
  assert.equal(readDaemonSettings({ BROADCAST_MAX_QUEUED_AGE_HOURS: '0' }, MINI_APP).maxQueuedAgeHours, null);
  assert.throws(() => readDaemonSettings({ BROADCAST_POLL_SECONDS: '0' }, MINI_APP));
  assert.throws(() => readDaemonSettings({ BROADCAST_MIN_INTERVAL_MS: '10' }, MINI_APP), /50-10000/);
});

test('worker CLI knows the daemon modes', () => {
  assert.deepEqual(parseWorkerArgs(['--daemon']), { mode: 'daemon' });
  assert.deepEqual(parseWorkerArgs(['--schema']), { mode: 'schema' });
  assert.deepEqual(parseWorkerArgs(['--healthcheck']), { mode: 'healthcheck' });
  assert.equal(parseWorkerArgs(['--daemon', '--max-sends=5']).mode, 'usage');
  assert.equal(parseWorkerArgs(['--daemon', '--send-mass']).mode, 'usage');
});

test('heartbeat freshness drives the container health check', () => {
  const file = path.join(os.tmpdir(), `gnh-heartbeat-${process.pid}-${Date.now()}`);
  assert.equal(heartbeatIsFresh(file, 60_000), false);
  fs.writeFileSync(file, '1');
  try {
    assert.equal(heartbeatIsFresh(file, 60_000), true);
    assert.equal(heartbeatIsFresh(file, 60_000, Date.now() + 120_000), false);
  } finally {
    fs.unlinkSync(file);
  }
});

test('deploy files keep the worker isolated and test-only by default', () => {
  const dir = path.join(process.cwd(), 'deploy', 'broadcast-worker');
  const dockerfile = fs.readFileSync(path.join(dir, 'Dockerfile'), 'utf8');
  const compose = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
  const env = fs.readFileSync(path.join(dir, 'worker.env.example'), 'utf8');
  assert.match(dockerfile, /broadcastWorkerMain\.js", "--daemon"/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /USER node/);
  assert.match(compose, /restart: unless-stopped/);
  assert.equal(/^\s*ports:/m.test(compose), false, 'the worker exposes no ports');
  assert.match(env, /^BROADCAST_MASS_ENABLED=false$/m);
  const settingsOnly = env.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n');
  assert.equal(/sslmode=(disable|no-verify)|NODE_TLS_REJECT_UNAUTHORIZED/.test(settingsOnly), false);
  assert.equal(fs.existsSync(path.join(process.cwd(), 'Dockerfile')), false, 'no root Dockerfile: Timeweb keeps building the bot as before');
});
