// Скрипт для настройки базы данных Railway
const { Client } = require("pg");

// Используем переменные окружения Railway
const DATABASE_URL = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL не найден в переменных окружения");
  console.log("Убедитесь, что вы установили переменные окружения Railway:");
  console.log("- DATABASE_URL");
  console.log("- DATABASE_PUBLIC_URL");
  process.exit(1);
}

async function setupRailwayDatabase() {
  console.log("🚀 Настройка базы данных Railway...");
  console.log(`🔗 Подключение к: ${DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);

  const client = new Client({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log("✅ Подключение к базе данных успешно");

    // Миграция 1: Основные таблицы
    console.log("\n🔄 Применяем миграцию 1: Основные таблицы...");
    await client.query(`
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
    `);
    console.log("✅ Миграция 1 применена успешно");

    // Миграция 2: Детализированные позиции и кэш
    console.log("\n🔄 Применяем миграцию 2: Детализированные позиции...");
    await client.query(`
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
    `);
    console.log("✅ Миграция 2 применена успешно");

    // Миграция 3: Метрики
    console.log("\n🔄 Применяем миграцию 3: Метрики...");
    await client.query(`
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
    `);
    console.log("✅ Миграция 3 применена успешно");

    // Миграция 4: Заявки на персональные планы
    console.log("\n🔄 Применяем миграцию 4: Заявки на персональные планы...");
    await client.query(`
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
    `);
    console.log("✅ Миграция 4 применена успешно");

    // Проверяем созданные таблицы
    console.log("\n📊 Проверяем созданные таблицы...");
    const tablesResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    console.log("✅ Созданные таблицы:");
    tablesResult.rows.forEach(row => {
      console.log(`  - ${row.table_name}`);
    });

    // Проверяем индексы
    console.log("\n🔍 Проверяем индексы...");
    const indexesResult = await client.query(`
      SELECT indexname, tablename 
      FROM pg_indexes 
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname
    `);

    console.log("✅ Созданные индексы:");
    indexesResult.rows.forEach(row => {
      console.log(`  - ${row.indexname} (${row.tablename})`);
    });

    console.log("\n🎉 Настройка базы данных Railway завершена успешно!");
    console.log("\nТеперь можно запустить бота на Railway");

  } catch (error) {
    console.error("❌ Ошибка при настройке базы данных:", error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

// Запускаем настройку
setupRailwayDatabase().catch(console.error);
