-- migrations/2025-09-22-coach-requests.sql
CREATE TYPE coach_request_status AS ENUM ('new','in_progress','done','rejected');

CREATE TABLE IF NOT EXISTS coach_requests (
  id SERIAL PRIMARY KEY,
  user_tg_id TEXT NOT NULL,
  user_id INT, -- если есть в users
  goal TEXT NOT NULL,              -- цель
  constraints TEXT,                -- ограничения/предпочтения
  stats TEXT,                      -- рост/вес/возраст (свободный ввод)
  contact TEXT NOT NULL,           -- удобный контакт (телега/телефон)
  status coach_request_status DEFAULT 'new',
  created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coach_requests_day ON coach_requests((created_at::date));
