import fs from 'node:fs';
import path from 'node:path';
import { Input, Markup, Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import { handleBroadcastTurn, rememberPrivateContact, type PanelReply } from './broadcastPanel.js';
import type { BroadcastStore } from './broadcastStore.js';
import type { AppConfig } from './config.js';
import { redact } from './log.js';
import { fetchPlans, formatTariffs, premiumPageUrl } from './plans.js';
import { EXPIRED_TEXT } from './subscriptionJob.js';

export const HERO_CAPTION =
  '<b>Ваш вечер начинается прямо сейчас!</b> ✨\n\n' +
  'Здесь решают эмоции, интеллект и смелость.\n' +
  'Вы не наблюдаете — вы управляете игрой.\n\n' +
  'Соберите тех, с кем хочется разделить этот вечер\n' +
  'Выберите формат игры\n' +
  'И позвольте атмосфере сделать своё дело\n\n' +
  '<b>GameNight Host - Вы диктуете правила, мы создаем.</b>';

export const START_BUTTON_TEXT = 'Стать частью игры';
export const PLAY_BUTTON_TEXT = '🎮 Открыть GameNight Host';
export const RENEW_BUTTON_TEXT = 'Продлить подписку';
export const OPEN_PREMIUM_BUTTON_TEXT = 'Открыть Premium';

const REMOVE_KEYBOARD = { reply_markup: { remove_keyboard: true } } as const;
const ZERO_WIDTH = '\u200B';
const heroMessageIds = new Map<number, number>();

export type BotDeps = {
  config: AppConfig;
  fetchImpl?: typeof fetch;
  broadcastStore?: BroadcastStore | null;
  resolveBroadcastStore?: () => Promise<BroadcastStore | null>;
};

export function createBot(deps: BotDeps): Telegraf {
  const token = deps.config.botToken.trim();
  if (!token) throw new Error('Missing required env BOT_TOKEN');
  const bot = new Telegraf(token);
  const miniAppUrl = deps.config.miniAppUrl;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const heroReady = fs.existsSync(deps.config.heroImagePath);
  console.log(heroReady ? '[bot] hero image ready' : '[bot] hero image missing, welcome will be text only');

  bot.catch((error, ctx) => {
    const updateId = 'update_id' in ctx.update ? ctx.update.update_id : undefined;
    console.error('[bot] handler error', redact(error), { updateId });
  });

  bot.start(async (ctx) => {
    console.log('[bot] /start', { id: ctx.from?.id });
    await rememberActor(ctx, deps);
    await sendStartText(ctx, miniAppUrl);
  });

  bot.command('play', async (ctx) => {
    console.log('[bot] /play', { id: ctx.from?.id });
    await rememberActor(ctx, deps);
    await sendHero(ctx, deps.config.heroImagePath, miniAppUrl, PLAY_BUTTON_TEXT);
  });

  bot.command('ping', async (ctx) => {
    console.log('[bot] /ping', { id: ctx.from?.id });
    await rememberActor(ctx, deps);
    await ctx.reply('pong', REMOVE_KEYBOARD);
  });

  const panel = async (ctx: Context) => {
    const store = await openBroadcastStore(deps);
    const reply = await handleBroadcastTurn(ctx.update as never, {
      adminId: deps.config.broadcastAdminId,
      miniAppUrl,
      store,
    });
    if (!reply) return;
    await sendPanelReply(ctx, reply);
  };
  bot.command('admin', panel);
  bot.command('subscribe', panel);
  bot.command('unsubscribe', panel);
  bot.action(/^ba:/, panel);
  bot.action(/^bc:/, panel);
  bot.on('text', async (ctx, next) => {
    const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    if (typeof text === 'string' && text.startsWith('/')) return next();
    await panel(ctx);
  });
  bot.on('photo', panel);

  bot.action('renew_subscription', async (ctx) => {
    await ctx.answerCbQuery().catch(() => undefined);
    const premiumUrl = premiumPageUrl(miniAppUrl);
    const plans = await fetchPlans(deps.config.apiUrl, fetchImpl);
    const text = formatTariffs(plans);
    await ctx.reply(ZERO_WIDTH, REMOVE_KEYBOARD).catch(() => undefined);
    if (!premiumUrl) {
      await ctx.reply(`${text}\n\nMINI_APP_URL не задан`);
      return;
    }
    await ctx.reply(text, Markup.inlineKeyboard([Markup.button.webApp(OPEN_PREMIUM_BUTTON_TEXT, premiumUrl)]));
  });

  console.log('[bot] handlers registered');
  return bot;
}

export async function sendExpiryNotice(bot: Telegraf, telegramId: number): Promise<number> {
  const message = await bot.telegram.sendMessage(telegramId, EXPIRED_TEXT, {
    reply_markup: {
      inline_keyboard: [[{ text: RENEW_BUTTON_TEXT, callback_data: 'renew_subscription' }]],
    },
  });
  if (!Number.isInteger(message.message_id) || message.message_id <= 0) {
    throw new Error('Telegram did not confirm the message');
  }
  return message.message_id;
}

async function openBroadcastStore(deps: BotDeps): Promise<BroadcastStore | null> {
  if (deps.broadcastStore !== undefined) return deps.broadcastStore;
  if (!deps.resolveBroadcastStore) return null;
  return deps.resolveBroadcastStore();
}

async function rememberActor(ctx: Context, deps: BotDeps): Promise<void> {
  if (ctx.chat?.type !== 'private' || ctx.chat.id !== ctx.from?.id || !ctx.from) return;
  await rememberPrivateContact(await openBroadcastStore(deps), ctx.update as never);
}

async function sendPanelReply(ctx: Context, reply: PanelReply): Promise<void> {
  if (reply.method === 'sendPhoto' && reply.photo) {
    await ctx.replyWithPhoto(reply.photo, {
      caption: reply.caption,
      parse_mode: 'HTML',
      ...(reply.reply_markup ? { reply_markup: reply.reply_markup } : {}),
    });
    return;
  }
  await ctx.reply(reply.text ?? '', {
    ...(reply.parse_mode ? { parse_mode: reply.parse_mode } : {}),
    ...(reply.reply_markup ? { reply_markup: reply.reply_markup } : {}),
  });
}

async function sendStartText(ctx: Context, miniAppUrl: string): Promise<void> {
  const buttonUrl = miniAppUrl.trim();
  const keyboard = buttonUrl
    ? Markup.inlineKeyboard([Markup.button.webApp(START_BUTTON_TEXT, buttonUrl)])
    : undefined;
  const text = buttonUrl ? HERO_CAPTION : `${HERO_CAPTION}\n\nMINI_APP_URL не задан`;
  if (keyboard) {
    await ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    return;
  }
  await ctx.reply(text, { parse_mode: 'HTML' });
}

async function sendHero(ctx: Context, heroImagePath: string, miniAppUrl: string, buttonText: string): Promise<void> {
  await ctx.reply(ZERO_WIDTH, REMOVE_KEYBOARD).catch(() => undefined);
  const chatId = ctx.chat?.id;
  if (chatId) {
    const previous = heroMessageIds.get(chatId);
    if (previous) {
      await ctx.telegram.deleteMessage(chatId, previous).catch(() => undefined);
      heroMessageIds.delete(chatId);
    }
  }

  const keyboard = miniAppUrl
    ? Markup.inlineKeyboard([Markup.button.webApp(buttonText, miniAppUrl)])
    : undefined;
  let messageId: number | null = null;
  if (fs.existsSync(heroImagePath)) {
    try {
      const sent = await ctx.replyWithPhoto(Input.fromLocalFile(path.resolve(heroImagePath)), {
        caption: HERO_CAPTION,
        parse_mode: 'HTML',
        ...(keyboard ?? {}),
      });
      messageId = sent.message_id;
    } catch (error) {
      console.error('[bot] hero photo failed, sending text', redact(error));
    }
  }
  if (messageId === null) {
    const sent = keyboard
      ? await ctx.reply(HERO_CAPTION, { parse_mode: 'HTML', ...keyboard })
      : await ctx.reply(HERO_CAPTION, { parse_mode: 'HTML' });
    messageId = sent.message_id;
  }
  if (!miniAppUrl) {
    await ctx.reply('MINI_APP_URL не задан', REMOVE_KEYBOARD);
  }
  if (chatId && messageId) heroMessageIds.set(chatId, messageId);
}
