import { Router } from 'express';
import { pool } from '../db.js';
import { authRequired } from '../middleware/auth.js';

const r = Router();
r.use(authRequired);

r.get('/stats', async (req, res) => {
  const { rows: me } = await pool.query(`SELECT id, referral_code FROM users WHERE id = $1`, [req.user.sub]);
  const { rows: refs } = await pool.query(
    `SELECT u.id, u.email, u.plan, u.created_at
     FROM users u WHERE u.referred_by = $1 ORDER BY u.created_at DESC LIMIT 200`,
    [req.user.sub]
  );
  res.json({ my_code: me[0]?.referral_code || null, referred_users: refs });
});

export default r;
