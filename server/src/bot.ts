import { Telegraf, Markup } from 'telegraf';
import { ensureUser } from './db.js';

console.log('[bot] module loaded');

const token = process.env.BOT_TOKEN;
if (!token || !token.trim()) {
  throw new Error('Missing required env BOT_TOKEN. Set it in Render Environment or .env');
}

export const bot = new Telegraf(token.trim());

const HERO_CAPTION =
  '<b>Ваш вечер начинается прямо сейчас!</b> ✨\n\n' +
  'Здесь решают эмоции, интеллект и смелость.\n' +
  'Вы не наблюдаете — вы управляете игрой.\n\n' +
  'Соберите тех, с кем хочется разделить этот вечер\n' +
  'Выберите формат игры\n' +
  'И позвольте атмосфере сделать своё дело\n\n' +
  '<b>GameNight Host - Вы диктуете правила, мы создаем.</b>';

/** Frontend Mini App URL only — never backend/API host. */
function getMiniAppUrl(): string {
  return (process.env.MINI_APP_URL || process.env.WEBAPP_URL || '').trim();
}

const miniAppUrl = getMiniAppUrl();

function webAppInlineKeyboard(buttonText: string) {
  return Markup.inlineKeyboard([Markup.button.webApp(buttonText, miniAppUrl)]);
}

// Убираем кастомную клавиатуру при каждом ответе (remove_keyboard и inline_keyboard в одном сообщении нельзя)
const REMOVE_KEYBOARD = { reply_markup: { remove_keyboard: true } } as const;
const ZERO_WIDTH = '\u200B';

bot.catch((err, ctx) => {
  console.error('[bot] telegraf error:', err);
  console.error('[bot] update:', ctx.update);
});

bot.start(async (ctx) => {
  console.log('[bot] /start from', ctx.from?.id, ctx.from?.username);
  if (ctx.from?.id) ensureUser(ctx.from.id);

  await ctx.reply(ZERO_WIDTH, REMOVE_KEYBOARD).catch(() => {});
  if (miniAppUrl) {
    await ctx.reply(HERO_CAPTION, {
      parse_mode: 'HTML',
      ...webAppInlineKeyboard('Стать частью игры'),
    });
  } else {
    await ctx.reply(HERO_CAPTION, { parse_mode: 'HTML' });
    await ctx.reply('MINI_APP_URL не задан', REMOVE_KEYBOARD);
  }
});

bot.command('ping', async (ctx) => {
  console.log('[bot] /ping from', ctx.from?.id);
  await ctx.reply('pong', REMOVE_KEYBOARD);
});

bot.command('play', async (ctx) => {
  console.log('[bot] /play from', ctx.from?.id);
  await ctx.reply(ZERO_WIDTH, REMOVE_KEYBOARD).catch(() => {});
  if (miniAppUrl) {
    await ctx.reply(HERO_CAPTION, {
      parse_mode: 'HTML',
      ...webAppInlineKeyboard('🎮 Открыть GameNight Host'),
    });
  } else {
    await ctx.reply(HERO_CAPTION, { parse_mode: 'HTML' });
    await ctx.reply('MINI_APP_URL не задан', REMOVE_KEYBOARD);
  }
});

const TARIFFS_TEXT = `📋 Тарифы подписки

• **Месяц** — полный доступ на 30 дней
• **3 месяца** — выгоднее на 15%
• **Год** — максимальная выгода

Выберите подходящий тариф или напишите в поддержку.`;

bot.action('renew_subscription', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(TARIFFS_TEXT, { parse_mode: 'Markdown', ...REMOVE_KEYBOARD });
});

console.log('[bot] handlers registered');
