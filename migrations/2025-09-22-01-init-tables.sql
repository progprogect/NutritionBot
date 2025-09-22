-- Создание основных таблиц
-- Миграция 1: Основные таблицы

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
