import fs from 'node:fs';
import type { AppConfig } from './config.js';
import { HERO_CAPTION, OPEN_PREMIUM_BUTTON_TEXT, PLAY_BUTTON_TEXT, START_BUTTON_TEXT } from './bot.js';
import { fetchPlans, formatTariffs, premiumPageUrl } from './plans.js';
import type { TelegramUpdate } from './webhook.js';

const MISSING_MINI_APP = 'MINI_APP_URL не задан';

type WebAppMarkup = {
  inline_keyboard: Array<Array<{ text: string; web_app: { url: string } }>>;
};

type RemoveKeyboardMarkup = { remove_keyboard: true };

export type WebhookMethodReply =
  | {
      method: 'sendMessage';
      chat_id: number;
      text: string;
      parse_mode?: 'HTML';
      reply_markup?: WebAppMarkup | RemoveKeyboardMarkup;
    }
  | {
      method: 'sendPhoto';
      chat_id: number;
      photo: string;
      caption: string;
      parse_mode: 'HTML';
      reply_markup?: WebAppMarkup;
    };

export type WebhookReplyDeps = {
  fetchImpl?: typeof fetch;
  fileExists?: (filePath: string) => boolean;
};

type ChatRef = { id: number; type: string };

export function usableHttpsUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return trimmed;
}

export function publicHeroPhotoUrl(publicUrl: string): string | null {
  const trimmed = publicUrl.trim();
  if (!usableHttpsUrl(trimmed)) return null;
  const url = new URL(trimmed);
  url.username = '';
  url.password = '';
  url.pathname = '/public/hero-new.png';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export async function buildWebhookReply(
  update: TelegramUpdate,
  config: Pick<AppConfig, 'miniAppUrl' | 'publicUrl' | 'apiUrl' | 'heroImagePath'>,
  deps: WebhookReplyDeps = {}
): Promise<WebhookMethodReply | null> {
  const fileExists = deps.fileExists ?? fs.existsSync;
  const command = readCommand(update);
  if (command) {
    if (command.name === 'ping') return pingReply(command.chat);
    if (command.name === 'start' || command.name === 'play') {
      return welcomeReply(command.chat, command.name === 'start' ? START_BUTTON_TEXT : PLAY_BUTTON_TEXT, config, fileExists);
    }
    return null;
  }
  const renewal = readRenewal(update);
  if (!renewal) return null;
  return renewalReply(renewal, config, deps.fetchImpl ?? fetch);
}

function pingReply(chat: ChatRef): WebhookMethodReply {
  return {
    method: 'sendMessage',
    chat_id: chat.id,
    text: 'pong',
    reply_markup: { remove_keyboard: true },
  };
}

function welcomeReply(
  chat: ChatRef,
  buttonText: string,
  config: Pick<AppConfig, 'miniAppUrl' | 'publicUrl' | 'heroImagePath'>,
  fileExists: (filePath: string) => boolean
): WebhookMethodReply {
  const miniAppUrl = usableHttpsUrl(config.miniAppUrl);
  const button = webAppButton(chat, buttonText, miniAppUrl);
  const photo = publicHeroPhotoUrl(config.publicUrl);
  if (photo && fileExists(config.heroImagePath) && miniAppUrl) {
    return {
      method: 'sendPhoto',
      chat_id: chat.id,
      photo,
      caption: HERO_CAPTION,
      parse_mode: 'HTML',
      ...(button ? { reply_markup: button } : {}),
    };
  }
  const text = miniAppUrl ? HERO_CAPTION : `${HERO_CAPTION}\n\n${MISSING_MINI_APP}`;
  return {
    method: 'sendMessage',
    chat_id: chat.id,
    text,
    parse_mode: 'HTML',
    ...(button ? { reply_markup: button } : {}),
  };
}

async function renewalReply(
  chat: ChatRef,
  config: Pick<AppConfig, 'miniAppUrl' | 'apiUrl'>,
  fetchImpl: typeof fetch
): Promise<WebhookMethodReply> {
  const plans = await fetchPlans(config.apiUrl, fetchImpl);
  const premiumUrl = premiumPageUrl(config.miniAppUrl);
  const button = webAppButton(chat, OPEN_PREMIUM_BUTTON_TEXT, premiumUrl);
  const text = premiumUrl ? formatTariffs(plans) : `${formatTariffs(plans)}\n\n${MISSING_MINI_APP}`;
  return {
    method: 'sendMessage',
    chat_id: chat.id,
    text,
    ...(button ? { reply_markup: button } : {}),
  };
}

function webAppButton(chat: ChatRef, text: string, url: string | null): WebAppMarkup | null {
  if (chat.type !== 'private' || !url) return null;
  return { inline_keyboard: [[{ text, web_app: { url } }]] };
}

function readCommand(update: TelegramUpdate): { name: string; chat: ChatRef } | null {
  const message = asRecord(update.message);
  if (!message) return null;
  const chat = readChat(message.chat);
  const text = message.text;
  if (!chat || typeof text !== 'string') return null;
  const match = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s|$)/.exec(text);
  if (!match) return null;
  if (match[2] && chat.type !== 'private') return null;
  return { name: match[1].toLowerCase(), chat };
}

function readRenewal(update: TelegramUpdate): ChatRef | null {
  const query = asRecord(update.callback_query);
  if (!query || query.data !== 'renew_subscription') return null;
  const message = asRecord(query.message);
  if (!message) return null;
  return readChat(message.chat);
}

function readChat(value: unknown): ChatRef | null {
  const chat = asRecord(value);
  if (!chat || typeof chat.id !== 'number' || !Number.isSafeInteger(chat.id)) return null;
  return { id: chat.id, type: typeof chat.type === 'string' ? chat.type : '' };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
