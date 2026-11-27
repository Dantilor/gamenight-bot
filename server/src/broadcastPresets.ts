import type { Audience } from './broadcastStore.js';
import type { ButtonMode } from './broadcastButtons.js';

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
    '<b>Обновление GameNight Host</b>\n\n' +
    'У GameNight Host появилась веб-версия: play.gamenighthost.ru\n\n' +
    'Её можно открыть в браузере с телефона или компьютера. Mini App в Telegram продолжает работать как раньше.\n\n' +
    'Отключить уведомления: /unsubscribe',
  audience: 'notify' as Audience,
  buttonMode: 'both' as ButtonMode,
  webUrl: WEB_LAUNCH_URL,
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

/** Known product claims that must not go out until claimsVerified is true. */
export function containsUnverifiedClaims(bodyHtml: string): boolean {
  if (WEB_LAUNCH_PRESET.claimsVerified) return false;
  const plain = plainText(bodyHtml);
  return (
    /колесо фортуны/i.test(plain) ||
    /16\s*игр/i.test(plain) ||
    /15\s*000/i.test(plain) ||
    (/без vpn/i.test(plain) && /gamenight host/i.test(plain))
  );
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
  if ((promo || (input.audience === 'ads' && unverified)) && !WEB_LAUNCH_PRESET.claimsVerified) {
    const listed = WEB_LAUNCH_PRESET.claims.map((claim) => `• ${claim}`).join('\n');
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
