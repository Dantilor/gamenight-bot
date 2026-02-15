import { Telegraf, Markup } from 'telegraf';

console.log('[bot] module loaded');

const token = process.env.BOT_TOKEN;
if (!token || !token.trim()) {
  throw new Error('Missing required env BOT_TOKEN. Set it in Render Environment or .env');
}

export const bot = new Telegraf(token.trim());

const HERO_CAPTION =
  'Ваш вечер начинается здесь!\n\nМы приглашаем вас в игру, где эстетика встречается с азартом. Это пространство, где вы не наблюдаете — вы становитесь частью момента.\n\nGameNight Host - Вы диктуете правила, мы создаем.';

function getPublicUrl(): string {
  return (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
}

bot.catch((err, ctx) => {
  console.error('[bot] telegraf error:', err);
  console.error('[bot] update:', ctx.update);
});

bot.start(async (ctx) => {
  console.log('[bot] /start from', ctx.from?.id, ctx.from?.username);

  const publicUrl = getPublicUrl();
  const webappUrl = process.env.WEBAPP_URL?.trim() || '';

  if (publicUrl) {
    const imageUrl = `${publicUrl}/public/hero-new.png`;
    try {
      await ctx.replyWithPhoto(imageUrl, { caption: HERO_CAPTION });
    } catch (err) {
      console.warn('[bot] replyWithPhoto failed, sending text only:', err);
      await ctx.reply(HERO_CAPTION);
    }
  } else {
    console.warn('[bot] PUBLIC_URL / RENDER_EXTERNAL_URL not set — sending /start without image');
    await ctx.reply(HERO_CAPTION);
  }

  if (webappUrl) {
    await ctx.reply('Открыть мини-апп:', Markup.inlineKeyboard([Markup.button.webApp('🎮 Открыть GameNight Host', webappUrl)]));
  } else {
    await ctx.reply('WEBAPP_URL не задан');
  }
});

bot.command('ping', async (ctx) => {
  console.log('[bot] /ping from', ctx.from?.id);
  await ctx.reply('pong');
});

bot.command('play', async (ctx) => {
  console.log('[bot] /play from', ctx.from?.id);
  const publicUrl = getPublicUrl();
  const webappUrl = process.env.WEBAPP_URL?.trim() || '';
  if (publicUrl) {
    try {
      const opts = webappUrl
        ? { caption: HERO_CAPTION, ...Markup.inlineKeyboard([Markup.button.webApp('🎮 Открыть GameNight Host', webappUrl)]) }
        : { caption: HERO_CAPTION };
      await ctx.replyWithPhoto(`${publicUrl}/public/hero-new.png`, opts);
    } catch (err) {
      console.warn('[bot] /play photo failed:', err);
      await ctx.reply(HERO_CAPTION);
    }
  } else {
    await ctx.reply(HERO_CAPTION);
  }
  if (webappUrl && !publicUrl) {
    await ctx.reply('Открыть мини-апп:', Markup.inlineKeyboard([Markup.button.webApp('🎮 Открыть GameNight Host', webappUrl)]));
  } else if (!webappUrl) {
    await ctx.reply('WEBAPP_URL не задан');
  }
});

console.log('[bot] handlers registered');
