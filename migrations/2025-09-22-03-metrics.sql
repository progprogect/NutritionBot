-- Миграция 3: Метрики MVP
-- Зависит от: 2025-09-22-01-init-tables.sql

-- Таблица метрик для MVP
CREATE TABLE IF NOT EXISTS metrics_events (
    id SERIAL PRIMARY KEY,
    user_tg_id TEXT NOT NULL,
    kind TEXT NOT NULL, -- 'text', 'voice', 'photo', 'day', 'error'
    latency_ms INTEGER NOT NULL,
    created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_metrics_user_tg_id ON metrics_events(user_tg_id);
CREATE INDEX IF NOT EXISTS idx_metrics_created_at ON metrics_events(created_at);
CREATE INDEX IF NOT EXISTS idx_metrics_kind ON metrics_events(kind);


