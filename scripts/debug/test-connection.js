const { PrismaClient } = require("@prisma/client");

async function testConnection() {
  const prisma = new PrismaClient({
    log: ['query', 'info', 'warn', 'error'],
  });
  
  try {
    console.log("Testing database connection...");
    const result = await prisma.$queryRaw`SELECT 1 as test`;
    console.log("✅ Database connection successful:", result);
    
    // Test user table
    const users = await prisma.user.findMany();
    console.log("✅ User table accessible, count:", users.length);
    
  } catch (error) {
    console.error("❌ Database connection failed:", error.message);
    console.error("Full error:", error);
  } finally {
    await prisma.$disconnect();
  }
}

testConnection();
