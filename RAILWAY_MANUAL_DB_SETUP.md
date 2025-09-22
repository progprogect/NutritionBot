# 🔧 Ручная настройка базы данных Railway

## Проблема
Railway не может автоматически применить миграции из-за зависимостей между таблицами. Нужно создать структуру базы данных вручную.

## Решение

### 1. Подключитесь к PostgreSQL Railway

Используйте **DATABASE_PUBLIC_URL** из ваших переменных окружения Railway:

```bash
# Пример подключения (замените на ваш URL)
psql "postgresql://postgres:password@host:port/database?sslmode=require"
```

### 2. Выполните SQL команды по порядку

#### Шаг 1: Основные таблицы
```sql
-- Таблица пользователей
CREATE TABLE IF NOT EXISTS "User" (
    id SERIAL PRIMARY KEY,
    "tgId" TEXT UNIQUE NOT NULL,
    "createdAt" TIMESTAMP DEFAULT now()
);

-- Таблица записей о еде
CREATE TABLE IF NOT EXISTS "FoodEntry" (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
    date TIMESTAMP NOT NULL,
    "textRaw" TEXT NOT NULL,
    "createdAt" TIMESTAMP DEFAULT now()
);

-- Индексы для основных таблиц
CREATE INDEX IF NOT EXISTS idx_user_tgid ON "User"("tgId");
CREATE INDEX IF NOT EXISTS idx_foodentry_userid ON "FoodEntry"("userId");
CREATE INDEX IF NOT EXISTS idx_foodentry_date ON "FoodEntry"(date);
```

#### Шаг 2: Детализированные позиции
```sql
-- Таблица нормализованных позиций внутри записи
CREATE TABLE IF NOT EXISTS food_items (
    id SERIAL PRIMARY KEY,
    entry_id INT NOT NULL REFERENCES "FoodEntry"(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    qty NUMERIC NOT NULL,
    unit TEXT NOT NULL,
    resolved_grams NUMERIC NOT NULL,
    kcal NUMERIC NOT NULL,
    p NUMERIC NOT NULL,
    f NUMERIC NOT NULL,
    c NUMERIC NOT NULL,
    fiber NUMERIC NOT NULL,
    edited_by_user BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_food_items_entry_id ON food_items(entry_id);

-- Кэш для LLM-ответов
CREATE TABLE IF NOT EXISTS llm_cache (
    id SERIAL PRIMARY KEY,
    key_hash TEXT UNIQUE NOT NULL,
    payload_json JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_llm_cache_key_hash ON llm_cache(key_hash);
```

#### Шаг 3: Метрики
```sql
-- Таблица метрик для MVP
CREATE TABLE IF NOT EXISTS metrics_events (
    id SERIAL PRIMARY KEY,
    user_tg_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    latency_ms INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_metrics_user_tg_id ON metrics_events(user_tg_id);
CREATE INDEX IF NOT EXISTS idx_metrics_created_at ON metrics_events(created_at);
CREATE INDEX IF NOT EXISTS idx_metrics_kind ON metrics_events(kind);
```

#### Шаг 4: Заявки на персональные планы
```sql
-- Создаем enum для статусов заявок
DO $$ BEGIN
    CREATE TYPE request_status AS ENUM ('new', 'in_progress', 'done', 'rejected');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Таблица заявок на персональные планы
CREATE TABLE IF NOT EXISTS coach_requests (
    id SERIAL PRIMARY KEY,
    user_tg_id TEXT NOT NULL,
    user_id INTEGER REFERENCES "User"(id) ON DELETE CASCADE,
    goal TEXT NOT NULL,
    constraints TEXT,
    stats TEXT,
    contact TEXT NOT NULL,
    status request_status DEFAULT 'new',
    created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coach_requests_user_tg_id ON coach_requests(user_tg_id);
CREATE INDEX IF NOT EXISTS idx_coach_requests_status ON coach_requests(status);
CREATE INDEX IF NOT EXISTS idx_coach_requests_created_at ON coach_requests(created_at);
```

### 3. Проверьте созданные таблицы

```sql
-- Проверка таблиц
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public'
ORDER BY table_name;

-- Проверка индексов
SELECT indexname, tablename 
FROM pg_indexes 
WHERE schemaname = 'public'
ORDER BY tablename, indexname;
```

### 4. Перезапустите бота на Railway

После создания всех таблиц:
1. Перейдите в Railway Dashboard
2. Найдите ваш проект
3. Нажмите "Redeploy" или подождите автоматического деплоя

## Ожидаемый результат

После настройки базы данных бот должен запуститься без ошибок:

```
✅ Подключение к PostgreSQL успешно
✅ Бот запущен, жду сообщения в Telegram...
```

## Альтернативный способ

Если у вас есть доступ к Railway CLI:

```bash
# Установите Railway CLI
npm install -g @railway/cli

# Войдите в аккаунт
railway login

# Подключитесь к проекту
railway link

# Выполните SQL команды
railway run psql < migrations/2025-09-22-01-init-tables.sql
railway run psql < migrations/2025-09-22-02-add-items-and-cache.sql
railway run psql < migrations/2025-09-22-03-metrics.sql
railway run psql < migrations/2025-09-22-04-coach-requests.sql
```

## Проверка работы

После настройки базы данных:
1. Отправьте `/start` боту
2. Попробуйте добавить еду: "овсянка 60 г и молоко 200 мл"
3. Проверьте команду `/day`
4. Проверьте команду `/mvpstats` (только для админа)
5. Проверьте команду `/inbox` (только для тренера)
