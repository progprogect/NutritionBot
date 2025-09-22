require("dotenv").config();
const { Bot, InlineKeyboard } = require("grammy");

const bot = new Bot(process.env.BOT_TOKEN);

// Простое хранилище в памяти
const userEntries = new Map();

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
    const userTgId = String(ctx.from.id);
    const today = new Date().toISOString().split('T')[0];
    
    if (!userEntries.has(userTgId)) {
      await ctx.answerCallbackQuery({ text: "Сегодня ещё ничего не записано." });
      return;
    }
    
    const userData = userEntries.get(userTgId);
    const todayEntries = userData.filter(entry => entry.date.startsWith(today));
    
    if (todayEntries.length === 0) {
      await ctx.answerCallbackQuery({ text: "Сегодня ещё ничего не записано." });
      return;
    }
    
    const list = todayEntries.map(e => `• ${e.text}`).join('\n');
    await ctx.answerCallbackQuery({ text: `Итог за сегодня:\n${list}` });
  }
});

// сохраняем записи в памяти
bot.on("message:text", async (ctx) => {
  const userTgId = String(ctx.from.id);
  
  if (!userEntries.has(userTgId)) {
    userEntries.set(userTgId, []);
  }
  
  const userData = userEntries.get(userTgId);
  userData.push({
    text: ctx.message.text,
    date: new Date().toISOString()
  });
  
  await ctx.reply("Запомнил! Посмотреть можно командой /day");
});

// команда /day
bot.command("day", async (ctx) => {
  const userTgId = String(ctx.from.id);
  const today = new Date().toISOString().split('T')[0];
  
  if (!userEntries.has(userTgId)) {
    return ctx.reply("Записей не найдено за сегодня.");
  }
  
  const userData = userEntries.get(userTgId);
  const todayEntries = userData.filter(entry => entry.date.startsWith(today));
  
  if (todayEntries.length === 0) {
    return ctx.reply("Сегодня ещё ничего не записано.");
  }
  
  const list = todayEntries.map(e => `• ${e.text}`).join('\n');
  return ctx.reply(`Итог за сегодня:\n${list}`);
});

// Обработка ошибок
bot.catch((err) => {
  console.error("Ошибка в боте:", err);
});

bot.start();
console.log("✅ Бот запущен, жду сообщения в Telegram...");
