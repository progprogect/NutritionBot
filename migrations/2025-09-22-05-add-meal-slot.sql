-- Добавляем поле meal_slot для группировки по приёмам пищи
ALTER TABLE "FoodEntry" 
  ADD COLUMN IF NOT EXISTS meal_slot TEXT;  -- 'breakfast'|'lunch'|'dinner'|'snack'

-- Создаём индекс для быстрого поиска по приёмам пищи
CREATE INDEX IF NOT EXISTS idx_food_entries_meal_slot ON "FoodEntry"(meal_slot);



