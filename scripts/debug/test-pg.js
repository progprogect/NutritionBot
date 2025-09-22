const { Client } = require("pg");

async function testConnection() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL
  });
  
  try {
    console.log("Testing direct PostgreSQL connection...");
    await client.connect();
    console.log("✅ Connected to PostgreSQL");
    
    const result = await client.query('SELECT 1 as test');
    console.log("✅ Query successful:", result.rows[0]);
    
    // Test user table
    const users = await client.query('SELECT COUNT(*) FROM "User"');
    console.log("✅ User table accessible, count:", users.rows[0].count);
    
  } catch (error) {
    console.error("❌ Database connection failed:", error.message);
  } finally {
    await client.end();
  }
}

testConnection();
