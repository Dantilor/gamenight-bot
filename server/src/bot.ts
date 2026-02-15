import { Telegraf } from 'telegraf';

console.log('[bot] module loaded');

const token = process.env.BOT_TOKEN;
if (!token || !token.trim()) {
  throw new Error('Missing required env BOT_TOKEN. Set it in Render Environment or .env');
}

export const bot = new Telegraf(token.trim());

bot.catch((err, ctx) => {
  console.error('[bot] telegraf error:', err);
  console.error('[bot] update:', ctx.update);
});

bot.start(async (ctx) => {
  console.log('[bot] /start from', ctx.from?.id, ctx.from?.username);
  await ctx.reply('start ok');
});

bot.command('ping', async (ctx) => {
  console.log('[bot] /ping from', ctx.from?.id);
  await ctx.reply('pong');
});

bot.command('play', async (ctx) => {
  console.log('[bot] /play from', ctx.from?.id);
  await ctx.reply('play');
});

console.log('[bot] handlers registered');
