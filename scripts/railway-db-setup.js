// Скрипт для ручной настройки базы данных Railway
require("dotenv").config();
const { Client } = require("pg");

async function setupRailwayDatabase() {
  console.log("🚀 Настройка базы данных Railway...");
  
  // Используем DATABASE_PUBLIC_URL для подключения
  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  
  if (!connectionString) {
    console.error("❌ DATABASE_URL не найден в переменных окружения");
    process.exit(1);
  }

  console.log("🔗 Подключение к базе данных...");
  console.log(`URL: ${connectionString.replace(/:[^:@]+@/, ':***@')}`); // Скрываем пароль в логах

  const client = new Client({
    connectionString: connectionString,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log("✅ Подключение к базе данных успешно");

    // Применяем миграции по порядку
    const migrations = [
      '2025-09-22-01-init-tables.sql',
      '2025-09-22-02-add-items-and-cache.sql', 
      '2025-09-22-03-metrics.sql',
      '2025-09-22-04-coach-requests.sql'
    ];

    for (const migration of migrations) {
      console.log(`\n🔄 Применяем миграцию: ${migration}`);
      
      try {
        const migrationSQL = require('fs').readFileSync(
          require('path').join(__dirname, '..', 'migrations', migration), 
          'utf8'
        );
        
        await client.query(migrationSQL);
        console.log(`✅ Миграция ${migration} применена успешно`);
      } catch (error) {
        if (error.message.includes('already exists') || 
            error.message.includes('duplicate key') ||
            error.message.includes('relation') && error.message.includes('already exists')) {
          console.log(`⚠️  Миграция ${migration} уже применена (пропускаем)`);
        } else {
          console.error(`❌ Ошибка в миграции ${migration}:`, error.message);
          throw error;
        }
      }
    }

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

// Запускаем только если это основной процесс
if (require.main === module) {
  setupRailwayDatabase().catch(console.error);
}

module.exports = { setupRailwayDatabase };





