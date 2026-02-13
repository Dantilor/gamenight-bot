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
```

- `BOT_TOKEN` — токен Telegram-бота от `@BotFather`
- `WEBAPP_URL` — URL твоего Telegram Mini App (WebApp)

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

## Заметки

- Файл `assets/hero.jpg` сейчас является **заглушкой** (текстовый файл с расширением `.jpg`).  
  Обязательно **замени его на реальное JPEG‑изображение** (hero-картинка для твоего Mini App).
- Бот использует long polling (без webhooks).
- Бот не отправляет никаких других сообщений, кроме hero-сообщения на `/start` и `/play`.

