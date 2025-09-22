-- migrations/2025-09-22-metrics.sql
CREATE TABLE IF NOT EXISTS metrics_events (
  id SERIAL PRIMARY KEY,
  user_tg_id TEXT NOT NULL,
  kind TEXT NOT NULL,         -- text|voice|photo|day|error
  latency_ms INT NOT NULL,    -- длительность обработки
  created_at TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_metrics_day ON metrics_events((created_at::date));
CREATE INDEX IF NOT EXISTS idx_metrics_kind_day ON metrics_events(kind, (created_at::date));
