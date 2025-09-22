// Скрипт для настройки базы данных на Railway
const { Client } = require("pg");
const fs = require("fs");
const path = require("path");

async function setupDatabase() {
  console.log("🔧 Настройка базы данных...");
  
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  try {
    await client.connect();
    console.log("✅ Подключение к базе данных успешно");

    // Применяем миграции
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    const migrationFiles = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort();

    console.log(`📁 Найдено миграций: ${migrationFiles.length}`);

    for (const file of migrationFiles) {
      console.log(`🔄 Применяем миграцию: ${file}`);
      const migrationSQL = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      
      try {
        await client.query(migrationSQL);
        console.log(`✅ Миграция ${file} применена успешно`);
      } catch (error) {
        if (error.message.includes('already exists') || 
            error.message.includes('duplicate key') ||
            error.message.includes('already exists') ||
            error.message.includes('relation') && error.message.includes('already exists')) {
          console.log(`⚠️  Миграция ${file} уже применена (пропускаем)`);
        } else {
          console.error(`❌ Ошибка в миграции ${file}:`, error.message);
          // Не останавливаем выполнение, продолжаем с другими миграциями
          console.log(`⚠️  Пропускаем миграцию ${file} и продолжаем...`);
        }
      }
    }

    // Проверяем, что таблицы созданы
    const tablesResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);

    console.log("📊 Созданные таблицы:");
    tablesResult.rows.forEach(row => {
      console.log(`  - ${row.table_name}`);
    });

    console.log("🎉 Настройка базы данных завершена успешно!");

  } catch (error) {
    console.error("❌ Ошибка при настройке базы данных:", error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

// Запускаем только если это основной процесс
if (require.main === module) {
  setupDatabase().catch(console.error);
}

module.exports = { setupDatabase };
