# 🚀 Развертывание Nutrition Bot на Railway

## Пошаговая инструкция

### 1. Подключение к Railway

1. Зайдите на [railway.app](https://railway.app)
2. Войдите в аккаунт (или зарегистрируйтесь)
3. Нажмите **"New Project"**
4. Выберите **"Deploy from GitHub repo"**
5. Найдите и выберите репозиторий: `progprogect/NutritionBot`

### 2. Настройка переменных окружения

В настройках проекта Railway добавьте следующие переменные:

#### В разделе "Variables":

```env
# Telegram Bot Token
BOT_TOKEN=your_telegram_bot_token_here

# OpenAI API Key  
OPENAI_API_KEY=your_openai_api_key_here

# Admin & Trainer IDs
ADMIN_TG_ID=319719503
TRAINER_TG_ID=319719503

# Environment
RAILWAY_ENVIRONMENT=production
NODE_ENV=production
```

### 3. Добавление PostgreSQL

1. В настройках проекта нажмите **"New Service"**
2. Выберите **"Database"** → **"PostgreSQL"**
3. Railway автоматически создаст переменные:
   - `DATABASE_URL`
   - `DATABASE_PUBLIC_URL` 
   - `POSTGRES_USER`
   - `POSTGRES_PASSWORD`

### 4. Деплой

Railway автоматически:
1. Обнаружит `package.json`
2. Установит зависимости: `npm install`
3. Запустит бота: `node index.js`
4. Применит миграции базы данных

## ✅ Проверка работы

### Логи
1. Перейдите в раздел **"Deployments"**
2. Нажмите на последний деплой
3. Откройте вкладку **"Logs"**

**Ожидаемые логи:**
```
✅ Подключение к PostgreSQL успешно
🔧 Применяем миграции базы данных...
✅ База данных инициализирована
✅ Бот запущен, жду сообщения в Telegram...
```

### Тестирование бота
1. Найдите вашего бота в Telegram
2. Отправьте `/start`
3. Попробуйте добавить еду: **"овсянка 60 г и молоко 200 мл"**
4. Проверьте команду `/day`

## 🔧 Устранение неполадок

### Бот не отвечает
- ✅ Проверьте логи на ошибки
- ✅ Убедитесь, что `BOT_TOKEN` правильный
- ✅ Проверьте, что бот не заблокирован

### Ошибки базы данных
- ✅ Проверьте, что PostgreSQL сервис запущен
- ✅ Убедитесь, что миграции применились
- ✅ Проверьте переменную `DATABASE_URL`

### Ошибки OpenAI
- ✅ Проверьте `OPENAI_API_KEY`
- ✅ Убедитесь, что у вас есть кредиты на аккаунте
- ✅ Проверьте лимиты API

## 📊 Мониторинг

### Railway Dashboard
- CPU и Memory usage
- Network traffic
- Response times
- Logs в реальном времени

### Команды для проверки
- `/start` - начать работу
- `/day` - показать записи за сегодня
- `/mvpstats` - статистика (только для админа)
- `/inbox` - заявки (только для тренера)

## 💰 Стоимость

### Railway
- **Hobby Plan**: $5/месяц
- **Pro Plan**: $20/месяц

### OpenAI API (примерно)
- **GPT-4o-mini**: ~$0.15 за 1M токенов
- **Whisper**: $0.006 за минуту аудио
- **Vision**: $0.0025 за 1K токенов

## 🔄 Обновления

Railway автоматически деплоит изменения при push в main ветку.

## 🎉 Готово!

Ваш Nutrition Bot теперь работает на Railway! 

**Ссылки:**
- [Railway Dashboard](https://railway.app/dashboard)
- [GitHub Repository](https://github.com/progprogect/NutritionBot)
- [Telegram Bot](https://t.me/your_bot_username)
