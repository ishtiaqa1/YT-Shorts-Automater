import cron from 'node-cron';
import { pool } from '../db.js';
import { uploadVideo } from './youtubeUpload.js';

export function startUploadScheduler() {
  cron.schedule('* * * * *', async () => {
    const { rows } = await pool.query(
      `SELECT su.*, p.output_video_path, p.title AS project_title, p.script_text,
              y.refresh_token
       FROM scheduled_uploads su
       JOIN projects p ON p.id = su.project_id
       JOIN youtube_connections y ON y.user_id = su.user_id
       WHERE su.status = 'pending'
         AND p.output_video_path IS NOT NULL
         AND p.status = 'ready'
       LIMIT 5`
    );

    for (const row of rows) {
      if (!row.output_video_path || !row.refresh_token) {
        await pool.query(`UPDATE scheduled_uploads SET status = 'failed', last_error = $2 WHERE id = $1`, [
          row.id,
          'Missing rendered video or YouTube connection',
        ]);
        continue;
      }

      try {
        const publishAt = row.scheduled_at.toISOString();
        const up = await uploadVideo({
          refreshToken: row.refresh_token,
          filePath: row.output_video_path,
          title: row.title || row.project_title || 'Short',
          description: row.description || row.script_text?.slice(0, 4000) || '',
          tags: row.tags || [],
          privacyStatus: row.privacy_status || 'private',
          publishAt,
        });

        await pool.query(
          `UPDATE scheduled_uploads SET status = 'uploaded', youtube_video_id = $2, last_error = NULL WHERE id = $1`,
          [row.id, up.id]
        );

        await pool.query(
          `INSERT INTO upload_diagnostics (scheduled_upload_id, user_id, metric, value_json)
           VALUES ($1, $2, 'youtube_upload', $3::jsonb)`,
          [row.id, row.user_id, JSON.stringify({ videoId: up.id })]
        );
      } catch (e) {
        await pool.query(`UPDATE scheduled_uploads SET status = 'failed', last_error = $2 WHERE id = $1`, [
          row.id,
          String(e.message || e),
        ]);
      }
    }
  });
}
