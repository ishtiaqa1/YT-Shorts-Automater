import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { appPublicOrigin } from '../appPublicUrl.js';
import { pool } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { authUrl, exchangeCode } from '../services/youtubeUpload.js';

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

/** Map token exchange / API errors to a short reason code for the SPA. */
function exchangeFailureReason(err) {
  const msg = String(err?.message || err);
  const data = err?.response?.data;
  const body = data && typeof data === 'object' ? JSON.stringify(data) : String(data || '');
  const s = `${msg} ${body}`;
  const oauthErr = typeof data?.error === 'string' ? data.error : '';
  if (oauthErr === 'invalid_grant' || /invalid_grant/i.test(s)) return 'invalid_grant';
  if (oauthErr === 'invalid_client' || /invalid_client/i.test(s)) return 'invalid_client';
  if (/redirect_uri|redirect uri|Redirect URI/i.test(s)) return 'redirect_mismatch';
  if (/accessNotConfigured|YouTube Data API v3 has not been used|youtube\.googleapis\.com is disabled/i.test(s)) {
    return 'youtube_api_disabled';
  }
  if (/PERMISSION_DENIED|quotaExceeded|dailyLimitExceeded|userRateLimitExceeded/i.test(s)) {
    return 'youtube_api_quota';
  }
  if (/insufficientPermissions|Insufficient Permission/i.test(s)) return 'insufficient_scope';
  return 'token_exchange';
}

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
  const { code, state, error: googleOAuthError, error_description: googleDesc } = req.query;
  if (googleOAuthError) {
    console.warn('[youtube oauth] Google returned error:', googleOAuthError, googleDesc || '');
    const reason = googleOAuthError === 'access_denied' ? 'access_denied' : 'google_oauth';
    res.redirect(settingsRedirect({ youtube: 'error', reason }));
    return;
  }
  if (!code || !state || typeof code !== 'string' || typeof state !== 'string') {
    res.redirect(settingsRedirect({ youtube: 'error', reason: 'missing_params' }));
    return;
  }
  let payload;
  try {
    payload = jwt.verify(state, process.env.JWT_SECRET);
  } catch (e) {
    console.error('[youtube oauth] bad state JWT', e);
    res.redirect(settingsRedirect({ youtube: 'error', reason: 'bad_state' }));
    return;
  }

  let tokens;
  try {
    tokens = await exchangeCode(code);
  } catch (e) {
    const reason = exchangeFailureReason(e);
    console.error('[youtube oauth] exchangeCode → redirect reason=%s', reason, e);
    res.redirect(settingsRedirect({ youtube: 'error', reason }));
    return;
  }

  if (!tokens.channel_id) {
    res.redirect(settingsRedirect({ youtube: 'error', reason: 'no_channel' }));
    return;
  }

  try {
    const { rows: existing } = await pool.query(
      `SELECT id, is_default, refresh_token FROM youtube_connections WHERE user_id = $1 AND channel_id = $2`,
      [payload.sub, tokens.channel_id]
    );

    const mergedRefresh = tokens.refresh_token || existing[0]?.refresh_token || null;
    if (!mergedRefresh) {
      res.redirect(settingsRedirect({ youtube: 'error', reason: 'no_refresh_token' }));
      return;
    }

    if (existing[0]) {
      await pool.query(
        `UPDATE youtube_connections SET
           refresh_token = $2,
           channel_title = $3,
           google_account_email = COALESCE($4, google_account_email),
           updated_at = NOW()
         WHERE id = $1`,
        [existing[0].id, mergedRefresh, tokens.channel_title, tokens.google_account_email]
      );
    } else {
      const { rows: cnt } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM youtube_connections WHERE user_id = $1`,
        [payload.sub]
      );
      const isDefault = cnt[0].n === 0;
      if (isDefault) {
        await pool.query(`UPDATE youtube_connections SET is_default = false WHERE user_id = $1`, [payload.sub]);
      }
      await pool.query(
        `INSERT INTO youtube_connections
          (user_id, refresh_token, channel_id, channel_title, google_account_email, is_default, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [
          payload.sub,
          mergedRefresh,
          tokens.channel_id,
          tokens.channel_title,
          tokens.google_account_email,
          isDefault,
        ]
      );
    }

    res.redirect(settingsRedirect({ youtube: 'connected' }));
  } catch (e) {
    console.error('[youtube oauth] database', e);
    res.redirect(settingsRedirect({ youtube: 'error', reason: 'database' }));
  }
});

r.get('/status', authRequired, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, channel_id, channel_title, google_account_email, is_default, updated_at
     FROM youtube_connections WHERE user_id = $1 ORDER BY is_default DESC, updated_at DESC`,
    [req.user.sub]
  );
  res.json({ connections: rows, connected: rows.length > 0 });
});

r.post('/connections/:connId/default', authRequired, async (req, res) => {
  const { connId } = req.params;
  const { rows } = await pool.query(`SELECT id FROM youtube_connections WHERE id = $1 AND user_id = $2`, [
    connId,
    req.user.sub,
  ]);
  if (!rows[0]) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }
  await pool.query(`UPDATE youtube_connections SET is_default = false WHERE user_id = $1`, [req.user.sub]);
  await pool.query(`UPDATE youtube_connections SET is_default = true WHERE id = $1`, [connId]);
  const { rows: list } = await pool.query(
    `SELECT id, channel_id, channel_title, google_account_email, is_default, updated_at
     FROM youtube_connections WHERE user_id = $1 ORDER BY is_default DESC, updated_at DESC`,
    [req.user.sub]
  );
  res.json({ connections: list });
});

r.delete('/connections/:connId', authRequired, async (req, res) => {
  const { connId } = req.params;
  const { rowCount } = await pool.query(`DELETE FROM youtube_connections WHERE id = $1 AND user_id = $2`, [
    connId,
    req.user.sub,
  ]);
  if (!rowCount) {
    res.status(404).json({ error: 'Connection not found' });
    return;
  }
  const { rows } = await pool.query(
    `SELECT id FROM youtube_connections WHERE user_id = $1 AND is_default = true LIMIT 1`,
    [req.user.sub]
  );
  if (!rows[0]) {
    const { rows: pick } = await pool.query(
      `SELECT id FROM youtube_connections WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1`,
      [req.user.sub]
    );
    if (pick[0]) {
      await pool.query(`UPDATE youtube_connections SET is_default = true WHERE id = $1`, [pick[0].id]);
    }
  }
  res.json({ ok: true });
});

export default r;
