# Инструкции по развертыванию Nutrition Bot

## 🚀 Быстрый старт

### 1. Подготовка окружения

```bash
# Клонируйте репозиторий
git clone https://github.com/progprogect/NutritionBot.git
cd NutritionBot

# Установите зависимости
npm install
```

### 2. Настройка базы данных

```bash
# Запустите PostgreSQL в Docker
docker run --name foodbot-db \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=foodbot \
  -p 5433:5432 \
  -d postgres

# Дождитесь запуска (5-10 секунд)
sleep 10

# Примените миграции
psql "postgresql://postgres:postgres@localhost:5433/foodbot" -f migrations/2025-09-22-add-items-and-cache.sql
psql "postgresql://postgres:postgres@localhost:5433/foodbot" -f migrations/2025-09-22-metrics.sql
psql "postgresql://postgres:postgres@localhost:5433/foodbot" -f migrations/2025-09-22-coach-requests.sql
```

### 3. Настройка переменных окружения

Создайте файл `.env`:

```env
# Telegram Bot Token (получите у @BotFather)
BOT_TOKEN=your_telegram_bot_token

# База данных
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/foodbot

# OpenAI API Key
OPENAI_API_KEY=your_openai_api_key

# Telegram ID администратора (для /mvpstats)
ADMIN_TG_ID=your_telegram_id

# Telegram ID тренера (для /inbox)
TRAINER_TG_ID=trainer_telegram_id
```

### 4. Запуск бота

```bash
node index.js
```

## 🔧 Получение необходимых ключей

### Telegram Bot Token
1. Напишите [@BotFather](https://t.me/BotFather) в Telegram
2. Отправьте `/newbot`
3. Следуйте инструкциям для создания бота
4. Скопируйте полученный токен

### OpenAI API Key
1. Зарегистрируйтесь на [platform.openai.com](https://platform.openai.com)
2. Перейдите в раздел API Keys
3. Создайте новый ключ
4. Скопируйте ключ (начинается с `sk-`)

### Telegram ID
1. Напишите боту [@userinfobot](https://t.me/userinfobot)
2. Скопируйте ваш ID (число)

## 🐳 Docker развертывание

### Dockerfile
```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 3000

CMD ["node", "index.js"]
```

### docker-compose.yml
```yaml
version: '3.8'

services:
  bot:
    build: .
    environment:
      - BOT_TOKEN=${BOT_TOKEN}
      - DATABASE_URL=postgresql://postgres:postgres@db:5432/foodbot
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - ADMIN_TG_ID=${ADMIN_TG_ID}
      - TRAINER_TG_ID=${TRAINER_TG_ID}
    depends_on:
      - db
    restart: unless-stopped

  db:
    image: postgres:15
    environment:
      - POSTGRES_PASSWORD=postgres
      - POSTGRES_USER=postgres
      - POSTGRES_DB=foodbot
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./migrations:/docker-entrypoint-initdb.d
    ports:
      - "5432:5432"
    restart: unless-stopped

volumes:
  postgres_data:
```

### Запуск с Docker
```bash
# Создайте .env файл с переменными
cp .env.example .env

# Запустите сервисы
docker-compose up -d

# Проверьте логи
docker-compose logs -f bot
```

## 🔍 Мониторинг и логи

### Проверка работы бота
```bash
# Проверьте статус
ps aux | grep "node index.js"

# Проверьте логи
tail -f logs/bot.log
```

### Проверка базы данных
```bash
# Подключитесь к БД
psql "postgresql://postgres:postgres@localhost:5433/foodbot"

# Проверьте таблицы
\dt

# Проверьте записи
SELECT COUNT(*) FROM "FoodEntry";
```

### Метрики
```bash
# Получите статистику (только для админа)
# Отправьте /mvpstats в Telegram боту
```

## 🛠 Обслуживание

### Обновление бота
```bash
git pull origin main
npm install
# Перезапустите бота
```

### Резервное копирование БД
```bash
# Создайте бэкап
pg_dump "postgresql://postgres:postgres@localhost:5433/foodbot" > backup.sql

# Восстановите из бэкапа
psql "postgresql://postgres:postgres@localhost:5433/foodbot" < backup.sql
```

### Очистка логов
```bash
# Очистите старые метрики (старше 30 дней)
psql "postgresql://postgres:postgres@localhost:5433/foodbot" -c "
DELETE FROM metrics_events 
WHERE created_at < NOW() - INTERVAL '30 days';"
```

## 🚨 Устранение неполадок

### Бот не отвечает
1. Проверьте токен бота в `.env`
2. Проверьте подключение к интернету
3. Проверьте логи на ошибки

### Ошибки базы данных
1. Проверьте, что PostgreSQL запущен
2. Проверьте строку подключения в `.env`
3. Убедитесь, что миграции применены

### Ошибки OpenAI API
1. Проверьте API ключ
2. Проверьте лимиты и квоты
3. Проверьте баланс аккаунта

### Фото не распознаются
1. Проверьте качество фото
2. Убедитесь, что на фото видна еда
3. Попробуйте добавить подпись к фото

## 📞 Поддержка

При возникновении проблем:
1. Проверьте логи бота
2. Проверьте статус сервисов
3. Создайте issue в GitHub репозитории
