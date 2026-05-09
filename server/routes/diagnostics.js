import { Router } from 'express';
import { pool } from '../db.js';
import { authRequired } from '../middleware/auth.js';

const r = Router();
r.use(authRequired);

r.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT d.id, d.metric, d.value_json, d.recorded_at, d.scheduled_upload_id,
            su.youtube_video_id, su.status AS upload_status, su.scheduled_at
     FROM upload_diagnostics d
     LEFT JOIN scheduled_uploads su ON su.id = d.scheduled_upload_id
     WHERE d.user_id = $1
     ORDER BY d.recorded_at DESC
     LIMIT 200`,
    [req.user.sub]
  );

  const stats = await pool.query(
    `SELECT su.status, COUNT(*)::int AS n
     FROM scheduled_uploads su
     WHERE su.user_id = $1
     GROUP BY su.status`,
    [req.user.sub]
  );

  res.json({ events: rows, upload_summary: stats.rows });
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
