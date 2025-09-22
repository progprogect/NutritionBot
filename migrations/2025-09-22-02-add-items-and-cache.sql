-- Миграция 2: Детализированные позиции и кэш
-- Зависит от: 2025-09-22-01-init-tables.sql

-- Таблица нормализованных позиций внутри записи
CREATE TABLE IF NOT EXISTS food_items (
    id SERIAL PRIMARY KEY,
    entry_id INT NOT NULL REFERENCES "FoodEntry"(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    qty NUMERIC NOT NULL,
    unit TEXT NOT NULL, -- g|ml|piece|tsp|tbsp|cup|slice|glass|...
    resolved_grams NUMERIC NOT NULL, -- всегда приводим к граммам
    kcal NUMERIC NOT NULL,
    p NUMERIC NOT NULL, -- protein
    f NUMERIC NOT NULL, -- fat
    c NUMERIC NOT NULL, -- carbs
    fiber NUMERIC NOT NULL,
    edited_by_user BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_food_items_entry_id ON food_items(entry_id);

-- Кэш для LLM-ответов (пер100г, плотности, типовой вес порции и пр.)
CREATE TABLE IF NOT EXISTS llm_cache (
    id SERIAL PRIMARY KEY,
    key_hash TEXT UNIQUE NOT NULL, -- хэш ключа (например, lower(name)+'|'+unit)
    payload_json JSONB NOT NULL, -- то, что вернёт LLM (пер100г, density, piece_grams и т.п.)
    created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_llm_cache_key_hash ON llm_cache(key_hash);
