-- ================================================================
-- Sunday Run Club — Supabase Schema
-- Run this in your Supabase SQL editor (one paste, one run)
-- ================================================================

CREATE TABLE teams (
  id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name  TEXT NOT NULL UNIQUE,
  color TEXT,
  emoji TEXT
);

INSERT INTO teams (name, color, emoji) VALUES
  ('Cheetahs', '#F0824A', '🐆'),
  ('Storm',    '#4AF0A0', '⛈'),
  ('Thunder',  '#C8F04A', '⚡'),
  ('Wolves',   '#C896FF', '🐺');

CREATE TABLE athletes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL UNIQUE,
  team_id          UUID REFERENCES teams(id),
  active           BOOLEAN DEFAULT true,

  -- Registration fields
  age              INTEGER,
  location         TEXT,
  email            TEXT UNIQUE,
  phone            TEXT,
  activity_level   TEXT,   -- daily | alternate | less
  primary_sport    TEXT,
  emergency_name   TEXT,
  emergency_phone  TEXT,

  -- Status
  registration_status TEXT DEFAULT 'pending',  -- pending | confirmed | rejected
  registered_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE activities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_id       UUID REFERENCES athletes(id) ON DELETE CASCADE,

  type             TEXT NOT NULL,
  distance_km      NUMERIC(8,2) DEFAULT 0,
  duration_text    TEXT,
  activity_date    DATE,
  notes            TEXT,

  screenshot_url   TEXT,
  ai_confidence    INTEGER,
  ai_notes         TEXT,
  review_status    TEXT DEFAULT 'pending',  -- approved | pending_review | flagged

  points           INTEGER DEFAULT 0,
  points_breakdown JSONB,

  -- Link back to the Google Sheet row for write-back
  source_row       INTEGER,
  spreadsheet_id   TEXT,

  created_at       TIMESTAMPTZ DEFAULT now()
);

-- ── LEADERBOARD VIEWS ────────────────────────────────────────

CREATE OR REPLACE VIEW v_individual_leaderboard AS
SELECT
  a.id, a.name,
  t.name  AS team_name,
  t.color AS team_color,
  t.emoji AS team_emoji,
  COALESCE(SUM(act.points), 0)      AS total_points,
  COALESCE(SUM(act.distance_km), 0) AS total_km,
  COUNT(act.id)                     AS activity_count,
  COALESCE(SUM(CASE WHEN act.type='running'  THEN 1 ELSE 0 END), 0) AS run_count,
  COALESCE(SUM(CASE WHEN act.type='walking'  THEN 1 ELSE 0 END), 0) AS walk_count,
  COALESCE(SUM(CASE WHEN act.type='swimming' THEN 1 ELSE 0 END), 0) AS swim_count,
  COALESCE(SUM(CASE WHEN act.type='gym / workout' THEN 1 ELSE 0 END), 0) AS gym_count,
  RANK() OVER (ORDER BY COALESCE(SUM(act.points), 0) DESC) AS rank
FROM athletes a
LEFT JOIN teams t ON a.team_id = t.id
LEFT JOIN activities act
       ON act.athlete_id = a.id AND act.review_status = 'approved'
WHERE a.active = true
GROUP BY a.id, a.name, t.name, t.color, t.emoji;

CREATE OR REPLACE VIEW v_team_leaderboard AS
SELECT
  t.id, t.name, t.color, t.emoji,
  COALESCE(SUM(act.points), 0)      AS total_points,
  COALESCE(SUM(act.distance_km), 0) AS total_km,
  COUNT(DISTINCT a.id)              AS member_count,
  COUNT(act.id)                     AS activity_count,
  RANK() OVER (ORDER BY COALESCE(SUM(act.points), 0) DESC) AS rank
FROM teams t
LEFT JOIN athletes a ON a.team_id = t.id AND a.active = true
LEFT JOIN activities act
       ON act.athlete_id = a.id AND act.review_status = 'approved'
GROUP BY t.id, t.name, t.color, t.emoji;

CREATE OR REPLACE VIEW v_recent_feed AS
SELECT
  act.id, act.type, act.distance_km, act.duration_text,
  act.points, act.activity_date, act.created_at,
  a.name  AS athlete_name,
  t.name  AS team_name,
  t.color AS team_color,
  t.emoji AS team_emoji
FROM activities act
JOIN athletes a ON act.athlete_id = a.id
LEFT JOIN teams t ON a.team_id = t.id
WHERE act.review_status = 'approved'
ORDER BY act.created_at DESC
LIMIT 30;

-- ── SECURITY ──────────────────────────────────────────────────
ALTER TABLE athletes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams      ENABLE ROW LEVEL SECURITY;

-- Public can read (dashboard)
CREATE POLICY "public read teams"      ON teams      FOR SELECT USING (true);
CREATE POLICY "public read athletes"   ON athletes   FOR SELECT USING (active = true);
CREATE POLICY "public read activities" ON activities FOR SELECT USING (review_status = 'approved');

-- Only service role (Railway server) can write
CREATE POLICY "service write athletes"   ON athletes   FOR ALL USING (auth.role() = 'service_role');
CREATE POLICY "service write activities" ON activities FOR ALL USING (auth.role() = 'service_role');

-- ── INDEXES ───────────────────────────────────────────────────
CREATE INDEX idx_activities_athlete ON activities(athlete_id);
CREATE INDEX idx_activities_status  ON activities(review_status);
CREATE INDEX idx_activities_date    ON activities(activity_date DESC);
