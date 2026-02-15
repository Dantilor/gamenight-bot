import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';

function getBotToken(): string {
  const token = process.env.BOT_TOKEN;
  if (!token || !token.trim()) {
    throw new Error('Missing required env BOT_TOKEN. Set it in Render Environment or .env');
  }
  return token.trim();
}

function getWebAppUrl(): string {
  const url = process.env.WEBAPP_URL;
  if (!url) {
    throw new Error('WEBAPP_URL is not set in .env file');
  }
  return url;
}

const botToken = getBotToken();
const webAppUrl = getWebAppUrl();

const bot = new Telegraf(botToken);

// In-memory map: chatId (as string) -> last hero message id
const heroMessages = new Map<string, number>();

const HERO_CAPTION = [
  'Ваш вечер начинается здесь!',
  '',
  'Мы приглашаем вас в игру, где эстетика встречается с азартом. Это пространство, где вы не наблюдаете — вы становитесь частью момента.',
  '',
  '<b>GameNight Host - Вы диктуете правила, мы создаем.</b>'
].join('\n');

// Путь к hero-картинке: из dist — на уровень выше в assets
const HERO_IMAGE_PATH = path.join(__dirname, '..', 'assets', 'hero-new.png');

const heroInlineKeyboard = [[{ text: '🎮 Играть', web_app: { url: webAppUrl } }]];

async function sendHeroMessage(ctx: Context, options?: { removeKeyboard?: boolean }) {
  const chatId = ctx.chat?.id;

  if (!chatId) {
    return;
  }

  const chatKey = String(chatId);
  const previousMessageId = heroMessages.get(chatKey);

  if (previousMessageId !== undefined) {
    try {
      await ctx.deleteMessage(previousMessageId);
    } catch {
      // Ignore errors (e.g., message already deleted or insufficient rights)
    }
  }

  const reply_markup = options?.removeKeyboard
    ? { remove_keyboard: true, inline_keyboard: heroInlineKeyboard }
    : { inline_keyboard: heroInlineKeyboard };

  const heroOptions = { caption: HERO_CAPTION, parse_mode: 'HTML' as const, reply_markup };

  let message;
  try {
    message = await ctx.replyWithPhoto({ source: HERO_IMAGE_PATH }, heroOptions);
  } catch (err) {
    console.error('Hero photo send failed, falling back to text:', err);
    try {
      message = await ctx.reply(HERO_CAPTION, { parse_mode: 'HTML', reply_markup });
    } catch (fallbackErr) {
      console.error('Hero fallback (text) failed:', fallbackErr);
      return;
    }
  }

  const messageId = Array.isArray(message) ? message[0].message_id : message.message_id;
  heroMessages.set(chatKey, messageId);
}

bot.catch((err, ctx) => {
  console.error('[bot] telegraf error:', err);
  console.error('[bot] update:', ctx.update);
});

bot.start(async (ctx) => {
  console.log('[bot] /start from', ctx.from?.id, ctx.from?.username);
  await ctx.reply('start ok');
});

bot.command('play', async (ctx) => {
  try {
    await sendHeroMessage(ctx);
  } catch (err) {
    console.error('Play handler error:', err);
  }
});

bot.command('ping', async (ctx) => {
  console.log('[bot] /ping from', ctx.from?.id);
  await ctx.reply('pong');
});

// ——— Express app (только webhook, без bot.launch()) ———
const app = express();

app.use(express.json({ limit: '2mb' }));

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

// Место для роутов mini-app: app.use('/api', apiRouter);

const port = Number(process.env.PORT ?? 3000);

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
});

function shutdown() {
  // deleteWebhook только при остановке процесса, не при старте
  bot.telegram.deleteWebhook().catch(() => {});
  server.close(() => process.exit(0));
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
