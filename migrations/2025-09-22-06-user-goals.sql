-- Миграция для системы целей пользователей (только питание)
-- Дата: 2025-09-22
-- Описание: Создание таблицы для хранения целей по питанию

CREATE TABLE IF NOT EXISTS user_goals (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  
  -- Цели по питанию (NULL означает, что цель не установлена)
  calories_goal INTEGER,           -- ккал/день
  protein_goal REAL,              -- г/день
  fat_goal REAL,                  -- г/день
  carbs_goal REAL,               -- г/день
  fiber_goal REAL,               -- г/день
  
  -- Метаданные
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  
  -- Ограничения (только если значения не NULL)
  CONSTRAINT valid_calories CHECK (calories_goal IS NULL OR (calories_goal > 0 AND calories_goal < 10000)),
  CONSTRAINT valid_protein CHECK (protein_goal IS NULL OR (protein_goal > 0 AND protein_goal < 500)),
  CONSTRAINT valid_fat CHECK (fat_goal IS NULL OR (fat_goal > 0 AND fat_goal < 300)),
  CONSTRAINT valid_carbs CHECK (carbs_goal IS NULL OR (carbs_goal > 0 AND carbs_goal < 1000)),
  CONSTRAINT valid_fiber CHECK (fiber_goal IS NULL OR (fiber_goal > 0 AND fiber_goal < 100))
);

-- Индекс для быстрого поиска
CREATE INDEX IF NOT EXISTS idx_user_goals_user_id ON user_goals(user_id);

-- Уникальный индекс (один набор целей на пользователя)
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_goals_unique_user ON user_goals(user_id);
