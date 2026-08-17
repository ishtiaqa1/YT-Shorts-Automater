CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  stripe_customer_id TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  onboarding_completed BOOLEAN NOT NULL DEFAULT false,
  referral_code TEXT,
  referred_by UUID REFERENCES users(id) ON DELETE SET NULL,
  subscription_ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

/** Partial index on referral_code lives in db.js AFTER ALTER COLUMN — old DBs may lack the column until migrations run. */

CREATE TABLE IF NOT EXISTS youtube_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token TEXT NOT NULL,
  channel_id TEXT,
  channel_title TEXT,
  channel_nickname TEXT,
  google_account_email TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS youtube_connections_user_channel_uidx
  ON youtube_connections (user_id, channel_id) WHERE channel_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS tiktok_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  open_id TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  access_token TEXT,
  access_token_expires_at TIMESTAMPTZ,
  creator_username TEXT,
  creator_nickname TEXT,
  is_default BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS tiktok_connections_user_open_uidx
  ON tiktok_connections (user_id, open_id);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  script_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  background_asset_path TEXT,
  background_theme TEXT NOT NULL DEFAULT 'gameplay',
  output_video_path TEXT,
  duration_seconds REAL,
  error_message TEXT,
  render_progress SMALLINT,
  render_phase TEXT,
  caption_settings JSONB,
  caption_style TEXT NOT NULL DEFAULT 'bold_pop',
  caption_text TEXT,
  thumbnail_path TEXT,
  reddit_permalink TEXT,
  source_type TEXT DEFAULT 'manual',
  youtube_connection_id UUID REFERENCES youtube_connections(id) ON DELETE SET NULL,
  tiktok_connection_id UUID REFERENCES tiktok_connections(id) ON DELETE SET NULL,
  /** When true (default), queue YouTube Shorts rows when scheduling. */
  upload_dest_youtube BOOLEAN NOT NULL DEFAULT true,
  /** When true, queue TikTok direct-post rows when scheduling. */
  upload_dest_tiktok BOOLEAN NOT NULL DEFAULT false,
  music_track TEXT,
  music_volume REAL DEFAULT 0.15,
  voice_source TEXT NOT NULL DEFAULT 'ai',
  voice_asset_path TEXT,
  /** When true (default), libass captions are burned into the MP4; when false, voice + video only. */
  burn_captions BOOLEAN NOT NULL DEFAULT true,
  /** Bumped on each successful render (identifies which MP4 generation this is). */
  output_revision INTEGER NOT NULL DEFAULT 0,
  /** Last `output_revision` successfully written to `scheduled_uploads` for this project; NULL = never queued from editor/calendar. */
  last_queued_output_revision INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scheduled_uploads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  /** `youtube` (default) or `tiktok` — each row is one platform job. */
  platform TEXT NOT NULL DEFAULT 'youtube' CHECK (platform IN ('youtube', 'tiktok')),
  youtube_connection_id UUID REFERENCES youtube_connections(id) ON DELETE SET NULL,
  tiktok_connection_id UUID REFERENCES tiktok_connections(id) ON DELETE SET NULL,
  youtube_video_id TEXT,
  tiktok_publish_id TEXT,
  tiktok_post_id TEXT,
  scheduled_at TIMESTAMPTZ NOT NULL,
  privacy_status TEXT DEFAULT 'private',
  title TEXT,
  description TEXT,
  tags TEXT[],
  /** When set, upload this file instead of `projects.output_video_path` (multi-part Shorts splits). */
  output_video_path TEXT,
  /** Higher value claimed first (bumped after YouTube rate-limit so retries beat newer queues). */
  upload_priority INT NOT NULL DEFAULT 0,
  /** When set, do not claim this pending row until this time (after a rate-limit backoff). */
  retry_after TIMESTAMPTZ,
  rate_limit_retries SMALLINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
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

CREATE TABLE IF NOT EXISTS templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  prompt_template TEXT,
  voice_name TEXT,
  caption_style TEXT,
  bg_category TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scheduled_uploads_user ON scheduled_uploads(user_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_uploads_status ON scheduled_uploads(status);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_diagnostics_user ON upload_diagnostics(user_id);
CREATE INDEX IF NOT EXISTS idx_templates_user ON templates(user_id);
