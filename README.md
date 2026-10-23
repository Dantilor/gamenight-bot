# GameNight Host Telegram Bot

Telegram-бот `@GameNightHostBot` для Mini App GameNight Host. Рабочий процесс — webhook, без long polling. Точка входа production: `server/src/main.ts` (`npm start` запускает `dist/main.js`).

Бот сохраняет текущие команды:

- `/start` — приветствие «Ваш вечер начинается прямо сейчас! ✨» и кнопка «Стать частью игры»
- `/play` — то же приветствие и кнопка «🎮 Открыть GameNight Host»
- `/ping` — `pong`
- уведомление об окончании Premium и кнопка «Продлить подписку»

Картинка приветствия — существующий файл `server/public/hero-new.png`. Она отдаётся как `/public/hero-new.png`. В режиме `api` бот загружает файл сам и при ошибке отправки фото отвечает текстом. В режиме `webhook` Telegram скачивает публичный HTTPS-адрес этой картинки.

Premium читается из PostgreSQL основной игры (`subscriptions.active_until`, `plans`). Бот не создаёт платежи и не меняет даты подписок. Оплата остаётся в Mini App и YooKassa. Страница продления — маршрут фронтенда `/premium`. Тарифы запрашиваются у `GET /api/plans`.

## Сборка и запуск

Нужен Node.js 22.

```bash
npm ci
npm run build
npm start
```

Timeweb App Platform:

- Framework: Express
- Runtime: Node.js 22
- Build command: `npm run build`
- Start command: `npm start`
- Health check: `/health`

`GET /health` возвращает HTTP 200 и `{"ok":true,"ready":true}`, когда HTTP-сервер готов принимать webhook. Это не означает, что webhook уже зарегистрирован в Telegram.

`GET /health/db` отвечает только при заголовке `X-Health-Token`, совпадающем с `HEALTHCHECK_TOKEN`. В ответе нет строки подключения.

## Безопасный старт

Пока идёт проверка на Timeweb, оставьте:

```bash
ENABLE_WEBHOOK_REGISTRATION=false
ENABLE_SUBSCRIPTION_NOTIFICATIONS=false
```

При `ENABLE_WEBHOOK_REGISTRATION=false` процесс не вызывает `setWebhook`. Остановка процесса webhook не снимает. Регистрация выполняется только в режиме `api`, при флаге `true` и только на `https://` адрес из `PUBLIC_URL` + `BOT_WEBHOOK_PATH`.

## Режим ответа

`TELEGRAM_REPLY_MODE=api` — поведение по умолчанию. Ответы уходят отдельными запросами на `https://api.telegram.org`.

`TELEGRAM_REPLY_MODE=webhook` отвечает на входящий webhook одним JSON-методом Bot API в HTTP 200. Так устроен официальный ответ при получении обновления: https://core.telegram.org/bots/api#making-requests-when-getting-updates. Этот режим не вызывает `getMe`, `setWebhook` и не передаёт обновление в Telegraf. Включения `webhookReply` у Telegraf недостаточно: перед обработчиком библиотека вызывает `getMe`, а `sendMessage` и `sendPhoto` всё равно уходят отдельным HTTP-запросом.

В режиме `webhook`:

- `/ping` — один `sendMessage` с текстом `pong` и снятием reply-клавиатуры в том же методе.
- `/start` и `/play` — один `sendPhoto`: подпись с HTML, разные кнопки `web_app` на `MINI_APP_URL`. Параметр deep-link у `/start` команду не ломает и в ответ не копируется. Кнопка `web_app` ставится только в личном чате.
- Фото — `https://<PUBLIC_URL>/public/hero-new.png`. Если заранее нет файла, `PUBLIC_URL` не является https без логина и пароля или `MINI_APP_URL` нельзя использовать как https-кнопку, ответ готовится как `sendMessage`. Повторной отправки после `sendPhoto` нет: Telegram не возвращает результат этого метода.
- В группе команда с `@именем` не обрабатывается: без `getMe` имя бота неизвестно. Команда без `@имени` обрабатывается, но кнопка `web_app` туда не ставится.
- Отдельные запросы на удаление прошлого приветствия и на пустое сообщение со снятием клавиатуры не выполняются.
- `renew_subscription` — один `sendMessage` с тарифами `GET /api/plans` и кнопкой на `/premium` в личном чате. `answerCallbackQuery` не отправляется, поэтому индикатор нажатия Telegram сам не гасит. `message_id` не сохраняется.
- Неизвестное обновление завершается пустым HTTP 200 и наружу к Telegram не идёт.
- `ENABLE_WEBHOOK_REGISTRATION=true` и `ENABLE_SUBSCRIPTION_NOTIFICATIONS=true` в этом режиме не выполняются. Процесс пишет, что регистрация и рассылка невозможны, и не сообщает об успехе. Уже установленный webhook не снимается.

При `ENABLE_SUBSCRIPTION_NOTIFICATIONS=false` сообщения о подписках не отправляются. Перед включением примените миграцию от имени владельца базы:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/db/migrations/001_bot_subscription_expiry_notices.sql
```

Либо, тем же владельцем: `npm run migrate`.

Роли бота достаточно `SELECT` на `plans` и `subscriptions` и `SELECT/INSERT/UPDATE` на таблицы уведомлений. Права на изменение подписок ей не выдавайте. Первый запуск с включёнными уведомлениями записывает уже наступившие окончания как исторические и не рассылает их.

## Проверка

```bash
npm test
```

Тесты не используют боевой токен, не создают платежи и не подключаются к production-базе. Они проверяют локальный HTTP-ответ и не доказывают, что Telegram принял метод и доставил сообщение.
