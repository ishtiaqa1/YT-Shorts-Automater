import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import { authRequired } from '../middleware/auth.js';
import { isValidTimezone } from '../timezone.js';

const r = Router();

async function mintUniqueReferralCode() {
  for (let i = 0; i < 8; i += 1) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const clash = await pool.query(`SELECT 1 FROM users WHERE referral_code = $1`, [code]);
    if (clash.rowCount === 0) return code;
  }
  return crypto.randomUUID().slice(0, 8).toUpperCase();
}

r.get('/me', authRequired, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, email, display_name, plan, timezone, onboarding_completed,
            referral_code, subscription_ends_at
     FROM users WHERE id = $1`,
    [req.user.sub]
  );
  const user = rows[0];
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({ user });
});

r.patch('/me', authRequired, async (req, res) => {
  const { display_name, timezone, onboarding_completed } = req.body || {};
  if (
    display_name === undefined &&
    timezone === undefined &&
    onboarding_completed === undefined
  ) {
    res.status(400).json({ error: 'Provide display_name, timezone, and/or onboarding_completed' });
    return;
  }
  if (timezone !== undefined && timezone !== null) {
    const tz = String(timezone).trim();
    if (!isValidTimezone(tz)) {
      res.status(400).json({ error: 'timezone must be UTC or an IANA name like America/New_York' });
      return;
    }
  }
  const sets = [];
  const vals = [req.user.sub];
  let i = 2;
  if (display_name !== undefined) {
    sets.push(`display_name = $${i}`);
    vals.push(display_name === null || display_name === '' ? null : String(display_name).slice(0, 120));
    i += 1;
  }
  if (timezone !== undefined) {
    sets.push(`timezone = $${i}`);
    vals.push(String(timezone).trim());
    i += 1;
  }
  if (onboarding_completed !== undefined) {
    sets.push(`onboarding_completed = $${i}`);
    vals.push(Boolean(onboarding_completed));
    i += 1;
  }
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING id, email, display_name, plan, timezone,
        onboarding_completed, referral_code, subscription_ends_at`,
    vals
  );
  if (!rows[0]) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({ user: rows[0] });
});

r.post('/register', async (req, res) => {
  try {
    const { email, password, display_name, referral_from } = req.body || {};
    if (!email || !password) {
      res.status(400).json({ error: 'email and password required' });
      return;
    }
    let referredById = null;
    if (typeof referral_from === 'string' && referral_from.trim()) {
      const rf = referral_from.trim().toUpperCase();
      const ref = await pool.query(`SELECT id FROM users WHERE referral_code = $1`, [rf]);
      if (ref.rows[0]) referredById = ref.rows[0].id;
    }
    const hash = await bcrypt.hash(password, 10);
    const referralCodeOwned = await mintUniqueReferralCode();
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, display_name, referred_by, referral_code)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, display_name, plan, timezone, onboarding_completed, referral_code, subscription_ends_at`,
      [email.trim().toLowerCase(), hash, display_name || null, referredById, referralCodeOwned]
    );
    const user = rows[0];
    const token = jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET, {
      expiresIn: '30d',
    });
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        plan: user.plan,
        timezone: user.timezone,
        onboarding_completed: user.onboarding_completed,
        referral_code: user.referral_code,
        subscription_ends_at: user.subscription_ends_at,
      },
    });
  } catch (e) {
    if (e.code === '23505') {
      res.status(409).json({ error: 'Email already registered' });
      return;
    }
    console.error(e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

r.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      res.status(400).json({ error: 'email and password required' });
      return;
    }
    const { rows } = await pool.query(
      `SELECT id, email, display_name, plan, password_hash, timezone,
              onboarding_completed, referral_code, subscription_ends_at
       FROM users WHERE email = $1`,
      [email.trim().toLowerCase()]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      res.status(401).json({ error: 'Invalid credentials' });
      return;
    }
    const token = jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET, {
      expiresIn: '30d',
    });
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        plan: user.plan,
        timezone: user.timezone || 'UTC',
        onboarding_completed: user.onboarding_completed,
        referral_code: user.referral_code,
        subscription_ends_at: user.subscription_ends_at,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

export default r;
