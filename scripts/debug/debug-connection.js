require("dotenv").config();
const { Client } = require("pg");

console.log("=== DEBUG CONNECTION ===");
console.log("DATABASE_URL from env:", process.env.DATABASE_URL);

// Попробуем с явными параметрами
const client = new Client({
  host: 'localhost',
  port: 5433,
  database: 'foodbot',
  user: 'postgres',
  password: 'postgres',
  ssl: false
});

async function testConnection() {
  try {
    console.log("Attempting to connect...");
    await client.connect();
    console.log("✅ Connected successfully!");
    
    const result = await client.query('SELECT current_user, current_database()');
    console.log("✅ Query result:", result.rows[0]);
    
  } catch (error) {
    console.error("❌ Connection failed:", error.message);
    console.error("Full error:", error);
  } finally {
    try {
      await client.end();
    } catch (e) {
      // ignore
    }
  }
}

testConnection();
