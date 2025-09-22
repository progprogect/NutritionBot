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
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

ffmpeg.setFfmpegPath(ffmpegPath);

const client = new Client({
  host: 'localhost',
  port: 5433,
  database: 'foodbot',
  user: 'postgres',
  password: 'postgres',
  ssl: false
});

// Подключаемся к БД
client.connect().then(() => {
  console.log("✅ Подключение к PostgreSQL успешно");
}).catch(err => {
  console.error("❌ Ошибка подключения к PostgreSQL:", err);
  process.exit(1);
});

const bot = new Bot(process.env.BOT_TOKEN);

// State для ожидания ввода граммов
const pendingGramEdit = new Map(); // userId -> itemId

// State для сбора анкеты персонального плана
const pendingCoach = new Map(); // userId -> { step: 1..4, draft: {...} }

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
    const items = await withTimeout(parseFoodTextStructured(text, tz), 8000, "Сервисы думают дольше обычного. Напиши короче или попробуй ещё раз.");

    // 4) расчёт и сохранение позиций
    let total = { kcal: 0, p: 0, f: 0, c: 0, fiber: 0 };
    for (const it of items) {
      const grams = resolveGrams({
        qty: it.qty,
        unit: it.unit,
        density: it.density_g_per_ml ?? null,
        pieceGrams: it.default_piece_grams ?? null,
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

    // 5) inline-кнопки
    const kb = new InlineKeyboard()
      .text("Изменить граммы", `edit:${entryId}`)
      .row()
      .text("Перенести на вчера", `mv_y:${entryId}`)
      .text("Удалить запись", `del:${entryId}`)
      .row()
      .text("Персональный план", "coach:new");

    await ctx.reply(`Добавил (из текста/голоса):\n${lines}\n${sum}`, { reply_markup: kb });
  } catch (e) {
    console.error("Ошибка в handleFoodText:", e);
    await ctx.reply("Запомнил, но без расчётов (тех. пауза). /day — список за день.");
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
      `SELECT fe.id as entry_id, fi.name, fi.kcal, fi.p, fi.f, fi.c, fi.fiber
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
      return `• ${r.name} — ${Math.round(r.kcal)} ккал | Б ${r.p} | Ж ${r.f} | У ${r.c} | Кл ${r.fiber}`;
    }).join('\n');
    
    const totalLine = `\n\nИТОГО: ${Math.round(total.kcal)} ккал | Б ${total.p.toFixed(1)} | Ж ${total.f.toFixed(1)} | У ${total.c.toFixed(1)} | Кл ${total.fiber.toFixed(1)}`;
    
    return { success: true, message: `Итог за ${title}:\n${lines}${totalLine}` };
    
  } catch (error) {
    console.error("Ошибка при рендере итогов:", error);
    return { success: false, message: "Произошла ошибка. Попробуйте позже." };
  }
}

// команда /start
bot.command("start", (ctx) => {
  const kb = new InlineKeyboard()
    .text("Помощь", "help")
    .row()
    .text("Итог дня", "day")
    .row()
    .text("Персональный план", "coach:new");
  return ctx.reply(
    "Привет! Я бот для учёта питания. Напиши: «овсянка 60 г + молоко 200 мл» или используй кнопки.",
    { reply_markup: kb }
  );
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
    
    if (data === "help") {
      await ctx.answerCallbackQuery({ text: "Команды: /start, напиши еду, /day." });
    } else if (data === "day") {
      const result = await getDayEntries(userId);
      
      // Если сообщение длинное, отправляем как обычное сообщение
      if (result.success && result.message.length > 200) {
        await ctx.answerCallbackQuery({ text: "Показываю итог дня..." });
        await ctx.reply(result.message);
      } else {
        await ctx.answerCallbackQuery({ text: result.message });
      }
    } else if (data === "coach:new") {
      pendingCoach.set(userId, { step: 1, draft: {} });
      await ctx.answerCallbackQuery();
      return ctx.reply("Цель (сброс/набор/поддержание) и срок? Напиши в одном сообщении.");
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
      
    } else if (data.startsWith("edititem:")) {
      // Начать редактирование позиции
      const itemId = data.split(":")[1];
      pendingGramEdit.set(userId, Number(itemId));
      await ctx.answerCallbackQuery();
      await ctx.reply("Введи новое количество (в граммах), например: 150");
      
    } else if (data.startsWith("mv_y:")) {
      // Перенести запись на вчера
      const entryId = data.split(":")[1];
      await client.query(`UPDATE "FoodEntry" SET date = date - INTERVAL '1 day' WHERE id=$1`, [entryId]);
      await ctx.answerCallbackQuery({ text: "Перенёс на вчера" });
      await ctx.reply("Готово: запись перенесена на вчера.");
      
    } else if (data.startsWith("del:")) {
      // Удалить запись
      const entryId = data.split(":")[1];
      await client.query(`DELETE FROM "FoodEntry" WHERE id=$1`, [entryId]);
      await ctx.answerCallbackQuery({ text: "Удалено" });
      await ctx.reply("Запись удалена.");
      
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
      result = await renderDayTotals(userId);
    } else {
      // Парсим дату
      const dateInfo = resolveDayToken(args);
      if (!dateInfo) {
        await ctx.reply("Не понял дату. Примеры: /day вчера, /day 21.09.2025");
        return;
      }
      result = await renderDayTotals(userId, dateInfo);
    }
    
    await ctx.reply(result.message);
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
    const text = await withTimeout(transcribeAudio(wavPath), 15000, "Сервисы думают дольше обычного. Напиши короче или попробуй ещё раз.");
    
    // 4) уборка временных файлов
    fs.unlink(oggPath, () => {});
    fs.unlink(wavPath, () => {});

    if (!text) {
      return ctx.reply("Не удалось распознать голос. Попробуй сказать чуть чётче или ближе к микрофону.");
    }

    // 5) сразу пускаем через пайплайн
    await handleFoodText(ctx, text);
  } catch (e) {
    console.error("Ошибка при обработке голоса:", e);
    await ctx.reply("Хмм, не вышло распознать аудио. Попробуй ещё раз или напиши текстом.");
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

    const items = await withTimeout(parseFoodImageStructured(dataUrl, "Europe/Warsaw", caption), 15000, "Сервисы думают дольше обычного. Напиши короче или попробуй ещё раз.");

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
        pieceGrams: it.default_piece_grams ?? null
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

    const kb = new InlineKeyboard()
      .text("Изменить граммы", `edit:${entryId}`)
      .row()
      .text("Перенести на вчера", `mv_y:${entryId}`)
      .text("Удалить запись", `del:${entryId}`)
      .row()
      .text("Персональный план", "coach:new");

    await ctx.reply(`Добавил (с фото):\n${lines}\n${sum}`, { reply_markup: kb });
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

  // Проверяем, не заполняем ли мы анкету персонального плана
  const coachSession = pendingCoach.get(userId);
  if (coachSession) {
    if (coachSession.step === 1) {
      coachSession.draft.goal = text;
      coachSession.step = 2;
      return ctx.reply("Ограничения/предпочтения по питанию?");
    }
    if (coachSession.step === 2) {
      coachSession.draft.constraints = text;
      coachSession.step = 3;
      return ctx.reply("Рост/вес/возраст — в свободной форме:");
    }
    if (coachSession.step === 3) {
      coachSession.draft.stats = text;
      coachSession.step = 4;
      return ctx.reply("Контакт для связи (телеграм @ник или телефон):");
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

  // Проверяем, не редактируем ли мы граммы
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

      // показываем итог за день
      const result = await renderDayTotals(dbUserId);
      const totalText = result.success ? result.message : "Ошибка при получении итогов";
      await ctx.reply(`Обновил. ${totalText}`);
      
    } catch (error) {
      console.error("Ошибка при обновлении граммов:", error);
      pendingGramEdit.delete(userId);
      await ctx.reply("Ошибка при обновлении. Попробуйте позже.");
    }
    return;
  }

  // Проверяем триггеры дня
  if (await checkDayTriggers(ctx, text)) {
    return;
  }

  // Обрабатываем как обычный текст еды
  await handleFoodText(ctx, text);
  
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

// Обработка ошибок
bot.catch((err) => {
  console.error("Ошибка в боте:", err);
});

bot.start();
console.log("✅ Бот запущен, жду сообщения в Telegram...");