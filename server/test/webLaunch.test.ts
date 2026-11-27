import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  BROADCAST_OPEN_BUTTON,
  BROADCAST_WEB_BUTTON,
  DEFAULT_WEB_URL,
  WEB_UPDATE_BUTTON,
  WEB_UPDATE_URL,
  webButtonLabel,
  buildBroadcastMarkup,
  httpsUrl,
  nextButtonMode,
} from '../src/broadcastButtons.js';
import { handleBroadcastTurn } from '../src/broadcastPanel.js';
import {
  WEB_LAUNCH_PRESET,
  WEB_LAUNCH_URL,
  WEB_UPDATE_PRESET,
  containsUnverifiedClaims,
  evaluateMassSendGate,
  findUnverifiedClaims,
  hasAdLabel,
  isPromotionalWebLaunch,
  isWebLaunchText,
} from '../src/broadcastPresets.js';
import { createBroadcastStore, type BroadcastStore } from '../src/broadcastStore.js';
import { DEFAULT_MIN_INTERVAL_MS, runBroadcastWorker, type OutboundMessage, type OutboundSender } from '../src/broadcastWorker.js';
import { parseWorkerArgs } from '../src/broadcastWorkerMain.js';
import { assertMigrationIsSafe } from '../src/migrationSql.js';
import type { SqlConnection, SqlQuery } from '../src/premiumReader.js';
import { checkTelegramHtml } from '../src/telegramHtml.js';

const ADMIN = 434230321;
const MINI_APP = 'https://mini.example/app';

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
    callback_query: {
      id: `cb-${updateId}`,
      data,
      from: person(fromId),
      message: { message_id: 1, date: 1, chat: { id: fromId, type: 'private' } },
    },
  };
}

async function withStore(fn: (store: BroadcastStore, query: SqlQuery) => Promise<void>): Promise<void> {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  await pg.exec("SET TIME ZONE 'UTC'");
  await pg.exec(`
    CREATE TABLE users (telegram_id BIGINT PRIMARY KEY);
    CREATE TABLE subscriptions (telegram_id BIGINT, plan_id TEXT, active_until TIMESTAMP, PRIMARY KEY (telegram_id, plan_id));
  `);
  for (const file of ['002_bot_broadcast.sql', '003_bot_broadcast_buttons.sql']) {
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

function deps(store: BroadcastStore) {
  return { adminId: ADMIN, miniAppUrl: MINI_APP, store };
}

type Reply = Awaited<ReturnType<typeof handleBroadcastTurn>>;

function buttons(reply: Reply): Array<Record<string, unknown>> {
  return (reply?.reply_markup?.inline_keyboard?.flat() ?? []) as Array<Record<string, unknown>>;
}

function tokenOf(reply: Reply): string {
  const button = buttons(reply).find((item) => String(item.callback_data ?? '').startsWith('ba:go:'));
  return String(button?.callback_data ?? '');
}

async function consent(store: BroadcastStore, query: SqlQuery, id: number, updateId: number): Promise<void> {
  await query('INSERT INTO users (telegram_id) VALUES ($1::bigint) ON CONFLICT DO NOTHING', [id]);
  await handleBroadcastTurn(textUpdate(updateId, id, '/subscribe'), deps(store));
  await handleBroadcastTurn(callbackUpdate(updateId + 1, id, 'bc:ads:on'), deps(store));
}

async function count(query: SqlQuery, table: string): Promise<number> {
  const result = await query<{ count: string | number }>(`SELECT count(*)::int AS count FROM ${table}`);
  return Number(result.rows[0]?.count);
}

test('migration 003 only adds button columns and passes the safety check', () => {
  const sql = fs.readFileSync(path.join(process.cwd(), 'server', 'db', 'migrations', '003_bot_broadcast_buttons.sql'), 'utf8');
  assertMigrationIsSafe(sql);
  assert.equal(/\bCREATE\s+TABLE\b|\bDROP\b|\bDELETE\b/i.test(sql), false);
  assert.match(sql, /bot_broadcast_campaigns/);
});

test('button modes: web is a plain URL button, Mini App is web_app, both keeps both', () => {
  const urls = { miniAppUrl: MINI_APP, webUrl: WEB_LAUNCH_URL };
  const web = buildBroadcastMarkup('web', true, urls);
  assert.deepEqual(web?.inline_keyboard, [[{ text: BROADCAST_WEB_BUTTON, url: WEB_LAUNCH_URL }]]);
  const miniapp = buildBroadcastMarkup('miniapp', true, urls);
  assert.deepEqual(miniapp?.inline_keyboard, [[{ text: BROADCAST_OPEN_BUTTON, web_app: { url: MINI_APP } }]]);
  const both = buildBroadcastMarkup('both', true, urls);
  assert.equal(both?.inline_keyboard.length, 2);
  assert.equal('url' in (both?.inline_keyboard[0][0] ?? {}), true);
  assert.equal('web_app' in (both?.inline_keyboard[0][0] ?? {}), false);
  assert.equal('web_app' in (both?.inline_keyboard[1][0] ?? {}), true);
  assert.equal(buildBroadcastMarkup('both', false, urls), null);
  assert.equal(BROADCAST_WEB_BUTTON, '🌐 Открыть новый сайт');
  assert.equal(BROADCAST_OPEN_BUTTON, '🎮 Играть в Mini App');
  assert.equal(nextButtonMode(nextButtonMode(nextButtonMode('web'))), 'web');
});

test('button URLs fall back safely', () => {
  assert.equal(buildBroadcastMarkup('web', true, { miniAppUrl: null, webUrl: null })?.inline_keyboard[0][0].text, BROADCAST_WEB_BUTTON);
  assert.equal(
    (buildBroadcastMarkup('web', true, { miniAppUrl: null, webUrl: 'http://insecure.example' })?.inline_keyboard[0][0] as { url: string }).url,
    DEFAULT_WEB_URL
  );
  assert.equal(buildBroadcastMarkup('miniapp', true, { miniAppUrl: null, webUrl: null }), null);
  assert.equal(buildBroadcastMarkup('both', true, { miniAppUrl: null, webUrl: WEB_LAUNCH_URL })?.inline_keyboard.length, 1);
  assert.equal(httpsUrl('http://x.example'), null);
  assert.equal(httpsUrl('https://user:pass@x.example'), null);
  assert.equal(httpsUrl('https://x.example/?a=1&b=2'), 'https://x.example/?a=1&b=2');
});

test('the web launch URL carries UTM and stays on the site host', () => {
  const url = new URL(WEB_LAUNCH_URL);
  assert.equal(url.origin, 'https://play.gamenighthost.ru');
  assert.equal(url.searchParams.get('utm_source'), 'telegram');
  assert.equal(url.searchParams.get('utm_medium'), 'bot');
  assert.equal(url.searchParams.get('utm_campaign'), 'web_launch_20261127');
});

test('preset text is valid Telegram HTML and has the agreed wording', () => {
  const html = checkTelegramHtml(WEB_LAUNCH_PRESET.bodyHtml);
  assert.equal(html.ok, true);
  if (!html.ok) return;
  assert.ok(html.visibleLength < 4096);
  assert.ok(html.visibleLength <= 1024, 'fits a photo caption');
  const plain = WEB_LAUNCH_PRESET.bodyHtml.replace(/<[^>]+>/g, '');
  for (const line of [
    '🎉 GAMENIGHT HOST ТЕПЕРЬ И БЕЗ VPN!',
    'Надоело включать VPN, ждать загрузки Telegram или сталкиваться с зависаниями?',
    '💜 У нас отличные новости — мы запустили полноценный сайт GameNight Host!',
    'Теперь любимые игры доступны прямо в браузере, без необходимости открывать Telegram.',
    '🔥 И это ещё не всё!',
    '🎡 Колесо фортуны — больше азарта и неожиданных поворотов.',
    '🃏 Ещё больше вопросов — новые поводы смеяться, спорить и узнавать друг друга.',
    '🎮 16 игр и более 15 000 вопросов — для друзей, пар и вечеринок.',
    '📱💻 Играй с телефона или компьютера!',
    'Собирай компанию. Выбирай игру. Вечер начинается! 🚀',
    '👇 Попробуй новый GameNight Host прямо сейчас!',
    'Отключить рекламные сообщения: /unsubscribe',
  ]) {
    assert.ok(plain.includes(line), line);
  }
  assert.equal(WEB_LAUNCH_PRESET.audience, 'ads');
  assert.equal(WEB_LAUNCH_PRESET.buttonMode, 'both');
});

test('HTML check rejects what Telegram would reject', () => {
  assert.equal(checkTelegramHtml('Tom & Jerry').ok, false);
  assert.equal(checkTelegramHtml('1 < 2').ok, false);
  assert.equal(checkTelegramHtml('<script>x</script>').ok, false);
  assert.equal(checkTelegramHtml('<b>open').ok, false);
  assert.equal(checkTelegramHtml('<b><i>x</b></i>').ok, false);
  assert.equal(checkTelegramHtml('<a href="javascript:x">x</a>').ok, false);
  assert.equal(checkTelegramHtml('Tom &amp; Jerry &lt;3').ok, true);
  assert.equal(checkTelegramHtml('<a href="https://play.gamenighthost.ru/">сайт</a>').ok, true);
  const counted = checkTelegramHtml('<b>ab</b> &amp;');
  assert.deepEqual(counted, { ok: true, visibleLength: 4 });
});

test('an ad label is detected as a word, not inside «рекламные»', () => {
  assert.equal(hasAdLabel(WEB_LAUNCH_PRESET.bodyHtml), false);
  assert.equal(hasAdLabel('Реклама. ИП Иванов. erid: abc'), true);
});

test('preset load fills ads audience and both buttons, queues nothing, preview shows both buttons', async () => {
  await withStore(async (store, query) => {
    const loaded = await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:preset'), deps(store));
    assert.match(loaded?.text ?? '', /Ничего не отправлено/);
    assert.match(loaded?.text ?? '', /реклама/);
    assert.equal(await count(query, 'bot_broadcast_campaigns'), 0);
    assert.equal(await count(query, 'bot_broadcast_deliveries'), 0);
    const preview = await handleBroadcastTurn(callbackUpdate(2, ADMIN, 'ba:preview'), deps(store));
    assert.equal(preview?.text, WEB_LAUNCH_PRESET.bodyHtml);
    assert.equal(preview?.parse_mode, 'HTML');
    const rows = preview?.reply_markup?.inline_keyboard ?? [];
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0][0], { text: BROADCAST_WEB_BUTTON, url: WEB_LAUNCH_URL });
    assert.deepEqual(rows[1][0], { text: BROADCAST_OPEN_BUTTON, web_app: { url: MINI_APP } });
  });
});

test('button choice cycles per draft and a new draft goes back to the old default', async () => {
  await withStore(async (store) => {
    await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:new'), deps(store));
    await handleBroadcastTurn(textUpdate(3, ADMIN, 'Привет'), deps(store));
    const first = await handleBroadcastTurn(callbackUpdate(4, ADMIN, 'ba:preview'), deps(store));
    assert.equal(buttons(first).length, 1);
    assert.equal(buttons(first)[0].text, BROADCAST_OPEN_BUTTON);
    await handleBroadcastTurn(callbackUpdate(5, ADMIN, 'ba:btn'), deps(store));
    const both = await handleBroadcastTurn(callbackUpdate(6, ADMIN, 'ba:preview'), deps(store));
    assert.equal(buttons(both).length, 2);
    await handleBroadcastTurn(callbackUpdate(7, ADMIN, 'ba:btn'), deps(store));
    const web = await handleBroadcastTurn(callbackUpdate(8, ADMIN, 'ba:preview'), deps(store));
    assert.equal(buttons(web).length, 1);
    assert.equal(buttons(web)[0].text, BROADCAST_WEB_BUTTON);
    assert.equal(typeof buttons(web)[0].url, 'string');
    await handleBroadcastTurn(callbackUpdate(9, ADMIN, 'ba:cancel'), deps(store));
    await handleBroadcastTurn(callbackUpdate(10, ADMIN, 'ba:new'), deps(store));
    await handleBroadcastTurn(textUpdate(11, ADMIN, 'Снова'), deps(store));
    const fresh = await handleBroadcastTurn(callbackUpdate(12, ADMIN, 'ba:preview'), deps(store));
    assert.equal(buttons(fresh).length, 1);
    assert.equal(buttons(fresh)[0].text, BROADCAST_OPEN_BUTTON);
  });
});

test('a broken or too long text is refused before it is saved', async () => {
  await withStore(async (store) => {
    await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:new'), deps(store));
    const broken = await handleBroadcastTurn(textUpdate(2, ADMIN, '<b>без закрытия'), deps(store));
    assert.match(broken?.text ?? '', /не сохранён/);
    const tooLong = await handleBroadcastTurn(textUpdate(3, ADMIN, 'я'.repeat(4097)), deps(store));
    assert.match(tooLong?.text ?? '', /длиннее 4096/);
    assert.equal((await store.getDraft(ADMIN)).bodyHtml, '');
  });
});

test('the preset fits a caption; a longer text with a photo is refused so it can go as text', async () => {
  await withStore(async (store) => {
    await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:preset'), deps(store));
    await handleBroadcastTurn(callbackUpdate(2, ADMIN, 'ba:photo'), deps(store));
    const photoUpdate = {
      update_id: 3,
      message: { message_id: 3, date: 1, from: person(ADMIN), chat: { id: ADMIN, type: 'private' }, photo: [{ file_id: 'AgACfile', width: 1, height: 1 }] },
    } as never;
    await handleBroadcastTurn(photoUpdate, deps(store));
    assert.equal((await store.getDraft(ADMIN)).photoFileId, 'AgACfile');
  });
  await withStore(async (store) => {
    await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:new'), deps(store));
    await handleBroadcastTurn(textUpdate(2, ADMIN, 'я'.repeat(1100)), deps(store));
    await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:photo'), deps(store));
    const photoUpdate = {
      update_id: 4,
      message: { message_id: 4, date: 1, from: person(ADMIN), chat: { id: ADMIN, type: 'private' }, photo: [{ file_id: 'AgACfile', width: 1, height: 1 }] },
    } as never;
    const refused = await handleBroadcastTurn(photoUpdate, deps(store));
    assert.match(refused?.text ?? '', /не длиннее 1024/);
    assert.equal((await store.getDraft(ADMIN)).photoFileId, null);
  });
});
test('mass queueing of the unverified preset text is blocked, tokens included, and creates nothing', async () => {
  assert.equal(WEB_LAUNCH_PRESET.claimsVerified, false);
  await withStore(async (store, query) => {
    await consent(store, query, 501, 100);
    await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:preset'), deps(store));
    const ask = await handleBroadcastTurn(callbackUpdate(2, ADMIN, 'ba:send'), deps(store));
    assert.match(ask?.text ?? '', /нельзя поставить в очередь/);
    assert.match(ask?.text ?? '', /Колесо фортуны/);
    assert.equal(tokenOf(ask), '');
    const forged = await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:go:aaaaaaaaaaaa'), deps(store));
    assert.match(forged?.text ?? '', /нельзя поставить в очередь|не создана|не принято/);
    assert.equal(await count(query, 'bot_broadcast_campaigns'), 0);
    // The owner can still test the exact text on themselves.
    const test = await handleBroadcastTurn(callbackUpdate(4, ADMIN, 'ba:test'), deps(store));
    assert.match(test?.text ?? '', /только для Telegram ID 434230321/);
    assert.equal(await count(query, 'bot_broadcast_deliveries'), 1);
  });
});

test('a small text edit or notify switch cannot bypass the ads gate', async () => {
  assert.equal(isPromotionalWebLaunch(WEB_LAUNCH_PRESET.bodyHtml), true);
  const edited = WEB_LAUNCH_PRESET.bodyHtml.replace('Колесо фортуны', 'Колесо удачи');
  assert.equal(isWebLaunchText(edited), false);
  assert.equal(isPromotionalWebLaunch(edited), true);
  assert.equal(containsUnverifiedClaims(edited), true);
  assert.equal(evaluateMassSendGate({ audience: 'ads', bodyHtml: edited }).ok, false);
  assert.equal(evaluateMassSendGate({ audience: 'notify', bodyHtml: edited }).ok, false);
  assert.equal(evaluateMassSendGate({ audience: 'notify', bodyHtml: WEB_LAUNCH_PRESET.bodyHtml }).ok, false);

  await withStore(async (store, query) => {
    await consent(store, query, 511, 100);
    await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:new'), deps(store));
    await handleBroadcastTurn(textUpdate(2, ADMIN, edited), deps(store));
    const draft = await store.getDraft(ADMIN);
    draft.audience = 'notify';
    await store.saveDraft(draft);
    const ask = await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:send'), deps(store));
    assert.equal(tokenOf(ask), '');
    assert.match(ask?.text ?? '', /рекламный|нельзя поставить в очередь|информаци/i);
    assert.equal(await count(query, 'bot_broadcast_campaigns'), 0);

    // Even with a confirm token forged into the draft, queueMass refuses.
    draft.step = 'confirm';
    draft.confirmToken = 'bbbbbbbbbbbb';
    draft.audience = 'ads';
    draft.bodyHtml = `${edited}\n\nРеклама.`;
    await store.saveDraft(draft);
    const refused = await store.queueMass(ADMIN, 'bbbbbbbbbbbb');
    assert.deepEqual(refused, { ok: false, reason: 'refused' });
    assert.equal(await count(query, 'bot_broadcast_campaigns'), 0);
  });
});

test('the exact owner-approved WEB update queues for notify without weakening other gates', async () => {
  assert.equal(evaluateMassSendGate({ audience: 'notify', bodyHtml: WEB_UPDATE_PRESET.bodyHtml }).ok, true);
  assert.equal(evaluateMassSendGate({ audience: 'ads', bodyHtml: WEB_UPDATE_PRESET.bodyHtml }).ok, false);
  assert.equal(evaluateMassSendGate({ audience: 'notify', bodyHtml: WEB_UPDATE_PRESET.bodyHtml + ' ' }).ok, false);
  await withStore(async (store, query) => {
    await query('INSERT INTO users (telegram_id) VALUES (60101)');
    await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:update'), deps(store));
    const draft = await store.getDraft(ADMIN);
    assert.equal(draft.bodyHtml, WEB_UPDATE_PRESET.bodyHtml);
    assert.equal(draft.audience, 'notify');
    assert.equal(draft.buttonMode, 'both');
    const ask = await handleBroadcastTurn(callbackUpdate(2, ADMIN, 'ba:send'), deps(store));
    const token = tokenOf(ask);
    assert.match(token, /^ba:go:/);
    await handleBroadcastTurn(callbackUpdate(3, ADMIN, token), deps(store));
    assert.equal(await count(query, 'bot_broadcast_deliveries'), 1);
    const campaigns = await query<{ audience: string; kind: string; button_mode: string }>(
      'SELECT audience, kind, button_mode FROM bot_broadcast_campaigns'
    );
    assert.equal(campaigns.rows[0]?.audience, 'notify');
    assert.equal(campaigns.rows[0]?.kind, 'mass');
    assert.equal(campaigns.rows[0]?.button_mode, 'both');
  });
});

test('missing ad label hard-blocks any ads mass campaign', async () => {
  assert.equal(evaluateMassSendGate({ audience: 'ads', bodyHtml: 'Просто текст без маркировки' }).ok, false);
  assert.equal(evaluateMassSendGate({ audience: 'ads', bodyHtml: 'Реклама. Короткий безопасный текст' }).ok, true);
  await withStore(async (store, query) => {
    await consent(store, query, 521, 10);
    await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:new'), deps(store));
    await handleBroadcastTurn(textUpdate(2, ADMIN, 'Просто текст'), deps(store));
    await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:send'), deps(store));
    const ads = await handleBroadcastTurn(callbackUpdate(4, ADMIN, 'ba:aud'), deps(store));
    assert.equal(tokenOf(ads), '');
    assert.match(ads?.text ?? '', /пометки «Реклама»/);
    assert.equal(await count(query, 'bot_broadcast_campaigns'), 0);
  });
});

test('the preset text cannot be sent to the informational audience either', async () => {
  await withStore(async (store, query) => {
    await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:preset'), deps(store));
    const draft = await store.getDraft(ADMIN);
    draft.audience = 'notify';
    await store.saveDraft(draft);
    const ask = await handleBroadcastTurn(callbackUpdate(2, ADMIN, 'ba:send'), deps(store));
    assert.equal(tokenOf(ask), '');
    assert.equal(await count(query, 'bot_broadcast_campaigns'), 0);
  });
});

test('ads audience takes only consenting, not unsubscribed, not blocked contacts', async () => {
  await withStore(async (store, query) => {
    await consent(store, query, 601, 10);
    await consent(store, query, 602, 20);
    await consent(store, query, 603, 30);
    await query('INSERT INTO users (telegram_id) VALUES (604) ON CONFLICT DO NOTHING');
    await handleBroadcastTurn(textUpdate(40, 604, '/start'), deps(store));
    assert.equal(await store.countRecipients('ads'), 3);
    await handleBroadcastTurn(textUpdate(50, 602, '/unsubscribe'), deps(store));
    await store.markContactBlocked(603);
    assert.equal(await store.countRecipients('ads'), 1);

    await handleBroadcastTurn(callbackUpdate(60, ADMIN, 'ba:new'), deps(store));
    await handleBroadcastTurn(textUpdate(61, ADMIN, 'Реклама. Тестовый текст'), deps(store));
    await handleBroadcastTurn(callbackUpdate(62, ADMIN, 'ba:btn'), deps(store));
    const notifyAsk = await handleBroadcastTurn(callbackUpdate(63, ADMIN, 'ba:send'), deps(store));
    const adsAsk = await handleBroadcastTurn(callbackUpdate(64, ADMIN, 'ba:aud'), deps(store));
    assert.match(adsAsk?.text ?? '', /Получателей: 1\./);
    assert.match(adsAsk?.text ?? '', /реклама/);
    assert.notEqual(notifyAsk?.text, adsAsk?.text);
    assert.equal(/пометки «Реклама»/.test(adsAsk?.text ?? ''), false);
    const token = tokenOf(adsAsk);
    const confirmed = await handleBroadcastTurn(callbackUpdate(65, ADMIN, token), deps(store));
    assert.match(confirmed?.text ?? '', /1 сообщений/);
    const repeated = await handleBroadcastTurn(callbackUpdate(66, ADMIN, token), deps(store));
    assert.match(repeated?.text ?? '', /Повторно получатели не добавлены/);
    const rows = await query<{ telegram_id: string | number }>('SELECT telegram_id FROM bot_broadcast_deliveries');
    assert.deepEqual(rows.rows.map((row) => Number(row.telegram_id)), [601]);
    const campaign = await query<{ audience: string; button_mode: string; web_url: string | null }>(
      'SELECT audience, button_mode, web_url FROM bot_broadcast_campaigns'
    );
    assert.equal(campaign.rows[0]?.audience, 'ads');
    assert.equal(campaign.rows[0]?.button_mode, 'both');
  });
});

test('ads with zero consents refuses the queue without creating a campaign', async () => {
  await withStore(async (store, query) => {
    await query('INSERT INTO users (telegram_id) VALUES (4001)');
    await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:new'), deps(store));
    await handleBroadcastTurn(textUpdate(2, ADMIN, 'Реклама. Короткий безопасный текст'), deps(store));
    await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:send'), deps(store));
    const ads = await handleBroadcastTurn(callbackUpdate(4, ADMIN, 'ba:aud'), deps(store));
    assert.equal(tokenOf(ads), '');
    assert.match(ads?.text ?? '', /Согласий на рекламу пока нет/);
    assert.equal(await count(query, 'bot_broadcast_campaigns'), 0);
  });
});

test('the test copy keeps the draft buttons and the worker sends them to the owner only', async () => {
  await withStore(async (store, query) => {
    await consent(store, query, 701, 10);
    await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:preset'), deps(store));
    await handleBroadcastTurn(callbackUpdate(2, ADMIN, 'ba:test'), deps(store));
    const campaign = await query<{ button_mode: string; web_url: string; kind: string }>(
      'SELECT button_mode, web_url, kind FROM bot_broadcast_campaigns'
    );
    assert.equal(campaign.rows[0]?.kind, 'test');
    assert.equal(campaign.rows[0]?.button_mode, 'both');
    assert.equal(campaign.rows[0]?.web_url, WEB_LAUNCH_URL);
    const sent: OutboundMessage[] = [];
    const sender: OutboundSender = {
      async send(message) {
        sent.push(message);
        return 4242;
      },
    };
    const report = await runBroadcastWorker(store, sender, { miniAppUrl: MINI_APP, minIntervalMs: 0, sleep: async () => undefined });
    assert.equal(report.sent, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].chatId, ADMIN);
    assert.equal(sent[0].text, WEB_LAUNCH_PRESET.bodyHtml);
    assert.deepEqual(sent[0].replyMarkup?.inline_keyboard, [
      [{ text: BROADCAST_WEB_BUTTON, url: WEB_LAUNCH_URL }],
      [{ text: BROADCAST_OPEN_BUTTON, web_app: { url: MINI_APP } }],
    ]);
    const stored = await query<{ telegram_message_id: string | number; status: string }>(
      'SELECT telegram_message_id, status FROM bot_broadcast_deliveries'
    );
    assert.equal(stored.rows[0]?.status, 'sent');
    assert.equal(Number(stored.rows[0]?.telegram_message_id), 4242);
  });
});

test('--only-test style runs never touch a mass queue', async () => {
  await withStore(async (store, query) => {
    await consent(store, query, 801, 10);
    await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:new'), deps(store));
    await handleBroadcastTurn(textUpdate(2, ADMIN, 'Реклама. Текст'), deps(store));
    await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:send'), deps(store));
    const ads = await handleBroadcastTurn(callbackUpdate(4, ADMIN, 'ba:aud'), deps(store));
    await handleBroadcastTurn(callbackUpdate(5, ADMIN, tokenOf(ads)), deps(store));
    const sent: number[] = [];
    const sender: OutboundSender = {
      async send(message) {
        sent.push(message.chatId);
        return 9;
      },
    };
    const onlyTest = await runBroadcastWorker(store, sender, { miniAppUrl: MINI_APP, kind: 'test', minIntervalMs: 0, sleep: async () => undefined });
    assert.equal(onlyTest.sent, 0);
    assert.deepEqual(sent, []);
    assert.equal(await store.queueDepth('mass'), 1);
    const all = await runBroadcastWorker(store, sender, { miniAppUrl: MINI_APP, minIntervalMs: 0, sleep: async () => undefined });
    assert.equal(all.sent, 1);
    assert.deepEqual(sent, [801]);
  });
});

test('mass send re-checks consent before Telegram and skips revoked recipients', async () => {
  await withStore(async (store, query) => {
    await consent(store, query, 901, 10);
    await consent(store, query, 902, 20);
    await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:new'), deps(store));
    await handleBroadcastTurn(textUpdate(2, ADMIN, 'Реклама. Текст'), deps(store));
    await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:send'), deps(store));
    const ads = await handleBroadcastTurn(callbackUpdate(4, ADMIN, 'ba:aud'), deps(store));
    await handleBroadcastTurn(callbackUpdate(5, ADMIN, tokenOf(ads)), deps(store));
    assert.equal(await store.queueDepth('mass'), 2);

    await handleBroadcastTurn(textUpdate(30, 902, '/unsubscribe'), deps(store));
    assert.equal(await store.isStillEligible(902, 'ads'), false);
    assert.equal(await store.isStillEligible(901, 'ads'), true);

    const sent: number[] = [];
    const sender: OutboundSender = {
      async send(message) {
        sent.push(message.chatId);
        return 33;
      },
    };
    const report = await runBroadcastWorker(store, sender, { miniAppUrl: MINI_APP, minIntervalMs: 0, sleep: async () => undefined });
    assert.equal(report.sent, 1);
    assert.equal(report.skipped, 1);
    assert.deepEqual(sent, [901]);
    const rows = await query<{ telegram_id: string | number; status: string }>(
      'SELECT telegram_id, status FROM bot_broadcast_deliveries ORDER BY telegram_id'
    );
    assert.equal(Number(rows.rows[0]?.telegram_id), 901);
    assert.equal(rows.rows[0]?.status, 'sent');
    assert.equal(Number(rows.rows[1]?.telegram_id), 902);
    assert.equal(rows.rows[1]?.status, 'failed');
  });
});

test('stopping a mass campaign still prevents delivery after the eligibility check', async () => {
  await withStore(async (store, query) => {
    await consent(store, query, 911, 10);
    await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:new'), deps(store));
    await handleBroadcastTurn(textUpdate(2, ADMIN, 'Реклама. Текст'), deps(store));
    await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:send'), deps(store));
    const ads = await handleBroadcastTurn(callbackUpdate(4, ADMIN, 'ba:aud'), deps(store));
    await handleBroadcastTurn(callbackUpdate(5, ADMIN, tokenOf(ads)), deps(store));
    await handleBroadcastTurn(callbackUpdate(6, ADMIN, 'ba:stop'), deps(store));
    const sender: OutboundSender = {
      async send() {
        throw new Error('must not send');
      },
    };
    const report = await runBroadcastWorker(store, sender, { miniAppUrl: MINI_APP, minIntervalMs: 0, sleep: async () => undefined });
    // A stopped campaign is no longer claimable (status not queued/running), so nothing is sent
    // and pending rows stay pending. Duplicate confirm tokens still cannot create a second campaign.
    assert.equal(report.sent, 0);
    assert.equal(report.skipped, 0);
    assert.equal(await store.queueDepth('mass'), 0);
    const row = await query<{ status: string }>('SELECT status FROM bot_broadcast_deliveries');
    assert.equal(row.rows[0]?.status, 'pending');
    const again = await handleBroadcastTurn(callbackUpdate(7, ADMIN, tokenOf(ads)), deps(store));
    assert.match(again?.text ?? '', /Повторно получатели не добавлены|не создана|не принято|нельзя/);
    assert.equal(await count(query, 'bot_broadcast_campaigns'), 1);
  });
});

function telegramFailure(code: number, description: string, retryAfter?: number): Error {
  const error = new Error(description);
  (error as { response?: unknown }).response = { error_code: code, description, parameters: retryAfter === undefined ? undefined : { retry_after: retryAfter } };
  return error;
}

async function queueOwnTest(store: BroadcastStore): Promise<void> {
  await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:new'), deps(store));
  await handleBroadcastTurn(textUpdate(2, ADMIN, 'Текст'), deps(store));
  await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:test'), deps(store));
}

test('429 waits for Telegram, does not use up an attempt and then sends', async () => {
  await withStore(async (store, query) => {
    await queueOwnTest(store);
    let calls = 0;
    const sleeps: number[] = [];
    const sender: OutboundSender = {
      async send() {
        calls += 1;
        if (calls === 1) throw telegramFailure(429, 'Too Many Requests: retry after 7', 7);
        return 11;
      },
    };
    const report = await runBroadcastWorker(store, sender, {
      miniAppUrl: MINI_APP,
      minIntervalMs: 0,
      maxAttempts: 1,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(report.rateLimited, 1);
    assert.equal(report.sent, 1);
    assert.equal(report.failed, 0);
    assert.ok(sleeps.includes(7000));
    const row = await query<{ status: string }>('SELECT status FROM bot_broadcast_deliveries');
    assert.equal(row.rows[0]?.status, 'sent');
  });
});

test('a long retry_after is honoured instead of being cut to 30 seconds', async () => {
  await withStore(async (store) => {
    await queueOwnTest(store);
    let calls = 0;
    const sleeps: number[] = [];
    const sender: OutboundSender = {
      async send() {
        calls += 1;
        if (calls === 1) throw telegramFailure(429, 'Too Many Requests', 120);
        return 12;
      },
    };
    await runBroadcastWorker(store, sender, { miniAppUrl: MINI_APP, minIntervalMs: 0, sleep: async (ms) => void sleeps.push(ms) });
    assert.ok(sleeps.includes(120_000));
  });
});

test('endless 429 stops the run and keeps the queue', async () => {
  await withStore(async (store, query) => {
    await queueOwnTest(store);
    const sender: OutboundSender = {
      async send() {
        throw telegramFailure(429, 'Too Many Requests', 1);
      },
    };
    const report = await runBroadcastWorker(store, sender, { miniAppUrl: MINI_APP, minIntervalMs: 0, sleep: async () => undefined });
    assert.equal(report.aborted, true);
    const row = await query<{ status: string }>('SELECT status FROM bot_broadcast_deliveries');
    assert.equal(row.rows[0]?.status, 'pending');
  });
});

test('a bad request that is not a block fails at once without retries', async () => {
  await withStore(async (store, query) => {
    await queueOwnTest(store);
    let calls = 0;
    const sender: OutboundSender = {
      async send() {
        calls += 1;
        throw telegramFailure(400, "Bad Request: can't parse entities");
      },
    };
    const report = await runBroadcastWorker(store, sender, { miniAppUrl: MINI_APP, minIntervalMs: 0, maxAttempts: 5, sleep: async () => undefined });
    assert.equal(calls, 1);
    assert.equal(report.failed, 1);
    assert.equal(report.retried, 0);
    const row = await query<{ status: string }>('SELECT status FROM bot_broadcast_deliveries');
    assert.equal(row.rows[0]?.status, 'failed');
  });
});

test('a blocked bot is recorded as blocked and a network error is retried', async () => {
  await withStore(async (store, query) => {
    await queueOwnTest(store);
    const blocked: OutboundSender = {
      async send() {
        throw telegramFailure(403, 'Forbidden: bot was blocked by the user');
      },
    };
    const first = await runBroadcastWorker(store, blocked, { miniAppUrl: MINI_APP, minIntervalMs: 0, sleep: async () => undefined });
    assert.equal(first.blocked, 1);
    const row = await query<{ status: string }>('SELECT status FROM bot_broadcast_deliveries');
    assert.equal(row.rows[0]?.status, 'blocked');
  });
  await withStore(async (store, query) => {
    await queueOwnTest(store);
    const offline: OutboundSender = {
      async send() {
        throw new Error('Telegram connection failed');
      },
    };
    const report = await runBroadcastWorker(store, offline, { miniAppUrl: MINI_APP, minIntervalMs: 0, maxSends: 1, sleep: async () => undefined });
    assert.equal(report.retried, 1);
    const row = await query<{ status: string }>('SELECT status FROM bot_broadcast_deliveries');
    assert.equal(row.rows[0]?.status, 'pending');
  });
});

test('default pace is 15 to 20 messages per second', () => {
  const perSecond = 1000 / DEFAULT_MIN_INTERVAL_MS;
  assert.ok(perSecond >= 15 && perSecond <= 20, String(perSecond));
});

test('worker CLI needs an explicit mode and keeps --only-test limited to tests', () => {
  assert.equal(parseWorkerArgs([]).mode, 'usage');
  assert.equal(parseWorkerArgs(['--check', '--status']).mode, 'usage');
  assert.equal(parseWorkerArgs(['--bogus']).mode, 'usage');
  assert.deepEqual(parseWorkerArgs(['--check']), { mode: 'check' });
  assert.deepEqual(parseWorkerArgs(['--status']), { mode: 'status' });
  assert.deepEqual(parseWorkerArgs(['--only-test']), { mode: 'send', kind: 'test', maxSends: undefined });
  assert.deepEqual(parseWorkerArgs(['--send-mass', '--max-sends=5']), { mode: 'send', kind: undefined, maxSends: 5 });
  assert.equal(parseWorkerArgs(['--only-test', '--max-sends=0']).mode, 'usage');
  assert.equal(parseWorkerArgs(['--only-test', '--max-sends=abc']).mode, 'usage');
});

test('the web launch module is not wired into the webhook process', () => {
  const main = fs.readFileSync(path.join(process.cwd(), 'server', 'src', 'main.ts'), 'utf8');
  assert.equal(main.includes('runBroadcastWorker'), false);
  assert.equal(isWebLaunchText(WEB_LAUNCH_PRESET.bodyHtml), true);
  assert.equal(isWebLaunchText(`${WEB_LAUNCH_PRESET.bodyHtml} `), false);
});

const NEUTRAL_NOTICE = 'Обновление: у GameNight Host появилась веб-версия. Mini App продолжает работать.\n\nОтключить уведомления: /unsubscribe';

const BANNER_UPDATE = {
  update_id: 900,
  message: {
    message_id: 900,
    date: 1,
    from: person(ADMIN),
    chat: { id: ADMIN, type: 'private' },
    photo: [
      { file_id: 'AgACsmall', width: 90, height: 90 },
      { file_id: 'AgACbanner', width: 1280, height: 720 },
    ],
  },
} as never;

test('update preset: HTML caption fits 1024, bold is HTML, exact wording and URL', () => {
  const body = WEB_UPDATE_PRESET.bodyHtml;
  const html = checkTelegramHtml(body);
  assert.equal(html.ok, true);
  if (html.ok) assert.ok(html.visibleLength <= 1024, String(html.visibleLength));
  assert.match(body, /<b>GameNight Host теперь на отдельном сайте!<\/b>/);
  assert.match(body, /<b>Что нового\?<\/b>/);
  assert.equal(body.includes('**'), false);
  assert.ok(body.includes('🌐 https://play.gamenighthost.ru/'));
  assert.ok(body.endsWith('Отключить уведомления: /unsubscribe'));
  const plain = body.replace(/<[^>]+>/g, '');
  for (const line of [
    'Больше не нужно ждать загрузки Telegram или включать VPN для Mini App — игры теперь доступны прямо в браузере! 💜',
    '🌐 Отдельный WEB-сайт — запуск игр без ожидания загрузки Telegram.',
    '🎡 Колесо фортуны — новый способ выбирать задания.',
    '🃏 Больше вопросов — обновлённые игровые подборки.',
    '💳 Premium на сайте — оформление и оплата через браузер.',
    '🔄 Восстановление Premium — перенос доступа из Telegram после привязки аккаунта.',
    '📱💻 С телефона и компьютера!',
    '🎮 Telegram Mini App продолжает работать.',
  ]) {
    assert.ok(plain.includes(line), line);
  }
  assert.equal(WEB_UPDATE_PRESET.audience, 'notify');
  assert.equal(WEB_UPDATE_PRESET.buttonMode, 'both');
  assert.equal(WEB_UPDATE_PRESET.webUrl, WEB_UPDATE_URL);
  const url = new URL(WEB_UPDATE_URL);
  assert.equal(url.origin, 'https://play.gamenighthost.ru');
  assert.equal(url.searchParams.get('utm_campaign'), 'web_update_20261127');
});

test('update buttons: own site label, plain URL, web_app for Mini App; other campaigns keep their label', () => {
  const markup = buildBroadcastMarkup('both', true, { miniAppUrl: MINI_APP, webUrl: WEB_UPDATE_URL });
  assert.deepEqual(markup?.inline_keyboard, [
    [{ text: '🌐 Открыть WEB-версию', url: WEB_UPDATE_URL }],
    [{ text: '🎮 Играть в Mini App', web_app: { url: MINI_APP } }],
  ]);
  assert.equal(WEB_UPDATE_BUTTON, '🌐 Открыть WEB-версию');
  assert.equal(webButtonLabel(WEB_LAUNCH_URL), BROADCAST_WEB_BUTTON);
  assert.equal(webButtonLabel(null), BROADCAST_WEB_BUTTON);
});

test('unverified product claims in the update text block mass queueing for notify', async () => {
  const found = findUnverifiedClaims(WEB_UPDATE_PRESET.bodyHtml);
  assert.ok(found.some((label) => /Колесо/.test(label)));
  assert.ok(found.some((label) => /Premium/.test(label)));
  assert.equal(isPromotionalWebLaunch(WEB_UPDATE_PRESET.bodyHtml), false);
  assert.equal(evaluateMassSendGate({ audience: 'notify', bodyHtml: WEB_UPDATE_PRESET.bodyHtml }).ok, false);
  assert.equal(evaluateMassSendGate({ audience: 'notify', bodyHtml: NEUTRAL_NOTICE }).ok, true);
  await withStore(async (store, query) => {
    await query('INSERT INTO users (telegram_id) VALUES (2001)');
    const loaded = await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:update'), deps(store));
    assert.match(loaded?.text ?? '', /Массовая отправка заблокирована/);
    const ask = await handleBroadcastTurn(callbackUpdate(2, ADMIN, 'ba:send'), deps(store));
    assert.equal(tokenOf(ask), '');
    assert.match(ask?.text ?? '', /Колесо фортуны/);
    const forged = await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:go:cccccccccccc'), deps(store));
    assert.match(forged?.text ?? '', /нельзя поставить в очередь/);
    assert.equal(await count(query, 'bot_broadcast_campaigns'), 0);
    assert.equal(await count(query, 'bot_broadcast_deliveries'), 0);
  });
});

test('banner flow: preset + photo file_id gives an exact sendPhoto preview with caption and two buttons', async () => {
  await withStore(async (store) => {
    await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:update'), deps(store));
    await handleBroadcastTurn(callbackUpdate(2, ADMIN, 'ba:photo'), deps(store));
    const saved = await handleBroadcastTurn(BANNER_UPDATE, deps(store));
    assert.match(saved?.text ?? '', /Фотография: есть/);
    assert.equal((await store.getDraft(ADMIN)).photoFileId, 'AgACbanner');
    const preview = await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:preview'), deps(store));
    assert.equal(preview?.method, 'sendPhoto');
    assert.equal(preview?.photo, 'AgACbanner');
    assert.equal(preview?.caption, WEB_UPDATE_PRESET.bodyHtml);
    assert.equal(preview?.parse_mode, 'HTML');
    assert.deepEqual(preview?.reply_markup?.inline_keyboard, [
      [{ text: '🌐 Открыть WEB-версию', url: WEB_UPDATE_URL }],
      [{ text: '🎮 Играть в Mini App', web_app: { url: MINI_APP } }],
    ]);
  });
});

test('owner test sends the banner as sendPhoto with HTML caption to the admin only', async () => {
  await withStore(async (store, query) => {
    await query('INSERT INTO users (telegram_id) VALUES (3001), (3002)');
    await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:update'), deps(store));
    await handleBroadcastTurn(callbackUpdate(2, ADMIN, 'ba:photo'), deps(store));
    await handleBroadcastTurn(BANNER_UPDATE, deps(store));
    await handleBroadcastTurn(callbackUpdate(4, ADMIN, 'ba:test'), deps(store));
    assert.equal(await count(query, 'bot_broadcast_deliveries'), 1);

    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch = (async (url: string, init?: { body?: string }) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 555 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const { createTelegramSender } = await import('../src/broadcastWorker.js');
    const sender = createTelegramSender('123456789:AAFakeTokenForTestsOnly000', fakeFetch);
    const report = await runBroadcastWorker(store, sender, { miniAppUrl: MINI_APP, kind: 'test', maxSends: 1, minIntervalMs: 0, sleep: async () => undefined });
    assert.equal(report.sent, 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/sendPhoto$/);
    assert.equal(calls[0].body.chat_id, ADMIN);
    assert.equal(calls[0].body.photo, 'AgACbanner');
    assert.equal(calls[0].body.caption, WEB_UPDATE_PRESET.bodyHtml);
    assert.equal(calls[0].body.parse_mode, 'HTML');
    assert.deepEqual((calls[0].body.reply_markup as { inline_keyboard: unknown }).inline_keyboard, [
      [{ text: '🌐 Открыть WEB-версию', url: WEB_UPDATE_URL }],
      [{ text: '🎮 Играть в Mini App', web_app: { url: MINI_APP } }],
    ]);
    const row = await query<{ telegram_id: string | number; telegram_message_id: string | number; status: string }>(
      'SELECT telegram_id, telegram_message_id, status FROM bot_broadcast_deliveries'
    );
    assert.equal(row.rows.length, 1);
    assert.equal(Number(row.rows[0]?.telegram_id), ADMIN);
    assert.equal(Number(row.rows[0]?.telegram_message_id), 555);
    assert.equal(row.rows[0]?.status, 'sent');
  });
});

test('notify audience: skips unsubscribed and blocked, re-checks before send, never twice', async () => {
  await withStore(async (store, query) => {
    for (const id of [1001, 1002, 1003, 1004]) await query('INSERT INTO users (telegram_id) VALUES ($1::bigint)', [id]);
    await handleBroadcastTurn(textUpdate(10, 1002, '/unsubscribe'), deps(store));
    await store.markContactBlocked(1003);

    await handleBroadcastTurn(callbackUpdate(1, ADMIN, 'ba:new'), deps(store));
    await handleBroadcastTurn(textUpdate(2, ADMIN, NEUTRAL_NOTICE), deps(store));
    await handleBroadcastTurn(callbackUpdate(3, ADMIN, 'ba:btn'), deps(store));
    const preview = await handleBroadcastTurn(callbackUpdate(4, ADMIN, 'ba:preview'), deps(store));
    assert.equal(preview?.text, NEUTRAL_NOTICE);
    assert.equal(buttons(preview).length, 2);

    const ask = await handleBroadcastTurn(callbackUpdate(5, ADMIN, 'ba:send'), deps(store));
    assert.match(ask?.text ?? '', /Получателей: 2\./);
    const confirmed = await handleBroadcastTurn(callbackUpdate(6, ADMIN, tokenOf(ask)), deps(store));
    assert.match(confirmed?.text ?? '', /2 сообщений/);
    const campaign = await query<{ audience: string; kind: string }>('SELECT audience, kind FROM bot_broadcast_campaigns');
    assert.deepEqual(campaign.rows[0], { audience: 'notify', kind: 'mass' });

    await handleBroadcastTurn(textUpdate(11, 1004, '/unsubscribe'), deps(store));
    const sent: number[] = [];
    const sender: OutboundSender = {
      async send(message) {
        sent.push(message.chatId);
        return 70 + sent.length;
      },
    };
    const report = await runBroadcastWorker(store, sender, { miniAppUrl: MINI_APP, minIntervalMs: 0, sleep: async () => undefined });
    assert.deepEqual(sent, [1001]);
    assert.equal(report.sent, 1);
    assert.equal(report.skipped, 1);

    await handleBroadcastTurn(callbackUpdate(20, ADMIN, 'ba:new'), deps(store));
    await handleBroadcastTurn(textUpdate(21, ADMIN, NEUTRAL_NOTICE), deps(store));
    const again = await handleBroadcastTurn(callbackUpdate(22, ADMIN, 'ba:send'), deps(store));
    assert.equal(tokenOf(again), '');
    assert.match(again?.text ?? '', /Получателей: 0/);
    assert.equal(await count(query, 'bot_broadcast_campaigns'), 1);
  });
});
