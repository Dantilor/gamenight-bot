# GameNight Host Telegram Bot

Telegram-бот `@GameNightHostBot` для Mini App GameNight Host. Рабочий процесс — webhook, без long polling. Точка входа production: `server/src/main.ts` (`npm start` запускает `dist/main.js`).

Бот сохраняет текущие команды:

- `/start` — приветствие «Ваш вечер начинается прямо сейчас! ✨», снятие старой reply-клавиатуры и кнопка «Стать частью игры»
- `/play` — то же приветствие и кнопка «🎮 Открыть GameNight Host»
- `/ping` — `pong`
- уведомление об окончании Premium и кнопка «Продлить подписку»

Картинка приветствия — существующий файл `server/public/hero-new.png`. Она отдаётся как `/public/hero-new.png` и уходит в `/start` и `/play`. Если отправка фото не удалась, бот отправляет тот же текст.

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

При `ENABLE_WEBHOOK_REGISTRATION=false` процесс не вызывает `setWebhook`. Остановка процесса webhook не снимает. Регистрация выполняется только при `true` и только на `https://` адрес из `PUBLIC_URL` + `BOT_WEBHOOK_PATH`.

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

Тесты не используют боевой токен, не создают платежи и не подключаются к production-базе.
