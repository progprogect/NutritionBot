require("dotenv").config();
const { Bot, InlineKeyboard } = require("grammy");
const { Client } = require("pg");
const { parseFoodTextStructured, resolveGrams, macrosFromPer100g } = require("./llm");
const { parseFoodImageStructured } = require("./vision");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const http = require("http");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

ffmpeg.setFfmpegPath(ffmpegPath);

// Настройка подключения к базе данных (поддержка Railway)
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Инициализация базы данных
async function initializeDatabase() {
  try {
    await client.connect();
    console.log("✅ Подключение к PostgreSQL успешно");
    
    // Применяем миграции при запуске (только на Railway)
    if (process.env.RAILWAY_ENVIRONMENT) {
      console.log("🔧 Применяем миграции базы данных...");
      const { setupDatabase } = require("./scripts/setup-db");
      await setupDatabase();
    }
  } catch (err) {
    console.error("❌ Ошибка подключения к PostgreSQL:", err);
    process.exit(1);
  }
}

// Инициализируем базу данных
initializeDatabase();

const bot = new Bot(process.env.BOT_TOKEN);

// State для ожидания ввода граммов
const pendingGramEdit = new Map(); // userId -> itemId

// State для сбора анкеты персонального плана
const pendingCoach = new Map(); // userId -> { step: 1..4, draft: {...} }

// Функции для работы с приёмами пищи
function slotRu(slot) {
  return { breakfast:"завтрак", lunch:"обед", dinner:"ужин", snack:"перекусы" }[slot] || slot;
}

function mealKeyboard(entryId) {
  return new InlineKeyboard()
    .text("🌅 Завтрак",  `meal:set:breakfast:${entryId}`)
    .text("☀️ Обед",     `meal:set:lunch:${entryId}`)
    .text("🌙 Ужин",     `meal:set:dinner:${entryId}`)
    .text("🍎 Перекусы", `meal:set:snack:${entryId}`);
}

// Общая функция для создания сообщения и кнопок после добавления записи
function createFoodEntryResponse(entryId, lines, sum, inputType = "текста/голоса") {
  // Создаем финальную клавиатуру - сначала кнопки приёмов пищи
  const finalKb = new InlineKeyboard();
  
  // Добавляем кнопки выбора приёма пищи (самые важные - сверху)
  const mealKb = mealKeyboard(entryId);
  mealKb.inline_keyboard.forEach(row => {
    finalKb.inline_keyboard.push(row);
  });
  
  // Добавляем разделитель
  finalKb.row();
  
  // Затем кнопки действий с записью
  finalKb.text("Изменить граммы", `edit:${entryId}`)
         .row()
         .text("Перенести на вчера", `mv_y:${entryId}`)
         .text("Удалить запись", `del:${entryId}`)
         .row()
         .text("Итог за сегодня", "day")
         .text("Итог за вчера", "day_yesterday")
         .row()
         .text("Персональный план", "coach:new");

  const message = `Добавил (из ${inputType}):\n${lines}\n${sum}\n\nУкажи приём пищи:`;
  
  return { message, keyboard: finalKb };
}

// Rate-limit на пользователя (in-memory)
const userBucket = new Map(); // tgId -> { ts[], limit, windowMs }
const LIMIT = 8, WINDOW_MS = 60_000;

function allowEvent(tgId) {
  const now = Date.now();
  const rec = userBucket.get(tgId) || { ts: [] };
  // очистить старые
  rec.ts = rec.ts.filter(t => now - t < WINDOW_MS);
  if (rec.ts.length >= LIMIT) { 
    userBucket.set(tgId, rec); 
    return false; 
  }
  rec.ts.push(now); 
  userBucket.set(tgId, rec);
  return true;
}

async function guardRate(ctx) {
  const tgId = String(ctx.from.id);
  if (!allowEvent(tgId)) {
    await ctx.reply("Слишком часто. Подожди немного и попробуй снова 🙏");
    return false;
  }
  return true;
}

// Таймауты OpenAI
async function withTimeout(promise, ms, onTimeoutMsg = "Таймаут, попробуй ещё раз.") {
  let to;
  const timeout = new Promise((_, rej) => to = setTimeout(() => rej(new Error("TIMEOUT")), ms));
  try {
    const res = await Promise.race([promise, timeout]);
    clearTimeout(to); 
    return res;
  } catch (e) {
    clearTimeout(to); 
    throw new Error(onTimeoutMsg);
  }
}

// Хелпер для конвертации OGG в WAV
async function oggToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec("pcm_s16le")
      .format("wav")
      .on("end", () => resolve(outputPath))
      .on("error", reject)
      .save(outputPath);
  });
}

// Хелпер для транскрибации аудио
async function transcribeAudio(filePath) {
  const file = fs.createReadStream(filePath);
  const resp = await openai.audio.transcriptions.create({
    file,
    model: "whisper-1",
    language: "ru"
  });
  return resp.text?.trim() || "";
}

// Хелпер: скачать фото и превратить в data URL
async function downloadPhotoAsDataUrl(api, fileId) {
  const file = await api.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
  const res = await fetch(fileUrl);
  const buf = Buffer.from(await res.arrayBuffer());
  const base64 = buf.toString("base64");
  // большинство фото -> jpeg
  return `data:image/jpeg;base64,${base64}`;
}

// Проверка триггеров дня
async function checkDayTriggers(ctx, text) {
  const tgId = String(ctx.from.id);
  
  if (text === 'итог за вчера' || text === 'итог за сегодня') {
    try {
      const userResult = await client.query('SELECT id FROM "User" WHERE "tgId" = $1', [tgId]);
      if (userResult.rows.length === 0) {
        await ctx.reply("Ещё ничего не записано.");
        return true;
      }
      const userId = userResult.rows[0].id;
      
      const dateInfo = text === 'итог за вчера' ? resolveDayToken('вчера') : null;
      const result = await renderDayTotals(userId, dateInfo);
      await ctx.reply(result.message);
      return true;
    } catch (error) {
      console.error("Ошибка при обработке фразы-триггера:", error);
      await ctx.reply("Произошла ошибка. Попробуйте позже.");
      return true;
    }
  }
  
  // Проверяем фразу "итог за DD.MM.YYYY"
  const dateMatch = text.match(/^итог за (\d{2}\.\d{2}\.\d{4})$/);
  if (dateMatch) {
    try {
      const userResult = await client.query('SELECT id FROM "User" WHERE "tgId" = $1', [tgId]);
      if (userResult.rows.length === 0) {
        await ctx.reply("Ещё ничего не записано.");
        return true;
      }
      const userId = userResult.rows[0].id;
      
      const dateInfo = resolveDayToken(dateMatch[1]);
      if (!dateInfo) {
        await ctx.reply("Не понял дату. Примеры: итог за 21.09.2025");
        return true;
      }
      
      const result = await renderDayTotals(userId, dateInfo);
      await ctx.reply(result.message);
      return true;
    } catch (error) {
      console.error("Ошибка при обработке фразы-триггера:", error);
      await ctx.reply("Произошла ошибка. Попробуйте позже.");
      return true;
    }
  }
  
  return false;
}

// Основная функция обработки текста еды
async function handleFoodText(ctx, text) {
  const tz = "Europe/Warsaw";
  const tgId = String(ctx.from.id);

  try {
    // 1) найти/создать пользователя
    let userResult = await client.query('SELECT id FROM "User" WHERE "tgId" = $1', [tgId]);
    if (userResult.rows.length === 0) {
      userResult = await client.query('INSERT INTO "User" ("tgId") VALUES ($1) RETURNING id', [tgId]);
    }
    const userId = userResult.rows[0].id;

    // 2) новая запись
    const entryResult = await client.query(
      'INSERT INTO "FoodEntry" ("userId", date, "textRaw", "createdAt") VALUES ($1, $2, $3, $4) RETURNING id',
      [userId, new Date(), text, new Date()]
    );
    const entryId = entryResult.rows[0].id;

    // 3) парсинг LLM с таймаутом
    const items = await withTimeout(parseFoodTextStructured(text, tz), 20000, "Сервисы думают дольше обычного. Попробуй ещё раз или напиши короче.");

    // 4) расчёт и сохранение позиций
    let total = { kcal: 0, p: 0, f: 0, c: 0, fiber: 0 };
    for (const it of items) {
      const grams = resolveGrams({
        qty: it.qty,
        unit: it.unit,
        density: it.density_g_per_ml ?? null,
        pieceGrams: it.default_piece_grams ?? null,
        resolved_grams: it.resolved_grams ?? null,
      });
      const m = macrosFromPer100g(grams, it.per100g);
      total.kcal += m.kcal; 
      total.p += m.p; 
      total.f += m.f;
      total.c += m.c; 
      total.fiber += m.fiber;

      await client.query(
        `INSERT INTO food_items(entry_id, name, qty, unit, resolved_grams, kcal, p, f, c, fiber, edited_by_user, created_at)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, now())`,
        [entryId, it.name, it.qty, it.unit, grams, m.kcal, m.p, m.f, m.c, m.fiber]
      );
    }

    const lines = items.map(i => `• ${i.name}: ${i.qty} ${i.unit}`).join("\n");
    const sum = `Итого: ${Math.round(total.kcal)} ккал | Б ${total.p.toFixed(1)} | Ж ${total.f.toFixed(1)} | У ${total.c.toFixed(1)} | Кл ${total.fiber.toFixed(1)}`;

    // 5) Используем общую функцию для создания сообщения и кнопок
    const { message, keyboard } = createFoodEntryResponse(entryId, lines, sum, "текста/голоса");
    
    await ctx.reply(message, { reply_markup: keyboard });
  } catch (e) {
    console.error("Ошибка в handleFoodText:", e);
    
    let errorMessage = "Запомнил, но без расчётов (тех. пауза). /day — список за день.";
    
    if (e.message.includes("Сервисы думают дольше обычного")) {
      errorMessage = "Сервис анализа текста временно недоступен. Попробуй ещё раз или напиши короче 📝";
    } else if (e.message.includes("OpenAI не вернул валидный JSON")) {
      errorMessage = "Не удалось разобрать текст. Попробуй написать проще, например: «овсянка 60 г, молоко 200 мл» 📝";
    } else if (e.message.includes("TIMEOUT")) {
      errorMessage = "Превышено время ожидания. Попробуй ещё раз или напиши короче 📝";
    } else if (e.message.includes("InlineKeyboard.combine is not a function")) {
      errorMessage = "Ошибка интерфейса. Попробуй ещё раз или обратись к администратору 🔧";
    } else if (e.message.includes("relation") && e.message.includes("does not exist")) {
      errorMessage = "Ошибка базы данных. Попробуй ещё раз через минуту 🗄️";
    } else if (e.message.includes("syntax error")) {
      errorMessage = "Ошибка в запросе к базе данных. Попробуй ещё раз 🗄️";
    } else if (e.message.includes("connection")) {
      errorMessage = "Проблема с подключением к базе данных. Попробуй ещё раз через минуту 🔌";
    } else if (e.message.includes("rate limit") || e.message.includes("429")) {
      errorMessage = "Слишком много запросов. Подожди немного и попробуй снова ⏰";
    } else if (e.message.includes("401") || e.message.includes("unauthorized")) {
      errorMessage = "Проблема с авторизацией. Обратись к администратору 🔐";
    } else if (e.message.includes("500") || e.message.includes("internal server error")) {
      errorMessage = "Временная проблема на сервере. Попробуй ещё раз через минуту 🛠️";
    } else {
      // Для неизвестных ошибок показываем более детальную информацию
      errorMessage = `Произошла ошибка: ${e.message}. Попробуй ещё раз или обратись к администратору 🚨`;
    }
    
    await ctx.reply(errorMessage);
  }
}

// Хелпер для парсинга дат
function resolveDayToken(token, tz = "Europe/Warsaw") {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  // Нормализуем токен
  const normalized = token.toLowerCase().trim();
  
  if (normalized === 'today' || normalized === 'сегодня') {
    const start = new Date(today);
    const end = new Date(today);
    end.setDate(end.getDate() + 1);
    return {
      start: start.toISOString().split('T')[0],
      end: end.toISOString().split('T')[0],
      title: 'сегодня'
    };
  }
  
  if (normalized === 'yesterday' || normalized === 'вчера') {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const start = new Date(yesterday);
    const end = new Date(yesterday);
    end.setDate(end.getDate() + 1);
    return {
      start: start.toISOString().split('T')[0],
      end: end.toISOString().split('T')[0],
      title: 'вчера'
    };
  }
  
  // DD.MM.YYYY формат
  const ddmmyyyy = normalized.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (ddmmyyyy) {
    const [, day, month, year] = ddmmyyyy;
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() == year && date.getMonth() == month - 1 && date.getDate() == day) {
      const start = new Date(date);
      const end = new Date(date);
      end.setDate(end.getDate() + 1);
      return {
        start: start.toISOString().split('T')[0],
        end: end.toISOString().split('T')[0],
        title: `${day.padStart(2, '0')}.${month.padStart(2, '0')}.${year}`
      };
    }
  }
  
  // YYYY-MM-DD формат
  const yyyymmdd = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (yyyymmdd) {
    const [, year, month, day] = yyyymmdd;
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() == year && date.getMonth() == month - 1 && date.getDate() == day) {
      const start = new Date(date);
      const end = new Date(date);
      end.setDate(end.getDate() + 1);
      return {
        start: start.toISOString().split('T')[0],
        end: end.toISOString().split('T')[0],
        title: `${day.padStart(2, '0')}.${month.padStart(2, '0')}.${year}`
      };
    }
  }
  
  return null;
}

// Вспомогательная функция для рендера итогов дня
// Клавиатура для смены статуса заявки тренера
function coachStatusKeyboard(id) {
  return new InlineKeyboard()
    .text("В работу", `cr:set:in_progress:${id}`)
    .text("Готово",   `cr:set:done:${id}`)
    .text("Отклонить",`cr:set:rejected:${id}`);
}

async function renderDayTotals(userId, dateInfo = null) {
  try {
    let dateCondition, params, title;
    
    if (dateInfo) {
      dateCondition = `AND fe.date::date >= $2 AND fe.date::date < $3`;
      params = [userId, dateInfo.start, dateInfo.end];
      title = dateInfo.title;
    } else {
      dateCondition = `AND fe.date::date = CURRENT_DATE`;
      params = [userId];
      title = 'сегодня';
    }
    
    const entriesResult = await client.query(
      `SELECT fe.id as entry_id, fi.name, fi.qty, fi.unit, fi.resolved_grams, fi.kcal, fi.p, fi.f, fi.c, fi.fiber
       FROM "FoodEntry" fe
       JOIN food_items fi ON fi.entry_id = fe.id
       WHERE fe."userId" = $1 ${dateCondition}
       ORDER BY fe.id ASC, fi.id ASC`,
      params
    );
    
    if (entriesResult.rows.length === 0) {
      return { success: false, message: `Записей не найдено за ${title}.` };
    }
    
    let total = { kcal: 0, p: 0, f: 0, c: 0, fiber: 0 };
    const lines = entriesResult.rows.map(r => {
      total.kcal += Number(r.kcal); 
      total.p += Number(r.p);
      total.f += Number(r.f); 
      total.c += Number(r.c); 
      total.fiber += Number(r.fiber);
      return `• ${r.name} (${Math.round(r.resolved_grams)}г) — ${Math.round(r.kcal)} ккал | Б ${r.p} | Ж ${r.f} | У ${r.c} | Кл ${r.fiber}`;
    }).join('\n');
    
    const totalLine = `\n\nИТОГО: ${Math.round(total.kcal)} ккал | Б ${total.p.toFixed(1)} | Ж ${total.f.toFixed(1)} | У ${total.c.toFixed(1)} | Кл ${total.fiber.toFixed(1)}`;
    
    return { success: true, message: `Итоги дня:\n\n${lines}${totalLine}` };
    
  } catch (error) {
    console.error("Ошибка при рендере итогов:", error);
    return { success: false, message: "Произошла ошибка. Попробуйте позже." };
  }
}

// Функция для отображения записей с кнопками редактирования
async function renderDayTotalsWithButtons(userId, dateInfo = null) {
  try {
    let dateCondition, params, title;
    
    if (dateInfo) {
      dateCondition = `AND fe.date::date >= $2 AND fe.date::date < $3`;
      params = [userId, dateInfo.start, dateInfo.end];
      title = dateInfo.title;
    } else {
      dateCondition = `AND fe.date::date = CURRENT_DATE`;
      params = [userId];
      title = 'сегодня';
    }
    
    // Получаем позиции за день с привязкой к entry_id и meal_slot
    const { rows } = await client.query(`
      SELECT fe.id AS entry_id, fe.meal_slot,
             fi.name, fi.kcal, fi.p, fi.f, fi.c, fi.fiber, fi.resolved_grams
      FROM "FoodEntry" fe
      JOIN food_items fi ON fi.entry_id = fe.id
      WHERE fe."userId" = $1 ${dateCondition}
      ORDER BY fe.id ASC, fi.id ASC
    `, params);

    if (!rows.length) {
      return { success: false, message: `Записей не найдено за ${title}.` };
    }

    // Группируем по приёмам пищи
    const buckets = {
      breakfast: [], lunch: [], dinner: [], snack: [], unslotted: []
    };
    
    rows.forEach(r => {
      const slot = r.meal_slot || "unslotted";
      (buckets[slot] || buckets.unslotted).push(r);
    });

    function renderBucket(label, arr) {
      if (!arr.length) return "";
      
      let t = { kcal: 0, p: 0, f: 0, c: 0, fiber: 0 };
      const lines = arr.map(x => {
        t.kcal += +x.kcal; 
        t.p += +x.p; 
        t.f += +x.f; 
        t.c += +x.c; 
        t.fiber += +x.fiber;
        return `• ${x.name} (${Math.round(x.resolved_grams)}г) — ${Math.round(x.kcal)} ккал | Б ${(+x.p).toFixed(1)} | Ж ${(+x.f).toFixed(1)} | У ${(+x.c).toFixed(1)} | Кл ${(+x.fiber).toFixed(1)}`;
      }).join("\n");
      
      const sum = `Итог ${label.toLowerCase()}: ${Math.round(t.kcal)} ккал | Б ${t.p.toFixed(1)} | Ж ${t.f.toFixed(1)} | У ${t.c.toFixed(1)} | Кл ${t.fiber.toFixed(1)}`;
      return `\n${label}\n${lines}\n${sum}\n`;
    }

    const parts = [];
    parts.push(renderBucket("Завтрак", buckets.breakfast));
    parts.push(renderBucket("Обед", buckets.lunch));
    parts.push(renderBucket("Ужин", buckets.dinner));
    parts.push(renderBucket("Перекусы", buckets.snack));
    if (buckets.unslotted.length) parts.push(renderBucket("Без пометки", buckets.unslotted));

    // Общий итог
    const all = rows.reduce((t, r) => ({
      kcal: t.kcal + +r.kcal, 
      p: t.p + +r.p, 
      f: t.f + +r.f, 
      c: t.c + +r.c, 
      fiber: t.fiber + +r.fiber
    }), { kcal: 0, p: 0, f: 0, c: 0, fiber: 0 });

    const text = `Итоги дня:\n${parts.filter(Boolean).join("")}\nИТОГО за день: ${Math.round(all.kcal)} ккал | Б ${all.p.toFixed(1)} | Ж ${all.f.toFixed(1)} | У ${all.c.toFixed(1)} | Кл ${all.fiber.toFixed(1)}`;

    // Создаем кнопки для каждого приёма пищи
    const kb = new InlineKeyboard();
    let isFirst = true;
    
    // Добавляем кнопки только для приёмов пищи, где есть записи
    const mealSlots = ['breakfast', 'lunch', 'dinner', 'snack', 'unslotted'];
    mealSlots.forEach(slot => {
      if (buckets[slot] && buckets[slot].length > 0) {
        if (!isFirst) kb.row();
        isFirst = false;
        const mealLabel = slot === 'unslotted' ? 'Без пометки' : slotRu(slot);
        const emoji = slot === 'breakfast' ? '🌅' : 
                     slot === 'lunch' ? '☀️' : 
                     slot === 'dinner' ? '🌙' : 
                     slot === 'snack' ? '🍎' : '❓';
        kb.text(`${emoji} ${mealLabel}`, `meal:edit:${slot}`);
      }
    });

    return { success: true, message: text, buttons: kb };
  } catch (error) {
    console.error("Ошибка при рендере итогов с кнопками:", error);
    return { success: false, message: "Произошла ошибка. Попробуйте позже." };
  }
}

// команда /start
bot.command("start", (ctx) => {
  const kb = new InlineKeyboard()
    .text("Персональный план", "coach:new")
    .text("Помощь", "help");
  
  const startText = `👋 Привет! Я помогу вести твой дневник питания.

Что можно делать:
• Написать текстом, что ел  
• Отправить голосовое сообщение  
• Прислать фото еды  

Я посчитаю калории, белки, жиры, углеводы и клетчатку.  

📊 Итоги и аналитика:
• /day — за сегодня  
• /day вчера — за вчера  
• /day 21.09.2025 — за конкретную дату
• /week — недельная статистика
• /month — месячная статистика

А если нужна помощь специалиста — закажи персональный план у тренера.

👉 Попробуй прямо сейчас: напиши или скажи одно блюдо — например:  
«овсянка 60 г»  
Лучше добавлять еду по одному блюду, чем сразу много.`;

  return ctx.reply(startText, { reply_markup: kb });
});

// Функция для получения записей за день с КБЖУ
async function getDayEntries(userTgId) {
  try {
    // Ищем пользователя
    const userResult = await client.query('SELECT id FROM "User" WHERE "tgId" = $1', [userTgId]);
    
    if (userResult.rows.length === 0) {
      return { success: false, message: "Ещё ничего не записано." };
    }
    
    const userId = userResult.rows[0].id;
    return await renderDayTotals(userId);
    
  } catch (error) {
    console.error("Ошибка при получении записей:", error);
    return { success: false, message: "Произошла ошибка. Попробуйте позже." };
  }
}

// обработка нажатий
bot.on("callback_query:data", async (ctx) => {
  try {
    const data = ctx.callbackQuery.data;
    const userId = String(ctx.from.id);
    
    console.log(`🔘 Callback received: ${data} from user ${userId}`);
    
    if (data === "help") {
      const helpText = `ℹ️ Вот как пользоваться ботом:

1️⃣ Записывай еду:
• Текстом: «овсянка 60 г и молоко 200 мл»
• Голосом: скажи то же самое
• Фото: пришли снимок тарелки (можно с подписью)

2️⃣ Смотри итоги:
• /day — за сегодня
• /day вчера — за вчера
• /day 21.09.2025 — за конкретную дату
Или напиши: «итог за вчера»

3️⃣ Анализируй прогресс:
• /week — недельная статистика и тренды
• /month — месячная статистика и достижения

4️⃣ Управляй записями:
После добавления появятся кнопки:
• Изменить граммы
• Перенести на вчера
• Удалить запись

5️⃣ Персональный план:
Нажми «Персональный план» → бот задаст несколько вопросов → заявка попадёт тренеру.

👉 Попробуй прямо сейчас: напиши «кофе с сахаром 2 ч.л.» или пришли фото.`;
      
      await ctx.answerCallbackQuery({ text: "Показываю инструкцию..." });
      await ctx.reply(helpText);
    } else if (data === "day") {
      // Ищем пользователя
      const userResult = await client.query('SELECT id FROM "User" WHERE "tgId" = $1', [userId]);
      
      if (userResult.rows.length === 0) {
        await ctx.answerCallbackQuery({ text: "Ещё ничего не записано." });
        return;
      }
      
      const dbUserId = userResult.rows[0].id;
      const result = await renderDayTotalsWithButtons(dbUserId);
      
      if (result.buttons) {
        await ctx.answerCallbackQuery({ text: "Показываю итог дня..." });
        await ctx.reply(result.message, { reply_markup: result.buttons });
      } else {
        await ctx.answerCallbackQuery({ text: result.message });
      }
    } else if (data === "day_yesterday") {
      // Ищем пользователя
      const userResult = await client.query('SELECT id FROM "User" WHERE "tgId" = $1', [userId]);
      
      if (userResult.rows.length === 0) {
        await ctx.answerCallbackQuery({ text: "Ещё ничего не записано." });
        return;
      }
      
      const dbUserId = userResult.rows[0].id;
      const dateInfo = resolveDayToken("вчера");
      const result = await renderDayTotalsWithButtons(dbUserId, dateInfo);
      
      if (result.buttons) {
        await ctx.answerCallbackQuery({ text: "Показываю итог за вчера..." });
        await ctx.reply(result.message, { reply_markup: result.buttons });
      } else {
        await ctx.answerCallbackQuery({ text: result.message });
      }
    } else if (data.startsWith("meal:set:")) {
      const parts = data.split(":");
      const slot = parts[2];
      const entryId = parts[3];
      
      const allowed = ["breakfast", "lunch", "dinner", "snack"];
      if (!allowed.includes(slot)) {
        await ctx.answerCallbackQuery({ text: "Неверный слот", show_alert: true });
        return;
      }

      try {
        await client.query(`UPDATE "FoodEntry" SET meal_slot=$1 WHERE id=$2`, [slot, entryId]);
        await ctx.answerCallbackQuery({ text: `Пометил как: ${slotRu(slot)}` });
        await ctx.reply(`Готово. Эта запись — ${slotRu(slot)}.`);
      } catch (e) {
        console.error("Ошибка при установке приёма пищи:", e);
        await ctx.answerCallbackQuery({ text: "Ошибка при сохранении", show_alert: true });
      }
    } else if (data.startsWith("meal:edit:")) {
      const slot = data.split(":")[2];
      const allowed = ["breakfast", "lunch", "dinner", "snack", "unslotted"];
      
      if (!allowed.includes(slot)) {
        await ctx.answerCallbackQuery({ text: "Неверный приём пищи", show_alert: true });
        return;
      }

      try {
        // Получаем все записи за сегодня для выбранного приёма пищи
        let query, params;
        if (slot === 'unslotted') {
          query = `
            SELECT fe.id AS entry_id, fe.meal_slot,
                   fi.id as item_id, fi.name, fi.kcal, fi.p, fi.f, fi.c, fi.fiber, fi.resolved_grams
            FROM "FoodEntry" fe
            JOIN food_items fi ON fi.entry_id = fe.id
            WHERE fe."userId" = (SELECT id FROM "User" WHERE "tgId" = $1)
              AND fe.date::date = CURRENT_DATE
              AND fe.meal_slot IS NULL
            ORDER BY fe.id ASC, fi.id ASC
          `;
          params = [userId];
        } else {
          query = `
            SELECT fe.id AS entry_id, fe.meal_slot,
                   fi.id as item_id, fi.name, fi.kcal, fi.p, fi.f, fi.c, fi.fiber, fi.resolved_grams
            FROM "FoodEntry" fe
            JOIN food_items fi ON fi.entry_id = fe.id
            WHERE fe."userId" = (SELECT id FROM "User" WHERE "tgId" = $1)
              AND fe.date::date = CURRENT_DATE
              AND fe.meal_slot = $2
            ORDER BY fe.id ASC, fi.id ASC
          `;
          params = [userId, slot];
        }
        
        const { rows } = await client.query(query, params);

        if (!rows.length) {
          await ctx.answerCallbackQuery({ text: "Нет записей в этом приёме пищи", show_alert: true });
          return;
        }

        // Группируем по записям (entry_id)
        const entries = new Map();
        rows.forEach(r => {
          if (!entries.has(r.entry_id)) {
            entries.set(r.entry_id, {
              id: r.entry_id,
              meal: r.meal_slot || 'unslotted',
              items: []
            });
          }
          entries.get(r.entry_id).items.push(r);
        });

        // Создаем кнопки для каждой записи в приёме пищи
        const kb = new InlineKeyboard();
        let isFirst = true;
        entries.forEach((entry, entryId) => {
          if (!isFirst) kb.row();
          isFirst = false;
          
          // Показываем первые 2 ингредиента в названии кнопки
          const itemNames = entry.items.map(item => item.name).slice(0, 2);
          const buttonText = itemNames.length > 1 
            ? `✏️ ${itemNames.join(', ')}${entry.items.length > 2 ? '...' : ''}`
            : `✏️ ${itemNames[0]}`;
            
          kb.text(buttonText, `edit:${entryId}`)
             .text(`📅 На вчера`, `mv_y:${entryId}`)
             .text(`🗑️ Удалить`, `del:${entryId}`);
        });

        const mealLabel = slot === 'unslotted' ? 'Без пометки' : slotRu(slot);
        const message = `Выберите запись в приёме "${mealLabel}" для редактирования:`;
        
        await ctx.answerCallbackQuery({ text: `Показываю записи в ${mealLabel.toLowerCase()}` });
        await ctx.reply(message, { reply_markup: kb });
      } catch (e) {
        console.error("Ошибка при получении записей приёма пищи:", e);
        await ctx.answerCallbackQuery({ text: "Ошибка при загрузке", show_alert: true });
      }
    } else if (data === "coach:new") {
      pendingCoach.set(userId, { step: 1, draft: {} });
      await ctx.answerCallbackQuery();
      
      const cancelKb = new InlineKeyboard()
        .text("Отменить запрос", "coach:cancel");
        
      return ctx.reply("Цель (сброс/набор/поддержание) и срок? Напиши в одном сообщении.", { 
        reply_markup: cancelKb 
      });
    } else if (data === "coach:cancel") {
      if (pendingCoach.has(userId)) {
        pendingCoach.delete(userId);
        await ctx.answerCallbackQuery({ text: "Заявка отменена" });
        
        const backKb = new InlineKeyboard()
          .text("Персональный план", "coach:new")
          .text("Помощь", "help");
          
        return ctx.reply("Заявка на персональный план отменена. Можете продолжить пользоваться ботом как обычно.", {
          reply_markup: backKb
        });
      } else {
        await ctx.answerCallbackQuery({ text: "Нет активной заявки для отмены" });
      }
    } else if (data.startsWith("cr:view:")) {
      const id = data.split(":")[2];
      if (String(ctx.from.id) !== process.env.TRAINER_TG_ID) {
        await ctx.answerCallbackQuery({ text: "Доступ запрещён", show_alert: true });
        return;
      }

      try {
        const { rows } = await client.query(
          `SELECT id, user_tg_id, user_id, goal, constraints, stats, contact, status, created_at
           FROM coach_requests WHERE id=$1`, [id]
        );
        
        if (!rows.length) {
          await ctx.answerCallbackQuery({ text: "Заявка не найдена", show_alert: true });
          return;
        }
        
        const r = rows[0];
        const text =
          `📝 Заявка #${r.id} (${r.status})\n` +
          `От: tg ${r.user_tg_id}\n` +
          `Дата: ${new Date(r.created_at).toLocaleString("ru-RU")}\n\n` +
          `Цель: ${r.goal}\n` +
          `Ограничения: ${r.constraints || "—"}\n` +
          `Параметры: ${r.stats || "—"}\n` +
          `Контакт: ${r.contact}`;

        await ctx.editMessageText(text, { reply_markup: coachStatusKeyboard(id) });
        await ctx.answerCallbackQuery();
      } catch (error) {
        console.error("Ошибка при просмотре заявки:", error);
        await ctx.answerCallbackQuery({ text: "Ошибка при загрузке заявки", show_alert: true });
      }
    } else if (data.startsWith("cr:set:")) {
      const parts = data.split(":");
      if (parts.length >= 4) {
        const newStatus = parts[2];
        const id = parts[3];
        
        if (String(ctx.from.id) !== process.env.TRAINER_TG_ID) {
          await ctx.answerCallbackQuery({ text: "Доступ запрещён", show_alert: true });
          return;
        }
        
        const allowed = ["new","in_progress","done","rejected"];
        if (!allowed.includes(newStatus)) {
          await ctx.answerCallbackQuery({ text: "Некорректный статус", show_alert: true });
          return;
        }

        try {
          await client.query(`UPDATE coach_requests SET status=$1 WHERE id=$2`, [newStatus, id]);

          // перечитать и перерисовать карточку
          const { rows } = await client.query(
            `SELECT id, user_tg_id, user_id, goal, constraints, stats, contact, status, created_at
             FROM coach_requests WHERE id=$1`, [id]
          );
          
          if (!rows.length) {
            await ctx.answerCallbackQuery({ text: "Заявка не найдена", show_alert: true });
            return;
          }

          const r = rows[0];
          const text =
            `📝 Заявка #${r.id} (${r.status})\n` +
            `От: tg ${r.user_tg_id}\n` +
            `Дата: ${new Date(r.created_at).toLocaleString("ru-RU")}\n\n` +
            `Цель: ${r.goal}\n` +
            `Ограничения: ${r.constraints || "—"}\n` +
            `Параметры: ${r.stats || "—"}\n` +
            `Контакт: ${r.contact}`;

          await ctx.editMessageText(text, { reply_markup: coachStatusKeyboard(id) });
          await ctx.answerCallbackQuery({ text: `Статус: ${newStatus}` });
        } catch (error) {
          console.error("Ошибка при смене статуса:", error);
          await ctx.answerCallbackQuery({ text: "Ошибка при обновлении статуса", show_alert: true });
        }
      }
    } else if (data.startsWith("edit:")) {
      // Показать позиции записи для редактирования
      try {
        const entryId = data.split(":")[1];
        const { rows: items } = await client.query(
          `SELECT id, name, resolved_grams FROM food_items WHERE entry_id=$1 ORDER BY id`, 
          [entryId]
        );
        
        if (!items.length) {
          await ctx.answerCallbackQuery({ text: "Нет позиций", show_alert: true });
          return;
        }

        const kb = new InlineKeyboard();
        items.forEach(it => kb.text(`${it.name} (${Math.round(it.resolved_grams)} г)`, `edititem:${it.id}`).row());
        await ctx.editMessageText("Выбери позицию для изменения граммов:", { reply_markup: kb });
        await ctx.answerCallbackQuery();
      } catch (error) {
        console.error("Ошибка при показе позиций для редактирования:", error);
        await ctx.answerCallbackQuery({ text: "Ошибка при загрузке позиций", show_alert: true });
      }
      
    } else if (data.startsWith("edititem:")) {
      // Начать редактирование позиции
      try {
        const itemId = data.split(":")[1];
        pendingGramEdit.set(userId, Number(itemId));
        await ctx.answerCallbackQuery();
        await ctx.reply("Введи новое количество (в граммах), например: 150");
      } catch (error) {
        console.error("Ошибка при начале редактирования позиции:", error);
        await ctx.answerCallbackQuery({ text: "Ошибка при начале редактирования", show_alert: true });
      }
      
    } else if (data.startsWith("mv_y:")) {
      // Перенести запись на вчера
      try {
        const entryId = data.split(":")[1];
        await client.query(`UPDATE "FoodEntry" SET date = date - INTERVAL '1 day' WHERE id=$1`, [entryId]);
        await ctx.answerCallbackQuery({ text: "Перенёс на вчера" });
        await ctx.reply("Готово: запись перенесена на вчера.");
      } catch (error) {
        console.error("Ошибка при переносе записи на вчера:", error);
        await ctx.answerCallbackQuery({ text: "Ошибка при переносе записи", show_alert: true });
      }
      
    } else if (data.startsWith("del:")) {
      // Удалить запись
      try {
        const entryId = data.split(":")[1];
        await client.query(`DELETE FROM "FoodEntry" WHERE id=$1`, [entryId]);
        await ctx.answerCallbackQuery({ text: "Удалено" });
        await ctx.reply("Запись удалена.");
      } catch (error) {
        console.error("Ошибка при удалении записи:", error);
        await ctx.answerCallbackQuery({ text: "Ошибка при удалении записи", show_alert: true });
      }
      
    } else {
      // Неизвестный callback
      await ctx.answerCallbackQuery({ text: "Неизвестная команда." });
    }
  } catch (error) {
    console.error("Ошибка в callback_query:", error);
    await ctx.answerCallbackQuery({ text: "Произошла ошибка. Попробуйте позже." });
  }
});

// команда /day
bot.command("day", async (ctx) => {
  const t0 = Date.now();
  
  try {
    const userTgId = String(ctx.from.id);
    const args = ctx.message.text.split(' ').slice(1).join(' ').trim();
    
    // Ищем пользователя
    const userResult = await client.query('SELECT id FROM "User" WHERE "tgId" = $1', [userTgId]);
    if (userResult.rows.length === 0) {
      await ctx.reply("Ещё ничего не записано.");
      return;
    }
    const userId = userResult.rows[0].id;
    
    let result;
    if (!args) {
      // /day без аргументов - сегодня
      result = await renderDayTotalsWithButtons(userId);
    } else {
      // Парсим дату
      const dateInfo = resolveDayToken(args);
      if (!dateInfo) {
        await ctx.reply("Не понял дату. Примеры: /day вчера, /day 21.09.2025");
        return;
      }
      result = await renderDayTotalsWithButtons(userId, dateInfo);
    }
    
    if (result.buttons) {
      await ctx.reply(result.message, { reply_markup: result.buttons });
    } else {
      await ctx.reply(result.message);
    }
  } catch (error) {
    console.error("Ошибка в команде /day:", error);
    await ctx.reply("Произошла ошибка. Попробуйте позже.");
    await client.query(`INSERT INTO metrics_events(user_tg_id, kind, latency_ms, created_at)
                        VALUES($1,$2,$3, now())`, [String(ctx.from.id), "error", Date.now()-t0]);
  } finally {
    await client.query(`INSERT INTO metrics_events(user_tg_id, kind, latency_ms, created_at)
                        VALUES($1,$2,$3, now())`, [String(ctx.from.id), "day", Date.now()-t0]);
  }
});

// временная команда для получения ID
bot.command("myid", async (ctx) => {
  await ctx.reply(`Ваш Telegram ID: ${ctx.from.id}\n\nСкопируйте этот ID и замените ADMIN_TG_ID в .env файле на этот номер.`);
});

// команда тренера /inbox
bot.command("inbox", async (ctx) => {
  if (String(ctx.from.id) !== process.env.TRAINER_TG_ID) return;

  try {
    const arg = (ctx.message.text.split(/\s+/)[1] || "new").toLowerCase();
    const allowed = ["new","in_progress","done","rejected"];
    const status = allowed.includes(arg) ? arg : "new";

    const { rows } = await client.query(
      `SELECT id, user_tg_id, goal, status, created_at
       FROM coach_requests
       WHERE status=$1
       ORDER BY created_at DESC
       LIMIT 10`, [status]
    );

    if (!rows.length) return ctx.reply(`Заявок со статусом "${status}" нет ✅`);

    const lines = rows.map(r =>
      `#${r.id} · ${new Date(r.created_at).toLocaleString("ru-RU")} · [${r.status}] · ${r.goal.slice(0,60)}`
    );

    const kb = new InlineKeyboard();
    rows.forEach(r => kb.text(`Открыть #${r.id}`, `cr:view:${r.id}`).row());

    await ctx.reply(`Заявки (${status}, последние 10):\n${lines.join("\n")}`, { reply_markup: kb });
  } catch (error) {
    console.error("Ошибка в /inbox:", error);
    await ctx.reply("Ошибка при получении заявок.");
  }
});

// команда админа /mvpstats
bot.command("mvpstats", async (ctx) => {
  if (String(ctx.from.id) !== process.env.ADMIN_TG_ID) return;

  try {
    const { rows: dau } = await client.query(
      `SELECT COUNT(DISTINCT user_tg_id) AS dau
       FROM metrics_events WHERE created_at::date = CURRENT_DATE`
    );

    const { rows: byKind } = await client.query(
      `SELECT kind, COUNT(*) AS cnt
       FROM metrics_events
       WHERE created_at::date = CURRENT_DATE AND kind IN ('text','voice','photo')
       GROUP BY kind`
    );

    const { rows: lat } = await client.query(
      `SELECT kind, ROUND(AVG(latency_ms)) AS avg_ms, PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_ms
       FROM metrics_events
       WHERE created_at::date = CURRENT_DATE AND kind IN ('text','voice','photo','day')
       GROUP BY kind`
    );

    const dauNum = dau[0]?.dau || 0;
    const kindLine = byKind.map(r => `${r.kind}: ${r.cnt}`).join(" · ") || "нет";
    const latLine = lat.map(r => `${r.kind}: avg ${r.avg_ms}мс, p95 ${Math.round(r.p95_ms)}мс`).join("\n") || "нет данных";

    await ctx.reply(
      `📊 MVP stats (сегодня)\nDAU: ${dauNum}\nАктивности: ${kindLine}\n\n⏱ Латентность:\n${latLine}`
    );
  } catch (error) {
    console.error("Ошибка в /mvpstats:", error);
    await ctx.reply("Ошибка при получении статистики.");
  }
});

// команда /week для недельной статистики
bot.command("week", async (ctx) => {
  const t0 = Date.now();
  
  try {
    const userId = String(ctx.from.id);
    const stats = await getWeeklyStats(userId);
    
    if (!stats || !stats.current || !stats.current.avg_kcal) {
      return ctx.reply("Недостаточно данных для недельной статистики. Записывай еду несколько дней!");
    }

    const current = stats.current;
    const previous = stats.previous;
    
    // Форматирование дат
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 7);
    const endDate = new Date();
    endDate.setDate(endDate.getDate() - 1);
    
    const dateRange = `${startDate.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}-${endDate.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}`;
    
    // Расчет трендов
    const kcalTrend = previous.avg_kcal ? 
      (current.avg_kcal - previous.avg_kcal).toFixed(0) : 0;
    const proteinTrend = previous.avg_protein ? 
      (current.avg_protein - previous.avg_protein).toFixed(1) : 0;
    
    const kcalEmoji = kcalTrend > 0 ? '↗️' : kcalTrend < 0 ? '↘️' : '➡️';
    const proteinEmoji = proteinTrend > 0 ? '↗️' : proteinTrend < 0 ? '↘️' : '➡️';
    
    let message = `📊 Недельная статистика (${dateRange})\n\n`;
    message += `🍽️ СРЕДНИЕ ПОКАЗАТЕЛИ:\n`;
    message += `• Калории: ${Math.round(current.avg_kcal)} ккал/день\n`;
    message += `• Белки: ${current.avg_protein.toFixed(1)}г/день\n`;
    message += `• Жиры: ${current.avg_fat.toFixed(1)}г/день\n`;
    message += `• Углеводы: ${current.avg_carbs.toFixed(1)}г/день\n`;
    message += `• Клетчатка: ${current.avg_fiber.toFixed(1)}г/день\n\n`;
    
    if (previous.avg_kcal) {
      message += `📈 ТРЕНДЫ:\n`;
      message += `• Калории: ${kcalEmoji} ${kcalTrend > 0 ? '+' : ''}${kcalTrend} ккал/день (vs прошлая неделя)\n`;
      message += `• Белки: ${proteinEmoji} ${proteinTrend > 0 ? '+' : ''}${proteinTrend}г/день (vs прошлая неделя)\n\n`;
    }
    
    // Данные по дням
    if (stats.daily && stats.daily.length > 0) {
      message += `📅 ПО ДНЯМ:\n`;
      const dayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
      
      stats.daily.forEach(day => {
        const dayName = dayNames[new Date(day.day).getDay()];
        message += `• ${dayName}: ${Math.round(day.total_kcal)} ккал | Б ${day.total_protein.toFixed(0)}г | Ж ${day.total_fat.toFixed(0)}г | У ${day.total_carbs.toFixed(0)}г\n`;
      });
    }
    
    await ctx.reply(message);
    
  } catch (error) {
    console.error("Ошибка в команде /week:", error);
    await ctx.reply("Произошла ошибка при получении статистики. Попробуйте позже.");
  } finally {
    await client.query(`INSERT INTO metrics_events(user_tg_id, kind, latency_ms, created_at)
                        VALUES($1,$2,$3, now())`, [String(ctx.from.id), "week", Date.now()-t0]);
  }
});

// команда /month для месячной статистики
bot.command("month", async (ctx) => {
  const t0 = Date.now();
  
  try {
    const userId = String(ctx.from.id);
    const stats = await getMonthlyStats(userId);
    
    if (!stats || !stats.current || !stats.current.avg_kcal) {
      return ctx.reply("Недостаточно данных для месячной статистики. Записывай еду несколько дней!");
    }

    const current = stats.current;
    const previous = stats.previous;
    
    // Форматирование месяца
    const monthName = new Date().toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
    
    // Расчет трендов
    const kcalTrend = previous.avg_kcal ? 
      (current.avg_kcal - previous.avg_kcal).toFixed(0) : 0;
    const proteinTrend = previous.avg_protein ? 
      (current.avg_protein - previous.avg_protein).toFixed(1) : 0;
    
    const kcalEmoji = kcalTrend > 0 ? '↗️' : kcalTrend < 0 ? '↘️' : '➡️';
    const proteinEmoji = proteinTrend > 0 ? '↗️' : proteinTrend < 0 ? '↘️' : '➡️';
    
    let message = `📊 Месячная статистика (${monthName})\n\n`;
    message += `🍽️ СРЕДНИЕ ПОКАЗАТЕЛИ:\n`;
    message += `• Калории: ${Math.round(current.avg_kcal)} ккал/день\n`;
    message += `• Белки: ${current.avg_protein.toFixed(1)}г/день\n`;
    message += `• Жиры: ${current.avg_fat.toFixed(1)}г/день\n`;
    message += `• Углеводы: ${current.avg_carbs.toFixed(1)}г/день\n`;
    message += `• Клетчатка: ${current.avg_fiber.toFixed(1)}г/день\n\n`;
    
    if (previous.avg_kcal) {
      message += `📈 ТРЕНДЫ:\n`;
      message += `• Калории: ${kcalEmoji} ${kcalTrend > 0 ? '+' : ''}${kcalTrend} ккал/день (vs прошлый месяц)\n`;
      message += `• Белки: ${proteinEmoji} ${proteinTrend > 0 ? '+' : ''}${proteinTrend}г/день (vs прошлый месяц)\n\n`;
    }
    
    // Недельные тренды
    if (stats.weeklyTrends && stats.weeklyTrends.length > 0) {
      message += `📅 НЕДЕЛЬНЫЕ ТРЕНДЫ:\n`;
      stats.weeklyTrends.forEach((week, index) => {
        message += `• ${index + 1}-я неделя: ${Math.round(week.avg_kcal)} ккал/день\n`;
      });
    }
    
    await ctx.reply(message);
    
  } catch (error) {
    console.error("Ошибка в команде /month:", error);
    await ctx.reply("Произошла ошибка при получении статистики. Попробуйте позже.");
  } finally {
    await client.query(`INSERT INTO metrics_events(user_tg_id, kind, latency_ms, created_at)
                        VALUES($1,$2,$3, now())`, [String(ctx.from.id), "month", Date.now()-t0]);
  }
});

// команда /admin_help для админа и тренера
bot.command("admin_help", async (ctx) => {
  const userId = String(ctx.from.id);
  const isAdmin = userId === process.env.ADMIN_TG_ID;
  const isTrainer = userId === process.env.TRAINER_TG_ID;
  
  if (!isAdmin && !isTrainer) {
    return ctx.reply("Эта команда доступна только администратору и тренеру.");
  }

  let helpText = `🔧 Команды для администратора и тренера:\n\n`;
  
  if (isAdmin) {
    helpText += `👑 АДМИНИСТРАТОР:\n`;
    helpText += `• /mvpstats — статистика бота за сегодня\n`;
    helpText += `• /myid — получить свой Telegram ID\n`;
    helpText += `• /parse <текст> — тестировать парсинг текста\n\n`;
  }
  
  if (isTrainer) {
    helpText += `🏋️ ТРЕНЕР:\n`;
    helpText += `• /inbox — новые заявки на персональный план\n`;
    helpText += `• /inbox new — заявки со статусом "новые"\n`;
    helpText += `• /inbox in_progress — заявки "в работе"\n`;
    helpText += `• /inbox done — завершённые заявки\n`;
    helpText += `• /inbox rejected — отклонённые заявки\n\n`;
  }
  
  helpText += `📋 ОБЩИЕ КОМАНДЫ:\n`;
  helpText += `• /day — итоги за сегодня\n`;
  helpText += `• /day вчера — итоги за вчера\n`;
  helpText += `• /day 21.09.2025 — итоги за конкретную дату\n`;
  helpText += `• /start — приветствие и инструкция\n`;
  helpText += `• /help — подробная справка\n\n`;
  
  helpText += `💡 УПРАВЛЕНИЕ ЗАЯВКАМИ:\n`;
  helpText += `• В /inbox нажми "Открыть #ID" для просмотра деталей\n`;
  helpText += `• В карточке заявки можно изменить статус кнопками\n`;
  helpText += `• Статусы: new → in_progress → done/rejected\n\n`;
  
  helpText += `📊 МЕТРИКИ (только админ):\n`;
  helpText += `• DAU — уникальные пользователи за день\n`;
  helpText += `• Активности — количество событий по типам\n`;
  helpText += `• Латентность — время ответа сервисов`;

  await ctx.reply(helpText);
});

// тестовая команда /parse
bot.command("parse", async (ctx) => {
  const text = ctx.message.text.replace(/^\/parse\s*/i, "").trim();
  if (!text) return ctx.reply("Пример: /parse вчера 2 куска пиццы и кола 0.5 в 20:00");

  try {
    const items = await parseFoodTextStructured(text, "Europe/Warsaw");
    const pretty = items.map(i =>
      `• ${i.name}: ${i.qty} ${i.unit}` +
      (i.datetime ? ` @ ${i.datetime}` : ``) +
      ` | per100g kcal:${i.per100g.kcal}`
    ).join("\n");
    await ctx.reply(pretty || "Пусто");
  } catch (e) {
    console.error(e);
    await ctx.reply("Не удалось распарсить по схеме. Попробуй упростить фразу.");
  }
});

// обработчик голосовых сообщений
bot.on("message:voice", async (ctx) => {
  const t0 = Date.now();
  
  try {
    // Rate-limit защита
    if (!(await guardRate(ctx))) return;

    // Проверка длительности голоса
    if ((ctx.message.voice?.duration || 0) > 60) {
      return ctx.reply("Аудио длиннее 60 сек. Скажи короче или отправь текстом 🙏");
    }
    await ctx.reply("Секунду, распознаю голос…");

    // 1) получаем файл с серверов Telegram
    const file = await ctx.api.getFile(ctx.message.voice.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;

    // 2) сохраняем исходник и конвертируем в wav
    const tmpDir = path.join(process.cwd(), "tmp");
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
    const oggPath = path.join(tmpDir, `voice_${Date.now()}.oga`);
    const wavPath = path.join(tmpDir, `voice_${Date.now()}.wav`);

    const res = await fetch(fileUrl);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(oggPath, buf);

    await oggToWav(oggPath, wavPath);

    // 3) транскрипция с таймаутом
    const text = await withTimeout(transcribeAudio(wavPath), 20000, "Сервисы думают дольше обычного. Попробуй ещё раз или напиши текстом.");
    
    // 4) уборка временных файлов
    fs.unlink(oggPath, () => {});
    fs.unlink(wavPath, () => {});

    if (!text) {
      return ctx.reply("Не удалось распознать голос. Попробуй сказать чуть чётче, ближе к микрофону или напиши текстом 📝");
    }

    // 5) сразу пускаем через пайплайн
    await handleFoodText(ctx, text);
  } catch (e) {
    console.error("Ошибка при обработке голоса:", e);
    await ctx.reply("Не удалось обработать голосовое сообщение. Попробуй ещё раз или напиши текстом 📝");
    await client.query(`INSERT INTO metrics_events(user_tg_id, kind, latency_ms, created_at)
                        VALUES($1,$2,$3, now())`, [String(ctx.from.id), "error", Date.now()-t0]);
  } finally {
    await client.query(`INSERT INTO metrics_events(user_tg_id, kind, latency_ms, created_at)
                        VALUES($1,$2,$3, now())`, [String(ctx.from.id), "voice", Date.now()-t0]);
  }
});

// обработчик фотографий
bot.on("message:photo", async (ctx) => {
  const t0 = Date.now();
  
  try {
    // Rate-limit защита
    if (!(await guardRate(ctx))) return;
    await ctx.reply("Секунду, распознаю фото…");

    const photos = ctx.message.photo; // массив вариантов; берём средний размер
    const chosen = photos[Math.max(0, photos.length - 2)]; // не самый большой
    const dataUrl = await downloadPhotoAsDataUrl(ctx.api, chosen.file_id);
    const caption = ctx.message.caption?.trim() || ""; // если юзер что-то подписал

    const items = await withTimeout(parseFoodImageStructured(dataUrl, "Europe/Warsaw", caption), 20000, "Сервисы думают дольше обычного. Попробуй ещё раз или напиши текстом.");

    // как и в тексте/голосе — создаём запись и позиции
    const tgId = String(ctx.from.id);
    let userResult = await client.query('SELECT id FROM "User" WHERE "tgId" = $1', [tgId]);
    if (userResult.rows.length === 0) {
      userResult = await client.query('INSERT INTO "User" ("tgId") VALUES ($1) RETURNING id', [tgId]);
    }
    const userId = userResult.rows[0].id;

    const rawText = caption ? `[photo] ${caption}` : "[photo]";
    const entryResult = await client.query(
      'INSERT INTO "FoodEntry" ("userId", date, "textRaw", "createdAt") VALUES ($1, $2, $3, $4) RETURNING id',
      [userId, new Date(), rawText, new Date()]
    );
    const entryId = entryResult.rows[0].id;

    let total = { kcal: 0, p: 0, f: 0, c: 0, fiber: 0 };
    for (const it of items) {
      const grams = resolveGrams({
        qty: it.qty,
        unit: it.unit,
        density: it.density_g_per_ml ?? null,
        pieceGrams: it.default_piece_grams ?? null,
        resolved_grams: it.resolved_grams ?? null,
      });
      const m = macrosFromPer100g(grams, it.per100g);
      total.kcal += m.kcal; 
      total.p += m.p; 
      total.f += m.f; 
      total.c += m.c; 
      total.fiber += m.fiber;

      await client.query(
        `INSERT INTO food_items(entry_id, name, qty, unit, resolved_grams, kcal, p, f, c, fiber, edited_by_user, created_at)
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, now())`,
        [entryId, it.name, it.qty, it.unit, grams, m.kcal, m.p, m.f, m.c, m.fiber]
      );
    }

    const lines = items.map(i => `• ${i.name}: ${i.qty} ${i.unit}`).join("\n");
    const sum = `Итого: ${Math.round(total.kcal)} ккал | Б ${total.p.toFixed(1)} | Ж ${total.f.toFixed(1)} | У ${total.c.toFixed(1)} | Кл ${total.fiber.toFixed(1)}`;

    // Используем общую функцию для создания сообщения и кнопок
    const { message, keyboard } = createFoodEntryResponse(entryId, lines, sum, "фото");
    
    await ctx.reply(message, { reply_markup: keyboard });
  } catch (e) {
    console.error("Ошибка при обработке фото:", e);
    
    let errorMessage = "Не удалось распознать фото. Попробуй сделать снимок ближе и на хорошем освещении или добавь подпись (например: «овсянка 60 г, банан 1 шт»).";
    
    if (e.message.includes("Сервисы думают дольше обычного")) {
      errorMessage = "Фото слишком сложное для анализа. Попробуй сделать снимок ближе и на хорошем освещении или добавь подпись (например: «овсянка 60 г, банан 1 шт»).";
    } else if (e.message.includes("Не удалось распознать еду на фото")) {
      errorMessage = "Не удалось распознать еду на фото. Попробуй сделать снимок ближе и на хорошем освещении или добавь подпись (например: «овсянка 60 г, банан 1 шт»).";
    } else if (e.message.includes("Пустой ответ от Vision API")) {
      errorMessage = "Сервис анализа фото временно недоступен. Попробуй добавить подпись к фото (например: «овсянка 60 г, банан 1 шт»).";
    }
    
    await ctx.reply(errorMessage);
    await client.query(`INSERT INTO metrics_events(user_tg_id, kind, latency_ms, created_at)
                        VALUES($1,$2,$3, now())`, [String(ctx.from.id), "error", Date.now()-t0]);
  } finally {
    await client.query(`INSERT INTO metrics_events(user_tg_id, kind, latency_ms, created_at)
                        VALUES($1,$2,$3, now())`, [String(ctx.from.id), "photo", Date.now()-t0]);
  }
});

// сохраняем записи в БД с парсингом и расчётом КБЖУ
bot.on("message:text", async (ctx) => {
  const t0 = Date.now();
  
  try {
    // Пропускаем команды - они обрабатываются отдельно
    if (ctx.message.text.startsWith('/') && !ctx.message.text.includes(' ')) {
      return;
    }

    // Rate-limit защита
    if (!(await guardRate(ctx))) return;

  const text = ctx.message.text.trim();
  const userId = String(ctx.from.id);
  let gramEditProcessed = false;

  // Проверяем, не редактируем ли мы граммы (ПРИОРИТЕТНАЯ ПРОВЕРКА)
  const editingItemId = pendingGramEdit.get(userId);
  if (editingItemId) {
    const grams = Number(String(text).replace(",", "."));
    if (!grams || grams <= 0) {
      await ctx.reply("Нужно число > 0. Введи ещё раз, например: 120");
      return;
    }

    try {
      // получаем старые граммы, считаем коэффициент и масштабируем нутриенты
      const { rows } = await client.query(
        `SELECT entry_id, resolved_grams, kcal, p, f, c, fiber FROM food_items WHERE id=$1`, 
        [editingItemId]
      );
      
      if (!rows.length) { 
        pendingGramEdit.delete(userId); 
        await ctx.reply("Позиция не найдена."); 
        return; 
      }

      const it = rows[0];
      const k = grams / Number(it.resolved_grams);
      await client.query(
        `UPDATE food_items
         SET resolved_grams=$1,
             kcal=$2, p=$3, f=$4, c=$5, fiber=$6
         WHERE id=$7`,
        [grams,
         (it.kcal*k).toFixed(1), (it.p*k).toFixed(1), (it.f*k).toFixed(1), (it.c*k).toFixed(1), (it.fiber*k).toFixed(1),
         editingItemId]
      );

      pendingGramEdit.delete(userId);

      // получаем ID пользователя из базы данных
      const userResult = await client.query('SELECT id FROM "User" WHERE "tgId" = $1', [userId]);
      if (userResult.rows.length === 0) {
        await ctx.reply("Обновил. Пользователь не найден.");
        return;
      }
      const dbUserId = userResult.rows[0].id;

      // показываем быстрый итог за день
      const { rows: totals } = await client.query(
        `SELECT COALESCE(SUM(fi.kcal),0) AS kcal, COALESCE(SUM(fi.p),0) AS p, COALESCE(SUM(fi.f),0) AS f, COALESCE(SUM(fi.c),0) AS c, COALESCE(SUM(fi.fiber),0) AS fiber
         FROM "FoodEntry" fe 
         JOIN food_items fi ON fi.entry_id=fe.id 
         WHERE fe."userId"=$1 AND fe."date"::date = CURRENT_DATE`,
        [dbUserId]
      );
      const t = totals[0];
      await ctx.reply(`Обновил. Итог за сегодня: ${Math.round(t.kcal)} ккал | Б ${(+t.p).toFixed(1)} | Ж ${(+t.f).toFixed(1)} | У ${(+t.c).toFixed(1)} | Кл ${(+t.fiber).toFixed(1)}`);
      gramEditProcessed = true;
      return;
    } catch (error) {
      console.error("Ошибка при обновлении граммов:", error);
      pendingGramEdit.delete(userId);
      await ctx.reply("Ошибка при обновлении. Попробуй ещё раз.");
      return;
    }
  }

  // Проверяем, не заполняем ли мы анкету персонального плана
  const coachSession = pendingCoach.get(userId);
  if (coachSession) {
    if (coachSession.step === 1) {
      coachSession.draft.goal = text;
      coachSession.step = 2;
      
      const cancelKb = new InlineKeyboard()
        .text("Отменить запрос", "coach:cancel");
        
      return ctx.reply("Ограничения/предпочтения по питанию?", { 
        reply_markup: cancelKb 
      });
    }
    if (coachSession.step === 2) {
      coachSession.draft.constraints = text;
      coachSession.step = 3;
      
      const cancelKb = new InlineKeyboard()
        .text("Отменить запрос", "coach:cancel");
        
      return ctx.reply("Рост/вес/возраст — в свободной форме:", { 
        reply_markup: cancelKb 
      });
    }
    if (coachSession.step === 3) {
      coachSession.draft.stats = text;
      coachSession.step = 4;
      
      const cancelKb = new InlineKeyboard()
        .text("Отменить запрос", "coach:cancel");
        
      return ctx.reply("Контакт для связи (телеграм @ник или телефон):", { 
        reply_markup: cancelKb 
      });
    }
    if (coachSession.step === 4) {
      coachSession.draft.contact = text;

      try {
        // сохранить в БД
        const { rows: u } = await client.query('SELECT id FROM "User" WHERE "tgId" = $1', [userId]);
        const dbUserId = u[0]?.id || null;

        await client.query(
          `INSERT INTO coach_requests(user_tg_id, user_id, goal, constraints, stats, contact, status, created_at)
           VALUES($1, $2, $3, $4, $5, $6, 'new', now())`,
          [userId, dbUserId, coachSession.draft.goal, coachSession.draft.constraints, coachSession.draft.stats, coachSession.draft.contact]
        );

        // уведомить тренера
        const summary =
          `📝 Новая заявка на персональный план\n` +
          `От: tg ${userId}\n` +
          `Цель: ${coachSession.draft.goal}\n` +
          `Ограничения: ${coachSession.draft.constraints}\n` +
          `Параметры: ${coachSession.draft.stats}\n` +
          `Контакт: ${coachSession.draft.contact}\n` +
          `Дата: ${new Date().toLocaleString("ru-RU")}`;

        if (process.env.TRAINER_TG_ID) {
          try { 
            await ctx.api.sendMessage(process.env.TRAINER_TG_ID, summary); 
          } catch(e) { 
            console.error("Ошибка отправки тренеру:", e); 
          }
        }

        pendingCoach.delete(userId);
        return ctx.reply("Заявка отправлена тренеру ✅. Он свяжется с тобой в личке.");
      } catch (error) {
        console.error("Ошибка при сохранении заявки:", error);
        pendingCoach.delete(userId);
        return ctx.reply("Не удалось отправить заявку, попробуй позже.");
      }
    }
  }


  // Проверяем триггеры дня
  if (await checkDayTriggers(ctx, text)) {
    return;
  }

  // Обрабатываем как обычный текст еды (только если не редактировали граммы)
  if (!gramEditProcessed) {
    await handleFoodText(ctx, text);
  }
  
  } catch (e) {
    console.error("Ошибка в обработчике текста:", e);
    await ctx.reply("Хмм, не смог обработать. Попробуй ещё раз.");
    await client.query(`INSERT INTO metrics_events(user_tg_id, kind, latency_ms, created_at)
                        VALUES($1,$2,$3, now())`, [String(ctx.from.id), "error", Date.now()-t0]);
    return;
  } finally {
    await client.query(`INSERT INTO metrics_events(user_tg_id, kind, latency_ms, created_at)
                        VALUES($1,$2,$3, now())`, [String(ctx.from.id), "text", Date.now()-t0]);
  }
});

// Функция для получения недельной статистики
async function getWeeklyStats(userId) {
  try {
    // Текущая неделя (последние 7 дней)
    const currentWeek = await client.query(`
      SELECT 
        AVG(fi.kcal) as avg_kcal,
        AVG(fi.p) as avg_protein,
        AVG(fi.f) as avg_fat,
        AVG(fi.c) as avg_carbs,
        AVG(fi.fiber) as avg_fiber
      FROM "FoodEntry" fe
      JOIN food_items fi ON fi.entry_id = fe.id
      WHERE fe."userId" = $1 
        AND fe.date >= CURRENT_DATE - INTERVAL '7 days'
        AND fe.date < CURRENT_DATE
    `, [userId]);

    // Прошлая неделя (7-14 дней назад)
    const prevWeek = await client.query(`
      SELECT 
        AVG(fi.kcal) as avg_kcal,
        AVG(fi.p) as avg_protein,
        AVG(fi.f) as avg_fat,
        AVG(fi.c) as avg_carbs,
        AVG(fi.fiber) as avg_fiber
      FROM "FoodEntry" fe
      JOIN food_items fi ON fi.entry_id = fe.id
      WHERE fe."userId" = $1 
        AND fe.date >= CURRENT_DATE - INTERVAL '14 days'
        AND fe.date < CURRENT_DATE - INTERVAL '7 days'
    `, [userId]);

    // Данные по дням недели
    const dailyData = await client.query(`
      SELECT 
        fe.date::date as day,
        SUM(fi.kcal) as total_kcal,
        SUM(fi.p) as total_protein,
        SUM(fi.f) as total_fat,
        SUM(fi.c) as total_carbs,
        SUM(fi.fiber) as total_fiber
      FROM "FoodEntry" fe
      JOIN food_items fi ON fi.entry_id = fe.id
      WHERE fe."userId" = $1 
        AND fe.date >= CURRENT_DATE - INTERVAL '7 days'
        AND fe.date < CURRENT_DATE
      GROUP BY fe.date::date
      ORDER BY fe.date::date DESC
    `, [userId]);

    return {
      current: currentWeek.rows[0],
      previous: prevWeek.rows[0],
      daily: dailyData.rows
    };
  } catch (error) {
    console.error("Ошибка при получении недельной статистики:", error);
    return null;
  }
}

// Функция для получения месячной статистики
async function getMonthlyStats(userId) {
  try {
    // Текущий месяц
    const currentMonth = await client.query(`
      SELECT 
        AVG(fi.kcal) as avg_kcal,
        AVG(fi.p) as avg_protein,
        AVG(fi.f) as avg_fat,
        AVG(fi.c) as avg_carbs,
        AVG(fi.fiber) as avg_fiber
      FROM "FoodEntry" fe
      JOIN food_items fi ON fi.entry_id = fe.id
      WHERE fe."userId" = $1 
        AND fe.date >= DATE_TRUNC('month', CURRENT_DATE)
        AND fe.date < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
    `, [userId]);

    // Прошлый месяц
    const prevMonth = await client.query(`
      SELECT 
        AVG(fi.kcal) as avg_kcal,
        AVG(fi.p) as avg_protein,
        AVG(fi.f) as avg_fat,
        AVG(fi.c) as avg_carbs,
        AVG(fi.fiber) as avg_fiber
      FROM "FoodEntry" fe
      JOIN food_items fi ON fi.entry_id = fe.id
      WHERE fe."userId" = $1 
        AND fe.date >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month'
        AND fe.date < DATE_TRUNC('month', CURRENT_DATE)
    `, [userId]);

    // Недельные тренды внутри месяца
    const weeklyTrends = await client.query(`
      SELECT 
        EXTRACT(week FROM fe.date) as week_num,
        AVG(fi.kcal) as avg_kcal
      FROM "FoodEntry" fe
      JOIN food_items fi ON fi.entry_id = fe.id
      WHERE fe."userId" = $1 
        AND fe.date >= DATE_TRUNC('month', CURRENT_DATE)
        AND fe.date < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'
      GROUP BY EXTRACT(week FROM fe.date)
      ORDER BY week_num
    `, [userId]);

    return {
      current: currentMonth.rows[0],
      previous: prevMonth.rows[0],
      weeklyTrends: weeklyTrends.rows
    };
  } catch (error) {
    console.error("Ошибка при получении месячной статистики:", error);
    return null;
  }
}

// Обработка ошибок
bot.catch((err) => {
  console.error("Ошибка в боте:", err);
});

// Создаем HTTP-сервер для healthcheck Railway
const server = http.createServer((req, res) => {
  if (req.url === '/' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      service: 'nutrition-bot',
      timestamp: new Date().toISOString()
    }));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

// Запускаем HTTP-сервер
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌐 HTTP-сервер запущен на порту ${PORT}`);
});

// Запускаем бота с обработкой ошибок
bot.start().catch(error => {
  if (error.error_code === 409) {
    console.log("⚠️  Другой экземпляр бота уже запущен. Останавливаем...");
    process.exit(0);
  } else {
    console.error("❌ Ошибка запуска бота:", error);
    process.exit(1);
  }
});
console.log("✅ Бот запущен, жду сообщения в Telegram...");