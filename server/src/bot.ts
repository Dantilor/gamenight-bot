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

const MINI_APP_URL = 'https://telegram-card-game.onrender.com';

const START_BUTTON = {
  reply_markup: {
    inline_keyboard: [[{ text: 'Стать частью игры', web_app: { url: MINI_APP_URL } }]],
  },
};

bot.catch((err, ctx) => {
  console.error('[bot] telegraf error:', err);
  console.error('[bot] update:', ctx.update);
});

bot.start(async (ctx) => {
  console.log('[bot] /start from', ctx.from?.id, ctx.from?.username);
  if (ctx.from?.id) ensureUser(ctx.from.id);

  await ctx.reply(HERO_CAPTION, {
    parse_mode: 'HTML',
    ...START_BUTTON,
  });
});

bot.command('ping', async (ctx) => {
  console.log('[bot] /ping from', ctx.from?.id);
  await ctx.reply('pong');
});

bot.command('play', async (ctx) => {
  console.log('[bot] /play from', ctx.from?.id);
  const webappUrl = process.env.WEBAPP_URL?.trim() || '';
  if (webappUrl) {
    await ctx.reply(HERO_CAPTION, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([Markup.button.webApp('🎮 Открыть GameNight Host', webappUrl)]),
    });
  } else {
    await ctx.reply(HERO_CAPTION, { parse_mode: 'HTML' });
    await ctx.reply('WEBAPP_URL не задан');
  }
});

const TARIFFS_TEXT = `📋 Тарифы подписки

• **Месяц** — полный доступ на 30 дней
• **3 месяца** — выгоднее на 15%
• **Год** — максимальная выгода

Выберите подходящий тариф или напишите в поддержку.`;

bot.action('renew_subscription', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(TARIFFS_TEXT, { parse_mode: 'Markdown' });
});

console.log('[bot] handlers registered');
