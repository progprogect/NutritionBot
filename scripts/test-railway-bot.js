// Тест для проверки работы бота на Railway
const { Client } = require("pg");

async function testRailwayBot() {
  console.log("🧪 Тестирование бота на Railway...");
  
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  try {
    await client.connect();
    console.log("✅ Подключение к базе данных успешно");

    // Тест 1: Проверяем таблицы
    console.log("\n📊 Проверяем таблицы...");
    const tablesResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    
    const expectedTables = ['User', 'FoodEntry', 'food_items', 'llm_cache', 'metrics_events', 'coach_requests'];
    const actualTables = tablesResult.rows.map(row => row.table_name);
    
    console.log("Найденные таблицы:", actualTables);
    
    const missingTables = expectedTables.filter(table => !actualTables.includes(table));
    if (missingTables.length > 0) {
      console.error("❌ Отсутствуют таблицы:", missingTables);
      return false;
    }
    console.log("✅ Все таблицы присутствуют");

    // Тест 2: Проверяем индексы
    console.log("\n🔍 Проверяем индексы...");
    const indexesResult = await client.query(`
      SELECT indexname, tablename 
      FROM pg_indexes 
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname
    `);
    
    console.log("Найденные индексы:", indexesResult.rows.length);
    indexesResult.rows.forEach(row => {
      console.log(`  - ${row.indexname} (${row.tablename})`);
    });

    // Тест 3: Проверяем enum типы
    console.log("\n🏷️ Проверяем enum типы...");
    const enumResult = await client.query(`
      SELECT typname, enumlabel 
      FROM pg_type t 
      JOIN pg_enum e ON t.oid = e.enumtypid 
      WHERE typname = 'request_status'
      ORDER BY enumlabel
    `);
    
    if (enumResult.rows.length > 0) {
      console.log("✅ Enum request_status найден:", enumResult.rows.map(r => r.enumlabel));
    } else {
      console.log("⚠️ Enum request_status не найден");
    }

    // Тест 4: Проверяем переменные окружения
    console.log("\n🔧 Проверяем переменные окружения...");
    const requiredEnvVars = ['BOT_TOKEN', 'OPENAI_API_KEY', 'ADMIN_TG_ID', 'TRAINER_TG_ID'];
    const missingEnvVars = requiredEnvVars.filter(envVar => !process.env[envVar]);
    
    if (missingEnvVars.length > 0) {
      console.error("❌ Отсутствуют переменные окружения:", missingEnvVars);
      return false;
    }
    console.log("✅ Все переменные окружения присутствуют");

    // Тест 5: Проверяем подключение к OpenAI (базовая проверка)
    console.log("\n🤖 Проверяем OpenAI API...");
    if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.startsWith('sk-')) {
      console.log("✅ OpenAI API ключ присутствует");
    } else {
      console.error("❌ OpenAI API ключ отсутствует или неверный");
      return false;
    }

    // Тест 6: Проверяем Telegram Bot Token
    console.log("\n📱 Проверяем Telegram Bot Token...");
    if (process.env.BOT_TOKEN && process.env.BOT_TOKEN.includes(':')) {
      console.log("✅ Telegram Bot Token присутствует");
    } else {
      console.error("❌ Telegram Bot Token отсутствует или неверный");
      return false;
    }

    console.log("\n🎉 Все тесты пройдены успешно!");
    console.log("✅ Бот готов к работе на Railway");
    
    return true;

  } catch (error) {
    console.error("❌ Ошибка при тестировании:", error);
    return false;
  } finally {
    await client.end();
  }
}

// Запускаем тест
if (require.main === module) {
  testRailwayBot().then(success => {
    process.exit(success ? 0 : 1);
  });
}

module.exports = { testRailwayBot };
