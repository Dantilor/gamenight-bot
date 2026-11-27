import type { Audience } from './broadcastStore.js';
import type { ButtonMode } from './broadcastButtons.js';

export type BroadcastPreset = {
  id: string;
  bodyHtml: string;
  audience: Audience;
  buttonMode: ButtonMode;
  webUrl: string;
  /**
   * Mass queueing of this exact text stays blocked until the owner has confirmed every
   * claim in `claims` against the live product and flipped this flag in a reviewed commit.
   * A different text (for example, one with the claims removed) is not blocked by it.
   */
  claimsVerified: boolean;
  claims: string[];
};

export const WEB_LAUNCH_URL =
  'https://play.gamenighthost.ru/?utm_source=telegram&utm_medium=bot&utm_campaign=web_launch_20261127';

export const WEB_LAUNCH_PRESET: BroadcastPreset = {
  id: 'web-launch-20261127',
  bodyHtml:
    '🎉 <b>GAMENIGHT HOST ТЕПЕРЬ И БЕЗ VPN!</b>\n\n' +
    'Надоело включать VPN, ждать загрузки Telegram или сталкиваться с зависаниями?\n\n' +
    '💜 У нас отличные новости — мы запустили полноценный сайт GameNight Host!\n\n' +
    'Теперь любимые игры доступны прямо в браузере, без необходимости открывать Telegram.\n\n' +
    '🔥 <b>И это ещё не всё!</b>\n\n' +
    '🎡 Колесо фортуны — больше азарта и неожиданных поворотов.\n\n' +
    '🃏 Ещё больше вопросов — новые поводы смеяться, спорить и узнавать друг друга.\n\n' +
    '🎮 16 игр и более 15 000 вопросов — для друзей, пар и вечеринок.\n\n' +
    '📱💻 Играй с телефона или компьютера!\n\n' +
    '<b>Собирай компанию. Выбирай игру. Вечер начинается! 🚀</b>\n\n' +
    '👇 Попробуй новый GameNight Host прямо сейчас!\n\n' +
    'Отключить рекламные сообщения: /unsubscribe',
  audience: 'ads',
  buttonMode: 'both',
  webUrl: WEB_LAUNCH_URL,
  claimsVerified: false,
  claims: [
    'Колесо фортуны на сайте',
    'Ещё больше вопросов (новые колоды)',
    '16 игр и более 15 000 вопросов',
    'Работа без VPN и без Telegram',
  ],
};

export function isWebLaunchText(bodyHtml: string): boolean {
  return bodyHtml === WEB_LAUNCH_PRESET.bodyHtml;
}

/** A word-form check for an explicit «Реклама» label; «рекламные» does not count. */
export function hasAdLabel(bodyHtml: string): boolean {
  return /реклама(?![а-яё])/i.test(bodyHtml) || /\berid\b/i.test(bodyHtml);
}
