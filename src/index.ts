import 'dotenv/config';
import http from 'node:http';
import { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';

const port = Number(process.env.PORT ?? 3000);
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('OK');
  })
  .listen(port, () => console.log(`[health] listening on ${port}`));

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
  'Ваш вечер начинается здесь.',
  '',
  'Мы приглашаем вас в игру, где эстетика встречается с азартом. Это пространство, где вы не наблюдаете — вы становитесь частью момента.',
  '',
  '<b>GameNight Host - Вы диктуете правила, мы создаем.</b>'
].join('\n');

const HERO_IMAGE_URL = 'https://images.unsplash.com/photo-1511512578047-dfb367046420';

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
    message = await ctx.replyWithPhoto(HERO_IMAGE_URL, heroOptions);
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

bot.launch().then(() => {
  // Bot launched with long polling
}).catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to launch bot:', error);
  process.exit(1);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

