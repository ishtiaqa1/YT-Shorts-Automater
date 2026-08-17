import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { appPublicOrigin } from '../appPublicUrl.js';
import { pool } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { tiktokAuthUrl, exchangeTiktokOAuthCode, queryCreatorInfo } from '../services/tiktokUpload.js';

const r = Router();

function settingsRedirect(searchParams) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) {
    if (v === undefined || v === null) continue;
    usp.set(k, String(v));
  }
  const q = usp.toString();
  return `${appPublicOrigin()}/app/settings${q ? `?${q}` : ''}`;
}

r.get('/auth-url', authRequired, (_req, res) => {
  try {
    const state = jwt.sign({ sub: _req.user.sub }, process.env.JWT_SECRET, { expiresIn: '10m' });
    const url = tiktokAuthUrl(state);
    res.json({ url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

r.get('/oauth/callback', async (req, res) => {
  const { code, state, error: oauthErr, error_description: oauthDesc } = req.query;
  if (oauthErr) {
    console.warn('[tiktok oauth] error:', oauthErr, oauthDesc || '');
    const reason = oauthErr === 'access_denied' ? 'access_denied' : 'tiktok_oauth';
    res.redirect(settingsRedirect({ tiktok: 'error', reason }));
    return;
  }
  if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
    res.redirect(settingsRedirect({ tiktok: 'error', reason: 'missing_params' }));
    return;
  }
  let payload;
  try {
    payload = jwt.verify(state, process.env.JWT_SECRET);
  } catch (e) {
    console.error('[tiktok oauth] bad state JWT', e);
    res.redirect(settingsRedirect({ tiktok: 'error', reason: 'bad_state' }));
    return;
  }

  let tokens;
  try {
    tokens = await exchangeTiktokOAuthCode(code);
  } catch (e) {
    console.error('[tiktok oauth] exchange failed', e);
    res.redirect(settingsRedirect({ tiktok: 'error', reason: 'token_exchange' }));
    return;
  }

  let creator;
  try {
    creator = await queryCreatorInfo(tokens.access_token);
  } catch (e) {
    console.warn('[tiktok oauth] creator_info failed (continuing)', e?.message || e);
    creator = { creator_username: null, creator_nickname: null };
  }

  const expiresAt = new Date(Date.now() + Math.max(60, tokens.expires_in) * 1000);

  try {
    const { rows: existing } = await pool.query(
      `SELECT id, refresh_token FROM tiktok_connections WHERE user_id = $1 AND open_id = $2`,
      [payload.sub, tokens.open_id]
    );

    if (existing[0]) {
      await pool.query(
        `UPDATE tiktok_connections SET
           refresh_token = $2,
           access_token = $3,
           access_token_expires_at = $4,
           creator_username = COALESCE($5, creator_username),
           creator_nickname = COALESCE($6, creator_nickname),
           updated_at = NOW()
         WHERE id = $1`,
        [
          existing[0].id,
          tokens.refresh_token,
          tokens.access_token,
          expiresAt,
          creator.creator_username,
          creator.creator_nickname,
        ]
      );
    } else {
      const { rows: cnt } = await pool.query(`SELECT COUNT(*)::int AS n FROM tiktok_connections WHERE user_id = $1`, [
        payload.sub,
      ]);
      const isDefault = cnt[0].n === 0;
      if (isDefault) {
        await pool.query(`UPDATE tiktok_connections SET is_default = false WHERE user_id = $1`, [payload.sub]);
      }
      await pool.query(
        `INSERT INTO tiktok_connections
          (user_id, open_id, refresh_token, access_token, access_token_expires_at,
           creator_username, creator_nickname, is_default, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
        [
          payload.sub,
          tokens.open_id,
          tokens.refresh_token,
          tokens.access_token,
          expiresAt,
          creator.creator_username,
          creator.creator_nickname,
          isDefault,
        ]
      );
    }

    res.redirect(settingsRedirect({ tiktok: 'connected' }));
  } catch (e) {
    console.error('[tiktok oauth] database', e);
    res.redirect(settingsRedirect({ tiktok: 'error', reason: 'database' }));
  }
});

r.get('/status', authRequired, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, open_id, creator_username, creator_nickname, is_default, updated_at
     FROM tiktok_connections WHERE user_id = $1 ORDER BY is_default DESC, updated_at DESC`,
    [req.user.sub]
  );
  res.json({ connections: rows, connected: rows.length > 0 });
});

r.post('/connections/:connId/default', authRequired, async (req, res) => {
  const { connId } = req.params;
  const { rows } = await pool.query(`SELECT id FROM tiktok_connections WHERE id = $1 AND user_id = $2`, [
    connId,
    req.user.sub,
  ]);
  if (!rows[0]) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }
  await pool.query(`UPDATE tiktok_connections SET is_default = false WHERE user_id = $1`, [req.user.sub]);
  await pool.query(`UPDATE tiktok_connections SET is_default = true WHERE id = $1`, [connId]);
  const { rows: list } = await pool.query(
    `SELECT id, open_id, creator_username, creator_nickname, is_default, updated_at
     FROM tiktok_connections WHERE user_id = $1 ORDER BY is_default DESC, updated_at DESC`,
    [req.user.sub]
  );
  res.json({ connections: list });
});

r.delete('/connections/:connId', authRequired, async (req, res) => {
  const { connId } = req.params;
  const { rowCount } = await pool.query(`DELETE FROM tiktok_connections WHERE id = $1 AND user_id = $2`, [
    connId,
    req.user.sub,
  ]);
  if (!rowCount) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }
  const { rows } = await pool.query(
    `SELECT id FROM tiktok_connections WHERE user_id = $1 AND is_default = true LIMIT 1`,
    [req.user.sub]
  );
  if (!rows[0]) {
    const { rows: pick } = await pool.query(
      `SELECT id FROM tiktok_connections WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1`,
      [req.user.sub]
    );
    if (pick[0]) {
      await pool.query(`UPDATE tiktok_connections SET is_default = true WHERE id = $1`, [pick[0].id]);
    }
  }
  res.json({ ok: true });
});

export default r;
