# GameNight Telegram Bot Launcher

Минимальный Telegram-бот лаунчер для Mini App GameNight.

Бот:
- обрабатывает команды `/start` и `/play`
- отправляет одно hero-сообщение с картинкой, описанием и кнопкой WebApp
- перед отправкой нового hero-сообщения удаляет предыдущее в этом чате
- раз в час проверяет подписки: при истечении срока переводит статус в `expired` и отправляет уведомление с кнопкой «Продлить подписку» (callback `renew_subscription` — ответ с тарифами)

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
MINI_APP_URL=https://gamenight-web.onrender.com
PUBLIC_URL=https://your-app.onrender.com
BOT_WEBHOOK_PATH=/telegram/webhook-SECRET
```

- `BOT_TOKEN` — токен Telegram-бота от @BotFather (обязательно)
- `MINI_APP_URL` — URL frontend Mini App (обязательно для кнопок `web_app`; не используйте backend/API host). Устаревший алиас: `WEBAPP_URL`
- `PUBLIC_URL` или `RENDER_EXTERNAL_URL` — публичный URL сервиса бота/webhook (на Render подставляется автоматически; нужен для картинки в /start и доступа по HTTPS к `/public/hero-new.png`)
- `BOT_WEBHOOK_PATH` — путь webhook (по умолчанию `/telegram/webhook-SECRET`)

Картинка hero после деплоя доступна по адресу: `https://<ваш-сервис>.onrender.com/public/hero-new.png`

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
- **Переменные окружения в Render (обязательные):**
  - `BOT_TOKEN` — токен от @BotFather
  - `MINI_APP_URL` — URL frontend Mini App (`https://gamenight-web.onrender.com`), не API
  - `BOT_WEBHOOK_PATH` — путь webhook **ровно как в URL** (например `/telegram/webhook-9f3k2lQp`). Без завершающего слэша. Если не задан — по умолчанию `/telegram/webhook-SECRET`.
  - `PUBLIC_URL` на Render можно не задавать — подставляется `RENDER_EXTERNAL_URL`.
- После деплоя в логах должно быть: `[webhook] route POST <BOT_WEBHOOK_PATH>` и `Webhook set to https://...`.
- **Что смотреть в Render Logs после отправки /start в боте:** должны появиться строки `[telegram] POST /telegram/...` и `[webhook] update_id: <число>`. Если их нет — запросы от Telegram не доходят до сервиса (проверьте URL webhook и что сервис не спит).

## Локальная проверка webhook endpoint (curl)

Проверка, что POST на путь webhook принимается (тело — пустой update, ответ 200):

```bash
# Пример: если BOT_WEBHOOK_PATH=/telegram/webhook-9f3k2lQp и сервис telegram-card-game.onrender.com
curl -s -X POST "https://telegram-card-game.onrender.com/telegram/webhook-9f3k2lQp" \
  -H "Content-Type: application/json" \
  -d '{"update_id":1}'
```

В ответ должен прийти 200 (тело может быть пустым). В логах Render появится `[telegram] POST /telegram/...` и `[webhook] update_id: 1`.

## Заметки

- Бот работает **только через webhook** (без long polling). При старте, если задан `PUBLIC_URL` или `RENDER_EXTERNAL_URL`, webhook регистрируется автоматически.
- Бот не отправляет никаких других сообщений, кроме hero-сообщения на `/start` и `/play`.

