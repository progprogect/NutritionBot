# Настройка Nutrition Bot на Railway

## 🚀 Быстрый старт

### 1. Подключение к GitHub

1. Зайдите на [railway.app](https://railway.app)
2. Нажмите "New Project"
3. Выберите "Deploy from GitHub repo"
4. Подключите репозиторий: `https://github.com/progprogect/NutritionBot.git`

### 2. Настройка переменных окружения

В настройках проекта Railway добавьте следующие переменные:

```env
# Telegram Bot
BOT_TOKEN=your_telegram_bot_token_here

# OpenAI
OPENAI_API_KEY=your_openai_api_key_here

# Admin & Trainer IDs
ADMIN_TG_ID=319719503
TRAINER_TG_ID=319719503

# Environment
RAILWAY_ENVIRONMENT=production
NODE_ENV=production
```

### 3. Добавление PostgreSQL

1. В настройках проекта нажмите "New Service"
2. Выберите "Database" → "PostgreSQL"
3. Railway автоматически создаст переменные:
   - `DATABASE_URL`
   - `DATABASE_PUBLIC_URL`
   - `POSTGRES_USER`
   - `POSTGRES_PASSWORD`

### 4. Деплой

1. Railway автоматически обнаружит `package.json`
2. Установит зависимости: `npm install`
3. Запустит бота: `node index.js`
4. Применит миграции базы данных автоматически

## 🔧 Проверка работы

### Логи
```bash
# В интерфейсе Railway перейдите в раздел "Deployments"
# Нажмите на последний деплой
# Откройте вкладку "Logs"
```

Ожидаемые логи:
```
✅ Подключение к PostgreSQL успешно
🔧 Применяем миграции базы данных...
✅ База данных инициализирована
✅ Бот запущен, жду сообщения в Telegram...
```

### Тестирование
1. Найдите вашего бота в Telegram
2. Отправьте `/start`
3. Попробуйте добавить еду: "овсянка 60 г и молоко 200 мл"
4. Проверьте команду `/day`

## 🛠 Устранение неполадок

### Бот не отвечает
1. Проверьте логи на ошибки
2. Убедитесь, что `BOT_TOKEN` правильный
3. Проверьте, что бот не заблокирован

### Ошибки базы данных
1. Проверьте, что PostgreSQL сервис запущен
2. Убедитесь, что миграции применились
3. Проверьте переменную `DATABASE_URL`

### Ошибки OpenAI
1. Проверьте `OPENAI_API_KEY`
2. Убедитесь, что у вас есть кредиты на аккаунте
3. Проверьте лимиты API

## 📊 Мониторинг

### Метрики Railway
- CPU и Memory usage
- Network traffic
- Response times

### Логи бота
- Ошибки обработки сообщений
- Время отклика API
- Статистика использования

### База данных
```sql
-- Проверка таблиц
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public';

-- Проверка записей
SELECT COUNT(*) FROM "FoodEntry";
SELECT COUNT(*) FROM food_items;
```

## 🔄 Обновления

### Автоматические
Railway автоматически деплоит изменения при push в main ветку.

### Ручные
1. В интерфейсе Railway нажмите "Redeploy"
2. Или сделайте push в репозиторий

## 💰 Стоимость

### Railway
- **Hobby Plan**: $5/месяц
- **Pro Plan**: $20/месяц
- **Team Plan**: $99/месяц

### OpenAI API
- **GPT-4o-mini**: ~$0.15 за 1M токенов
- **Whisper**: $0.006 за минуту аудио
- **Vision**: $0.0025 за 1K токенов

### PostgreSQL
- Включен в план Railway
- 1GB хранилища на Hobby плане

## 🔗 Полезные ссылки

- [Railway Dashboard](https://railway.app/dashboard)
- [Railway Docs](https://docs.railway.app)
- [Telegram Bot API](https://core.telegram.org/bots/api)
- [OpenAI API](https://platform.openai.com/docs)
