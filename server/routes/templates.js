import { Router } from 'express';
import { pool } from '../db.js';
import { authRequired } from '../middleware/auth.js';

const r = Router();
r.use(authRequired);

r.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, prompt_template, voice_name, caption_style, bg_category, created_at
     FROM templates WHERE user_id = $1 ORDER BY created_at DESC`,
    [req.user.sub]
  );
  res.json({ templates: rows });
});

r.post('/', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) {
    res.status(400).json({ error: 'name required' });
    return;
  }
  const { rows } = await pool.query(
    `INSERT INTO templates (user_id, name, prompt_template, voice_name, caption_style, bg_category)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      req.user.sub,
      name.slice(0, 120),
      b.prompt_template != null ? String(b.prompt_template) : null,
      b.voice_name != null ? String(b.voice_name).slice(0, 80) : null,
      b.caption_style != null ? String(b.caption_style).slice(0, 64) : null,
      b.bg_category != null ? String(b.bg_category).slice(0, 80) : null,
    ]
  );
  res.json({ template: rows[0] });
});

r.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query(`DELETE FROM templates WHERE id = $1 AND user_id = $2`, [
    req.params.id,
    req.user.sub,
  ]);
  if (!rowCount) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  res.json({ ok: true });
});

export default r;
