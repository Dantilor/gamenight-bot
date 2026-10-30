import crypto from 'node:crypto';
import type { BroadcastDraft, BroadcastStore } from './broadcastStore.js';
import { redact } from './log.js';
import type { TelegramUpdate } from './webhook.js';

export const BROADCAST_OPEN_BUTTON = '🎮 Открыть GameNight Host';

const TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;

type CallbackButton = { text: string; callback_data: string };
type WebAppButton = { text: string; web_app: { url: string } };
type InlineMarkup = { inline_keyboard: Array<Array<CallbackButton | WebAppButton>> };

export type PanelReply = {
  method: 'sendMessage' | 'sendPhoto';
  chat_id: number;
  text?: string;
  caption?: string;
  photo?: string;
  parse_mode?: 'HTML';
  reply_markup?: InlineMarkup;
};

type Actor = { userId: number; chatId: number; chatType: string };

export type BroadcastTurnDeps = {
  adminId: number | null;
  miniAppUrl: string;
  store: BroadcastStore | null;
};

export async function rememberPrivateContact(store: BroadcastStore | null, update: TelegramUpdate): Promise<void> {
  if (!store) return;
  const actor = readActor(update);
  if (!actor || actor.chatType !== 'private' || actor.chatId !== actor.userId) return;
  try {
    if (!(await store.tablesReady())) return;
    await store.touchContact(actor.userId, actor.chatId);
  } catch (error) {
    console.error('[broadcast] contact was not stored', redact(error));
  }
}

export async function handleBroadcastTurn(update: TelegramUpdate, deps: BroadcastTurnDeps): Promise<PanelReply | null> {
  const actor = readActor(update);
  if (!actor) return null;
  const callback = readCallback(update);
  const command = readCommandName(update);
  const text = readText(update);
  const photoFileId = readPhotoFileId(update);

  if (callback?.startsWith('bc:')) return adsTurn(actor, callback, deps);
  if (command === 'subscribe' || command === 'unsubscribe') return consentTurn(actor, command === 'subscribe', deps);
  if (command === 'admin' || callback?.startsWith('ba:') || (await adminIsEditing(actor, deps, text, photoFileId))) {
    return adminTurn(actor, { command, callback, text, photoFileId }, deps);
  }
  return null;
}

async function adminIsEditing(
  actor: Actor,
  deps: BroadcastTurnDeps,
  text: string | null,
  photoFileId: string | null
): Promise<boolean> {
  if (!isAdmin(actor, deps.adminId) || !deps.store) return false;
  if (!(await ready(deps.store))) return false;
  const draft = await deps.store.getDraft(actor.userId);
  if (draft.step === 'text' && text && !text.startsWith('/')) return true;
  if (draft.step === 'photo' && photoFileId) return true;
  return false;
}

async function adminTurn(
  actor: Actor,
  input: { command: string | null; callback: string | null; text: string | null; photoFileId: string | null },
  deps: BroadcastTurnDeps
): Promise<PanelReply> {
  if (!isAdmin(actor, deps.adminId)) return textReply(actor.chatId, 'Команда недоступна.');
  if (!deps.store || !(await ready(deps.store))) {
    return textReply(actor.chatId, 'Панель рассылки недоступна: таблицы ещё не созданы. Сообщения не отправлялись.');
  }
  const store = deps.store;
  const draft = await store.getDraft(actor.userId);
  if (draft.step === 'text' && input.text && !input.text.startsWith('/') && !input.command && !input.callback) {
    return saveText(actor, draft, input.text, store);
  }
  if (draft.step === 'photo' && input.photoFileId && !input.command && !input.callback) {
    return savePhoto(actor, draft, input.photoFileId, store);
  }
  const action = input.command === 'admin' ? 'menu' : actionOf(input.callback);
  if (!action) return textReply(actor.chatId, 'Неизвестное действие. Откройте /admin ещё раз.');
  if (action === 'menu' || action === 'cancel') return showMenu(actor, await resetDraft(store, draft, action === 'cancel'), action === 'cancel');
  if (action === 'new') return askText(actor, draft, store);
  if (action === 'photo') return askPhoto(actor, draft, store);
  if (action === 'preview') return preview(actor, draft, deps.miniAppUrl);
  if (action === 'test') return queueTest(actor, draft, store);
  if (action === 'send') return askConfirm(actor, draft, store);
  if (action === 'stats') return showStats(actor, store);
  if (action === 'stop') return stop(actor, store);
  if (action.startsWith('go:')) return confirm(actor, draft, action.slice(3), store);
  if (action === 'aud') return toggleAudience(actor, draft, store);
  return textReply(actor.chatId, 'Неизвестное действие. Откройте /admin ещё раз.');
}

async function adsTurn(actor: Actor, callback: string, deps: BroadcastTurnDeps): Promise<PanelReply> {
  if (actor.chatType !== 'private' || actor.chatId !== actor.userId) {
    return textReply(actor.chatId, 'Согласие на рекламу меняется только в личном чате.');
  }
  if (!deps.store || !(await ready(deps.store))) return textReply(actor.chatId, 'Список получателей ещё не готов.');
  if (callback === 'bc:ads:on') {
    await deps.store.setAdsOptIn(actor.userId, actor.chatId, true);
    return textReply(actor.chatId, 'Согласие на рекламные сообщения включено. Его можно отозвать кнопкой ниже.', adsKeyboard(true));
  }
  if (callback === 'bc:ads:off') {
    await deps.store.setAdsOptIn(actor.userId, actor.chatId, false);
    return textReply(actor.chatId, 'Согласие на рекламные сообщения выключено.', adsKeyboard(false));
  }
  return textReply(actor.chatId, 'Неизвестное действие.');
}

async function consentTurn(actor: Actor, optedIn: boolean, deps: BroadcastTurnDeps): Promise<PanelReply> {
  if (actor.chatType !== 'private' || actor.chatId !== actor.userId) {
    return textReply(actor.chatId, 'Подписка на сообщения бота меняется только в личном чате.');
  }
  if (!deps.store || !(await ready(deps.store))) return textReply(actor.chatId, 'Список получателей ещё не готов.');
  await deps.store.setNotifyOptOut(actor.userId, actor.chatId, !optedIn);
  if (!optedIn) {
    await deps.store.setAdsOptIn(actor.userId, actor.chatId, false);
    return textReply(actor.chatId, 'Информационные уведомления выключены. Новые рассылки этого типа вам не ставятся. Реклама тоже не придёт.');
  }
  return textReply(
    actor.chatId,
    'Отказ от информационных уведомлений снят. Реклама по-прежнему выключена, пока вы отдельно её не разрешите.',
    adsKeyboard(false)
  );
}

async function saveText(actor: Actor, draft: BroadcastDraft, text: string, store: BroadcastStore): Promise<PanelReply> {
  if (text.length > TEXT_LIMIT) return textReply(actor.chatId, `Текст длиннее ${TEXT_LIMIT} символов. Пришлите более короткий.`);
  if (draft.photoFileId && text.length > CAPTION_LIMIT) {
    return textReply(actor.chatId, `С фотографией текст не длиннее ${CAPTION_LIMIT} символов. Укоротите его или уберите фото через отмену.`);
  }
  draft.bodyHtml = text;
  draft.step = 'idle';
  draft.confirmToken = null;
  await store.saveDraft(draft);
  return showMenu(actor, draft, false, 'Текст сохранён.');
}

async function savePhoto(actor: Actor, draft: BroadcastDraft, fileId: string, store: BroadcastStore): Promise<PanelReply> {
  if (!draft.bodyHtml.trim()) return textReply(actor.chatId, 'Сначала пришлите текст рассылки.');
  if (draft.bodyHtml.length > CAPTION_LIMIT) {
    return textReply(actor.chatId, `Подпись к фотографии не длиннее ${CAPTION_LIMIT} символов. Укоротите текст.`);
  }
  draft.photoFileId = fileId;
  draft.step = 'idle';
  draft.confirmToken = null;
  await store.saveDraft(draft);
  return showMenu(actor, draft, false, 'Фотография прикреплена. В очередь она ещё не поставлена.');
}

async function askText(actor: Actor, draft: BroadcastDraft, store: BroadcastStore): Promise<PanelReply> {
  draft.step = 'text';
  draft.confirmToken = null;
  await store.saveDraft(draft);
  return textReply(
    actor.chatId,
    'Пришлите текст рассылки одним сообщением.\nМожно использовать HTML: <b>жирный</b>, <i>курсив</i>, <a href="https://example.com">ссылка</a>.'
  );
}

async function askPhoto(actor: Actor, draft: BroadcastDraft, store: BroadcastStore): Promise<PanelReply> {
  if (!draft.bodyHtml.trim()) return textReply(actor.chatId, 'Сначала создайте текст рассылки.');
  draft.step = 'photo';
  draft.confirmToken = null;
  await store.saveDraft(draft);
  return textReply(actor.chatId, 'Пришлите одну фотографию. Она будет показана вместе с сохранённым текстом.');
}

function preview(actor: Actor, draft: BroadcastDraft, miniAppUrl: string): PanelReply {
  if (!draft.bodyHtml.trim()) return textReply(actor.chatId, 'Черновик пуст. Сначала создайте текст.');
  return draftMessage(actor.chatId, draft, miniAppUrl);
}

async function queueTest(actor: Actor, draft: BroadcastDraft, store: BroadcastStore): Promise<PanelReply> {
  const result = await store.queueTest(actor.userId, draft);
  if (!result.ok) return textReply(actor.chatId, 'Сначала создайте текст. Тест никому не поставлен.');
  if (result.duplicate) {
    return textReply(actor.chatId, 'Тест для вас уже стоит в очереди и повторно не создан. Его отправит broadcast-worker, когда появится доступ к Telegram.');
  }
  return textReply(
    actor.chatId,
    `Тест поставлен в очередь только для Telegram ID ${actor.userId}. Другие получатели не добавлены.\n` +
      'Этот процесс сообщение не отправляет. Пока Telegram не вернёт message_id, доставка не считается успешной.'
  );
}

async function askConfirm(actor: Actor, draft: BroadcastDraft, store: BroadcastStore): Promise<PanelReply> {
  if (!draft.bodyHtml.trim()) return textReply(actor.chatId, 'Сначала создайте текст. Рассылка не создана.');
  let recipients: number;
  try {
    recipients = await store.countRecipients(draft.audience);
  } catch (error) {
    console.error('[broadcast] recipients were not counted', redact(error));
    return textReply(actor.chatId, 'Список получателей не прочитан. Рассылка не создана и сообщения не отправлялись.');
  }
  const token = crypto.randomBytes(6).toString('hex');
  draft.step = 'confirm';
  draft.confirmToken = token;
  await store.saveDraft(draft);
  const audience = draft.audience === 'ads'
    ? 'реклама. В очередь попадут только те, кто заранее разрешил рекламу.'
    : 'информация. Берутся Telegram ID из users, кроме отказавшихся и недоступных.';
  return textReply(
    actor.chatId,
    `Получателей: ${recipients}.\nАудитория: ${audience}\n` +
      'Это ещё не отправка. Подтверждение только ставит сообщения в очередь.\n' +
      'Доставка будет засчитана после message_id от Telegram.',
    {
      inline_keyboard: [
        [{ text: '✅ Подтвердить', callback_data: `ba:go:${token}` }],
        [{ text: draft.audience === 'ads' ? '🔔 Сделать информацией' : '📣 Сделать рекламой', callback_data: 'ba:aud' }],
        [{ text: '← Назад', callback_data: 'ba:menu' }],
      ],
    }
  );
}

async function confirm(actor: Actor, draft: BroadcastDraft, token: string, store: BroadcastStore): Promise<PanelReply> {
  let result: Awaited<ReturnType<BroadcastStore['queueMass']>>;
  try {
    result = await store.queueMass(actor.userId, token);
  } catch (error) {
    console.error('[broadcast] recipients were not queued', redact(error));
    return textReply(actor.chatId, 'Список получателей не прочитан. Рассылка не создана и сообщения не отправлялись.');
  }
  if (!result.ok && result.reason === 'empty') {
    const text = draft.audience === 'ads'
      ? 'Нет получателей с предварительным согласием на рекламу. Рассылка не создана.'
      : 'Доступных получателей нет. Рассылка не создана.';
    return textReply(actor.chatId, text);
  }
  if (!result.ok && result.reason === 'busy') {
    return textReply(actor.chatId, 'Уже есть незавершённая рассылка. Новая не создана. Сначала остановите текущую.');
  }
  if (!result.ok) return textReply(actor.chatId, 'Подтверждение не принято. Рассылка не создана.');
  if (result.duplicate) {
    return textReply(actor.chatId, `Это подтверждение уже принято. Повторно получатели не добавлены. В очереди: ${result.recipients}.`);
  }
  return textReply(
    actor.chatId,
    `В очередь поставлено ${result.recipients} сообщений. Ни одно ещё не отправлено.\n` +
      'Отправку выполняет только отдельно запущенный broadcast-worker на сети, где открывается api.telegram.org.'
  );
}

async function toggleAudience(actor: Actor, draft: BroadcastDraft, store: BroadcastStore): Promise<PanelReply> {
  if (draft.step !== 'confirm' || !draft.confirmToken) return showMenu(actor, draft, false);
  draft.audience = draft.audience === 'ads' ? 'notify' : 'ads';
  return askConfirm(actor, draft, store);
}

async function showStats(actor: Actor, store: BroadcastStore): Promise<PanelReply> {
  const stats = await store.stats(actor.userId);
  return textReply(
    actor.chatId,
    `Очередь: ${stats.pending}\nОтправлено и подтверждено: ${stats.sent}\nОшибки: ${stats.failed}\nЗаблокировали бота: ${stats.blocked}\n` +
      `Кампании в очереди: ${stats.queuedCampaigns}\nКампании в работе: ${stats.runningCampaigns}`
  );
}

async function stop(actor: Actor, store: BroadcastStore): Promise<PanelReply> {
  const stopped = await store.stopActive(actor.userId);
  return textReply(
    actor.chatId,
    stopped > 0
      ? 'Рассылка остановлена. Уже подтверждённые сообщения не отменяются, остальные worker больше не возьмёт.'
      : 'Активной рассылки нет.'
  );
}

async function resetDraft(store: BroadcastStore, draft: BroadcastDraft, clearBody: boolean): Promise<BroadcastDraft> {
  if (clearBody) {
    draft.bodyHtml = '';
    draft.photoFileId = null;
    draft.audience = 'notify';
    draft.includeButton = true;
  }
  draft.step = 'idle';
  draft.confirmToken = null;
  await store.saveDraft(draft);
  return draft;
}

async function showMenu(actor: Actor, draft: BroadcastDraft, cancelled: boolean, note?: string): Promise<PanelReply> {
  const audience = draft.audience === 'ads' ? 'реклама, только с согласием' : 'информация пользователям';
  const photo = draft.photoFileId ? 'есть' : 'нет';
  const text = draft.bodyHtml.trim() ? `${draft.bodyHtml.length} символов` : 'нет';
  const prefix = [cancelled ? 'Черновик отменён.' : '', note ?? ''].filter(Boolean).join('\n');
  return textReply(
    actor.chatId,
    `${prefix ? `${prefix}\n\n` : ''}Админ-панель рассылок\nТекст: ${text}\nФотография: ${photo}\nАудитория: ${audience}\nКнопка Mini App: ${draft.includeButton ? 'да' : 'нет'}`,
    menuKeyboard()
  );
}

function draftMessage(chatId: number, draft: BroadcastDraft, miniAppUrl: string): PanelReply {
  const buttonUrl = draft.includeButton ? httpsButtonUrl(miniAppUrl) : null;
  const markup = buttonUrl
    ? { inline_keyboard: [[{ text: BROADCAST_OPEN_BUTTON, web_app: { url: buttonUrl } }]] }
    : undefined;
  if (draft.photoFileId) {
    return {
      method: 'sendPhoto',
      chat_id: chatId,
      photo: draft.photoFileId,
      caption: draft.bodyHtml,
      parse_mode: 'HTML',
      ...(markup ? { reply_markup: markup } : {}),
    };
  }
  return {
    method: 'sendMessage',
    chat_id: chatId,
    text: draft.bodyHtml,
    parse_mode: 'HTML',
    ...(markup ? { reply_markup: markup } : {}),
  };
}

function menuKeyboard(): InlineMarkup {
  return {
    inline_keyboard: [
      [{ text: '📝 Создать рассылку', callback_data: 'ba:new' }],
      [{ text: '🖼 Добавить фотографию', callback_data: 'ba:photo' }],
      [{ text: '👀 Предпросмотр', callback_data: 'ba:preview' }],
      [{ text: '🧪 Отправить тест себе', callback_data: 'ba:test' }],
      [{ text: '🚀 Отправить пользователям', callback_data: 'ba:send' }],
      [{ text: '📊 Статистика', callback_data: 'ba:stats' }],
      [{ text: '🛑 Остановить рассылку', callback_data: 'ba:stop' }],
      [{ text: '❌ Отмена', callback_data: 'ba:cancel' }],
    ],
  };
}

function adsKeyboard(enabled: boolean): InlineMarkup {
  return {
    inline_keyboard: [[{ text: enabled ? 'Отключить рекламу' : 'Включить рекламу', callback_data: enabled ? 'bc:ads:off' : 'bc:ads:on' }]],
  };
}

function textReply(chatId: number, text: string, replyMarkup?: InlineMarkup): PanelReply {
  return {
    method: 'sendMessage',
    chat_id: chatId,
    text,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };
}

function isAdmin(actor: Actor, adminId: number | null): boolean {
  return adminId !== null && actor.userId === adminId && actor.chatType === 'private' && actor.chatId === actor.userId;
}

function actionOf(callback: string | null): string | null {
  if (!callback || !callback.startsWith('ba:')) return null;
  const action = callback.slice(3);
  if (action.startsWith('go:')) {
    const token = action.slice(3);
    return /^[a-f0-9]{12}$/.test(token) ? action : null;
  }
  if (['menu', 'new', 'photo', 'preview', 'test', 'send', 'stats', 'stop', 'cancel', 'aud'].includes(action)) return action;
  return null;
}

function httpsButtonUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return trimmed;
  } catch {
    return null;
  }
}

async function ready(store: BroadcastStore): Promise<boolean> {
  try {
    return await store.tablesReady();
  } catch (error) {
    console.error('[broadcast] registry is unavailable', redact(error));
    return false;
  }
}

function readActor(update: TelegramUpdate): Actor | null {
  const callback = asRecord(update.callback_query);
  if (callback) {
    const from = readUserId(callback.from);
    const message = asRecord(callback.message);
    const chat = readChat(message?.chat);
    if (from === null || !chat) return null;
    return { userId: from, chatId: chat.id, chatType: chat.type };
  }
  const message = asRecord(update.message);
  if (!message) return null;
  const from = readUserId(message.from);
  const chat = readChat(message.chat);
  if (from === null || !chat) return null;
  return { userId: from, chatId: chat.id, chatType: chat.type };
}

function readCallback(update: TelegramUpdate): string | null {
  const callback = asRecord(update.callback_query);
  return typeof callback?.data === 'string' ? callback.data : null;
}

function readText(update: TelegramUpdate): string | null {
  const message = asRecord(update.message);
  return typeof message?.text === 'string' ? message.text : null;
}

function readCommandName(update: TelegramUpdate): string | null {
  const text = readText(update);
  if (!text) return null;
  const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s|$)/.exec(text);
  return match ? match[1].toLowerCase() : null;
}

function readPhotoFileId(update: TelegramUpdate): string | null {
  const message = asRecord(update.message);
  const photos = message?.photo;
  if (!Array.isArray(photos)) return null;
  let best: string | null = null;
  let area = -1;
  for (const item of photos) {
    const photo = asRecord(item);
    if (!photo || typeof photo.file_id !== 'string') continue;
    const width = typeof photo.width === 'number' ? photo.width : 0;
    const height = typeof photo.height === 'number' ? photo.height : 0;
    const size = width * height;
    if (size >= area) {
      area = size;
      best = photo.file_id;
    }
  }
  return best;
}

function readUserId(value: unknown): number | null {
  const user = asRecord(value);
  if (!user || typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0) return null;
  return user.id;
}

function readChat(value: unknown): { id: number; type: string } | null {
  const chat = asRecord(value);
  if (!chat || typeof chat.id !== 'number' || !Number.isSafeInteger(chat.id)) return null;
  return { id: chat.id, type: typeof chat.type === 'string' ? chat.type : '' };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
