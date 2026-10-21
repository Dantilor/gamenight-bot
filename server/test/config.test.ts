import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildWebhookUrl, isEnabled, readConfig } from '../src/config.js';
import { redact } from '../src/log.js';
import { assertMigrationIsSafe, migrationStatements, readMigrationSql } from '../src/migrationSql.js';
import { fetchPlans, formatTariffs, plansUrl, premiumPageUrl } from '../src/plans.js';

const root = process.cwd();

test('feature flags stay off unless the value is true', () => {
  assert.equal(isEnabled(undefined), false);
  assert.equal(isEnabled(''), false);
  assert.equal(isEnabled('false'), false);
  assert.equal(isEnabled('0'), false);
  assert.equal(isEnabled('TRUE'), true);
});

test('config ignores Render and keeps registration off by default', () => {
  const config = readConfig({
    BOT_TOKEN: '123456789:AAFakeTokenForTestsOnly000',
    RENDER_EXTERNAL_URL: 'https://telegram-card-game.onrender.com',
    MINI_APP_URL: 'https://mini.example',
  });
  assert.equal(config.publicUrl, '');
  assert.equal(config.enableWebhookRegistration, false);
  assert.equal(config.enableSubscriptionNotifications, false);
  assert.equal(config.webhookPath, '/telegram/webhook-9f3k2lQp');
  assert.equal(config.miniAppUrl, 'https://mini.example');
});

test('webhook URL is https and drops query and hash', () => {
  assert.equal(
    buildWebhookUrl('https://bot.example/ignored?token=secret#frag', '/telegram/test-hook'),
    'https://bot.example/telegram/test-hook'
  );
  assert.throws(() => buildWebhookUrl('http://bot.example', '/telegram/test-hook'));
});

test('premium page is the Mini App /premium route', () => {
  assert.equal(
    premiumPageUrl('https://dantilor-telegram-card-game-a2cc.twc1.net/games?x=1#pay'),
    'https://dantilor-telegram-card-game-a2cc.twc1.net/premium'
  );
  assert.equal(premiumPageUrl('http://mini.example'), null);
  assert.equal(plansUrl('https://dantilor-telegram-card-game-3706.twc1.net/ignored'), 'https://dantilor-telegram-card-game-3706.twc1.net/api/plans');
});

test('tariffs come from the API and do not invent a yearly plan', async () => {
  const text = formatTariffs([
    { id: 'premium_lifetime', title: 'Premium навсегда', priceRub: 990, durationDays: 36500 },
    { id: 'premium_1m', title: 'Premium на 1 месяц', priceRub: 259, durationDays: 30 },
    { id: 'premium_3m', title: 'Premium на 3 месяца', priceRub: 399, durationDays: 90 },
  ]);
  assert.match(text, /1 месяц — 259 ₽/);
  assert.match(text, /3 месяца — 399 ₽/);
  assert.match(text, /Навсегда — 990 ₽/);
  assert.equal(text.includes('Год'), false);

  let requested = '';
  const plans = await fetchPlans('https://api.example', async (input) => {
    requested = String(input);
    return new Response(JSON.stringify({
      ok: true,
      plans: [{ id: 'premium_1m', title: '1 месяц', priceRub: 111, durationDays: 30 }],
    }), { status: 200 });
  });
  assert.equal(requested, 'https://api.example/api/plans');
  assert.equal(plans?.[0]?.priceRub, 111);
  assert.equal(formatTariffs(plans).includes('111 ₽'), true);
  assert.equal(formatTariffs(null).includes('Год'), false);
});

test('logs and migration cannot leak secrets or change premium tables', () => {
  const token = '123456789:AAFakeTokenForTestsOnly000';
  assert.equal(redact(`failed ${token} postgresql://bot:pw@db/gnh`).includes(token), false);
  assert.equal(redact(`failed ${token} postgresql://bot:pw@db/gnh`).includes('pw'), false);
  const sql = readMigrationSql(root);
  assertMigrationIsSafe(sql);
  const statements = migrationStatements(sql);
  assert.equal(statements.length, 3);
  assert.equal(statements.some((statement) => statement.toLowerCase().includes('subscriptions')), false);
  assert.match(sql, /bot_subscription_expiry_notices_event/);
  for (const file of fs.readdirSync(path.join(root, 'server', 'src'))) {
    if (!file.endsWith('.ts')) continue;
    const source = fs.readFileSync(path.join(root, 'server', 'src', file), 'utf8');
    assert.equal(source.includes('deleteWebhook'), false, file);
    assert.equal(source.includes('RENDER_EXTERNAL_URL'), false, file);
    assert.equal(source.includes('better-sqlite3'), false, file);
    assert.equal(/insert\s+into\s+subscriptions/i.test(source), false, file);
    assert.equal(/update\s+subscriptions/i.test(source), false, file);
    assert.equal(/delete\s+from\s+subscriptions/i.test(source), false, file);
  }
  assert.equal(fs.existsSync(path.join(root, 'src', 'index.ts')), false);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  assert.equal(pkg.dependencies?.['better-sqlite3'], undefined);
});
