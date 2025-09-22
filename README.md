# Nutrition Bot

Telegram-бот для учёта питания с поддержкой текста, голоса и фото.

## 🚀 Возможности

### Основной функционал
- **Логирование еды** через текст, голосовые сообщения и фото
- **Автоматический расчёт КБЖУ** (калории, белки, жиры, углеводы, клетчатка)
- **Просмотр записей** за любой день с помощью команды `/day`
- **Inline-кнопки** для управления записями:
  - Изменение количества граммов
  - Перенос записей на вчера
  - Удаление записей

### Дополнительные функции
- **Персональные планы питания** - анкета для заявки тренеру
- **Инбокс тренера** - управление заявками с фильтрацией по статусам
- **Метрики MVP** - статистика использования бота
- **Защита от спама** - rate limiting и таймауты

## 🛠 Технологии

- **Node.js** + **Grammy.js** (Telegram Bot API)
- **PostgreSQL** (база данных)
- **OpenAI API** (GPT-4o-mini, Whisper, Vision)
- **Docker** (для PostgreSQL)

## 📦 Установка

1. Клонируйте репозиторий:
```bash
git clone https://github.com/progprogect/NutritionBot.git
cd NutritionBot
```

2. Установите зависимости:
```bash
npm install
```

3. Настройте переменные окружения в `.env`:
```env
BOT_TOKEN=your_telegram_bot_token
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/foodbot
OPENAI_API_KEY=your_openai_api_key
ADMIN_TG_ID=your_telegram_id
TRAINER_TG_ID=trainer_telegram_id
```

4. Запустите PostgreSQL через Docker:
```bash
docker run --name foodbot-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=foodbot -p 5433:5432 -d postgres
```

5. Примените миграции базы данных:
```bash
psql "postgresql://postgres:postgres@localhost:5433/foodbot" -f migrations/2025-09-22-add-items-and-cache.sql
psql "postgresql://postgres:postgres@localhost:5433/foodbot" -f migrations/2025-09-22-metrics.sql
psql "postgresql://postgres:postgres@localhost:5433/foodbot" -f migrations/2025-09-22-coach-requests.sql
```

6. Запустите бота:
```bash
node index.js
```

## 📋 Команды

### Для пользователей
- `/start` - начать работу с ботом
- `/day` - показать записи за сегодня
- `/day вчера` - показать записи за вчера
- `/day 21.09.2025` - показать записи за конкретную дату
- `/myid` - получить свой Telegram ID

### Для администраторов
- `/mvpstats` - статистика использования бота

### Для тренеров
- `/inbox` - просмотр новых заявок
- `/inbox in_progress` - заявки в работе
- `/inbox done` - готовые заявки
- `/inbox rejected` - отклоненные заявки

## 🗄 Структура базы данных

### Основные таблицы
- `users` - пользователи бота
- `food_entries` - записи о еде
- `food_items` - детализированные позиции с КБЖУ
- `coach_requests` - заявки на персональные планы
- `metrics_events` - метрики использования
- `llm_cache` - кэш ответов LLM

## 🔧 API

### OpenAI Integration
- **GPT-4o-mini** - парсинг текста о еде
- **Whisper** - распознавание голосовых сообщений
- **Vision** - анализ фото еды

### Structured Outputs
Бот использует JSON Schema для получения структурированных данных от OpenAI API.

## 📊 Метрики

Бот собирает метрики:
- DAU (Daily Active Users)
- Типы активности (текст, голос, фото)
- Время отклика API
- Ошибки

## 🚦 Ограничения

- **Rate limiting**: 8 запросов в минуту на пользователя
- **Таймауты**: 8 сек (текст), 15 сек (голос/фото)
- **Голосовые**: максимум 60 секунд
- **Доступ к командам**: только для авторизованных пользователей

## 🤝 Разработка

### Структура проекта
```
foodbot/
├── index.js              # Основной файл бота
├── llm.js                # OpenAI интеграция
├── vision.js             # Vision API
├── migrations/           # SQL миграции
├── scripts/test/         # Тестовые скрипты
└── README.md
```

### Тестирование
```bash
# Тест парсинга дат
node scripts/test/test-date-parsing.js

# Тест инбокса тренера
node scripts/test/test-trainer-inbox.js

# Тест смены статуса заявок
node scripts/test/test-trainer-status.js
```

## 📝 Лицензия

MIT License

## 👥 Авторы

- [progprogect](https://github.com/progprogect)

## 🔗 Ссылки

- [Telegram Bot API](https://core.telegram.org/bots/api)
- [Grammy.js](https://grammy.dev/)
- [OpenAI API](https://platform.openai.com/)
- [PostgreSQL](https://www.postgresql.org/)
