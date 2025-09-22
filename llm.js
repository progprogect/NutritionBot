// llm.js
require("dotenv").config();
const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const ALLOWED_UNITS = ["g","ml","piece","slice","tsp","tbsp","cup","glass","can","bottle"];

async function parseFoodTextStructured(text, tz = "Europe/Warsaw") {
  const system = `Ты нутрициолог. Верни СТРОГО JSON по схеме. 
Без пояснений. Единицы только: ${ALLOWED_UNITS.join(", ")}.
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

function resolveGrams({ qty, unit, density, pieceGrams }) {
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
