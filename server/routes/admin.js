import { Router } from 'express';
import { pool } from '../db.js';
import { authRequired } from '../middleware/auth.js';

const r = Router();
r.use(authRequired);

function adminEmail() {
  return (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
}

r.use((req, res, next) => {
  const want = adminEmail();
  if (!want || String(req.user.email || '').toLowerCase() !== want) {
    res.status(403).json({ error: 'Admin only' });
    return;
  }
  next();
});

r.get('/stats', async (_req, res) => {
  const [{ rows: users }, { rows: byPlan }, { rows: rend }, { rows: upload }, { rows: rev }] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n FROM users`),
    pool.query(`SELECT plan, COUNT(*)::int AS n FROM users GROUP BY plan`),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM upload_diagnostics WHERE metric = 'render_complete' AND recorded_at >= NOW() - INTERVAL '7 days'`
    ),
    pool.query(
      `SELECT COUNT(*)::int AS n FROM upload_diagnostics WHERE metric = 'youtube_upload' AND recorded_at >= NOW() - INTERVAL '7 days'`
    ),
    pool.query(
      `SELECT COALESCE(SUM((value_json->>'amount_cents')::int),0)::int AS cents
       FROM upload_diagnostics WHERE metric = 'stripe_revenue_est' AND recorded_at >= NOW() - INTERVAL '7 days'`
    ),
  ]);

  res.json({
    total_users: users[0]?.n ?? 0,
    users_by_plan: byPlan,
    videos_rendered_this_week: rend[0]?.n ?? 0,
    videos_uploaded_this_week: upload[0]?.n ?? 0,
    revenue_estimate_cents_last_7d: rev[0]?.cents ?? 0,
    note: 'Revenue row is filled only if you log stripe_revenue_est diagnostics from webhooks.',
  });
});

export default r;
