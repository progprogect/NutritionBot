require("dotenv").config();
const { Bot, InlineKeyboard } = require("grammy");
const { Client } = require("pg");

const client = new Client({
  connectionString: process.env.DATABASE_URL
});

// Подключаемся к БД
client.connect().then(() => {
  console.log("✅ Подключение к PostgreSQL успешно");
}).catch(err => {
  console.error("❌ Ошибка подключения к PostgreSQL:", err);
  process.exit(1);
});

const bot = new Bot(process.env.BOT_TOKEN);

// команда /start
bot.command("start", (ctx) => {
  const kb = new InlineKeyboard()
    .text("Помощь", "help")
    .row()
    .text("Итог дня", "day");
  return ctx.reply(
    "Привет! Я бот для учёта питания. Напиши: «овсянка 60 г + молоко 200 мл» или используй кнопки.",
    { reply_markup: kb }
  );
});

// обработка нажатий
bot.on("callback_query:data", async (ctx) => {
  if (ctx.callbackQuery.data === "help") {
    await ctx.answerCallbackQuery({ text: "Команды: /start, напиши еду, /day." });
  }
  if (ctx.callbackQuery.data === "day") {
    try {
      const userTgId = String(ctx.from.id);
      
      // Ищем пользователя
      const userResult = await client.query('SELECT id FROM "User" WHERE "tgId" = $1', [userTgId]);
      
      if (userResult.rows.length === 0) {
        await ctx.answerCallbackQuery({ text: "Записей не найдено за сегодня." });
        return;
      }
      
      const userId = userResult.rows[0].id;
      
      // Получаем записи за сегодня
      const today = new Date();
      const todayStr = today.toISOString().split('T')[0];
      
      const entriesResult = await client.query(
        'SELECT "textRaw" FROM "FoodEntry" WHERE "userId" = $1 AND date::date = $2 ORDER BY "createdAt"',
        [userId, todayStr]
      );
      
      if (entriesResult.rows.length === 0) {
        await ctx.answerCallbackQuery({ text: "Сегодня ещё ничего не записано." });
        return;
      }
      
      const list = entriesResult.rows.map(e => `• ${e.textRaw}`).join('\n');
      await ctx.answerCallbackQuery({ text: `Итог за сегодня:\n${list}` });
      
    } catch (error) {
      console.error("Ошибка в callback_query:", error);
      await ctx.answerCallbackQuery({ text: "Произошла ошибка. Попробуйте позже." });
    }
  }
});

// сохраняем записи в БД
bot.on("message:text", async (ctx) => {
  try {
    const userTgId = String(ctx.from.id);
    
    // Ищем или создаём пользователя
    let userResult = await client.query('SELECT id FROM "User" WHERE "tgId" = $1', [userTgId]);
    
    if (userResult.rows.length === 0) {
      // Создаём пользователя
      userResult = await client.query('INSERT INTO "User" ("tgId") VALUES ($1) RETURNING id', [userTgId]);
    }
    
    const userId = userResult.rows[0].id;
    
    // Создаём запись
    await client.query(
      'INSERT INTO "FoodEntry" ("userId", date, "textRaw") VALUES ($1, $2, $3)',
      [userId, new Date(), ctx.message.text]
    );
    
    await ctx.reply("Запомнил! Посмотреть можно командой /day");
    
  } catch (error) {
    console.error("Ошибка при сохранении:", error);
    await ctx.reply("Произошла ошибка при сохранении. Попробуйте позже.");
  }
});

// команда /day
bot.command("day", async (ctx) => {
  try {
    const userTgId = String(ctx.from.id);
    
    // Ищем пользователя
    const userResult = await client.query('SELECT id FROM "User" WHERE "tgId" = $1', [userTgId]);
    
    if (userResult.rows.length === 0) {
      return ctx.reply("Записей не найдено за сегодня.");
    }
    
    const userId = userResult.rows[0].id;
    
    // Получаем записи за сегодня
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    
    const entriesResult = await client.query(
      'SELECT "textRaw" FROM "FoodEntry" WHERE "userId" = $1 AND date::date = $2 ORDER BY "createdAt"',
      [userId, todayStr]
    );
    
    if (entriesResult.rows.length === 0) {
      return ctx.reply("Сегодня ещё ничего не записано.");
    }
    
    const list = entriesResult.rows.map(e => `• ${e.textRaw}`).join('\n');
    return ctx.reply(`Итог за сегодня:\n${list}`);
    
  } catch (error) {
    console.error("Ошибка в команде /day:", error);
    return ctx.reply("Произошла ошибка. Попробуйте позже.");
  }
});

// Обработка ошибок
bot.catch((err) => {
  console.error("Ошибка в боте:", err);
});

bot.start();
console.log("✅ Бот запущен, жду сообщения в Telegram...");
