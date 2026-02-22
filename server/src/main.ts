import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { bot } from './bot.js';
import { closeDb } from './db.js';
import { startSubscriptionScheduler } from './subscriptionJob.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use('/public', express.static(path.join(process.cwd(), 'server', 'public')));

const BOT_WEBHOOK_PATH = (process.env.BOT_WEBHOOK_PATH || '/telegram/webhook-9f3k2lQp').replace(/\/+$/, '');

app.get('/health', (_req, res) => {
  res.status(200).type('text/plain').send('ok');
});

app.post(BOT_WEBHOOK_PATH, async (req, res) => {
  console.log('[telegram] POST', BOT_WEBHOOK_PATH);
  try {
    if (req.body && typeof req.body === 'object') {
      await bot.handleUpdate(req.body, res);
    }
  } catch (e) {
    console.error('[webhook] handleUpdate error', e);
  }
  if (!res.headersSent) {
    res.status(200).end();
  }
});

app.post('/telegram/webhook-9f3k2lQp', async (req, res) => {
  console.log('[telegram] POST', '/telegram/webhook-9f3k2lQp');
  try {
    if (req.body && typeof req.body === 'object') {
      await bot.handleUpdate(req.body, res);
    }
  } catch (e) {
    console.error('[webhook] handleUpdate error', e);
  }
  if (!res.headersSent) {
    res.status(200).end();
  }
});

const port = Number(process.env.PORT ?? 3000);

let subscriptionTask: { stop: () => void } | null = null;

const server = app.listen(port, async () => {
  console.log('[health] listening on', port);
  console.log('[webhook] route POST', BOT_WEBHOOK_PATH);

  const publicUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
  if (publicUrl) {
    const base = publicUrl.replace(/\/$/, '');
    const fullWebhookUrl = `${base}${BOT_WEBHOOK_PATH}`;
    await bot.telegram.setWebhook(fullWebhookUrl);
    console.log('Webhook set to', fullWebhookUrl);
  } else {
    console.log('PUBLIC_URL / RENDER_EXTERNAL_URL not set — webhook not registered');
  }

  subscriptionTask = startSubscriptionScheduler(bot);
});

function shutdown() {
  subscriptionTask?.stop();
  closeDb();
  bot.telegram.deleteWebhook().catch(() => {});
  server.close(() => process.exit(0));
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
