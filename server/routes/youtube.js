import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { authUrl, exchangeCode } from '../services/youtubeUpload.js';

const r = Router();

r.get('/auth-url', authRequired, (_req, res) => {
  try {
    const state = jwt.sign({ sub: _req.user.sub }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const url = authUrl(state);
    res.json({ url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

r.get('/oauth/callback', async (req, res) => {
  const { code, state } = req.query;
  const appUrl = process.env.PUBLIC_APP_URL || 'http://localhost:5173';
  if (!code || !state) {
    res.redirect(`${appUrl}/settings?youtube=error`);
    return;
  }
  try {
    const payload = jwt.verify(state, process.env.JWT_SECRET);
    const tokens = await exchangeCode(code);
    if (!tokens.refresh_token) {
      res.redirect(`${appUrl}/settings?youtube=error`);
      return;
    }
    await pool.query(
      `INSERT INTO youtube_connections (user_id, refresh_token, channel_id, channel_title, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         refresh_token = EXCLUDED.refresh_token,
         channel_id = EXCLUDED.channel_id,
         channel_title = EXCLUDED.channel_title,
         updated_at = NOW()`,
      [payload.sub, tokens.refresh_token, tokens.channel_id, tokens.channel_title]
    );
    res.redirect(`${appUrl}/settings?youtube=connected`);
  } catch (e) {
    console.error(e);
    res.redirect(`${appUrl}/settings?youtube=error`);
  }
});

r.get('/status', authRequired, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT channel_id, channel_title, updated_at FROM youtube_connections WHERE user_id = $1`,
    [req.user.sub]
  );
  res.json({ connected: !!rows[0], connection: rows[0] || null });
});

export default r;
