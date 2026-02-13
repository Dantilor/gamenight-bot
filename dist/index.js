"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const telegraf_1 = require("telegraf");
function getBotToken() {
    const token = process.env.BOT_TOKEN;
    if (!token) {
        throw new Error('Missing required environment variable BOT_TOKEN. Set it in .env or your environment.');
    }
    return token;
}
function getWebAppUrl() {
    const url = process.env.WEBAPP_URL;
    if (!url) {
        throw new Error('WEBAPP_URL is not set in .env file');
    }
    return url;
}
const botToken = getBotToken();
const webAppUrl = getWebAppUrl();
const bot = new telegraf_1.Telegraf(botToken);
// In-memory map: chatId (as string) -> last hero message id
const heroMessages = new Map();
const HERO_CAPTION = [
    'GameNight Host',
    '',
    'Новая культура игровых вечеров в Telegram.',
    '',
    'Игровые сценарии для пар.',
    'Интерактивные режимы для компаний.',
    'Живая игровая платформа, которая развивается вместе с вами.',
    '',
    '✨ Авторские игровые режимы',
    '🎮 Private игровые сессии',
    '🚀 Постоянные обновления и новые механики',
    '',
    'Начните вечер.'
].join('\n');
async function sendHeroMessage(ctx) {
    var _a;
    const chatId = (_a = ctx.chat) === null || _a === void 0 ? void 0 : _a.id;
    if (!chatId) {
        return;
    }
    const chatKey = String(chatId);
    const previousMessageId = heroMessages.get(chatKey);
    if (previousMessageId !== undefined) {
        try {
            await ctx.deleteMessage(previousMessageId);
        }
        catch {
            // Ignore errors (e.g., message already deleted or insufficient rights)
        }
    }
    const message = await ctx.replyWithPhoto('https://images.unsplash.com/photo-1511512578047-dfb367046420', {
        caption: HERO_CAPTION,
        ...telegraf_1.Markup.inlineKeyboard([
            telegraf_1.Markup.button.webApp('🎮 Играть', webAppUrl)
        ])
    });
    const messageId = Array.isArray(message) ? message[0].message_id : message.message_id;
    heroMessages.set(chatKey, messageId);
}
bot.start(async (ctx) => {
    await sendHeroMessage(ctx);
});
bot.command('play', async (ctx) => {
    await sendHeroMessage(ctx);
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
