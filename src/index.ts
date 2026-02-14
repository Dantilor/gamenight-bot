import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';

function getPublicUrl(): string {
  const url = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
  if (!url) {
    throw new Error('Set RENDER_EXTERNAL_URL (on Render) or PUBLIC_URL for webhook.');
  }
  return url.replace(/\/$/, '');
}

function getBotToken(): string {
  const token = process.env.BOT_TOKEN;
  if (!token) {
    throw new Error('Missing required environment variable BOT_TOKEN. Set it in .env or your environment.');
  }
  return token;
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

bot.start(async (ctx) => {
  try {
    await sendHeroMessage(ctx, { removeKeyboard: true });
  } catch (err) {
    console.error('Start handler error:', err);
  }
});

bot.command('play', async (ctx) => {
  try {
    await sendHeroMessage(ctx);
  } catch (err) {
    console.error('Play handler error:', err);
  }
});

bot.catch((err, ctx) => {
  console.error('Bot error', err);
});

const port = Number(process.env.PORT ?? 3000);
const publicUrl = getPublicUrl();
const webhookPath = `${publicUrl}/telegram`;

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('OK');
    return;
  }

  if (req.method === 'POST' && req.url === '/telegram') {
    let raw: string;
    try {
      raw = await parseBody(req);
    } catch (err) {
      console.error('Webhook body read error:', err);
      res.writeHead(400);
      res.end();
      return;
    }
    if (!raw || !raw.trim()) {
      res.writeHead(400);
      res.end();
      return;
    }
    let update: unknown;
    try {
      update = JSON.parse(raw);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    res.writeHead(200);
    res.end();
    bot.handleUpdate(update as Parameters<typeof bot.handleUpdate>[0]).catch((err) => {
      console.error('Webhook handleUpdate error:', err);
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(port, async () => {
  console.log(`[health] listening on ${port}`);
  await bot.telegram.setWebhook(webhookPath);
  console.log('Webhook set to', webhookPath);
});

function shutdown() {
  bot.telegram.deleteWebhook().catch(() => {});
  server.close(() => process.exit(0));
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

