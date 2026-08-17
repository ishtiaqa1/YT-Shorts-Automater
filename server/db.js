import './loadEnv.js';
import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

export async function initDb() {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  await pool.query(`
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS render_progress SMALLINT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS render_phase TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS caption_settings JSONB;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS caption_text TEXT;
  `);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC'`);

  const { rows: ytCols } = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'youtube_connections'
  `);
  const yt = new Set(ytCols.map((r) => r.column_name));
  if (!yt.has('id')) {
    await pool.query(`
      ALTER TABLE youtube_connections ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();
      ALTER TABLE youtube_connections ADD COLUMN IF NOT EXISTS google_account_email TEXT;
      ALTER TABLE youtube_connections ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT true;
    `);
    await pool.query(`UPDATE youtube_connections SET is_default = true WHERE is_default IS NULL`);
    await pool.query(`ALTER TABLE youtube_connections ALTER COLUMN id SET NOT NULL`);
    await pool.query(`ALTER TABLE youtube_connections DROP CONSTRAINT IF EXISTS youtube_connections_pkey`);
    await pool.query(`ALTER TABLE youtube_connections ADD PRIMARY KEY (id)`);
  }
  await pool.query(`
    DROP INDEX IF EXISTS youtube_connections_user_channel_uidx;
    CREATE UNIQUE INDEX IF NOT EXISTS youtube_connections_user_channel_uidx
    ON youtube_connections (user_id, channel_id) WHERE channel_id IS NOT NULL
  `);

  await pool.query(`
    ALTER TABLE scheduled_uploads ADD COLUMN IF NOT EXISTS youtube_connection_id UUID
      REFERENCES youtube_connections(id) ON DELETE SET NULL
  `);

  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS caption_style TEXT DEFAULT 'bold_pop'`);
  await pool.query(`UPDATE projects SET caption_style = 'bold_pop' WHERE caption_style IS NULL`);

  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT`);
  await pool.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES users(id) ON DELETE SET NULL`
  );
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_ends_at TIMESTAMPTZ`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_uidx ON users (referral_code) WHERE referral_code IS NOT NULL`);

  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS thumbnail_path TEXT`);
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS background_theme TEXT NOT NULL DEFAULT 'gameplay'`);
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS reddit_permalink TEXT`);
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'manual'`);
  await pool.query(
    `ALTER TABLE projects ADD COLUMN IF NOT EXISTS youtube_connection_id UUID REFERENCES youtube_connections(id) ON DELETE SET NULL`
  );
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS music_track TEXT`);
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS music_volume REAL DEFAULT 0.15`);
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS voice_source TEXT NOT NULL DEFAULT 'ai'`);
  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS voice_asset_path TEXT`);

  await pool.query(`ALTER TABLE youtube_connections ADD COLUMN IF NOT EXISTS channel_nickname TEXT`);
  await pool.query(`
    UPDATE youtube_connections SET channel_nickname = COALESCE(channel_nickname, channel_title)
    WHERE channel_title IS NOT NULL
  `);

  await pool.query(`
    ALTER TABLE scheduled_uploads ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()
  `);
  await pool.query(`
    ALTER TABLE scheduled_uploads ADD COLUMN IF NOT EXISTS output_video_path TEXT
  `);
  await pool.query(`
    ALTER TABLE scheduled_uploads ADD COLUMN IF NOT EXISTS upload_priority INT NOT NULL DEFAULT 0
  `);
  await pool.query(`
    ALTER TABLE scheduled_uploads ADD COLUMN IF NOT EXISTS retry_after TIMESTAMPTZ
  `);
  await pool.query(`
    ALTER TABLE scheduled_uploads ADD COLUMN IF NOT EXISTS rate_limit_retries SMALLINT NOT NULL DEFAULT 0
  `);

  // Heal rows that were prematurely claimed before the scheduled_at guard was added.
  await pool.query(`
    UPDATE scheduled_uploads
    SET status = 'pending', last_error = NULL, updated_at = NOW()
    WHERE status IN ('uploading', 'failed')
      AND scheduled_at > NOW()
      AND youtube_video_id IS NULL
  `);

  await pool.query(`
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS output_revision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_queued_output_revision INTEGER;
  `);
  await pool.query(
    `ALTER TABLE projects ADD COLUMN IF NOT EXISTS burn_captions BOOLEAN NOT NULL DEFAULT true`
  );
  /** Existing ready renders: treat as revision 1 so first schedule after upgrade still works; re-render continues bumping from there. */
  await pool.query(`
    UPDATE projects SET output_revision = 1
    WHERE output_revision = 0
      AND status = 'ready'
      AND output_video_path IS NOT NULL
      AND length(trim(output_video_path::text)) > 0
  `);

  await pool.query(`
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
    CREATE INDEX IF NOT EXISTS idx_templates_user ON templates(user_id);
  `);

  await pool.query(`
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
  `);
  await pool.query(`
    DROP INDEX IF EXISTS tiktok_connections_user_open_uidx;
    CREATE UNIQUE INDEX IF NOT EXISTS tiktok_connections_user_open_uidx
      ON tiktok_connections (user_id, open_id);
  `);

  await pool.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS tiktok_connection_id UUID`);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE projects
        ADD CONSTRAINT projects_tiktok_connection_id_fkey
        FOREIGN KEY (tiktok_connection_id) REFERENCES tiktok_connections(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await pool.query(
    `ALTER TABLE projects ADD COLUMN IF NOT EXISTS upload_dest_youtube BOOLEAN NOT NULL DEFAULT true`
  );
  await pool.query(
    `ALTER TABLE projects ADD COLUMN IF NOT EXISTS upload_dest_tiktok BOOLEAN NOT NULL DEFAULT false`
  );

  await pool.query(`ALTER TABLE scheduled_uploads ADD COLUMN IF NOT EXISTS platform TEXT`);
  await pool.query(`UPDATE scheduled_uploads SET platform = 'youtube' WHERE platform IS NULL OR trim(platform) = ''`);
  await pool.query(`ALTER TABLE scheduled_uploads ALTER COLUMN platform SET DEFAULT 'youtube'`);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE scheduled_uploads ALTER COLUMN platform SET NOT NULL;
    EXCEPTION WHEN others THEN NULL; END $$;
  `);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE scheduled_uploads
        ADD CONSTRAINT scheduled_uploads_platform_chk
        CHECK (platform IN ('youtube', 'tiktok'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);

  await pool.query(`ALTER TABLE scheduled_uploads ADD COLUMN IF NOT EXISTS tiktok_connection_id UUID`);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE scheduled_uploads
        ADD CONSTRAINT scheduled_uploads_tiktok_connection_id_fkey
        FOREIGN KEY (tiktok_connection_id) REFERENCES tiktok_connections(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  await pool.query(`ALTER TABLE scheduled_uploads ADD COLUMN IF NOT EXISTS tiktok_publish_id TEXT`);
  await pool.query(`ALTER TABLE scheduled_uploads ADD COLUMN IF NOT EXISTS tiktok_post_id TEXT`);
}
