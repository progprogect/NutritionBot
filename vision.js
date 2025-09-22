// vision.js
const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ALLOWED_UNITS = ["g","ml","piece","slice","tsp","tbsp","cup","glass","can","bottle"];

/**
 * parseFoodImageStructured
 * @param {string} dataUrl  data:image/jpeg;base64,...
 * @param {string} tz       e.g., "Europe/Warsaw"
 * @param {string} caption  optional user caption to help recognition
 * @returns {Array} items   [{ name, qty, unit, datetime?, per100g, density_g_per_ml?, default_piece_grams? }]
 */
async function parseFoodImageStructured(dataUrl, tz = "Europe/Warsaw", caption = "") {
  const system = `Ты нутрициолог. Анализируешь ФОТО еды (и подпись, если есть) и возвращаешь СТРОГО JSON по схеме.
Единицы только: ${ALLOWED_UNITS.join(", ")}.
Если 'ml' — оцени плотность density_g_per_ml (вода/кола ~1.00, молоко ~1.03).
Если 'piece'/'slice' — оцени default_piece_grams (реалистично).
"сегодня/вчера/в 10:30" в подписи — верни ISO datetime с учётом TZ ${tz}.
Если уверенности недостаточно — верни реалистичные дефолты. Поля пустыми не оставляй.`;

  const userText = caption
    ? `Подпись пользователя (если поможет): """${caption}"""`
    : `Подпись отсутствует. Определи из фото.`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "FoodLogFromImage",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  name: { type: "string" },
                  qty: { type: "number" },
                  unit: { type: "string", enum: ALLOWED_UNITS },
                  datetime: { type: "string", format: "date-time" },
                  per100g: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      kcal: { type: "number" },
                      p: { type: "number" },
                      f: { type: "number" },
                      c: { type: "number" },
                      fiber: { type: "number" }
                    },
                    required: ["kcal","p","f","c","fiber"]
                  },
                  density_g_per_ml: { type: ["number","null"] },
                  default_piece_grams: { type: ["number","null"] }
                },
                required: ["name","qty","unit","per100g"]
              }
            }
          },
          required: ["items"]
        }
      }
    }
  });

  // Проверяем, что ответ содержит данные
  if (!resp.choices || !resp.choices[0] || !resp.choices[0].message) {
    throw new Error("Пустой ответ от Vision API");
  }

  const message = resp.choices[0].message;
  
  // Проверяем, есть ли parsed данные
  if (message.parsed && message.parsed.items) {
    return message.parsed.items;
  }
  
  // Если parsed нет, пытаемся распарсить content как JSON
  if (message.content) {
    try {
      const parsed = JSON.parse(message.content);
      if (parsed.items && Array.isArray(parsed.items)) {
        return parsed.items;
      }
    } catch (e) {
      console.error("Ошибка парсинга JSON из Vision API:", e);
    }
  }
  
  throw new Error("Не удалось распознать еду на фото");
}

module.exports = { parseFoodImageStructured };
