import { Router } from 'express';
import { pool } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { buildActivityFeed } from '../diagnosticsActivity.js';
import { listRecentChannelVideosWithStudioFlag } from '../services/youtubeChannelVideos.js';

const r = Router();
r.use(authRequired);

r.get('/', async (req, res) => {
  const userId = req.user.sub;

  const [diagRes, statsRes, scheduledRes, channelVideos] = await Promise.all([
    pool.query(
      `SELECT d.id, d.metric, d.value_json, d.recorded_at, d.scheduled_upload_id,
              su.youtube_video_id, su.status AS upload_status, su.scheduled_at
       FROM upload_diagnostics d
       LEFT JOIN scheduled_uploads su ON su.id = d.scheduled_upload_id
       WHERE d.user_id = $1
       ORDER BY d.recorded_at DESC
       LIMIT 200`,
      [userId]
    ),
    pool.query(
      `SELECT su.status, COUNT(*)::int AS n
       FROM scheduled_uploads su
       WHERE su.user_id = $1
       GROUP BY su.status`,
      [userId]
    ),
    pool.query(
      `SELECT su.id, su.project_id, su.youtube_connection_id, su.youtube_video_id, su.scheduled_at,
              su.privacy_status, su.title, su.description, su.tags, su.status, su.last_error, su.created_at,
              p.title AS project_title, p.status AS project_status
       FROM scheduled_uploads su
       JOIN projects p ON p.id = su.project_id
       WHERE su.user_id = $1
       ORDER BY su.created_at DESC
       LIMIT 80`,
      [userId]
    ),
    listRecentChannelVideosWithStudioFlag(userId, 40),
  ]);

  const rows = diagRes.rows;
  const activity = buildActivityFeed(rows);

  res.json({
    events: rows,
    upload_summary: statsRes.rows,
    activity,
    scheduled_uploads: scheduledRes.rows,
    channel_videos: channelVideos,
  });
});

r.get('/uploads', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT su.*, p.title AS project_title
     FROM scheduled_uploads su
     JOIN projects p ON p.id = su.project_id
     WHERE su.user_id = $1
     ORDER BY su.created_at DESC`,
    [req.user.sub]
  );
  res.json({ uploads: rows });
});

export default r;
