CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS youtube_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token TEXT NOT NULL,
  channel_id TEXT,
  channel_title TEXT,
  google_account_email TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS youtube_connections_user_channel_uidx
  ON youtube_connections (user_id, channel_id) WHERE channel_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  script_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  background_asset_path TEXT,
  output_video_path TEXT,
  duration_seconds REAL,
  error_message TEXT,
  render_progress SMALLINT,
  render_phase TEXT,
  caption_settings JSONB,
  /** When set, burned-in subtitles use this text (timed against audio); TTS still uses script_text. NULL = use script_text for captions too. */
  caption_text TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scheduled_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  youtube_connection_id UUID REFERENCES youtube_connections(id) ON DELETE SET NULL,
  youtube_video_id TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL,
  privacy_status TEXT DEFAULT 'private',
  title TEXT,
  description TEXT,
  tags TEXT[],
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS upload_diagnostics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_upload_id UUID REFERENCES scheduled_uploads(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  value_json JSONB,
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_uploads_user ON scheduled_uploads(user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_uploads_status ON scheduled_uploads(status);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_diagnostics_user ON upload_diagnostics(user_id);
