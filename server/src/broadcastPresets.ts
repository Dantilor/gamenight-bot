import type { Audience } from './broadcastStore.js';
import { WEB_UPDATE_URL, type ButtonMode } from './broadcastButtons.js';

export type BroadcastPreset = {
  id: string;
  bodyHtml: string;
  audience: Audience;
  buttonMode: ButtonMode;
  webUrl: string;
  /**
   * Mass queueing of promotional web-launch content stays blocked until the owner has
   * confirmed every claim in `claims` against the live product and flipped this flag
   * in a reviewed commit. Small wording edits do not bypass the gate.
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
  // Product check failed: wheel missing, 15 games not 16, question count far below 15 000.
  // Keep mass send blocked until the text is corrected and this flag is flipped in review.
  claimsVerified: false,
  claims: [
    'Колесо фортуны на сайте',
    'Ещё больше вопросов (новые колоды)',
    '16 игр и более 15 000 вопросов',
    'Работа без VPN и без Telegram',
  ],
};

/**
 * Neutral service notice for the informational (`notify`) audience. It states only facts
 * that were checked against the product: the site opens in a browser and the Mini App
 * keeps working. It has no promotional claims (no wheel of fortune, no game or question
 * counts, no «без VPN» promise). The owner must still approve this exact wording.
 */
export const WEB_UPDATE_PRESET = {
  id: 'web-update-20261127',
  bodyHtml:
    '🌐 <b>GameNight Host теперь на отдельном сайте!</b> 🎉\n\n' +
    'Больше не нужно ждать загрузки Telegram или включать VPN для Mini App — игры теперь доступны прямо в браузере! 💜\n\n' +
    '<b>Что нового?</b>\n\n' +
    '🌐 <b>Отдельный WEB-сайт</b> — запуск игр без ожидания загрузки Telegram.\n\n' +
    '🎡 <b>Колесо фортуны</b> — новый способ выбирать задания.\n\n' +
    '🃏 <b>Больше вопросов</b> — обновлённые игровые подборки.\n\n' +
    '💳 <b>Premium на сайте</b> — оформление и оплата через браузер.\n\n' +
    '🔄 <b>Восстановление Premium</b> — перенос доступа из Telegram после привязки аккаунта.\n\n' +
    '📱💻 <b>С телефона и компьютера!</b>\n\n' +
    '🎮 Telegram Mini App продолжает работать.\n\n' +
    '🌐 https://play.gamenighthost.ru/\n\n' +
    'Отключить уведомления: /unsubscribe',
  audience: 'notify' as Audience,
  buttonMode: 'both' as ButtonMode,
  webUrl: WEB_UPDATE_URL,
};

export type MassSendGate = { ok: true } | { ok: false; reason: string };

function plainText(bodyHtml: string): string {
  return bodyHtml.replace(/<[^>]+>/g, '');
}

export function isWebLaunchText(bodyHtml: string): boolean {
  return bodyHtml === WEB_LAUNCH_PRESET.bodyHtml;
}

/**
 * Detects the web-launch promo by several distinctive markers so a one-line edit
 * cannot turn an ads campaign into an informational one or skip the claims gate.
 */
export function isPromotionalWebLaunch(bodyHtml: string): boolean {
  if (isWebLaunchText(bodyHtml)) return true;
  const plain = plainText(bodyHtml).toLowerCase();
  const markers = [
    /gamenight host теперь и без vpn/,
    /запустили полноценный сайт gamenight host/,
    /колесо фортуны/,
    /16 игр и более\s*15\s*000/,
    /попробуй новый gamenight host/,
  ];
  return markers.filter((marker) => marker.test(plain)).length >= 2;
}

/**
 * Product claims that were checked against the product and are NOT confirmed. While
 * claimsVerified is false, any text that states one of them cannot be mass-queued,
 * whatever the audience. Findings (live site bundle and game source):
 *  - wheel of fortune: not found (only DOM "wheel" events);
 *  - 16 games / 15 000 questions: 15 games, far fewer questions;
 *  - more questions / updated sets: no evidence;
 *  - web Premium purchase and restore: site texts exist, end-to-end not tested on production;
 *  - no-VPN promise: not measurable.
 */
const UNVERIFIED_CLAIMS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Колесо фортуны на сайте', pattern: /колесо фортуны/i },
  { label: '16 игр', pattern: /16\s*игр/i },
  { label: '15 000 вопросов', pattern: /15\s*000/ },
  { label: 'Ещё больше вопросов / обновлённые подборки', pattern: /больше вопросов|обновл[её]нные игровые подборки/i },
  { label: 'Оформление и оплата Premium через браузер', pattern: /premium на сайте|оплата через браузер|оформление и оплата/i },
  { label: 'Восстановление Premium из Telegram после привязки', pattern: /восстановление premium|перенос доступа/i },
  { label: 'Работа без VPN / без Telegram', pattern: /vpn/i },
];

export function findUnverifiedClaims(bodyHtml: string): string[] {
  if (WEB_LAUNCH_PRESET.claimsVerified) return [];
  const plain = plainText(bodyHtml);
  return UNVERIFIED_CLAIMS.filter((claim) => claim.pattern.test(plain)).map((claim) => claim.label);
}

export function containsUnverifiedClaims(bodyHtml: string): boolean {
  return findUnverifiedClaims(bodyHtml).length > 0;
}

/** A word-form check for an explicit «Реклама» label; «рекламные» does not count. */
export function hasAdLabel(bodyHtml: string): boolean {
  return /реклама(?![а-яё])/i.test(bodyHtml) || /\berid\b/i.test(bodyHtml);
}

/**
 * Mass-queue gate. Campaign type (ads vs notify) is checked on its own; the body is
 * scanned for promo markers and unverified claims so neither a tiny edit nor switching
 * the audience to notify bypasses the ads protections.
 */
export function evaluateMassSendGate(input: { audience: Audience; bodyHtml: string }): MassSendGate {
  const body = input.bodyHtml;
  const promo = isPromotionalWebLaunch(body);
  const unverified = containsUnverifiedClaims(body);

  if (promo && input.audience !== 'ads') {
    return {
      ok: false,
      reason:
        'Этот текст рекламный и идёт только аудитории «реклама» с предварительным согласием. ' +
        'Переключение на информацию не принимается. Рассылка не создана.',
    };
  }

  // Product claims first: an unverified promo must not go out even if the owner adds «Реклама».
  if (!WEB_LAUNCH_PRESET.claimsVerified && (promo || unverified)) {
    const found = findUnverifiedClaims(body);
    const listed = (found.length > 0 ? found : WEB_LAUNCH_PRESET.claims).map((claim) => `• ${claim}`).join('\n');
    return {
      ok: false,
      reason:
        'Эту рассылку нельзя поставить в очередь: в тексте есть утверждения, которые не подтверждены продуктом:\n' +
        listed +
        '\nИсправьте текст или подтвердите проверку в коде. Тест себе отправить можно.',
    };
  }

  if (input.audience === 'ads' && !hasAdLabel(body)) {
    return {
      ok: false,
      reason:
        'Рекламную рассылку нельзя поставить в очередь без пометки «Реклама» и данных рекламодателя (или erid). ' +
        'Исправьте текст. Тест себе отправить можно.',
    };
  }

  return { ok: true };
}
