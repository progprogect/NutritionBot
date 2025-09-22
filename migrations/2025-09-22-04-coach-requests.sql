-- Миграция 4: Заявки на персональные планы
-- Зависит от: 2025-09-22-01-init-tables.sql

-- Создаем enum для статусов заявок
DO $$ BEGIN
    CREATE TYPE request_status AS ENUM ('new', 'in_progress', 'done', 'rejected');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Таблица заявок на персональные планы
CREATE TABLE IF NOT EXISTS coach_requests (
    id SERIAL PRIMARY KEY,
    user_tg_id TEXT NOT NULL,
    user_id INTEGER REFERENCES "User"(id) ON DELETE CASCADE,
    goal TEXT NOT NULL,
    constraints TEXT,
    stats TEXT,
    contact TEXT NOT NULL,
    status request_status DEFAULT 'new',
    created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coach_requests_user_tg_id ON coach_requests(user_tg_id);
CREATE INDEX IF NOT EXISTS idx_coach_requests_status ON coach_requests(status);
CREATE INDEX IF NOT EXISTS idx_coach_requests_created_at ON coach_requests(created_at);
