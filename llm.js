// llm.js
require("dotenv").config();
const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ALLOWED_UNITS = ["g","ml","piece","slice","tsp","tbsp","cup","glass","can","bottle"];

async function parseFoodTextStructured(text, tz = "Europe/Warsaw") {
  const system = `Ты нутрициолог. Верни СТРОГО JSON по схеме. 
Без пояснений. 

ВАЖНО: Для каждого продукта укажи точное количество в граммах в поле resolved_grams.
Учитывай контекст и размеры:

Примеры определения граммов:
- "тарелка супа" → resolved_grams: 300 (большая тарелка)
- "маленькая тарелка супа" → resolved_grams: 200  
- "стакан молока" → resolved_grams: 250
- "чашка кофе" → resolved_grams: 150
- "банка пива" → resolved_grams: 500
- "банка тушенки" → resolved_grams: 400
- "ломтик хлеба" → resolved_grams: 25
- "кусок хлеба" → resolved_grams: 50
- "ложка сахара" → resolved_grams: 5
- "столовая ложка масла" → resolved_grams: 15

Единицы измерения: ${ALLOWED_UNITS.join(", ")}.
Если 'ml' — оцени density_g_per_ml (вода/кола ~1.00, молоко ~1.03).
Если 'piece'/'slice' — оцени default_piece_grams (реалистично).
"сегодня/вчера/в 10:30" верни ISO datetime c учётом TZ ${tz}.`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: `Фраза: """${text}"""` }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "FoodLog",
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
                  resolved_grams: { type: "number" },
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
                required: ["name","qty","unit","resolved_grams","per100g"]
              }
            }
          },
          required: ["items"]
        }
      }
    }
  });

  // c json_schema у OpenAI доступно готовое поле parsed
  const message = resp.choices[0].message;
  
  const parsed = message.parsed;
  if (!parsed || !parsed.items) {
    // Fallback: парсим content как JSON
    try {
      const content = JSON.parse(message.content);
      if (content && content.items) {
        return content.items;
      }
    } catch (e) {
      console.error("Не удалось распарсить content как JSON:", e);
    }
    throw new Error("OpenAI не вернул валидный JSON по схеме");
  }
  return parsed.items;
}

function resolveGrams({ qty, unit, density, pieceGrams, resolved_grams }) {
  // Если ИИ уже указал граммы - используем их (приоритет)
  if (resolved_grams && resolved_grams > 0) {
    return resolved_grams;
  }
  
  // Fallback для старых записей или ошибок ИИ
  if (unit === "g") return qty;
  if (unit === "ml") return density ? qty * density : qty; // фоллбек 1.0
  if (unit === "piece" || unit === "slice") return pieceGrams ? qty * pieceGrams : qty * 100; // фоллбек 100 г/шт
  if (unit === "tsp") return qty * 5;
  if (unit === "tbsp") return qty * 15;
  if (unit === "cup" || unit === "glass") return qty * 250;
  if (unit === "can" || unit === "bottle") return qty * 330;
  return qty;
}

function macrosFromPer100g(grams, per100g) {
  const k = grams / 100;
  const round1 = (x) => Math.round(x * 10) / 10;
  return {
    kcal: round1(per100g.kcal * k),
    p:    round1(per100g.p * k),
    f:    round1(per100g.f * k),
    c:    round1(per100g.c * k),
    fiber:round1(per100g.fiber * k),
  };
}

module.exports = { parseFoodTextStructured, resolveGrams, macrosFromPer100g };
