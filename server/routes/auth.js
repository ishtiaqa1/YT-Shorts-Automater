import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import { authRequired } from '../middleware/auth.js';

const r = Router();

function isValidTimezone(tz) {
  if (tz === 'UTC') return true;
  if (tz.length < 5 || tz.length > 64 || !tz.includes('/')) return false;
  return /^[A-Za-z][A-Za-z0-9_]*(\/[A-Za-z0-9_+\-]+)+$/.test(tz);
}

r.get('/me', authRequired, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, email, display_name, plan, timezone FROM users WHERE id = $1`,
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
  const { display_name, timezone } = req.body || {};
  if (display_name === undefined && timezone === undefined) {
    res.status(400).json({ error: 'Provide display_name and/or timezone' });
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
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $1 RETURNING id, email, display_name, plan, timezone`,
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
    const { email, password, display_name } = req.body || {};
    if (!email || !password) {
      res.status(400).json({ error: 'email and password required' });
      return;
    }
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3)
       RETURNING id, email, display_name, plan, timezone`,
      [email.trim().toLowerCase(), hash, display_name || null]
    );
    const user = rows[0];
    const token = jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET, {
      expiresIn: '30d',
    });
    res.json({ token, user });
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
      `SELECT id, email, display_name, plan, password_hash, timezone FROM users WHERE email = $1`,
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
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

export default r;
