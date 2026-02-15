# GameNight Telegram Bot Launcher

Минимальный Telegram-бот лаунчер для Mini App GameNight.

Бот:
- обрабатывает команды `/start` и `/play`
- отправляет одно hero-сообщение с картинкой, описанием и кнопкой WebApp
- перед отправкой нового hero-сообщения удаляет предыдущее в этом чате

## Требования

- Node.js 18+ (рекомендуется)

## Установка

```bash
git clone <your-repo-url>
cd gamenight-bot
npm install
```

## Настройка окружения

1. Создай файл `.env` **в корне проекта рядом с `package.json`** на основе примера:

```bash
cp .env.example .env
```

2. Открой `.env` и добавь свои значения:

```bash
BOT_TOKEN=ВАШ_ТОКЕН_ОТ_BOTFATHER
WEBAPP_URL=ВАШ_URL_MINI_APP
PUBLIC_URL=https://your-app.onrender.com
BOT_WEBHOOK_PATH=/telegram/webhook-SECRET
```

- `BOT_TOKEN` — токен Telegram-бота от `@BotFather`
- `WEBAPP_URL` — URL твоего Telegram Mini App (WebApp)
- `PUBLIC_URL` — публичный URL сервиса (на Render можно использовать `RENDER_EXTERNAL_URL`, он подставляется автоматически)
- `BOT_WEBHOOK_PATH` — секретный путь для webhook (по умолчанию `/telegram/webhook-SECRET`). Не делайте путь публично известным.

## Скрипты

- `npm run dev` — запуск бота в dev-режиме (ts-node, без сборки)
- `npm run build` — сборка TypeScript в `dist`
- `npm start` — запуск собранного бота из `dist`

### Примеры

Запуск в dev-режиме:

```bash
npm run dev
```

Сборка и запуск прод-версии:

```bash
npm run build
npm start
```

## Проверка

**Health (Render и мониторинг):**
```bash
curl -s https://your-app.onrender.com/health
# ответ: ok
```

**Текущий webhook (нужен BOT_TOKEN):**
```bash
curl -s "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```
В ответе будет поле `url` с зарегистрированным webhook (должен совпадать с `PUBLIC_URL` + `BOT_WEBHOOK_PATH`).

## Деплой на Render (один Web Service)

- Тип: **Web Service**. Один сервис — и бот (webhook), и при необходимости API mini-app.
- **Переменные окружения:** `BOT_TOKEN`, `WEBAPP_URL`, `BOT_WEBHOOK_PATH` (опционально, по умолчанию `/telegram/webhook-SECRET`). `PUBLIC_URL` на Render можно не задавать — подставляется `RENDER_EXTERNAL_URL`.
- После деплоя в логах должно быть: `Webhook set to https://<your-service>.onrender.com<BOT_WEBHOOK_PATH>`.
- Старый отдельный сервис бота (если был): можно отключить или удалить; webhook теперь указывает на этот единый сервис.

## Заметки

- Бот работает **только через webhook** (без long polling). При старте, если задан `PUBLIC_URL` или `RENDER_EXTERNAL_URL`, webhook регистрируется автоматически.
- Бот не отправляет никаких других сообщений, кроме hero-сообщения на `/start` и `/play`.

