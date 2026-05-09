import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import { authRequired } from '../middleware/auth.js';

const r = Router();

r.get('/me', authRequired, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, email, display_name, plan FROM users WHERE id = $1`,
    [req.user.sub]
  );
  const user = rows[0];
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  res.json({ user });
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
       RETURNING id, email, display_name, plan`,
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
    const { rows } = await pool.query(`SELECT * FROM users WHERE email = $1`, [email.trim().toLowerCase()]);
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
      user: { id: user.id, email: user.email, display_name: user.display_name, plan: user.plan },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Login failed' });
  }
});

export default r;
