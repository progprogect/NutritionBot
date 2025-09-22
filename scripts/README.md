# Scripts

Эта папка содержит вспомогательные скрипты для разработки и отладки.

## debug/
- `debug-connection.js` - тест подключения к PostgreSQL с отладочной информацией
- `test-connection.js` - тест подключения через Prisma
- `test-pg.js` - тест прямого подключения к PostgreSQL

## test/
- `test-bot-logic.js` - тест логики бота и функции getDayEntries

## Использование

```bash
# Тест подключения к БД
node scripts/debug/debug-connection.js

# Тест логики бота
node scripts/test/test-bot-logic.js
```

**Примечание:** Эти скрипты используются только для разработки и отладки. Основной код бота находится в `index.js`.

