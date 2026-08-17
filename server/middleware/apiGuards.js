import rateLimit from 'express-rate-limit';
import { pool } from '../db.js';

const isDev = process.env.NODE_ENV !== 'production';

export const globalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_GLOBAL_PER_MIN || (isDev ? '1200' : '200')),
  standardHeaders: true,
  legacyHeaders: false,
  /** CORS/browser preflight must never burn quota or surface 429 — that blocks POST/DELETE with Authorization */
  skip: (req) => req.method === 'OPTIONS',
});

export const aiGenerateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_AI_PER_MIN || (isDev ? '120' : '10')),
  standardHeaders: true,
  legacyHeaders: false,
});

export const renderLimiterFactory = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_LIMIT_RENDER_PER_MIN || (isDev ? '120' : '5')),
  standardHeaders: true,
  legacyHeaders: false,
});

/** Warn on burst API calls per authenticated user into diagnostics. */
const burst = new Map();
export function suspiciousActivityWatcher(req, res, next) {
  const sub = req.user?.sub;
  if (!sub || req.method === 'OPTIONS') return next();
  const now = Date.now();
  const list = burst.get(sub) || [];
  const cutoff = now - 10 * 60 * 1000;
  const recent = [...list, now].filter((t) => t > cutoff);
  burst.set(sub, recent);
  if (recent.length > 50 && recent.length % 10 === 0) {
    void pool.query(
      `INSERT INTO upload_diagnostics (scheduled_upload_id, user_id, metric, value_json)
       VALUES (NULL, $1, $2, $3::jsonb)`,
      [sub, 'suspicious_api_burst', JSON.stringify({ count: recent.length, path: req.path })]
    ).catch(() => {});
  }
  next();
}

/**
 * Rough daily render quota (logged-in users only — applied on render route middleware).
 */
export async function enforceRenderDailyCap(req, res, next) {
  if (isDev || String(process.env.DISABLE_RENDER_DAILY_CAP || '').trim() === '1') return next();
  try {
    const sub = req.user?.sub;
    if (!sub) return next();
    const dayStartSql = `(NOW() AT TIME ZONE 'utc')::date`;
    const { rows: u } = await pool.query(`SELECT plan FROM users WHERE id = $1`, [sub]);
    const plan = u[0]?.plan || 'free';
    const freeCap = Number(process.env.FREE_RENDERS_PER_DAY || '8');
    const proCap = Number(process.env.PRO_RENDERS_PER_DAY_CAP || '8');
    const cap = plan === 'pro' ? proCap : freeCap;

    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM upload_diagnostics ud
       WHERE ud.user_id = $1 AND ud.metric = 'render_started'
       AND (ud.recorded_at AT TIME ZONE 'utc')::date = (${dayStartSql})`,
      [sub]
    );

    const n = cnt[0]?.n ?? 0;
    if (n >= cap) {
      res.status(429).json({ error: `Daily render limit reached (${cap}). Try again tomorrow or upgrade quotas.` });
      return;
    }
  } catch (e) {
    console.warn('[render quota]', e);
  }
  next();
}
