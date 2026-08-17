import cron from 'node-cron';
import { pool } from '../db.js';
import { fetchVideoAnalyticsSnippet } from './youtubeAnalytics.js';
import { mailWeeklySummary } from './email.js';
import { appPublicOrigin } from '../appPublicUrl.js';
import { pickYoutubeConnectionIdSql } from '../youtubeConnectionPickSql.js';

/** Poll YouTube Analytics for recently uploaded shorts (~every 6h). */
export function startYoutubeAnalyticsCron() {
  cron.schedule('0 */6 * * *', async () => {
    try {
      const yPick = pickYoutubeConnectionIdSql('su');
      const { rows } = await pool.query(
        `SELECT su.id AS scheduled_id, su.youtube_video_id, su.user_id,
                y.refresh_token, y.channel_id
         FROM scheduled_uploads su
         JOIN youtube_connections y ON y.id = ${yPick}
         WHERE su.status = 'uploaded'
           AND su.youtube_video_id IS NOT NULL
           AND y.refresh_token IS NOT NULL
           AND y.channel_id IS NOT NULL
         ORDER BY COALESCE(su.updated_at, su.created_at) DESC
         LIMIT 120`
      );

      const seen = new Set();
      for (const row of rows) {
        const key = `${row.user_id}:${row.youtube_video_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        try {
          const snap = await fetchVideoAnalyticsSnippet({
            refreshToken: row.refresh_token,
            channelId: row.channel_id,
            videoId: row.youtube_video_id,
          });
          await pool.query(
            `INSERT INTO upload_diagnostics (scheduled_upload_id, user_id, metric, value_json)
             VALUES ($1, $2, 'analytics_snapshot', $3::jsonb)`,
            [row.scheduled_id, row.user_id, JSON.stringify({ videoId: row.youtube_video_id, ...snap.values })]
          );
        } catch (e) {
          console.warn('[analytics cron] skip row', row.youtube_video_id, e.message || e);
        }
      }
    } catch (e) {
      console.error('[analytics cron]', e);
    }
  });
}

export async function weeklySummaryEmails() {
  const adminEmails = process.env.WEEKLY_SUMMARY_TO?.trim();
  const lines = [];
  try {
    const { rows } = await pool.query(`
      SELECT COUNT(*)::int AS n_users FROM users
    `);
    const { rows: w1 } = await pool.query(`
      SELECT COUNT(*)::int AS n FROM upload_diagnostics
      WHERE metric = 'render_complete' AND recorded_at >= NOW() - INTERVAL '7 days'
    `);
    lines.push(`<p>New users total: ${rows[0].n_users}</p>`);
    lines.push(`<p>Renders finished (last 7d): ${w1[0].n}</p>`);
    if (adminEmails) {
      for (const addr of adminEmails.split(',').map((s) => s.trim())) {
        if (addr) await mailWeeklySummary(addr, lines.join(''));
      }
    }
  } catch (e) {
    console.error('[weekly summary]', e);
  }
}

export function startWeeklySummaryCron() {
  cron.schedule('0 9 * * 1', () => weeklySummaryEmails()); // Monday 09:00 UTC
}
