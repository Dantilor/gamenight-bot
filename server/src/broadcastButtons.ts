export type ButtonMode = 'web' | 'miniapp' | 'both';

export const BUTTON_MODES: readonly ButtonMode[] = ['web', 'miniapp', 'both'];

export const BROADCAST_WEB_BUTTON = '🌐 Открыть новый сайт';
export const BROADCAST_OPEN_BUTTON = '🎮 Играть в Mini App';
export const DEFAULT_WEB_URL = 'https://play.gamenighthost.ru/';

type WebAppButton = { text: string; web_app: { url: string } };
type UrlButton = { text: string; url: string };

export type BroadcastMarkup = { inline_keyboard: Array<Array<WebAppButton | UrlButton>> };

export type ButtonUrls = { miniAppUrl: string | null; webUrl: string | null };

export function isButtonMode(value: unknown): value is ButtonMode {
  return typeof value === 'string' && (BUTTON_MODES as readonly string[]).includes(value);
}

export function nextButtonMode(mode: ButtonMode): ButtonMode {
  return BUTTON_MODES[(BUTTON_MODES.indexOf(mode) + 1) % BUTTON_MODES.length];
}

export function describeButtonMode(mode: ButtonMode): string {
  if (mode === 'web') return 'сайт';
  if (mode === 'miniapp') return 'Mini App';
  return 'сайт и Mini App';
}

export function httpsUrl(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * One keyboard builder for the preview and for the worker, so the preview shows
 * exactly the buttons that recipients get. The web button is a plain URL button.
 * Only the Mini App button uses web_app.
 */
export function buildBroadcastMarkup(
  mode: ButtonMode,
  includeButton: boolean,
  urls: ButtonUrls
): BroadcastMarkup | null {
  if (!includeButton) return null;
  const rows: BroadcastMarkup['inline_keyboard'] = [];
  const web = httpsUrl(urls.webUrl) ?? DEFAULT_WEB_URL;
  if (mode === 'web' || mode === 'both') rows.push([{ text: BROADCAST_WEB_BUTTON, url: web }]);
  const miniApp = httpsUrl(urls.miniAppUrl);
  if ((mode === 'miniapp' || mode === 'both') && miniApp) {
    rows.push([{ text: BROADCAST_OPEN_BUTTON, web_app: { url: miniApp } }]);
  }
  return rows.length > 0 ? { inline_keyboard: rows } : null;
}
