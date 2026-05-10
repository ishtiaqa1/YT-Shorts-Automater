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
}
